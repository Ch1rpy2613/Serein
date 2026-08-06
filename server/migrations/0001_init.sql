CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  keys_json TEXT,
  city TEXT,
  levels TEXT,
  created_at INTEGER,
  last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS sync_states (
  code TEXT PRIMARY KEY,
  payload TEXT,
  version INTEGER,
  updated_at INTEGER
);
