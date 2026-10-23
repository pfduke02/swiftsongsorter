# Swift Song Sorter

Pick the Taylor Swift song you like better in each battle and get a ranking of all 253 album tracks. Runs as a single page on a Cloudflare Worker, with one record per sorter in a D1 database and a share link for each ranking.

## How the ranking works

- **Library**: 253 songs across the debut album, Fearless / Speak Now / Red / 1989 (Taylor's Versions with vault tracks), Reputation, Lover, folklore, evermore, Midnights, The Tortured Poets Department, The Life of a Showgirl, and 9 non-album singles. Each song carries album, era, tempo, musical style and single-or-deep-cut tags (see the top of `public/index.html`).
- **Model**: after every battle a hierarchical Bradley-Terry model is refit in the browser. A song's score is album + era + tempo + style + single + its own deviation, so each answer also moves musically similar songs you have not been asked about.
- **Battle selection**: the first 40 battles spread across albums and unseen songs. Then the sorter concentrates on pinning down the top 26, then the top 52, then everything else, always preferring pairs whose outcome it cannot predict.
- **Stop any time**: the list is inferred from whatever has been answered. Exact ties are broken by a similarity-weighted look at the songs you did compare, then singles over deep cuts.
- **Hand sorting**: the inferred list is a suggestion. Drag or nudge songs; the order is saved and the album table follows it.

## Project layout

```
public/index.html          the whole app (library, model, UI, cloud sync, shared view)
src/worker.js              JSON API on Cloudflare Workers, backed by D1
migrations/0001_init.sql   D1 schema: one row per sorter in `sorts`, every answer in `battles`
wrangler.jsonc             Worker + static assets + D1 binding
.github/workflows/         deploys on push to main
```

### API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/sorts` | Create a record. Returns `{ id, token }`; the token stays in that browser. |
| `GET` | `/api/sorts/:id` | Public view: name, battle count, ranking. Powers `/s/:id`. |
| `PUT` | `/api/sorts/:id` | Save progress. Needs `Authorization: Bearer <token>`. Battles are sent incrementally from the last synced index, which also handles undo. |
| `GET` | `/api/stats?min=5&limit=50` | Song win rates across every sorter. |

## Run locally

```sh
npm install
npm run db:migrate:local
npm run dev            # http://127.0.0.1:8787
```

## Deploy to Cloudflare

### From GitHub (recommended)

1. In Cloudflare: My Profile → API Tokens → Create Token → use the **Edit Cloudflare Workers** template and add **Account → D1 → Edit**.
2. In this repo: Settings → Secrets and variables → Actions → add `CLOUDFLARE_API_TOKEN`.
3. Push to `main` or run the **Deploy to Cloudflare** workflow by hand. It creates the D1 database on first run, applies migrations, and deploys the Worker.

The Worker is named `swiftsongsorter` and the account id is in `wrangler.jsonc`, so the site comes up at `https://swiftsongsorter.<your-workers-subdomain>.workers.dev` (Workers & Pages → Overview shows the subdomain).

### From your machine

```sh
npx wrangler login
npm run db:create      # copy the database_id it prints into wrangler.jsonc
npm run db:migrate
npm run deploy
```

### Your own domain

Add the domain (for example `swiftsongsorter.com` or `songbattles.com`) to the Cloudflare account, then uncomment the `routes` block in `wrangler.jsonc` and deploy again. Cloudflare provisions the certificate and DNS record.
