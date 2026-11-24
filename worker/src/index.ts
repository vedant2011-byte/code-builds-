/**
 * CODE BUILTS — single Worker entry.
 *
 * /api/*        JSON API (public arcade + private admin)
 * /the-letter   the dedicated letter page
 * /admin*       the admin app shell (the API still enforces auth)
 * everything else falls through to the built site in dist/
 */

import { handleAdminApi } from './admin';
import { handleArcadeApi } from './arcade';
import { ensureSchema } from './db';
import { apiError, errorResponse } from './http';
import type { Env } from './types';

const PAGE_ROUTES: Record<string, string> = {
  '/the-letter': '/the-letter.html',
  '/the-letter/': '/the-letter.html',
  '/admin': '/admin.html',
  '/admin/': '/admin.html',
  '/admin/login': '/admin.html',
  '/admin/arcade': '/admin.html',
};

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

async function servePage(env: Env, requestUrl: string, assetPath: string): Promise<Response> {
  const url = new URL(requestUrl);
  const response = await env.ASSETS.fetch(new URL(assetPath, url.origin).toString());

  if (response.status === 404) {
    return new Response('Page not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  return withHeaders(response, {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        await ensureSchema(env.DB);
        const arcade = await handleArcadeApi(request, env, url);
        if (arcade) return arcade;
        const admin = await handleAdminApi(request, env, url);
        if (admin) return admin;
        return apiError(404, 'NOT_FOUND', 'Unknown endpoint.');
      } catch (error) {
        return errorResponse(error);
      }
    }

    if (url.pathname.startsWith('/admin')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      }
      return withHeaders(await servePage(env, request.url, '/admin.html'), {
        'x-robots-tag': 'noindex, nofollow',
        'cache-control': 'no-store',
      });
    }

    const page = PAGE_ROUTES[url.pathname];
    if (page) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      }
      return servePage(env, request.url, page);
    }

    return env.ASSETS.fetch(request);
  },
};
