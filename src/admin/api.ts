/** Admin API client. Every mutating call carries the CSRF header the Worker expects. */

export class AdminAuthError extends Error {}

export class AdminApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface ErrorShape {
  error?: { code?: string; message?: string };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'x-cb-request': '1',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });

  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (response.status === 401) {
    const message = (data as ErrorShape | null)?.error?.message ?? 'Your session expired. Sign in again.';
    throw new AdminAuthError(message);
  }

  if (!response.ok) {
    const shape = data as ErrorShape | null;
    throw new AdminApiError(
      shape?.error?.message ?? 'The request failed. Please try again.',
      response.status,
      shape?.error?.code ?? 'ERROR',
    );
  }

  return data as T;
}

export function getJson<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function sendJson<T>(path: string, method: 'POST' | 'PUT', body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export async function login(email: string, password: string): Promise<{ email: string }> {
  return sendJson<{ email: string }>('/api/admin/login', 'POST', { email, password });
}

export async function logout(): Promise<void> {
  await sendJson('/api/admin/logout', 'POST', {});
}

/* ------------------------------------------------------------------- types */

export interface SessionMeta {
  page: number;
  pageSize: number;
  total: number;
  pages: number;
}

export interface SessionRow {
  id: string;
  status: string;
  hits: number;
  score: number;
  duration_ms: number | null;
  started_at: number;
  finished_at: number | null;
  suspicious: number;
  suspicion_reasons: string | null;
  name: string | null;
  email: string | null;
  code: string | null;
  claim_id: string | null;
}

export interface PlayerRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  created_at: number;
  claims: number;
  coupons: number;
  best_score: number;
}

export interface ClaimRow {
  id: string;
  session_id: string;
  score: number;
  discount: number;
  status: string;
  note: string | null;
  created_at: number;
  reviewed_at: number | null;
  reviewed_by: string | null;
  player_id: string;
  name: string;
  email: string;
  phone: string | null;
  player_since: number;
  coupon_id: string | null;
  code: string | null;
  coupon_status: string | null;
  issued_at: number | null;
  expires_at: number | null;
  min_project_value: number | null;
  uses: number | null;
  max_uses: number | null;
  duration_ms: number | null;
  session_status: string | null;
  suspicious: number | null;
  started_at: number | null;
  hits: number | null;
  redemption_id: string | null;
  discount_amount: number | null;
  final_amount: number | null;
}

export interface CouponRow {
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
  name: string;
  email: string;
  phone: string | null;
  redemption_id: string | null;
  original_amount: number | null;
  discount_amount: number | null;
  final_amount: number | null;
  redeemed_at: number | null;
  service: string | null;
  reference: string | null;
  recorded_by: string | null;
}

export interface RedemptionRow {
  id: string;
  coupon_id: string;
  player_id: string;
  service: string;
  original_amount: number;
  discount: number;
  discount_amount: number;
  final_amount: number;
  reference: string | null;
  redeemed_at: number;
  recorded_by: string;
  code: string;
  name: string;
  email: string;
  phone: string | null;
}

export interface Overview {
  rangeDays: number;
  generatedAt: number;
  sessions: {
    total: number;
    inRange: number;
    finished: number;
    flagged: number;
    live: number;
    bestScore: number;
  };
  players: { total: number };
  claims: { total: number; pending: number; verified: number; rejected: number };
  coupons: {
    total: number;
    active: number;
    pending: number;
    redeemed: number;
    expired: number;
    revoked: number;
    redemptionRate: number;
    byDiscount: { discount: number; issued: number; redeemed: number }[];
  };
  redemptions: { total: number; discountTotal: number; grossTotal: number; netTotal: number };
  series: { day: string; sessions: number; flagged: number; claims: number }[];
  topScores: {
    id: string;
    score: number;
    started_at: number;
    duration_ms: number | null;
    discount: number | null;
    name: string | null;
    email: string | null;
  }[];
  recentCoupons: {
    code: string;
    discount: number;
    status: string;
    issued_at: number;
    name: string;
    email: string;
  }[];
}

export interface ClaimDetail {
  claim: ClaimRow;
  player: PlayerRow;
  session: SessionRow & { expires_at: number; last_event_ms: number; user_agent: string | null };
  events: { count: number; firstMs: number; lastMs: number };
  coupon: CouponRow | null;
  redemption: RedemptionRow | null;
  history: {
    id: string;
    score: number;
    discount: number;
    status: string;
    created_at: number;
    session_id: string;
    code: string | null;
    coupon_status: string | null;
  }[];
  notes: { id: string; admin_email: string; body: string; created_at: number }[];
  audit: {
    id: number;
    admin_email: string;
    action: string;
    target_type: string;
    target_id: string;
    detail: string | null;
    created_at: number;
  }[];
}

export interface SettingsPayload {
  settings: {
    arcadeEnabled: boolean;
    claimsEnabled: boolean;
    difficulty: 'relaxed' | 'standard' | 'challenging';
    couponValidDays: number;
    minProjectValue: number;
    maxCouponUses: number;
    tiers: { min: number; max: number | null; discount: number }[];
    eligibleServices: string[];
  };
  defaults: SettingsPayload['settings'];
  catalogue: string[];
}

export interface AuditRow {
  id: number;
  admin_email: string;
  action: string;
  target_type: string;
  target_id: string;
  detail: string | null;
  created_at: number;
}
