-- Ступень 3. Локальный индекс портфеля.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS objects (
  id          TEXT PRIMARY KEY,
  cluster     TEXT NOT NULL DEFAULT 'B',   -- A Enbek | B Technopark | C OS | D Foresight
  layer       INTEGER NOT NULL DEFAULT 1,  -- 1 исполнение | 2 foresight
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  body        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  owner       TEXT,
  pred        TEXT,
  rel         TEXT,
  obj         TEXT
);
CREATE INDEX IF NOT EXISTS idx_obj_pred ON objects(pred);


CREATE TABLE IF NOT EXISTS links (
  from_id TEXT NOT NULL REFERENCES objects(id),
  to_id   TEXT NOT NULL REFERENCES objects(id),
  rel     TEXT NOT NULL,
  note    TEXT,
  PRIMARY KEY (from_id, to_id, rel)
);

CREATE TABLE IF NOT EXISTS origins (
  object_id  TEXT NOT NULL REFERENCES objects(id),
  session_id TEXT NOT NULL,
  span       TEXT,
  PRIMARY KEY (object_id, session_id)
);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT NOT NULL,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  object_id TEXT,
  detail    TEXT
);

CREATE TABLE IF NOT EXISTS packets (
  id           TEXT PRIMARY KEY,
  from_session TEXT NOT NULL,
  to_session   TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  read_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_obj_cluster_status ON objects(cluster, status);
CREATE INDEX IF NOT EXISTS idx_obj_type ON objects(type);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id);
