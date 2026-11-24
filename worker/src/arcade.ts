/**
 * Public arcade API.
 *
 * The browser is never trusted with a score: the Worker owns a session record,
 * counts accepted bounce events itself, checks their timing against the wall
 * clock, and derives the score from that count. A session that fails any check
 * is flagged and cannot produce a claim.
 */

import {
  CLAIMS_PER_IP_PER_HOUR,
  CLOCK_TOLERANCE_MS,
  MAX_PLAY_MS,
  MIN_BOUNCE_GAP_MS,
  POINTS_PER_BOUNCE,
  SESSION_TTL_MS,
  discountForScore,
  type PublicArcadeConfig,
} from '../../shared/arcade';
import {
  isValidEmail,
  normalizeEmail,
  randomCode,
  randomToken,
  sha256Hex,
  timingSafeEqual,
} from './crypto';
import { expireCoupons, getSettings, upsertPlayer } from './db';
import {
  HttpError,
  apiError,
  clientIp,
  isSameOrigin,
  json,
  rateLimit,
  readJson,
  userAgent,
} from './http';
import type { D1Database, Env } from './types';

interface SessionRow {
  id: string;
  token_hash: string;
  started_at: number;
  expires_at: number;
  finished_at: number | null;
  status: string;
  hits: number;
  score: number;
  duration_ms: number | null;
  last_event_ms: number;
  suspicious: number;
  suspicion_reasons: string | null;
}

interface CouponRow {
  id: string;
  code: string;
  discount: number;
  status: string;
  issued_at: number;
  expires_at: number;
  valid_days: number;
  min_project_value: number;
  eligible_services: string | null;
}

async function ipHash(env: Env, request: Request): Promise<string> {
  const secret = env.SESSION_SECRET ?? 'code-builts-arcade';
  return sha256Hex(`${secret}:${clientIp(request)}`);
}

function checkOrigin(request: Request, env: Env): void {
  const allowed = (env.APP_ORIGIN ?? '').split(',');
  if (!isSameOrigin(request, allowed)) {
    throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Requests must come from the CODE BUILTS site.');
  }
}

async function loadSession(db: D1Database, id: string, token: string): Promise<SessionRow> {
  const row = await db.prepare('SELECT * FROM game_sessions WHERE id = ?').bind(id).first<SessionRow>();
  if (!row) throw new HttpError(404, 'SESSION_NOT_FOUND', 'That game session no longer exists.');
  if (!token || !timingSafeEqual(await sha256Hex(token), row.token_hash)) {
    throw new HttpError(403, 'SESSION_TOKEN_INVALID', 'This game session could not be verified.');
  }
  return row;
}

async function flagSession(
  db: D1Database,
  session: SessionRow,
  reasons: string[],
  extra: { durationMs?: number; finish?: boolean } = {},
): Promise<void> {
  await db
    .prepare(
      `UPDATE game_sessions
       SET status = 'flagged', suspicious = 1, suspicion_reasons = ?,
           duration_ms = COALESCE(?, duration_ms),
           finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
       WHERE id = ?`,
    )
    .bind(
      JSON.stringify(reasons),
      extra.durationMs ?? null,
      extra.finish ? 1 : 0,
      Date.now(),
      session.id,
    )
    .run();
}

async function readConfig(db: D1Database): Promise<PublicArcadeConfig> {
  const settings = await getSettings(db);
  return {
    arcadeEnabled: settings.arcadeEnabled,
    claimsEnabled: settings.claimsEnabled,
    difficulty: settings.difficulty,
    tiers: settings.tiers,
    couponValidDays: settings.couponValidDays,
    minProjectValue: settings.minProjectValue,
    eligibleServices: settings.eligibleServices,
    pointsPerBounce: POINTS_PER_BOUNCE,
  };
}

function requireBody(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_FIELD', `${field} is required.`);
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > max) {
    throw new HttpError(400, 'INVALID_FIELD', `Please check the ${field.toLowerCase()} you entered.`);
  }
  return trimmed;
}

async function createSession(request: Request, env: Env): Promise<Response> {
  checkOrigin(request, env);
  const settings = await getSettings(env.DB);
  if (!settings.arcadeEnabled) {
    throw new HttpError(503, 'ARCADE_DISABLED', 'The arcade is taking a short break. Please try again later.');
  }

  const ip = await ipHash(env, request);
  const limit = await rateLimit(env.DB, `arcade:session:${ip}`, 40, 60 * 60 * 1000);
  if (!limit.allowed) {
    return apiError(429, 'RATE_LIMITED', 'Too many games started. Take a breather and try again shortly.');
  }

  const id = crypto.randomUUID();
  const token = randomToken(24);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO game_sessions
       (id, token_hash, started_at, expires_at, status, last_seen_at, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
  )
    .bind(id, await sha256Hex(token), now, now + SESSION_TTL_MS, now, ip, userAgent(request))
    .run();

  return json(
    {
      sessionId: id,
      sessionToken: token,
      startedAt: now,
      expiresAt: now + SESSION_TTL_MS,
      rules: {
        minBounceGapMs: MIN_BOUNCE_GAP_MS,
        pointsPerBounce: POINTS_PER_BOUNCE,
        maxPlayMs: MAX_PLAY_MS,
      },
    },
    201,
  );
}

interface EventInput {
  seq?: unknown;
  t?: unknown;
}

async function appendEvents(request: Request, env: Env, sessionId: string): Promise<Response> {
  checkOrigin(request, env);
  const body = await readJson<{ token?: unknown; events?: unknown }>(request);
  const token = typeof body.token === 'string' ? body.token : '';
  const session = await loadSession(env.DB, sessionId, token);
  const now = Date.now();

  if (session.status === 'flagged') {
    throw new HttpError(409, 'SESSION_REJECTED', 'This run was rejected and cannot be verified.');
  }
  if (session.status === 'finished') return json({ hits: session.hits, score: session.score, closed: true });
  if (session.status !== 'active' || now > session.expires_at) {
    throw new HttpError(409, 'SESSION_EXPIRED', 'This game session expired. Start a new run.');
  }

  const rawEvents = Array.isArray(body.events) ? body.events : [];
  if (rawEvents.length === 0) return json({ hits: session.hits, score: session.score });
  if (rawEvents.length > 40) {
    throw new HttpError(400, 'TOO_MANY_EVENTS', 'Too many game events in one batch.');
  }

  const reasons: string[] = [];
  const serverElapsed = now - session.started_at;
  let expectedSeq = session.hits + 1;
  let previousT = session.last_event_ms;
  const accepted: { seq: number; t: number }[] = [];

  for (const raw of rawEvents as EventInput[]) {
    const seq = typeof raw?.seq === 'number' ? raw.seq : Number.NaN;
    const t = typeof raw?.t === 'number' ? raw.t : Number.NaN;

    if (!Number.isInteger(seq) || !Number.isFinite(t)) {
      reasons.push('malformed_event');
      break;
    }
    if (seq !== expectedSeq) {
      reasons.push('sequence_gap');
      break;
    }
    if (t <= previousT) {
      reasons.push('non_monotonic_timing');
      break;
    }
    if (t - previousT < MIN_BOUNCE_GAP_MS) {
      reasons.push('impossible_bounce_rate');
      break;
    }
    if (t > serverElapsed + CLOCK_TOLERANCE_MS) {
      reasons.push('future_timestamp');
      break;
    }
    if (t > MAX_PLAY_MS) {
      reasons.push('over_time_limit');
      break;
    }

    accepted.push({ seq, t });
    previousT = t;
    expectedSeq += 1;
  }

  if (!reasons.length && accepted.length > 0) {
    // A batch may never contain more bounces than the fastest legal play allows.
    const span = previousT - session.last_event_ms;
    if (accepted.length > Math.floor(span / MIN_BOUNCE_GAP_MS) + 3) reasons.push('batch_too_dense');
  }

  if (reasons.length) {
    await flagSession(env.DB, session, reasons);
    throw new HttpError(409, 'SESSION_REJECTED', 'This run could not be verified.');
  }

  const hitCount = session.hits + accepted.length;
  const statements = accepted.map((event) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO game_events (session_id, seq, t_ms, created_at) VALUES (?, ?, ?, ?)',
    ).bind(session.id, event.seq, Math.round(event.t), now),
  );
  statements.push(
    env.DB.prepare(
      `UPDATE game_sessions
       SET hits = ?, score = ?, last_event_ms = ?, last_seen_at = ?
       WHERE id = ? AND status = 'active'`,
    ).bind(hitCount, hitCount * POINTS_PER_BOUNCE, previousT, now, session.id),
  );

  await env.DB.batch(statements);

  return json({ hits: hitCount, score: hitCount * POINTS_PER_BOUNCE, verified: true });
}

async function finishSession(request: Request, env: Env, sessionId: string): Promise<Response> {
  checkOrigin(request, env);
  const body = await readJson<{ token?: unknown; durationMs?: unknown }>(request);
  const token = typeof body.token === 'string' ? body.token : '';
  const session = await loadSession(env.DB, sessionId, token);
  const settings = await getSettings(env.DB);
  const now = Date.now();

  if (session.status === 'flagged') {
    return json(
      {
        verified: false,
        score: session.score,
        discount: 0,
        claimEligible: false,
        reasons: ['session_flagged'],
      },
      200,
    );
  }

  if (session.status === 'finished') {
    const existing = await env.DB
      .prepare('SELECT id, discount FROM reward_claims WHERE session_id = ?')
      .bind(session.id)
      .first<{ id: string; discount: number }>();
    return json({
      verified: true,
      score: session.score,
      hits: session.hits,
      durationMs: session.duration_ms,
      discount: discountForScore(session.score, settings.tiers),
      claimEligible:
        settings.claimsEnabled && discountForScore(session.score, settings.tiers) > 0 && !existing,
      claimed: Boolean(existing),
    });
  }

  if (session.status !== 'active' || now > session.expires_at) {
    throw new HttpError(409, 'SESSION_EXPIRED', 'This game session expired. Start a new run.');
  }

  const durationMs = typeof body.durationMs === 'number' ? Math.round(body.durationMs) : Number.NaN;
  const reasons: string[] = [];
  const serverElapsed = now - session.started_at;

  if (!Number.isFinite(durationMs) || durationMs < 0) reasons.push('missing_duration');
  else {
    if (durationMs > MAX_PLAY_MS) reasons.push('over_time_limit');
    if (durationMs < session.last_event_ms) reasons.push('duration_before_events');
    if (durationMs > serverElapsed + CLOCK_TOLERANCE_MS) reasons.push('duration_exceeds_wall_clock');
    if (session.hits > 0 && durationMs < session.hits * MIN_BOUNCE_GAP_MS - 100) {
      reasons.push('score_impossible_for_duration');
    }
    if (session.hits > Math.floor(Math.max(serverElapsed, 1) / MIN_BOUNCE_GAP_MS) + 2) {
      reasons.push('score_exceeds_possible_rate');
    }
    if (session.hits > 0 && durationMs < 700) reasons.push('finish_too_fast');
  }

  if (reasons.length) {
    await flagSession(env.DB, session, reasons, { durationMs: 0, finish: true });
    await env.DB.prepare('UPDATE game_sessions SET score = ? WHERE id = ?')
      .bind(session.hits * POINTS_PER_BOUNCE, session.id)
      .run();
    return json({
      verified: false,
      score: session.hits * POINTS_PER_BOUNCE,
      discount: 0,
      claimEligible: false,
      reasons,
    });
  }

  const score = session.hits * POINTS_PER_BOUNCE;
  const discount = discountForScore(score, settings.tiers);

  await env.DB.prepare(
    `UPDATE game_sessions
     SET status = 'finished', score = ?, duration_ms = ?, finished_at = ?, last_seen_at = ?
     WHERE id = ? AND status = 'active'`,
  )
    .bind(score, durationMs, now, now, session.id)
    .run();

  return json({
    verified: true,
    score,
    hits: session.hits,
    durationMs,
    discount,
    claimEligible: settings.claimsEnabled && discount > 0,
    claimed: false,
    tiers: settings.tiers,
  });
}

async function generateCouponCode(db: D1Database, discount: number): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = `CB-${discount}-${randomCode(6)}`;
    const taken = await db.prepare('SELECT 1 FROM coupons WHERE code = ?').bind(code).first();
    if (!taken) return code;
  }
  throw new HttpError(503, 'COUPON_CODE_UNAVAILABLE', 'Could not issue a coupon right now. Please try again.');
}

async function createClaim(request: Request, env: Env): Promise<Response> {
  checkOrigin(request, env);
  const body = await readJson<{
    sessionId?: unknown;
    sessionToken?: unknown;
    name?: unknown;
    email?: unknown;
    phone?: unknown;
  }>(request);

  const settings = await getSettings(env.DB);
  if (!settings.arcadeEnabled || !settings.claimsEnabled) {
    throw new HttpError(503, 'CLAIMS_CLOSED', 'Reward claims are paused right now.');
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const token = typeof body.sessionToken === 'string' ? body.sessionToken : '';
  const session = await loadSession(env.DB, sessionId, token);

  if (session.status === 'flagged' || session.suspicious === 1) {
    throw new HttpError(403, 'SESSION_NOT_VERIFIED', 'This score could not be verified, so no reward is due.');
  }
  if (session.status !== 'finished') {
    throw new HttpError(409, 'SESSION_NOT_FINISHED', 'Finish the game before claiming a reward.');
  }
  if (session.finished_at && Date.now() - session.finished_at > 60 * 60 * 1000) {
    throw new HttpError(409, 'CLAIM_WINDOW_CLOSED', 'That reward window has closed. Play again to earn a new one.');
  }

  const discount = discountForScore(session.score, settings.tiers);
  if (discount <= 0) {
    throw new HttpError(422, 'NO_REWARD', 'That score did not unlock a discount.');
  }

  const name = requireBody(body.name, 'Name', 80);
  const email = normalizeEmail(requireBody(body.email, 'Email', 254));
  if (!isValidEmail(email)) throw new HttpError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  const phone =
    typeof body.phone === 'string' && body.phone.trim() ? body.phone.trim().slice(0, 32) : null;
  if (phone && phone.replace(/\D/g, '').length < 7) {
    throw new HttpError(400, 'INVALID_PHONE', 'Enter a valid phone number, or leave it empty.');
  }

  const ip = await ipHash(env, request);
  const perIp = await rateLimit(env.DB, `arcade:claim:${ip}`, CLAIMS_PER_IP_PER_HOUR, 60 * 60 * 1000);
  if (!perIp.allowed) {
    return apiError(429, 'RATE_LIMITED', 'Too many claims from this connection. Please try again later.');
  }
  const perEmail = await rateLimit(env.DB, `arcade:claim:email:${email}`, 5, 24 * 60 * 60 * 1000);
  if (!perEmail.allowed) {
    return apiError(429, 'RATE_LIMITED', 'Too many claims for this email address today.');
  }

  const existing = await env.DB
    .prepare('SELECT id FROM reward_claims WHERE session_id = ?')
    .bind(session.id)
    .first<{ id: string }>();

  if (existing) {
    const coupon = await env.DB
      .prepare('SELECT * FROM coupons WHERE claim_id = ?')
      .bind(existing.id)
      .first<CouponRow>();
    if (coupon) {
      return json({
        duplicate: true,
        coupon: {
          code: coupon.code,
          discount: coupon.discount,
          status: coupon.status,
          issuedAt: coupon.issued_at,
          expiresAt: coupon.expires_at,
          validDays: coupon.valid_days,
          minProjectValue: coupon.min_project_value,
          eligibleServices: coupon.eligible_services ? JSON.parse(coupon.eligible_services) : [],
        },
      });
    }
  }

  const now = Date.now();
  const player = await upsertPlayer(env.DB, { name, email, phone }, now);
  const claimId = crypto.randomUUID();
  const couponId = crypto.randomUUID();
  const code = await generateCouponCode(env.DB, discount);
  const expiresAt = now + settings.couponValidDays * 24 * 60 * 60 * 1000;

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO reward_claims (id, session_id, player_id, score, discount, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      ).bind(claimId, session.id, player.id, session.score, discount, now),
      env.DB.prepare(
        `INSERT INTO coupons
           (id, code, claim_id, player_id, session_id, discount, status, issued_at, expires_at,
            valid_days, min_project_value, max_uses, uses, eligible_services, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, ?, NULL)`,
      ).bind(
        couponId,
        code,
        claimId,
        player.id,
        session.id,
        discount,
        now,
        expiresAt,
        settings.couponValidDays,
        settings.minProjectValue,
        settings.maxCouponUses,
        JSON.stringify(settings.eligibleServices),
      ),
    ]);
  } catch (error) {
    // UNIQUE(session_id) means a concurrent claim already won the race.
    const raced = await env.DB
      .prepare('SELECT id FROM reward_claims WHERE session_id = ?')
      .bind(session.id)
      .first<{ id: string }>();
    if (raced) {
      throw new HttpError(409, 'ALREADY_CLAIMED', 'This run has already been claimed.');
    }
    throw error;
  }

  await expireCoupons(env.DB);

  return json(
    {
      coupon: {
        code,
        discount,
        status: 'active',
        issuedAt: now,
        expiresAt,
        validDays: settings.couponValidDays,
        minProjectValue: settings.minProjectValue,
        eligibleServices: settings.eligibleServices,
      },
      player: { name: player.name, email: player.email },
      score: session.score,
    },
    201,
  );
}

export async function handleArcadeApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  const segments = url.pathname.split('/').filter(Boolean); // api, arcade, ...
  if (segments[0] !== 'api' || segments[1] !== 'arcade') return null;
  const rest = segments.slice(2);
  const method = request.method.toUpperCase();

  if (rest.length === 1 && rest[0] === 'config' && method === 'GET') {
    return json({ config: await readConfig(env.DB), serverTime: Date.now() });
  }

  if (rest.length === 1 && rest[0] === 'sessions' && method === 'POST') {
    return createSession(request, env);
  }

  if (rest.length === 3 && rest[0] === 'sessions' && rest[2] === 'events' && method === 'POST') {
    return appendEvents(request, env, rest[1]);
  }

  if (rest.length === 3 && rest[0] === 'sessions' && rest[2] === 'finish' && method === 'POST') {
    return finishSession(request, env, rest[1]);
  }

  if (rest.length === 1 && rest[0] === 'claims' && method === 'POST') {
    return createClaim(request, env);
  }

  return apiError(404, 'NOT_FOUND', 'Unknown arcade endpoint.');
}
