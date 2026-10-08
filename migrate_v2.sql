-- Jalankan hanya SATU KALI pada database yang sudah ada (schema.sql versi lama).
ALTER TABLE donations ADD COLUMN recipient_user_id INTEGER;
ALTER TABLE donations ADD COLUMN connection_id TEXT;
ALTER TABLE donations ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE donations ADD COLUMN verification TEXT;
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
CREATE INDEX IF NOT EXISTS idx_donations_recipient ON donations(recipient_user_id,state,created_at);
