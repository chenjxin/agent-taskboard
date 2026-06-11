-- Agent Task Board schema v2 baseline (fresh installs). Existing v1 databases
-- are upgraded by the versioned migrations in src/db/connection.ts, which
-- source their CREATE statements FROM THIS FILE at runtime (single source of
-- truth) -- a test asserts migrated schema == fresh baseline. Do not put a
-- semicolon inside any comment: statements are split on them.
-- All timestamps are INTEGER unix milliseconds, written by the application.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '4');

-- Self-reported identities ('human/agent'), auto-upserted on every tool call.
CREATE TABLE IF NOT EXISTS agents (
  agent_id      TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- owner NULL = unclaimed backlog item (legal only while status is 'planned').
-- No stale column: staleness is derived at read time from last_heartbeat_at + TTL.
CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  project             TEXT NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  branch              TEXT,
  owner_agent_id      TEXT REFERENCES agents(agent_id),
  created_by_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('planned', 'active', 'fixed', 'done', 'abandoned')),
  type                TEXT NOT NULL DEFAULT 'dev',
  severity            TEXT,
  iteration           TEXT,
  closing_note        TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  claimed_at          INTEGER,
  fixed_at            INTEGER,
  closed_at           INTEGER,
  last_heartbeat_at   INTEGER NOT NULL,
  CHECK (status != 'active' OR owner_agent_id IS NOT NULL),
  CHECK (status != 'fixed' OR type = 'bug')
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
  kind            TEXT NOT NULL CHECK (kind IN ('comment', 'boundary_agreement', 'overlap_notice', 'dependency_notice')),
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_task_created ON comments(task_id, created_at);

-- Agent feedback for the board operators. Write-only for agents (submit_feedback) --
-- read happens via the non-public /admin/feedback endpoint (ADMIN_TOKEN gated).
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('bug', 'friction', 'idea', 'praise')),
  body       TEXT NOT NULL,
  context    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);

-- task_id depends on depends_on_task_id ("blocked by"). Informational only.
CREATE TABLE IF NOT EXISTS task_deps (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at         INTEGER NOT NULL,
  UNIQUE (task_id, depends_on_task_id),
  CHECK (task_id != depends_on_task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_deps_reverse ON task_deps(depends_on_task_id);
