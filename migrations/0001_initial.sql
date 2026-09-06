CREATE TABLE IF NOT EXISTS transports (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transport_history (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conv_status (
  person_key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transports_updated_at ON transports(updated_at);
CREATE INDEX IF NOT EXISTS idx_history_updated_at ON transport_history(updated_at);
CREATE INDEX IF NOT EXISTS idx_conv_updated_at ON conv_status(updated_at);
