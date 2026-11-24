/** HTTP helpers: JSON responses, body parsing, origin checks, cookies, rate limits. */

import type { D1Database } from './types';

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-robots-tag': 'noindex, nofollow',
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

export function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export async function readJson<T>(request: Request, maxBytes = 64 * 1024): Promise<T> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON.');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'BODY_TOO_LARGE', 'That request is too large.');
  try {
    const parsed: unknown = JSON.parse(text || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as T;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'The request body is not valid JSON.');
  }
}

export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return apiError(error.status, error.code, error.message);
  console.error('Unhandled API error', error);
  return apiError(500, 'INTERNAL', 'Something went wrong on our side. Please try again.');
}

/** Same-origin enforcement for state-changing calls. */
export function isSameOrigin(request: Request, allowedOrigins: string[] = []): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // native fetch / curl carries no Origin
  const url = new URL(request.url);
  if (origin === url.origin) return true;
  return allowedOrigins.some((allowed) => allowed.trim() !== '' && allowed.trim() === origin);
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}

export function userAgent(request: Request): string {
  return (request.headers.get('user-agent') ?? '').slice(0, 200);
}

/**
 * Fixed-window counter backed by D1. Returns whether the call is allowed.
 * The batch is transactional, so concurrent calls cannot slip past the limit.
 */
export async function rateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const bucket = `${key}:${windowStart}`;

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(bucket) DO UPDATE SET count = count + 1`,
      )
      .bind(bucket, windowStart),
    db.prepare('SELECT count FROM rate_limits WHERE bucket = ?').bind(bucket),
  ]);

  const row = results[1]?.results?.[0] as { count?: number } | undefined;
  const count = Number(row?.count ?? limit + 1);
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfter: Math.ceil((windowStart + windowMs - now) / 1000),
  };
}

export async function pruneRateLimits(db: D1Database, olderThanMs = 24 * 60 * 60 * 1000): Promise<void> {
  await db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Date.now() - olderThanMs).run();
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function buildCookie(
  name: string,
  value: string,
  options: { maxAge: number; secure: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function csvResponse(filename: string, rows: (string | number | null)[][]): Response {
  const escape = (value: string | number | null) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const body = rows.map((row) => row.map(escape).join(',')).join('\r\n');
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
