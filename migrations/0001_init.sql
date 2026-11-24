-- CODE BUILTS ARCADE — initial schema (SQLite / Cloudflare D1)
-- Applied automatically (idempotently) by the Worker on first request, and
-- available here for manual runs:
--   npx wrangler d1 execute code-builts-arcade --local --file=migrations/0001_init.sql
--   npx wrangler d1 execute code-builts-arcade --remote --file=migrations/0001_init.sql

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS players_email_idx ON players (lower(email));

CREATE TABLE IF NOT EXISTS game_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',        -- active | finished | flagged | expired
  hits INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  last_event_ms INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  suspicious INTEGER NOT NULL DEFAULT 0,
  suspicion_reasons TEXT,
  ip_hash TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS game_sessions_started_idx ON game_sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS game_sessions_status_idx ON game_sessions (status, started_at DESC);

CREATE TABLE IF NOT EXISTS game_events (
  session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  t_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS reward_claims (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES game_sessions(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  score INTEGER NOT NULL,
  discount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | verified | rejected
  note TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT
);
CREATE INDEX IF NOT EXISTS reward_claims_status_idx ON reward_claims (status, created_at DESC);

CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  claim_id TEXT REFERENCES reward_claims(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  session_id TEXT REFERENCES game_sessions(id),
  discount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | active | redeemed | expired | revoked
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  valid_days INTEGER NOT NULL,
  min_project_value INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  eligible_services TEXT,
  revoked_at INTEGER,
  revoked_reason TEXT,
  created_by TEXT                                -- admin email for manual coupons, NULL for game
);
CREATE INDEX IF NOT EXISTS coupons_status_idx ON coupons (status, issued_at DESC);
CREATE INDEX IF NOT EXISTS coupons_player_idx ON coupons (player_id);

CREATE TABLE IF NOT EXISTS redemptions (
  id TEXT PRIMARY KEY,
  coupon_id TEXT NOT NULL UNIQUE REFERENCES coupons(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  service TEXT NOT NULL,
  original_amount INTEGER NOT NULL,              -- whole rupees
  discount INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL,
  final_amount INTEGER NOT NULL,
  reference TEXT,
  redeemed_at INTEGER NOT NULL,
  recorded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS admin_notes (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_notes_subject_idx ON admin_notes (subject_type, subject_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_email TEXT NOT NULL,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
