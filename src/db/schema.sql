-- Agent Task Board schema v1. All timestamps are INTEGER unix milliseconds,
-- written by the application (millisecond precision matters: the heartbeat
-- activity cursor uses strict '>' comparisons).

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');

-- Self-reported identities ('human/agent'), auto-upserted on every tool call.
CREATE TABLE IF NOT EXISTS agents (
  agent_id      TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- No stale column: staleness is derived at read time from last_heartbeat_at + TTL.
CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  project           TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  branch            TEXT,
  owner_agent_id    TEXT NOT NULL REFERENCES agents(agent_id),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'abandoned')),
  closing_note      TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  closed_at         INTEGER,
  last_heartbeat_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project, status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_status ON tasks(owner_agent_id, status);

-- Scope declarations as rows (not JSON) so overlap reports can cite the exact pair that collided.
CREATE TABLE IF NOT EXISTS scopes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  path_glob TEXT,
  module    TEXT,
  note      TEXT,
  CHECK (path_glob IS NOT NULL OR module IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_scopes_task ON scopes(task_id);

-- author_agent_id has no FK on purpose: the reserved 'system' author needs no agents row.
CREATE TABLE IF NOT EXISTS comments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_agent_id TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('comment', 'boundary_agreement', 'overlap_notice')),
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_task_created ON comments(task_id, created_at);
