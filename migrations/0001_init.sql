-- One record per person who sorts. The token hash lets only that person's browser write to it.
CREATE TABLE IF NOT EXISTS sorts (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL,
  name        TEXT,
  budget      INTEGER NOT NULL DEFAULT 500,
  battles     INTEGER NOT NULL DEFAULT 0,
  manual      INTEGER NOT NULL DEFAULT 0,      -- 1 if the person reordered the list by hand
  state       TEXT,                             -- full client state (albums, history, manual order) as JSON
  ranking     TEXT,                             -- final ordered list of song keys as JSON
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Every battle answered, so song-level stats can be computed across everyone.
CREATE TABLE IF NOT EXISTS battles (
  sorter_id   TEXT NOT NULL,
  n           INTEGER NOT NULL,                 -- position in that person's history (0-based)
  song_a      TEXT NOT NULL,                    -- song key, e.g. "lover:1"
  song_b      TEXT NOT NULL,
  result      TEXT NOT NULL,                    -- 'a', 'b', 't' (like both), 'n' (no opinion)
  created_at  TEXT NOT NULL,
  PRIMARY KEY (sorter_id, n),
  FOREIGN KEY (sorter_id) REFERENCES sorts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS battles_song_a ON battles(song_a);
CREATE INDEX IF NOT EXISTS battles_song_b ON battles(song_b);
