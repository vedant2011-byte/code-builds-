/**
 * Private admin API. Every route below requires a valid signed session cookie
 * backed by a row in D1, same-origin mutations and an explicit CSRF header.
 * Nothing here is reachable from the public site without that cookie.
 */

import {
  DEFAULT_SETTINGS,
  SERVICE_CATALOGUE,
  validateTiers,
  type ArcadeSettings,
} from '../../shared/arcade';
import {
  isValidEmail,
  normalizeEmail,
  randomCode,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  verifyPassword,
} from './crypto';
import { coerceIncomingSettings, expireCoupons, getSettings, saveSettings, upsertPlayer, writeAudit } from './db';
import {
  HttpError,
  apiError,
  buildCookie,
  clientIp,
  csvResponse,
  isSameOrigin,
  json,
  parseCookie,
  rateLimit,
  readJson,
} from './http';
import type { Env } from './types';

const COOKIE_NAME = 'cb_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;
const CSRF_HEADER = 'x-cb-request';

interface AdminSession {
  id: string;
  email: string;
  csrf: string;
  expiresAt: number;
}

interface ClaimRow {
  id: string;
  session_id: string;
  player_id: string;
  score: number;
  discount: number;
  status: string;
  note: string | null;
  created_at: number;
  reviewed_at: number | null;
  reviewed_by: string | null;
}

interface CouponRow {
  id: string;
  code: string;
  claim_id: string | null;
  player_id: string;
  session_id: string | null;
  discount: number;
  status: string;
  issued_at: number;
  expires_at: number;
  valid_days: number;
  min_project_value: number;
  max_uses: number;
  uses: number;
  eligible_services: string | null;
  revoked_at: number | null;
  revoked_reason: string | null;
  created_by: string | null;
}

/* ------------------------------------------------------------------- guards */

function allowedOrigins(env: Env): string[] {
  return (env.APP_ORIGIN ?? '').split(',');
}

function assertMutation(request: Request, env: Env): void {
  if (!isSameOrigin(request, allowedOrigins(env))) {
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Cross-site admin requests are refused.');
  }
  if (request.headers.get(CSRF_HEADER) !== '1') {
    throw new HttpError(403, 'CSRF_HEADER_MISSING', 'This request was blocked by CSRF protection.');
  }
}

function requireConfig(env: Env): { adminEmail: string; secret: string; passwordHash: string } {
  const adminEmail = env.ADMIN_EMAIL?.trim();
  const secret = env.SESSION_SECRET?.trim();
  const passwordHash = env.ADMIN_PASSWORD_HASH?.trim();
  if (!adminEmail || !secret || !passwordHash) {
    throw new HttpError(
      503,
      'ADMIN_NOT_CONFIGURED',
      'The admin portal is not configured yet. Set ADMIN_EMAIL, ADMIN_PASSWORD_HASH and SESSION_SECRET.',
    );
  }
  return { adminEmail: normalizeEmail(adminEmail), secret, passwordHash };
}

async function requireAdmin(request: Request, env: Env): Promise<AdminSession> {
  const { secret, adminEmail } = requireConfig(env);
  const raw = parseCookie(request.headers.get('cookie'), COOKIE_NAME);
  if (!raw) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in to continue.');

  const [sid, expRaw, signature] = raw.split('.');
  if (!sid || !expRaw || !signature) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in to continue.');

  const expected = await sha256Hex(`${secret}:${sid}.${expRaw}`);
  if (!timingSafeEqual(expected, signature)) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Your session is no longer valid.');
  }

  const expiresAt = Number(expRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    throw new HttpError(401, 'SESSION_EXPIRED', 'Your session expired. Sign in again.');
  }

  const row = await env.DB.prepare(
    'SELECT id, admin_email, csrf, expires_at, revoked FROM admin_sessions WHERE id = ?',
  )
    .bind(sid)
    .first<{ id: string; admin_email: string; csrf: string; expires_at: number; revoked: number }>();

  if (!row || row.revoked === 1 || row.expires_at < Date.now() || row.admin_email !== adminEmail) {
    throw new HttpError(401, 'SESSION_INVALID', 'Your session is no longer valid. Sign in again.');
  }

  return { id: row.id, email: row.admin_email, csrf: row.csrf, expiresAt: row.expires_at };
}

/* -------------------------------------------------------------------- login */

async function login(request: Request, env: Env): Promise<Response> {
  assertMutation(request, env);
  const { adminEmail, secret, passwordHash } = requireConfig(env);
  const body = await readJson<{ email?: unknown; password?: unknown }>(request);
  const email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password) throw new HttpError(400, 'INVALID_CREDENTIALS', 'Enter your email and password.');

  const ip = sha256Hex(`${secret}:${clientIp(request)}`);
  const ipKey = await ip;
  const ipLimit = await rateLimit(env.DB, `admin:login:ip:${ipKey}`, 10, 15 * 60 * 1000);
  const emailLimit = await rateLimit(env.DB, `admin:login:email:${email}`, 6, 15 * 60 * 1000);
  if (!ipLimit.allowed || !emailLimit.allowed) {
    return apiError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Wait 15 minutes and try again.');
  }

  const emailOk = timingSafeEqual(email, adminEmail);
  const passwordOk = await verifyPassword(password, passwordHash);

  if (!emailOk || !passwordOk) {
    await writeAudit(env.DB, {
      adminEmail: email.slice(0, 80) || 'unknown',
      action: 'admin.login_failed',
      targetType: 'admin',
      targetId: email.slice(0, 80) || 'unknown',
      detail: { ipHash: ipKey },
    });
    // Same message either way: do not reveal which half was wrong.
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Those credentials were not accepted.');
  }

  const sid = crypto.randomUUID();
  const csrf = randomToken(18);
  const expiresAt = Date.now() + SESSION_MS;

  await env.DB.prepare(
    `INSERT INTO admin_sessions (id, admin_email, csrf, created_at, expires_at, revoked, ip_hash)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(sid, adminEmail, csrf, Date.now(), expiresAt, ipKey)
    .run();

  await writeAudit(env.DB, {
    adminEmail,
    action: 'admin.login',
    targetType: 'admin',
    targetId: adminEmail,
    detail: { ipHash: ipKey },
  });

  const cookieValue = `${sid}.${expiresAt}.${await sha256Hex(`${secret}:${sid}.${expiresAt}`)}`;
  const secure = new URL(request.url).protocol === 'https:';

  return json(
    { email: adminEmail, expiresAt, csrf },
    200,
    { 'set-cookie': buildCookie(COOKIE_NAME, cookieValue, { maxAge: SESSION_MS / 1000, secure }) },
  );
}

async function logout(request: Request, env: Env): Promise<Response> {
  const session = await requireAdmin(request, env);
  assertMutation(request, env);
  await env.DB.prepare('UPDATE admin_sessions SET revoked = 1 WHERE id = ?').bind(session.id).run();
  await writeAudit(env.DB, {
    adminEmail: session.email,
    action: 'admin.logout',
    targetType: 'admin',
    targetId: session.email,
  });
  const secure = new URL(request.url).protocol === 'https:';
  return json(
    { ok: true },
    200,
    { 'set-cookie': buildCookie(COOKIE_NAME, '', { maxAge: 0, secure }) },
  );
}

/* ---------------------------------------------------------------- utilities */

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function paginate(url: URL): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Math.floor(num(url.searchParams.get('page'), 1)));
  const pageSize = Math.min(100, Math.max(5, Math.floor(num(url.searchParams.get('pageSize'), 25))));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function like(value: string): string {
  return `%${value.replace(/[%_]/g, (match) => `\\${match}`)}%`;
}

function intParam(url: URL, name: string, allowed: number[]): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '' || raw === 'all') return null;
  const value = Number(raw);
  return allowed.includes(value) ? value : null;
}

function iso(ms: number | null | undefined): string {
  if (!ms) return '';
  return new Date(Number(ms)).toISOString();
}

function parseServices(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------- overview */

async function overview(env: Env, url: URL): Promise<Response> {
  const days = Math.min(90, Math.max(7, Math.floor(num(url.searchParams.get('days'), 30))));
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  await expireCoupons(env.DB);

  const results = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) AS in_range,
              SUM(CASE WHEN status = 'finished' THEN 1 ELSE 0 END) AS finished,
              SUM(CASE WHEN status = 'flagged' THEN 1 ELSE 0 END) AS flagged,
              SUM(CASE WHEN status = 'active' AND expires_at > ? THEN 1 ELSE 0 END) AS live,
              COALESCE(MAX(score), 0) AS best_score
       FROM game_sessions`,
    ).bind(since, Date.now()),
    env.DB.prepare('SELECT COUNT(*) AS total FROM players'),
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
       FROM reward_claims`,
    ),
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed,
              SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
              SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked,
              SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) * 1.0 AS redeemed_count
       FROM coupons`,
    ),
    env.DB.prepare(
      `SELECT discount, COUNT(*) AS count, SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed
       FROM coupons GROUP BY discount ORDER BY discount DESC`,
    ),
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(discount_amount), 0) AS discount_total,
              COALESCE(SUM(original_amount), 0) AS gross_total,
              COALESCE(SUM(final_amount), 0) AS net_total
       FROM redemptions`,
    ),
    env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS sessions,
              SUM(CASE WHEN status = 'flagged' THEN 1 ELSE 0 END) AS flagged
       FROM game_sessions WHERE started_at >= ? GROUP BY day ORDER BY day ASC`,
    ).bind(since),
    env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS claims
       FROM reward_claims WHERE created_at >= ? GROUP BY day ORDER BY day ASC`,
    ).bind(since),
    env.DB.prepare(
      `SELECT s.id, s.score, s.started_at, s.duration_ms, c.discount,
              p.name, p.email
       FROM game_sessions s
       LEFT JOIN reward_claims c ON c.session_id = s.id
       LEFT JOIN players p ON p.id = c.player_id
       WHERE s.status = 'finished'
       ORDER BY s.score DESC, s.started_at DESC LIMIT 8`,
    ),
    env.DB.prepare(
      `SELECT c.code, c.discount, c.status, c.issued_at, p.name, p.email
       FROM coupons c JOIN players p ON p.id = c.player_id
       ORDER BY c.issued_at DESC LIMIT 8`,
    ),
  ]);

  const sessionStats = (results[0].results[0] ?? {}) as Record<string, unknown>;
  const playerStats = (results[1].results[0] ?? {}) as Record<string, unknown>;
  const claimStats = (results[2].results[0] ?? {}) as Record<string, unknown>;
  const couponStats = (results[3].results[0] ?? {}) as Record<string, unknown>;
  const tierRows = results[4].results as { discount: number; count: number; redeemed: number }[];
  const redemptionStats = (results[5].results[0] ?? {}) as Record<string, unknown>;
  const sessionSeries = results[6].results as { day: string; sessions: number; flagged: number }[];
  const claimSeries = results[7].results as { day: string; claims: number }[];
  const topScores = results[8].results;
  const recentCoupons = results[9].results;

  const claimsByDay = new Map(claimSeries.map((row) => [row.day, num(row.claims)]));
  const series = sessionSeries.map((row) => ({
    day: row.day,
    sessions: num(row.sessions),
    flagged: num(row.flagged),
    claims: claimsByDay.get(row.day) ?? 0,
  }));

  const couponsIssued = num(couponStats.total);
  const redeemed = num(couponStats.redeemed);

  return json({
    rangeDays: days,
    generatedAt: Date.now(),
    sessions: {
      total: num(sessionStats.total),
      inRange: num(sessionStats.in_range),
      finished: num(sessionStats.finished),
      flagged: num(sessionStats.flagged),
      live: num(sessionStats.live),
      bestScore: num(sessionStats.best_score),
    },
    players: { total: num(playerStats.total) },
    claims: {
      total: num(claimStats.total),
      pending: num(claimStats.pending),
      verified: num(claimStats.verified),
      rejected: num(claimStats.rejected),
    },
    coupons: {
      total: couponsIssued,
      active: num(couponStats.active),
      pending: num(couponStats.pending),
      redeemed,
      expired: num(couponStats.expired),
      revoked: num(couponStats.revoked),
      redemptionRate: couponsIssued ? Math.round((redeemed / couponsIssued) * 1000) / 10 : 0,
      byDiscount: tierRows.map((row) => ({
        discount: num(row.discount),
        issued: num(row.count),
        redeemed: num(row.redeemed),
      })),
    },
    redemptions: {
      total: num(redemptionStats.total),
      discountTotal: num(redemptionStats.discount_total),
      grossTotal: num(redemptionStats.gross_total),
      netTotal: num(redemptionStats.net_total),
    },
    series,
    topScores,
    recentCoupons,
  });
}

/* ------------------------------------------------------------- sessions list */

async function listSessions(env: Env, url: URL): Promise<Response> {
  const { page, pageSize, offset } = paginate(url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const status = url.searchParams.get('status') ?? 'all';
  const where: string[] = [];
  const bindings: unknown[] = [];

  if (q) {
    where.push('(s.id LIKE ? ESCAPE \'\\\' OR s.ip_hash LIKE ? ESCAPE \'\\\')');
    bindings.push(like(q), like(q));
  }
  if (['active', 'finished', 'flagged', 'expired'].includes(status)) {
    where.push('s.status = ?');
    bindings.push(status);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, total] = await env.DB.batch([
    env.DB.prepare(
      `SELECT s.id, s.status, s.hits, s.score, s.duration_ms, s.started_at, s.finished_at,
              s.suspicious, s.suspicion_reasons, s.expires_at,
              c.id AS claim_id, c.discount AS claim_discount,
              p.name, p.email, cp.code
       FROM game_sessions s
       LEFT JOIN reward_claims c ON c.session_id = s.id
       LEFT JOIN players p ON p.id = c.player_id
       LEFT JOIN coupons cp ON cp.claim_id = c.id
       ${clause}
       ORDER BY s.started_at DESC LIMIT ? OFFSET ?`,
    ).bind(...bindings, pageSize, offset),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM game_sessions s ${clause}`).bind(...bindings),
  ]);

  const totalRows = num((total.results[0] as { total?: number } | undefined)?.total);
  return json({
    rows: rows.results,
    page,
    pageSize,
    total: totalRows,
    pages: Math.max(1, Math.ceil(totalRows / pageSize)),
  });
}

/* ---------------------------------------------------------------- players */

async function listPlayers(env: Env, url: URL): Promise<Response> {
  const { page, pageSize, offset } = paginate(url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const clause = q ? 'WHERE p.name LIKE ? ESCAPE \'\\\' OR p.email LIKE ? ESCAPE \'\\\'' : '';
  const bindings = q ? [like(q), like(q)] : [];

  const [rows, total] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.id, p.name, p.email, p.phone, p.created_at,
              COUNT(DISTINCT c.id) AS claims,
              COUNT(DISTINCT cp.id) AS coupons,
              COALESCE(MAX(s.score), 0) AS best_score
       FROM players p
       LEFT JOIN reward_claims c ON c.player_id = p.id
       LEFT JOIN coupons cp ON cp.player_id = p.id
       LEFT JOIN game_sessions s ON s.id = c.session_id
       ${clause}
       GROUP BY p.id
       ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    ).bind(...bindings, pageSize, offset),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM players p ${clause}`).bind(...bindings),
  ]);

  const totalRows = num((total.results[0] as { total?: number } | undefined)?.total);
  return json({
    rows: rows.results,
    page,
    pageSize,
    total: totalRows,
    pages: Math.max(1, Math.ceil(totalRows / pageSize)),
  });
}

/* ----------------------------------------------------------------- claims */

const CLAIM_FILTERS = ['pending', 'verified', 'rejected'];
const COUPON_FILTERS = ['pending', 'active', 'redeemed', 'expired', 'revoked'];

async function listClaims(env: Env, url: URL): Promise<Response> {
  const { page, pageSize, offset } = paginate(url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const status = url.searchParams.get('status') ?? 'all';
  const discount = intParam(url, 'discount', [2, 5, 7, 10]);
  const couponState = url.searchParams.get('coupon') ?? 'all';
  const sort = url.searchParams.get('sort') ?? 'recent';

  const where: string[] = [];
  const bindings: unknown[] = [];

  if (q) {
    where.push(
      "(p.name LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\' OR p.phone LIKE ? ESCAPE '\\' OR cp.code LIKE ? ESCAPE '\\' OR c.session_id LIKE ? ESCAPE '\\')",
    );
    bindings.push(like(q), like(q), like(q), like(q), like(q));
  }
  if (CLAIM_FILTERS.includes(status)) {
    where.push('c.status = ?');
    bindings.push(status);
  }
  if (COUPON_FILTERS.includes(couponState)) {
    where.push('cp.status = ?');
    bindings.push(couponState);
  }
  if (discount !== null) {
    where.push('c.discount = ?');
    bindings.push(discount);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order =
    sort === 'score'
      ? 'c.score DESC, c.created_at DESC'
      : sort === 'expiry'
        ? 'cp.expires_at ASC'
        : sort === 'name'
          ? 'p.name ASC'
          : 'c.created_at DESC';

  const [rows, total] = await env.DB.batch([
    env.DB.prepare(
      `SELECT c.id, c.session_id, c.score, c.discount, c.status, c.note, c.created_at,
              c.reviewed_at, c.reviewed_by,
              p.id AS player_id, p.name, p.email, p.phone, p.created_at AS player_since,
              cp.id AS coupon_id, cp.code, cp.status AS coupon_status, cp.issued_at, cp.expires_at,
              cp.min_project_value, cp.uses, cp.max_uses,
              s.duration_ms, s.status AS session_status, s.suspicious, s.started_at, s.hits,
              r.id AS redemption_id, r.discount_amount, r.final_amount
       FROM reward_claims c
       JOIN players p ON p.id = c.player_id
       LEFT JOIN coupons cp ON cp.claim_id = c.id
       LEFT JOIN game_sessions s ON s.id = c.session_id
       LEFT JOIN redemptions r ON r.coupon_id = cp.id
       ${clause}
       ORDER BY ${order} LIMIT ? OFFSET ?`,
    ).bind(...bindings, pageSize, offset),
    env.DB.prepare(
      `SELECT COUNT(*) AS total FROM reward_claims c
       JOIN players p ON p.id = c.player_id
       LEFT JOIN coupons cp ON cp.claim_id = c.id
       ${clause}`,
    ).bind(...bindings),
  ]);

  const totalRows = num((total.results[0] as { total?: number } | undefined)?.total);
  return json({
    rows: rows.results,
    page,
    pageSize,
    total: totalRows,
    pages: Math.max(1, Math.ceil(totalRows / pageSize)),
  });
}

async function claimDetail(env: Env, claimId: string): Promise<Response> {
  const claim = await env.DB.prepare('SELECT * FROM reward_claims WHERE id = ?').bind(claimId).first<ClaimRow>();
  if (!claim) throw new HttpError(404, 'NOT_FOUND', 'That claim does not exist.');

  const results = await env.DB.batch([
    env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(claim.player_id),
    env.DB.prepare('SELECT * FROM game_sessions WHERE id = ?').bind(claim.session_id),
    env.DB.prepare('SELECT * FROM coupons WHERE claim_id = ?').bind(claim.id),
    env.DB.prepare(
      `SELECT COUNT(*) AS events, COALESCE(MIN(t_ms), 0) AS first_ms, COALESCE(MAX(t_ms), 0) AS last_ms
       FROM game_events WHERE session_id = ?`,
    ).bind(claim.session_id),
    env.DB.prepare(
      `SELECT c.id, c.score, c.discount, c.status, c.created_at, c.session_id, cp.code, cp.status AS coupon_status
       FROM reward_claims c LEFT JOIN coupons cp ON cp.claim_id = c.id
       WHERE c.player_id = ? ORDER BY c.created_at DESC LIMIT 10`,
    ).bind(claim.player_id),
    env.DB.prepare(
      `SELECT id, admin_email, body, created_at FROM admin_notes
       WHERE subject_type = 'claim' AND subject_id = ? ORDER BY created_at DESC`,
    ).bind(claim.id),
  ]);

  const session = (results[1].results[0] ?? null) as Record<string, unknown> | null;
  const coupon = (results[2].results[0] ?? null) as unknown as CouponRow | null;
  const eventStats = (results[3].results[0] ?? {}) as Record<string, unknown>;

  let redemption: Record<string, unknown> | null = null;
  if (coupon) {
    redemption =
      (await env.DB.prepare('SELECT * FROM redemptions WHERE coupon_id = ?')
        .bind(coupon.id)
        .first<Record<string, unknown>>()) ?? null;
  }

  const auditWhere = coupon
    ? `(target_type = 'claim' AND target_id = ?) OR (target_type = 'coupon' AND target_id = ?)`
    : `target_type = 'claim' AND target_id = ?`;
  const audit = await env.DB.prepare(
    `SELECT id, admin_email, action, target_type, target_id, detail, created_at
     FROM audit_log WHERE ${auditWhere} ORDER BY created_at DESC LIMIT 25`,
  )
    .bind(...(coupon ? [claim.id, coupon.id] : [claim.id]))
    .all();

  return json({
    claim,
    player: results[0].results[0] ?? null,
    session,
    events: {
      count: num(eventStats.events),
      firstMs: num(eventStats.first_ms),
      lastMs: num(eventStats.last_ms),
    },
    coupon,
    redemption,
    history: results[4].results,
    notes: results[5].results,
    audit: audit.results,
  });
}

async function reviewClaim(
  request: Request,
  env: Env,
  session: AdminSession,
  claimId: string,
  decision: 'verified' | 'rejected',
): Promise<Response> {
  const body = await readJson<{ note?: unknown }>(request);
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';
  if (decision === 'rejected' && note.length < 3) {
    throw new HttpError(400, 'REASON_REQUIRED', 'Add a short reason so the decision is auditable.');
  }

  const claim = await env.DB.prepare('SELECT * FROM reward_claims WHERE id = ?').bind(claimId).first<ClaimRow>();
  if (!claim) throw new HttpError(404, 'NOT_FOUND', 'That claim does not exist.');

  const coupon = await env.DB.prepare('SELECT * FROM coupons WHERE claim_id = ?')
    .bind(claim.id)
    .first<CouponRow>();

  const now = Date.now();

  if (decision === 'verified') {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE reward_claims SET status = 'verified', reviewed_at = ?, reviewed_by = ?,
           note = CASE WHEN ? = '' THEN note ELSE ? END WHERE id = ?`,
      ).bind(now, session.email, note, note, claim.id),
      env.DB.prepare(
        `UPDATE coupons SET status = CASE
            WHEN status IN ('revoked', 'redeemed') THEN status
            WHEN expires_at <= ? THEN 'expired'
            ELSE 'active' END
         WHERE claim_id = ?`,
      ).bind(now, claim.id),
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE reward_claims SET status = 'rejected', reviewed_at = ?, reviewed_by = ?,
           note = CASE WHEN ? = '' THEN note ELSE ? END WHERE id = ?`,
      ).bind(now, session.email, note, note, claim.id),
      env.DB.prepare(
        `UPDATE coupons SET status = 'revoked', revoked_at = ?, revoked_reason = ?
         WHERE claim_id = ? AND status != 'redeemed'`,
      ).bind(now, `Rejected claim: ${note}`.slice(0, 500), claim.id),
    ]);
  }

  await writeAudit(env.DB, {
    adminEmail: session.email,
    action: decision === 'verified' ? 'claim.verify' : 'claim.reject',
    targetType: 'claim',
    targetId: claim.id,
    detail: { note: note || null, previousStatus: claim.status, couponId: coupon?.id ?? null },
  });

  return claimDetail(env, claim.id);
}

async function addNote(request: Request, env: Env, session: AdminSession, claimId: string): Promise<Response> {
  const body = await readJson<{ body?: unknown }>(request);
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (text.length < 2 || text.length > 2000) {
    throw new HttpError(400, 'INVALID_NOTE', 'Notes must be between 2 and 2000 characters.');
  }
  const claim = await env.DB.prepare('SELECT id FROM reward_claims WHERE id = ?').bind(claimId).first();
  if (!claim) throw new HttpError(404, 'NOT_FOUND', 'That claim does not exist.');

  await env.DB.prepare(
    `INSERT INTO admin_notes (id, subject_type, subject_id, admin_email, body, created_at)
     VALUES (?, 'claim', ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), claimId, session.email, text, Date.now())
    .run();

  await writeAudit(env.DB, {
    adminEmail: session.email,
    action: 'claim.note',
    targetType: 'claim',
    targetId: claimId,
    detail: { body: text.slice(0, 200) },
  });

  return claimDetail(env, claimId);
}

/* ---------------------------------------------------------------- coupons */

async function listCoupons(env: Env, url: URL): Promise<Response> {
  const { page, pageSize, offset } = paginate(url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const status = url.searchParams.get('status') ?? 'all';
  const discount = intParam(url, 'discount', [2, 5, 7, 10, 15, 20]);

  const where: string[] = [];
  const bindings: unknown[] = [];
  if (q) {
    where.push(
      "(cp.code LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\' OR cp.session_id LIKE ? ESCAPE '\\')",
    );
    bindings.push(like(q), like(q), like(q), like(q));
  }
  if (COUPON_FILTERS.includes(status)) {
    where.push('cp.status = ?');
    bindings.push(status);
  }
  if (discount !== null) {
    where.push('cp.discount = ?');
    bindings.push(discount);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  await expireCoupons(env.DB);

  const [rows, total] = await env.DB.batch([
    env.DB.prepare(
      `SELECT cp.*, p.name, p.email, p.phone,
              r.id AS redemption_id, r.original_amount, r.discount_amount, r.final_amount,
              r.redeemed_at, r.service, r.reference, r.recorded_by
       FROM coupons cp
       JOIN players p ON p.id = cp.player_id
       LEFT JOIN redemptions r ON r.coupon_id = cp.id
       ${clause}
       ORDER BY cp.issued_at DESC LIMIT ? OFFSET ?`,
    ).bind(...bindings, pageSize, offset),
    env.DB.prepare(
      `SELECT COUNT(*) AS total FROM coupons cp JOIN players p ON p.id = cp.player_id ${clause}`,
    ).bind(...bindings),
  ]);

  const totalRows = num((total.results[0] as { total?: number } | undefined)?.total);
  return json({
    rows: rows.results,
    page,
    pageSize,
    total: totalRows,
    pages: Math.max(1, Math.ceil(totalRows / pageSize)),
  });
}

async function createCoupon(request: Request, env: Env, session: AdminSession): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  const settings = await getSettings(env.DB);

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  const email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
  const phone = typeof body.phone === 'string' && body.phone.trim() ? body.phone.trim().slice(0, 32) : null;
  const discount = Math.floor(num(body.discount, Number.NaN));
  const validDays = Math.floor(num(body.validDays, settings.couponValidDays));
  const minProjectValue = Math.floor(num(body.minProjectValue, settings.minProjectValue));
  const maxUses = Math.floor(num(body.maxUses, 1));

  if (name.length < 2) throw new HttpError(400, 'INVALID_NAME', 'Enter the customer name.');
  if (!isValidEmail(email)) throw new HttpError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  if (!Number.isInteger(discount) || discount < 1 || discount > 100) {
    throw new HttpError(400, 'INVALID_DISCOUNT', 'Discount must be a whole percentage between 1 and 100.');
  }
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 90) {
    throw new HttpError(400, 'INVALID_VALIDITY', 'Validity must be between 1 and 90 days.');
  }
  if (!Number.isInteger(minProjectValue) || minProjectValue < 0 || minProjectValue > 100_000_000) {
    throw new HttpError(400, 'INVALID_MINIMUM', 'Minimum project value is not valid.');
  }
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 5) {
    throw new HttpError(400, 'INVALID_USES', 'Coupon usage must be between 1 and 5.');
  }

  let code = '';
  for (let attempt = 0; attempt < 6 && !code; attempt += 1) {
    const candidate = `CB-${discount}-${randomCode(6)}`;
    const taken = await env.DB.prepare('SELECT 1 FROM coupons WHERE code = ?').bind(candidate).first();
    if (!taken) code = candidate;
  }
  if (!code) throw new HttpError(503, 'CODE_UNAVAILABLE', 'Could not generate a unique coupon code.');

  const now = Date.now();
  const player = await upsertPlayer(env.DB, { name, email, phone }, now);
  const id = crypto.randomUUID();
  const expiresAt = now + validDays * 24 * 60 * 60 * 1000;

  await env.DB.prepare(
    `INSERT INTO coupons
       (id, code, claim_id, player_id, session_id, discount, status, issued_at, expires_at,
        valid_days, min_project_value, max_uses, uses, eligible_services, created_by)
     VALUES (?, ?, NULL, ?, NULL, ?, 'active', ?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      id,
      code,
      player.id,
      discount,
      now,
      expiresAt,
      validDays,
      minProjectValue,
      maxUses,
      JSON.stringify(settings.eligibleServices),
      session.email,
    )
    .run();

  await writeAudit(env.DB, {
    adminEmail: session.email,
    action: 'coupon.issue_manual',
    targetType: 'coupon',
    targetId: id,
    detail: { code, discount, email, validDays, minProjectValue, maxUses },
  });

  return json({ coupon: { id, code, discount, status: 'active', issuedAt: now, expiresAt } }, 201);
}

async function revokeCoupon(
  request: Request,
  env: Env,
  session: AdminSession,
  couponId: string,
): Promise<Response> {
  const body = await readJson<{ reason?: unknown }>(request);
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  if (reason.length < 3) throw new HttpError(400, 'REASON_REQUIRED', 'Add a short reason for the revocation.');

  const coupon = await env.DB.prepare('SELECT * FROM coupons WHERE id = ?').bind(couponId).first<CouponRow>();
  if (!coupon) throw new HttpError(404, 'NOT_FOUND', 'That coupon does not exist.');
  if (coupon.status === 'redeemed') {
    throw new HttpError(409, 'ALREADY_REDEEMED', 'This coupon has a recorded redemption and cannot be revoked.');
  }
  if (coupon.status === 'revoked') {
    return json({ coupon: { ...coupon, status: 'revoked' }, unchanged: true });
  }

  await env.DB.prepare(
    `UPDATE coupons SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE id = ?`,
  )
    .bind(Date.now(), reason, couponId)
    .run();

  await writeAudit(env.DB, {
    adminEmail: session.email,
    action: 'coupon.revoke',
    targetType: 'coupon',
    targetId: couponId,
    detail: { code: coupon.code, reason, previousStatus: coupon.status },
  });

  return json({ coupon: { ...coupon, status: 'revoked', revoked_reason: reason } });
}

async function redeemCoupon(
  request: Request,
  env: Env,
  session: AdminSession,
  couponId: string,
): Promise<Response> {
  const body = await readJson<{
    service?: unknown;
    originalAmount?: unknown;
    reference?: unknown;
  }>(request);

  const coupon = await env.DB.prepare('SELECT * FROM coupons WHERE id = ?').bind(couponId).first<CouponRow>();
  if (!coupon) throw new HttpError(404, 'NOT_FOUND', 'That coupon does not exist.');

  const now = Date.now();
  if (coupon.expires_at <= now) {
    await env.DB.prepare("UPDATE coupons SET status = 'expired' WHERE id = ?").bind(coupon.id).run();
    throw new HttpError(409, 'COUPON_EXPIRED', 'This coupon has expired.');
  }
  if (coupon.status === 'revoked') throw new HttpError(409, 'COUPON_REVOKED', 'This coupon was revoked.');
  if (coupon.status === 'redeemed' || coupon.uses >= coupon.max_uses) {
    throw new HttpError(409, 'COUPON_REDEEMED', 'This coupon has already been redeemed.');
  }
  if (coupon.status !== 'active' && coupon.status !== 'pending') {
    throw new HttpError(409, 'COUPON_NOT_ACTIVE', 'Only an active coupon can be redeemed.');
  }

  const eligible = parseServices(coupon.eligible_services);
  const service = typeof body.service === 'string' ? body.service.trim() : '';
  if (!service) throw new HttpError(400, 'SERVICE_REQUIRED', 'Choose the service that was purchased.');
  if (eligible.length && !eligible.includes(service)) {
    throw new HttpError(422, 'SERVICE_NOT_ELIGIBLE', 'That service is not covered by this coupon.');
  }

  const originalAmount = Math.floor(num(body.originalAmount, Number.NaN));
  if (!Number.isInteger(originalAmount) || originalAmount <= 0 || originalAmount > 100_000_000) {
    throw new HttpError(400, 'INVALID_AMOUNT', 'Enter the original project amount in whole rupees.');
  }
  if (originalAmount < coupon.min_project_value) {
    throw new HttpError(
      422,
      'BELOW_MINIMUM',
      `This coupon needs a project of at least ₹${coupon.min_project_value.toLocaleString('en-IN')}.`,
    );
  }

  const reference =
    typeof body.reference === 'string' ? body.reference.trim().slice(0, 120) : null;
  const discountAmount = Math.floor((originalAmount * coupon.discount) / 100);
  const finalAmount = originalAmount - discountAmount;
  const redemptionId = crypto.randomUUID();

  // The INSERT is guarded by the coupon's own state, and UNIQUE(coupon_id) makes
  // a second redemption impossible even under concurrent admin clicks.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO redemptions
         (id, coupon_id, player_id, service, original_amount, discount, discount_amount,
          final_amount, reference, redeemed_at, recorded_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM coupons
         WHERE id = ? AND status IN ('active', 'pending') AND uses < max_uses AND expires_at > ?
       )`,
    ).bind(
      redemptionId,
      coupon.id,
      coupon.player_id,
      service,
      originalAmount,
      coupon.discount,
      discountAmount,
      finalAmount,
      reference,
      now,
      session.email,
      now,
      coupon.id,
      now,
    ),
    env.DB.prepare(
      `UPDATE coupons SET uses = uses + 1,
         status = CASE WHEN uses + 1 >= max_uses THEN 'redeemed' ELSE status END
       WHERE id = ? AND status IN ('active', 'pending') AND uses < max_uses`,
    ).bind(coupon.id),
  ]);

  const redemption = await env.DB.prepare('SELECT * FROM redemptions WHERE coupon_id = ?')
    .bind(coupon.id)
    .first();

  if (!redemption) {
    await expireCoupons(env.DB);
    throw new HttpError(409, 'REDEMPTION_REFUSED', 'This coupon could not be redeemed. Refresh and check its status.');
  }

  await writeAudit(env.DB, {
    adminEmail: session.email,
    action: 'coupon.redeem',
    targetType: 'coupon',
    targetId: coupon.id,
    detail: {
      code: coupon.code,
      service,
      originalAmount,
      discount: coupon.discount,
      discountAmount,
      finalAmount,
      reference,
    },
  });

  return json({ redemption, coupon: { ...coupon, status: 'redeemed', uses: coupon.uses + 1 } }, 201);
}

async function listRedemptions(env: Env, url: URL): Promise<Response> {
  const { page, pageSize, offset } = paginate(url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const bindings: unknown[] = [];
  let clause = '';
  if (q) {
    clause = `WHERE cp.code LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR p.email LIKE ? ESCAPE '\\' OR r.reference LIKE ? ESCAPE '\\'`;
    bindings.push(like(q), like(q), like(q), like(q));
  }

  const [rows, total] = await env.DB.batch([
    env.DB.prepare(
      `SELECT r.*, cp.code, p.name, p.email, p.phone
       FROM redemptions r
       JOIN coupons cp ON cp.id = r.coupon_id
       JOIN players p ON p.id = r.player_id
       ${clause}
       ORDER BY r.redeemed_at DESC LIMIT ? OFFSET ?`,
    ).bind(...bindings, pageSize, offset),
    env.DB.prepare(
      `SELECT COUNT(*) AS total FROM redemptions r
       JOIN coupons cp ON cp.id = r.coupon_id JOIN players p ON p.id = r.player_id ${clause}`,
    ).bind(...bindings),
  ]);

  const totalRows = num((total.results[0] as { total?: number } | undefined)?.total);
  return json({
    rows: rows.results,
    page,
    pageSize,
    total: totalRows,
    pages: Math.max(1, Math.ceil(totalRows / pageSize)),
  });
}

/* --------------------------------------------------------------- settings */

async function settingsResponse(env: Env): Promise<Response> {
  const settings = await getSettings(env.DB);
  return json({ settings, defaults: DEFAULT_SETTINGS, catalogue: SERVICE_CATALOGUE });
}

async function updateSettings(request: Request, env: Env, session: AdminSession): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);

  if (body.tiers !== undefined) {
    const error = validateTiers(body.tiers);
    if (error) throw new HttpError(400, 'INVALID_TIERS', error);
  }
  if (body.eligibleServices !== undefined) {
    const list = body.eligibleServices;
    if (!Array.isArray(list) || list.length === 0) {
      throw new HttpError(400, 'INVALID_SERVICES', 'Choose at least one eligible service.');
    }
    for (const service of list) {
      if (typeof service !== 'string' || !(SERVICE_CATALOGUE as readonly string[]).includes(service)) {
        throw new HttpError(400, 'INVALID_SERVICES', 'One of those services is not in the catalogue.');
      }
    }
  }
  for (const [key, min, max] of [
    ['couponValidDays', 1, 90],
    ['minProjectValue', 0, 100_000_000],
    ['maxCouponUses', 1, 5],
  ] as const) {
    if (body[key] !== undefined) {
      const value = body[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new HttpError(400, 'INVALID_SETTING', `${key} must be a whole number between ${min} and ${max}.`);
      }
    }
  }

  const previous = await getSettings(env.DB);
  const next: ArcadeSettings = coerceIncomingSettings({ ...previous, ...body });

  await saveSettings(env.DB, next, session.email);
  await writeAudit(env.DB, {
    adminEmail: session.email,
    action: 'settings.update',
    targetType: 'settings',
    targetId: 'arcade',
    detail: { previous, next },
  });

  return json({ settings: next });
}

/* ------------------------------------------------------------------ audit */

async function listAudit(env: Env, url: URL): Promise<Response> {
  const { page, pageSize, offset } = paginate(url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const bindings: unknown[] = [];
  let clause = '';
  if (q) {
    clause = `WHERE admin_email LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR target_id LIKE ? ESCAPE '\\'`;
    bindings.push(like(q), like(q), like(q));
  }

  const [rows, total] = await env.DB.batch([
    env.DB.prepare(
      `SELECT * FROM audit_log ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).bind(...bindings, pageSize, offset),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM audit_log ${clause}`).bind(...bindings),
  ]);

  const totalRows = num((total.results[0] as { total?: number } | undefined)?.total);
  return json({
    rows: rows.results,
    page,
    pageSize,
    total: totalRows,
    pages: Math.max(1, Math.ceil(totalRows / pageSize)),
  });
}

/* -------------------------------------------------------------------- CSV */

async function exportCsv(env: Env, type: string): Promise<Response> {
  if (type === 'players') {
    const rows = await env.DB.prepare(
      `SELECT p.id, p.name, p.email, p.phone, p.created_at,
              COUNT(DISTINCT cp.id) AS coupons, COALESCE(MAX(s.score), 0) AS best_score
       FROM players p
       LEFT JOIN coupons cp ON cp.player_id = p.id
       LEFT JOIN reward_claims c ON c.player_id = p.id
       LEFT JOIN game_sessions s ON s.id = c.session_id
       GROUP BY p.id ORDER BY p.created_at DESC`,
    ).all<Record<string, unknown>>();
    return csvResponse('code-builts-players.csv', [
      ['Player ID', 'Name', 'Email', 'Phone', 'First seen', 'Coupons', 'Best score'],
      ...rows.results.map((row) => [
        String(row.id),
        String(row.name),
        String(row.email),
        row.phone ? String(row.phone) : '',
        iso(num(row.created_at)),
        num(row.coupons),
        num(row.best_score),
      ]),
    ]);
  }

  if (type === 'sessions') {
    const rows = await env.DB.prepare(
      `SELECT s.*, p.name, p.email FROM game_sessions s
       LEFT JOIN reward_claims c ON c.session_id = s.id
       LEFT JOIN players p ON p.id = c.player_id
       ORDER BY s.started_at DESC`,
    ).all<Record<string, unknown>>();
    return csvResponse('code-builts-sessions.csv', [
      ['Session ID', 'Status', 'Score', 'Hits', 'Duration (ms)', 'Started', 'Finished', 'Flagged', 'Reasons', 'Player', 'Email'],
      ...rows.results.map((row) => [
        String(row.id),
        String(row.status),
        num(row.score),
        num(row.hits),
        row.duration_ms === null ? '' : num(row.duration_ms),
        iso(num(row.started_at)),
        iso(row.finished_at === null ? null : num(row.finished_at)),
        num(row.suspicious) === 1 ? 'yes' : 'no',
        row.suspicion_reasons ? String(row.suspicion_reasons) : '',
        row.name ? String(row.name) : '',
        row.email ? String(row.email) : '',
      ]),
    ]);
  }

  if (type === 'winners' || type === 'claims') {
    const rows = await env.DB.prepare(
      `SELECT c.id, c.session_id, c.score, c.discount, c.status, c.created_at, c.reviewed_at, c.reviewed_by,
              p.name, p.email, p.phone, cp.code, cp.status AS coupon_status, cp.issued_at, cp.expires_at,
              cp.uses, cp.max_uses
       FROM reward_claims c
       JOIN players p ON p.id = c.player_id
       LEFT JOIN coupons cp ON cp.claim_id = c.id
       ORDER BY c.created_at DESC`,
    ).all<Record<string, unknown>>();
    return csvResponse('code-builts-winners.csv', [
      ['Claim ID', 'Player', 'Email', 'Phone', 'Score', 'Discount %', 'Coupon code', 'Coupon status',
        'Session ID', 'Played', 'Claimed', 'Expiry', 'Verification', 'Reviewed by', 'Reviewed at'],
      ...rows.results.map((row) => [
        String(row.id),
        String(row.name),
        String(row.email),
        row.phone ? String(row.phone) : '',
        num(row.score),
        num(row.discount),
        row.code ? String(row.code) : '',
        row.coupon_status ? String(row.coupon_status) : '',
        String(row.session_id),
        iso(row.created_at === null ? null : num(row.created_at)),
        iso(num(row.created_at)),
        iso(row.expires_at === null ? null : num(row.expires_at)),
        String(row.status),
        row.reviewed_by ? String(row.reviewed_by) : '',
        iso(row.reviewed_at === null ? null : num(row.reviewed_at)),
      ]),
    ]);
  }

  if (type === 'coupons') {
    const rows = await env.DB.prepare(
      `SELECT cp.*, p.name, p.email, r.redeemed_at, r.original_amount, r.discount_amount, r.final_amount
       FROM coupons cp JOIN players p ON p.id = cp.player_id
       LEFT JOIN redemptions r ON r.coupon_id = cp.id
       ORDER BY cp.issued_at DESC`,
    ).all<Record<string, unknown>>();
    return csvResponse('code-builts-coupons.csv', [
      ['Code', 'Player', 'Email', 'Discount %', 'Status', 'Issued', 'Expires', 'Minimum project value',
        'Uses', 'Max uses', 'Session ID', 'Issued by', 'Redeemed at', 'Original amount', 'Discount amount', 'Final amount'],
      ...rows.results.map((row) => [
        String(row.code),
        String(row.name),
        String(row.email),
        num(row.discount),
        String(row.status),
        iso(num(row.issued_at)),
        iso(num(row.expires_at)),
        num(row.min_project_value),
        num(row.uses),
        num(row.max_uses),
        row.session_id ? String(row.session_id) : '',
        row.created_by ? String(row.created_by) : 'arcade',
        iso(row.redeemed_at === null ? null : num(row.redeemed_at)),
        row.original_amount === null ? '' : num(row.original_amount),
        row.discount_amount === null ? '' : num(row.discount_amount),
        row.final_amount === null ? '' : num(row.final_amount),
      ]),
    ]);
  }

  if (type === 'redemptions') {
    const rows = await env.DB.prepare(
      `SELECT r.*, cp.code, p.name, p.email
       FROM redemptions r JOIN coupons cp ON cp.id = r.coupon_id JOIN players p ON p.id = r.player_id
       ORDER BY r.redeemed_at DESC`,
    ).all<Record<string, unknown>>();
    return csvResponse('code-builts-redemptions.csv', [
      ['Redemption ID', 'Coupon code', 'Player', 'Email', 'Service', 'Original amount', 'Discount %',
        'Discount amount', 'Final amount', 'Redeemed at', 'Reference', 'Recorded by'],
      ...rows.results.map((row) => [
        String(row.id),
        String(row.code),
        String(row.name),
        String(row.email),
        String(row.service),
        num(row.original_amount),
        num(row.discount),
        num(row.discount_amount),
        num(row.final_amount),
        iso(num(row.redeemed_at)),
        row.reference ? String(row.reference) : '',
        String(row.recorded_by),
      ]),
    ]);
  }

  throw new HttpError(404, 'UNKNOWN_EXPORT', 'Unknown export type.');
}

/* ----------------------------------------------------------------- router */

export async function handleAdminApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'api' || segments[1] !== 'admin') return null;
  const rest = segments.slice(2);
  const method = request.method.toUpperCase();

  if (rest.length === 1 && rest[0] === 'login' && method === 'POST') return login(request, env);

  const session = await requireAdmin(request, env);

  if (method !== 'GET') assertMutation(request, env);

  if (rest.length === 1 && rest[0] === 'session' && method === 'GET') {
    return json({ email: session.email, expiresAt: session.expiresAt });
  }
  if (rest.length === 1 && rest[0] === 'logout' && method === 'POST') return logout(request, env);

  if (rest.length === 1 && rest[0] === 'overview' && method === 'GET') return overview(env, url);
  if (rest.length === 1 && rest[0] === 'sessions' && method === 'GET') return listSessions(env, url);
  if (rest.length === 1 && rest[0] === 'players' && method === 'GET') return listPlayers(env, url);

  if (rest.length === 1 && rest[0] === 'claims' && method === 'GET') return listClaims(env, url);
  if (rest.length === 2 && rest[0] === 'claims' && method === 'GET') return claimDetail(env, rest[1]);
  if (rest.length === 3 && rest[0] === 'claims' && rest[2] === 'verify' && method === 'POST') {
    return reviewClaim(request, env, session, rest[1], 'verified');
  }
  if (rest.length === 3 && rest[0] === 'claims' && rest[2] === 'reject' && method === 'POST') {
    return reviewClaim(request, env, session, rest[1], 'rejected');
  }
  if (rest.length === 3 && rest[0] === 'claims' && rest[2] === 'notes' && method === 'POST') {
    return addNote(request, env, session, rest[1]);
  }

  if (rest.length === 1 && rest[0] === 'coupons' && method === 'GET') return listCoupons(env, url);
  if (rest.length === 1 && rest[0] === 'coupons' && method === 'POST') return createCoupon(request, env, session);
  if (rest.length === 3 && rest[0] === 'coupons' && rest[2] === 'revoke' && method === 'POST') {
    return revokeCoupon(request, env, session, rest[1]);
  }
  if (rest.length === 3 && rest[0] === 'coupons' && rest[2] === 'redeem' && method === 'POST') {
    return redeemCoupon(request, env, session, rest[1]);
  }

  if (rest.length === 1 && rest[0] === 'redemptions' && method === 'GET') return listRedemptions(env, url);
  if (rest.length === 1 && rest[0] === 'settings' && method === 'GET') return settingsResponse(env);
  if (rest.length === 1 && rest[0] === 'settings' && method === 'PUT') return updateSettings(request, env, session);
  if (rest.length === 1 && rest[0] === 'audit' && method === 'GET') return listAudit(env, url);
  if (rest.length === 2 && rest[0] === 'export' && method === 'GET') return exportCsv(env, rest[1]);

  return apiError(404, 'NOT_FOUND', 'Unknown admin endpoint.');
}

export { SESSION_MS as ADMIN_SESSION_MS };
