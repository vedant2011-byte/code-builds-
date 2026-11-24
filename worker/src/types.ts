/** Minimal Cloudflare Workers bindings used by this project (no extra types package). */

export interface D1Meta {
  changes: number;
  last_row_id: number;
  duration?: number;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1Statement;
  batch<T = Record<string, unknown>>(statements: D1Statement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface Env {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD_HASH?: string;
  SESSION_SECRET?: string;
  APP_ORIGIN?: string;
  ENVIRONMENT?: string;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
