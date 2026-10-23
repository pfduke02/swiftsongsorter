/**
 * Swift Song Sorter — Cloudflare Worker.
 * Serves the static page from ./public and a small JSON API backed by D1.
 *
 *   POST /api/sorts            create a sort record → { id, token }
 *   GET  /api/sorts/:id        public view of one record (name, battles, ranking)
 *   PUT  /api/sorts/:id        save progress; needs "Authorization: Bearer <token>"
 *   GET  /api/stats            song win rates across every sorter
 */

const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    try {
      return await route(request, env, url);
    } catch (err) {
      console.error(err);
      return json({ error: err.message || 'Server error' }, 500);
    }
  },
};

async function route(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'sorts', id]
  const [, resource, id] = parts;

  if (resource === 'sorts' && !id && request.method === 'POST') return createSort(request, env);
  if (resource === 'sorts' && id && request.method === 'GET') return getSort(env, id);
  if (resource === 'sorts' && id && request.method === 'PUT') return saveSort(request, env, id);
  if (resource === 'stats' && request.method === 'GET') return stats(env, url);
  return json({ error: 'Not found' }, 404);
}

async function createSort(request, env) {
  const body = await readJson(request);
  const id = randomId(10);
  const token = randomHex(32);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sorts (id, token_hash, name, budget, battles, manual, state, ranking, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?)`
  ).bind(id, await sha256(token), cleanName(body.name), clampBudget(body.budget), now, now).run();
  return json({ id, token }, 201);
}

async function getSort(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, name, budget, battles, manual, ranking, created_at, updated_at FROM sorts WHERE id = ?`
  ).bind(id).first();
  if (!row) return json({ error: 'No sort with that id' }, 404);
  return json({
    id: row.id,
    name: row.name,
    budget: row.budget,
    battles: row.battles,
    manual: !!row.manual,
    ranking: row.ranking ? JSON.parse(row.ranking) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

async function saveSort(request, env, id) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Missing token' }, 401);
  const row = await env.DB.prepare(`SELECT token_hash FROM sorts WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: 'No sort with that id' }, 404);
  if (row.token_hash !== (await sha256(token))) return json({ error: 'Wrong token' }, 403);

  const body = await readJson(request);
  const now = new Date().toISOString();
  const state = body.state && typeof body.state === 'object' ? body.state : null;
  const ranking = Array.isArray(body.ranking) ? body.ranking.map(String).slice(0, 2000) : null;
  const from = Number.isInteger(body.from) && body.from >= 0 ? body.from : null;
  const newBattles = Array.isArray(body.newBattles) ? body.newBattles.slice(0, 5000) : [];
  const battleCount = state && Array.isArray(state.history) ? state.history.length : (from ?? 0) + newBattles.length;

  const stmts = [
    env.DB.prepare(
      `UPDATE sorts SET name = COALESCE(?, name), budget = COALESCE(?, budget), battles = ?, manual = ?, state = ?, ranking = ?, updated_at = ? WHERE id = ?`
    ).bind(cleanName(body.name), body.budget === undefined ? null : clampBudget(body.budget), battleCount, body.manual ? 1 : 0,
           state ? JSON.stringify(state) : null, ranking ? JSON.stringify(ranking) : null, now, id),
  ];
  if (from !== null) {
    // The client re-sends everything from index `from` (handles undo), so drop anything at or after it first.
    stmts.push(env.DB.prepare(`DELETE FROM battles WHERE sorter_id = ? AND n >= ?`).bind(id, from));
    newBattles.forEach((b, i) => {
      if (!b || typeof b.a !== 'string' || typeof b.b !== 'string' || !['a', 'b', 't', 'n'].includes(b.r)) return;
      stmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO battles (sorter_id, n, song_a, song_b, result, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, from + i, b.a.slice(0, 40), b.b.slice(0, 40), b.r, now));
    });
  }
  // D1 batches are limited in size; send in chunks.
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return json({ ok: true, battles: battleCount, synced: from !== null ? from + newBattles.length : battleCount, updated_at: now });
}

async function stats(env, url) {
  const min = Math.max(1, Math.min(100, parseInt(url.searchParams.get('min') || '5', 10) || 5));
  const limit = Math.max(1, Math.min(300, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS sorters, COALESCE(SUM(battles), 0) AS battles FROM sorts`
  ).first();
  const { results } = await env.DB.prepare(
    `SELECT song, SUM(win) AS wins, COUNT(*) AS n, SUM(win) * 1.0 / COUNT(*) AS rate FROM (
       SELECT song_a AS song, CASE result WHEN 'a' THEN 1.0 WHEN 't' THEN 0.5 ELSE 0.0 END AS win FROM battles WHERE result IN ('a','b','t')
       UNION ALL
       SELECT song_b AS song, CASE result WHEN 'b' THEN 1.0 WHEN 't' THEN 0.5 ELSE 0.0 END AS win FROM battles WHERE result IN ('a','b','t')
     ) GROUP BY song HAVING n >= ? ORDER BY rate DESC, n DESC LIMIT ?`
  ).bind(min, limit).all();
  return json({ sorters: totals.sorters, battles: totals.battles, min_battles: min, songs: results });
}

/* ---------- helpers ---------- */
function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors() } });
}
async function readJson(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}
function cleanName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim().slice(0, 40);
  return n || null;
}
function clampBudget(b) {
  const n = parseInt(b, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(5000, n)) : 500;
}
function randomId(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('');
}
function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
