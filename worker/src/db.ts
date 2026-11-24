/** D1 schema, settings storage and shared data helpers. */

import {
  DEFAULT_SETTINGS,
  SERVICE_CATALOGUE,
  validateTiers,
  type ArcadeSettings,
  type Tier,
} from '../../shared/arcade';
import type { D1Database } from './types';

/**
 * Every statement is idempotent, so the Worker can guarantee its own schema on
 * the first request after a deployment (Sites provisions an empty database).
 * The same statements live in migrations/0001_init.sql for manual/remote runs.
 */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS players (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL,
     phone TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS players_email_idx ON players (lower(email))`,

  `CREATE TABLE IF NOT EXISTS game_sessions (
     id TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     finished_at INTEGER,
     status TEXT NOT NULL DEFAULT 'active',
     hits INTEGER NOT NULL DEFAULT 0,
     score INTEGER NOT NULL DEFAULT 0,
     duration_ms INTEGER,
     last_event_ms INTEGER NOT NULL DEFAULT 0,
     last_seen_at INTEGER NOT NULL,
     suspicious INTEGER NOT NULL DEFAULT 0,
     suspicion_reasons TEXT,
     ip_hash TEXT,
     user_agent TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS game_sessions_started_idx ON game_sessions (started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS game_sessions_status_idx ON game_sessions (status, started_at DESC)`,

  `CREATE TABLE IF NOT EXISTS game_events (
     session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     t_ms INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (session_id, seq)
   )`,

  `CREATE TABLE IF NOT EXISTS reward_claims (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL UNIQUE REFERENCES game_sessions(id),
     player_id TEXT NOT NULL REFERENCES players(id),
     score INTEGER NOT NULL,
     discount INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     note TEXT,
     created_at INTEGER NOT NULL,
     reviewed_at INTEGER,
     reviewed_by TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS reward_claims_status_idx ON reward_claims (status, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS coupons (
     id TEXT PRIMARY KEY,
     code TEXT NOT NULL UNIQUE,
     claim_id TEXT REFERENCES reward_claims(id),
     player_id TEXT NOT NULL REFERENCES players(id),
     session_id TEXT REFERENCES game_sessions(id),
     discount INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     issued_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     valid_days INTEGER NOT NULL,
     min_project_value INTEGER NOT NULL DEFAULT 0,
     max_uses INTEGER NOT NULL DEFAULT 1,
     uses INTEGER NOT NULL DEFAULT 0,
     eligible_services TEXT,
     revoked_at INTEGER,
     revoked_reason TEXT,
     created_by TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS coupons_status_idx ON coupons (status, issued_at DESC)`,
  `CREATE INDEX IF NOT EXISTS coupons_player_idx ON coupons (player_id)`,

  `CREATE TABLE IF NOT EXISTS redemptions (
     id TEXT PRIMARY KEY,
     coupon_id TEXT NOT NULL UNIQUE REFERENCES coupons(id),
     player_id TEXT NOT NULL REFERENCES players(id),
     service TEXT NOT NULL,
     original_amount INTEGER NOT NULL,
     discount INTEGER NOT NULL,
     discount_amount INTEGER NOT NULL,
     final_amount INTEGER NOT NULL,
     reference TEXT,
     redeemed_at INTEGER NOT NULL,
     recorded_by TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     updated_by TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS admin_notes (
     id TEXT PRIMARY KEY,
     subject_type TEXT NOT NULL,
     subject_id TEXT NOT NULL,
     admin_email TEXT NOT NULL,
     body TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS admin_notes_subject_idx ON admin_notes (subject_type, subject_id)`,

  `CREATE TABLE IF NOT EXISTS audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     admin_email TEXT NOT NULL,
     action TEXT NOT NULL,
     target_type TEXT NOT NULL,
     target_id TEXT NOT NULL,
     detail TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS admin_sessions (
     id TEXT PRIMARY KEY,
     admin_email TEXT NOT NULL,
     csrf TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     revoked INTEGER NOT NULL DEFAULT 0,
     ip_hash TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions (expires_at)`,

  `CREATE TABLE IF NOT EXISTS rate_limits (
     bucket TEXT PRIMARY KEY,
     window_start INTEGER NOT NULL,
     count INTEGER NOT NULL
   )`,
];

let schemaReady: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = db
      .batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)))
      .then(() => undefined)
      .catch((error) => {
        schemaReady = null;
        throw error;
      });
  }
  return schemaReady;
}

/* ----------------------------------------------------------------- settings */

function coerceSettings(raw: unknown): ArcadeSettings {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<ArcadeSettings>;
  const tiers = validateTiers(input.tiers) === null ? (input.tiers as Tier[]) : DEFAULT_SETTINGS.tiers;
  const difficulty =
    input.difficulty === 'relaxed' || input.difficulty === 'challenging' ? input.difficulty : 'standard';

  const eligible = Array.isArray(input.eligibleServices)
    ? input.eligibleServices.filter(
        (service): service is string =>
          typeof service === 'string' && (SERVICE_CATALOGUE as readonly string[]).includes(service),
      )
    : DEFAULT_SETTINGS.eligibleServices;

  const clampInt = (value: unknown, min: number, max: number, fallback: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
      ? value
      : fallback;

  return {
    arcadeEnabled: typeof input.arcadeEnabled === 'boolean' ? input.arcadeEnabled : true,
    claimsEnabled: typeof input.claimsEnabled === 'boolean' ? input.claimsEnabled : true,
    difficulty,
    couponValidDays: clampInt(input.couponValidDays, 1, 90, 7),
    minProjectValue: clampInt(input.minProjectValue, 0, 100_000_000, 0),
    maxCouponUses: clampInt(input.maxCouponUses, 1, 5, 1),
    tiers,
    eligibleServices: eligible.length ? eligible : DEFAULT_SETTINGS.eligibleServices,
  };
}

export async function getSettings(db: D1Database): Promise<ArcadeSettings> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('arcade').first<{
    value: string;
  }>();
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return coerceSettings(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(
  db: D1Database,
  settings: ArcadeSettings,
  adminEmail: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('arcade', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(JSON.stringify(settings), Date.now(), adminEmail)
    .run();
}

export function coerceIncomingSettings(raw: unknown): ArcadeSettings {
  return coerceSettings(raw);
}

/* ------------------------------------------------------------------ players */

export interface PlayerInput {
  name: string;
  email: string;
  phone?: string | null;
}

export interface PlayerRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  created_at: number;
  updated_at: number;
}

/** Finds a player by email or creates one. Email is unique (case-insensitive). */
export async function upsertPlayer(
  db: D1Database,
  input: PlayerInput,
  now = Date.now(),
): Promise<PlayerRow> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  const phone = input.phone?.trim() || null;

  const existing = await db
    .prepare('SELECT * FROM players WHERE lower(email) = ?')
    .bind(email)
    .first<PlayerRow>();

  if (existing) {
    await db
      .prepare(
        `UPDATE players SET name = ?, phone = COALESCE(?, phone), updated_at = ?
         WHERE id = ?`,
      )
      .bind(name, phone, now, existing.id)
      .run();
    return { ...existing, name, phone: phone ?? existing.phone, updated_at: now };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO players (id, name, email, phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, name, email, phone, now, now)
    .run();
  return { id, name, email, phone, created_at: now, updated_at: now };
}

/* -------------------------------------------------------------------- audit */

export async function writeAudit(
  db: D1Database,
  entry: {
    adminEmail: string;
    action: string;
    targetType: string;
    targetId: string;
    detail?: unknown;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (admin_email, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entry.adminEmail,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.detail === undefined ? null : JSON.stringify(entry.detail).slice(0, 2000),
      Date.now(),
    )
    .run();
}

/* ------------------------------------------------------------------- expiry */

/** Coupons past their expiry date are marked expired before they are read. */
export async function expireCoupons(db: D1Database, now = Date.now()): Promise<void> {
  await db
    .prepare(
      `UPDATE coupons SET status = 'expired'
       WHERE status IN ('pending', 'active') AND expires_at <= ?`,
    )
    .bind(now)
    .run();
}
