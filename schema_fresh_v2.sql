-- Gunakan untuk database BARU, bukan database lama.
CREATE TABLE IF NOT EXISTS connections (
  user_id INTEGER PRIMARY KEY,
  connection_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  token_last4 TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  verification TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  verified_at INTEGER,
  last_webhook_at INTEGER
);
CREATE TABLE IF NOT EXISTS donations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'sociabuzz',
  username TEXT NOT NULL,
  amount INTEGER NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'IDR',
  created_at INTEGER NOT NULL,
  created_at_iso TEXT NOT NULL,
  raw_hash TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'queued',
  lease_token TEXT,
  lease_until INTEGER,
  leased_by TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER,
  recipient_user_id INTEGER,
  connection_id TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  verification TEXT
);
CREATE INDEX IF NOT EXISTS idx_donations_queue ON donations(state,lease_until,attempts,created_at);
CREATE INDEX IF NOT EXISTS idx_donations_recipient ON donations(recipient_user_id,state,created_at);
CREATE INDEX IF NOT EXISTS idx_donations_created ON donations(created_at DESC);
