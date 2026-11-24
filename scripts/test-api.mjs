/* End-to-end checks against the local Worker (wrangler dev on :8787). */

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const ORIGIN = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
const EMAIL = process.env.ADMIN_EMAIL ?? 'owner@codebuilts.local';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';

if (!PASSWORD) {
  console.error('Set ADMIN_PASSWORD (the local .dev.vars password) before running the API test.');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`FAIL  ${name} ${detail}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, text };
}

function adminHeaders(extra = {}) {
  return { origin: ORIGIN, 'x-cb-request': '1', ...extra };
}

async function makeSession() {
  const res = await call('/api/arcade/sessions', { method: 'POST', body: {} });
  if (res.status !== 201) throw new Error(`session create failed: ${res.status} ${res.text}`);
  return res.json;
}

async function play(session, hits, gapMs, { wait = true } = {}) {
  const events = [];
  for (let i = 1; i <= hits; i += 1) events.push({ seq: i, t: i * gapMs });
  if (wait) await sleep(hits * gapMs + 150);
  return call(`/api/arcade/sessions/${session.sessionId}/events`, {
    method: 'POST',
    body: { token: session.sessionToken, events },
  });
}

function couponOf(res) {
  return res.json?.coupon ?? null;
}

/* ------------------------------------------------------------------ public */

const config = await call('/api/arcade/config');
check('GET /api/arcade/config reaches the database', config.status === 200 && config.json?.config?.arcadeEnabled === true, config.text);
check('config exposes the reward tiers', Array.isArray(config.json?.config?.tiers) && config.json.config.tiers.length >= 4);

const session = await makeSession();
check('POST /api/arcade/sessions creates a session', Boolean(session.sessionId && session.sessionToken));

const events = await play(session, 40, 130);
check('events accepted for a 400-point run', events.status === 200 && events.json?.score === 400, events.text);

const finish = await call(`/api/arcade/sessions/${session.sessionId}/finish`, {
  method: 'POST',
  body: { token: session.sessionToken, durationMs: 5300 },
});
check('finish verifies the score server-side', finish.status === 200 && finish.json?.verified === true);
check('400 points unlocks 10%', finish.json?.discount === 10 && finish.json?.claimEligible === true, finish.text);

const claim = await call('/api/arcade/claims', {
  method: 'POST',
  body: {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    name: 'Test Player',
    email: 'test.player@example.com',
    phone: '+91 90000 00000',
  },
});
const coupon = couponOf(claim);
check('claim issues a coupon', claim.status === 201 && Boolean(coupon?.code), claim.text);
check('coupon code format CB-10-XXXXXX', /^CB-10-[A-Z0-9]{6}$/.test(coupon?.code ?? ''), coupon?.code);
check('coupon valid for 7 days', coupon && Math.round((coupon.expiresAt - coupon.issuedAt) / 86400000) === 7);
check('claim is stamped pending for review', claim.status === 201);

const duplicate = await call('/api/arcade/claims', {
  method: 'POST',
  body: {
    sessionId: session.sessionId,
    sessionToken: session.sessionToken,
    name: 'Test Player',
    email: 'test.player@example.com',
  },
});
check('duplicate claim returns the same coupon', duplicate.json?.duplicate === true && couponOf(duplicate)?.code === coupon.code);

/* reward tier boundaries, verified by the Worker itself */
const boundaries = [
  [9, 90, 0],
  [10, 100, 2],
  [19, 190, 2],
  [20, 200, 5],
  [29, 290, 5],
  [30, 300, 7],
  [39, 390, 7],
  [40, 400, 10],
];

for (const [hits, expectedScore, expectedDiscount] of boundaries) {
  const tierSession = await makeSession();
  await play(tierSession, hits, 130);
  const tierFinish = await call(`/api/arcade/sessions/${tierSession.sessionId}/finish`, {
    method: 'POST',
    body: { token: tierSession.sessionToken, durationMs: hits * 130 + 250 },
  });
  check(
    `${expectedScore} points unlocks ${expectedDiscount}%`,
    tierFinish.status === 200 &&
      tierFinish.json?.verified === true &&
      tierFinish.json?.score === expectedScore &&
      tierFinish.json?.discount === expectedDiscount &&
      tierFinish.json?.claimEligible === (expectedDiscount > 0),
    `${tierFinish.status} ${tierFinish.text}`.slice(0, 200),
  );
}

/* low score gets nothing */
const low = await makeSession();
await play(low, 5, 200);
const lowFinish = await call(`/api/arcade/sessions/${low.sessionId}/finish`, {
  method: 'POST',
  body: { token: low.sessionToken, durationMs: 1200 },
});
check('low score finishes without a reward', lowFinish.json?.verified === true && lowFinish.json?.discount === 0 && lowFinish.json?.claimEligible === false);
const lowClaim = await call('/api/arcade/claims', {
  method: 'POST',
  body: { sessionId: low.sessionId, sessionToken: low.sessionToken, name: 'Low Score', email: 'low@example.com' },
});
check('claiming below 100 points is refused', lowClaim.status === 422, `${lowClaim.status} ${lowClaim.text}`);

/* forged timing is flagged */
const cheat = await makeSession();
const forged = await call(`/api/arcade/sessions/${cheat.sessionId}/events`, {
  method: 'POST',
  body: { token: cheat.sessionToken, events: [{ seq: 1, t: 30000 }, { seq: 2, t: 30130 }] },
});
check('future-timestamped bounces are rejected', forged.status === 409, `${forged.status} ${forged.text}`);
const cheatFinish = await call(`/api/arcade/sessions/${cheat.sessionId}/finish`, {
  method: 'POST',
  body: { token: cheat.sessionToken, durationMs: 2000 },
});
check('flagged session cannot be verified', cheatFinish.json?.verified === false && cheatFinish.json?.claimEligible === false);

const badToken = await call(`/api/arcade/sessions/${session.sessionId}/finish`, {
  method: 'POST',
  body: { token: 'not-the-token', durationMs: 5300 },
});
check('wrong session token is refused', badToken.status === 403);

/* ------------------------------------------------------------------- admin */

const anon = await call('/api/admin/session');
check('admin session requires a cookie', anon.status === 401, String(anon.status));

const noCsrf = await call('/api/admin/login', {
  method: 'POST',
  headers: { origin: ORIGIN },
  body: { email: EMAIL, password: PASSWORD },
});
check('login without the CSRF header is blocked', noCsrf.status === 403, String(noCsrf.status));

const crossSite = await call('/api/admin/login', {
  method: 'POST',
  headers: { origin: 'https://evil.example', 'x-cb-request': '1' },
  body: { email: EMAIL, password: PASSWORD },
});
check('login from a foreign origin is blocked', crossSite.status === 403, String(crossSite.status));

const wrong = await call('/api/admin/login', {
  method: 'POST',
  headers: adminHeaders(),
  body: { email: EMAIL, password: 'wrong-password-123' },
});
check('wrong password is refused', wrong.status === 401, String(wrong.status));

const loginRes = await call('/api/admin/login', {
  method: 'POST',
  headers: adminHeaders(),
  body: { email: EMAIL, password: PASSWORD },
});
const setCookie = loginRes.headers.get('set-cookie') ?? '';
const cookie = setCookie.split(';')[0];
check('correct credentials open a session', loginRes.status === 200 && cookie.startsWith('cb_admin='));
check('session cookie is HttpOnly + SameSite=Strict', /httponly/i.test(setCookie) && /samesite=strict/i.test(setCookie));

const me = await call('/api/admin/session', { cookie });
check('authenticated session resolves', me.status === 200 && me.json?.email === EMAIL);

const overview = await call('/api/admin/overview?days=30', { cookie });
check('overview returns real counts', overview.status === 200 && overview.json?.sessions?.total >= 3, overview.text.slice(0, 200));
check('overview counts the issued coupon', overview.json?.coupons?.total >= 1);
check('overview reports the flagged session', overview.json?.sessions?.flagged >= 1);
check('overview series has points', Array.isArray(overview.json?.series) && overview.json.series.length > 0);

const claims = await call('/api/admin/claims?page=1', { cookie });
const claimRow = claims.json?.rows?.find((row) => row.email === 'test.player@example.com');
check('claims list joins player + coupon', claims.status === 200 && Boolean(claimRow?.code === coupon.code), claims.text.slice(0, 300));
check('claim starts pending', claimRow?.status === 'pending');

const detail = await call(`/api/admin/claims/${claimRow?.id}`, { cookie });
check('claim detail returns the session and events', detail.status === 200 && detail.json?.events?.count === 40, detail.text.slice(0, 200));
check('claim detail includes the coupon', detail.json?.coupon?.code === coupon.code);

const verify = await call(`/api/admin/claims/${claimRow?.id}/verify`, {
  method: 'POST',
  headers: adminHeaders(),
  cookie,
  body: { note: 'Looks legitimate.' },
});
check('admin can approve a claim', verify.status === 200 && verify.json?.claim?.status === 'verified', verify.text.slice(0, 200));

const note = await call(`/api/admin/claims/${claimRow?.id}/notes`, {
  method: 'POST',
  headers: adminHeaders(),
  cookie,
  body: { body: 'Internal check note.' },
});
check('admin can add an internal note', note.status === 200 && note.json?.notes?.length === 1);

const couponsList = await call('/api/admin/coupons?page=1', { cookie });
const couponRow = couponsList.json?.rows?.find((row) => row.code === coupon.code);
check('coupon appears in coupon management', Boolean(couponRow) && couponRow.status === 'active');

const redeem = await call(`/api/admin/coupons/${couponRow?.id}/redeem`, {
  method: 'POST',
  headers: adminHeaders(),
  cookie,
  body: { service: 'Website development', originalAmount: 20000, reference: 'TEST-001' },
});
check('redemption is recorded', redeem.status === 201, `${redeem.status} ${redeem.text}`);
check('discount math is correct', redeem.json?.redemption?.discount_amount === 2000 && redeem.json?.redemption?.final_amount === 18000);

const doubleRedeem = await call(`/api/admin/coupons/${couponRow?.id}/redeem`, {
  method: 'POST',
  headers: adminHeaders(),
  cookie,
  body: { service: 'Website development', originalAmount: 20000 },
});
check('a coupon cannot be redeemed twice', doubleRedeem.status === 409, `${doubleRedeem.status} ${doubleRedeem.text}`);

const revokeRedeemed = await call(`/api/admin/coupons/${couponRow?.id}/revoke`, {
  method: 'POST',
  headers: adminHeaders(),
  cookie,
  body: { reason: 'should not be allowed' },
});
check('a redeemed coupon cannot be revoked', revokeRedeemed.status === 409, String(revokeRedeemed.status));

const redemptions = await call('/api/admin/redemptions', { cookie });
check('redemption list shows the purchase', redemptions.json?.rows?.some((row) => row.code === coupon.code));

const settings = await call('/api/admin/settings', { cookie });
check('settings endpoint returns tiers', settings.status === 200 && settings.json?.settings?.couponValidDays === 7);
const settingsSave = await call('/api/admin/settings', {
  method: 'PUT',
  headers: adminHeaders(),
  cookie,
  body: { couponValidDays: 14, minProjectValue: 5000 },
});
check('settings can be updated', settingsSave.status === 200 && settingsSave.json?.settings?.couponValidDays === 14);
const settingsBack = await call('/api/admin/settings', {
  method: 'PUT',
  headers: adminHeaders(),
  cookie,
  body: { couponValidDays: 7, minProjectValue: 0 },
});
check('settings can be restored', settingsBack.json?.settings?.couponValidDays === 7);

const badTiers = await call('/api/admin/settings', {
  method: 'PUT',
  headers: adminHeaders(),
  cookie,
  body: { tiers: [{ min: 100, max: null, discount: 200 }] },
});
check('invalid tiers are refused', badTiers.status === 400, String(badTiers.status));

const manual = await call('/api/admin/coupons', {
  method: 'POST',
  headers: adminHeaders(),
  cookie,
  body: { name: 'Manual Customer', email: 'manual@example.com', discount: 5, validDays: 10, minProjectValue: 1000, maxUses: 1 },
});
check('admin can issue a manual coupon', manual.status === 201 && /^CB-5-[A-Z0-9]{6}$/.test(manual.json?.coupon?.code ?? ''), manual.text);
const manualId = manual.json?.coupon?.id;

const manualRedeemLow = await call(`/api/admin/coupons/${manualId}/redeem`, {
  method: 'POST',
  headers: adminHeaders(),
  cookie,
  body: { service: 'Website development', originalAmount: 500 },
});
check('minimum project value is enforced', manualRedeemLow.status === 422, String(manualRedeemLow.status));

const manualRevoke = await call(`/api/admin/coupons/${manualId}/revoke`, {
  method: 'POST',
  headers: adminHeaders(),
  cookie,
  body: { reason: 'Issued by mistake in the test run.' },
});
check('admin can revoke an unused coupon', manualRevoke.status === 200 && manualRevoke.json?.coupon?.status === 'revoked');

const revokedRedeem = await call(`/api/admin/coupons/${manualId}/redeem`, {
  method: 'POST',
  headers: adminHeaders(),
  cookie,
  body: { service: 'Website development', originalAmount: 5000 },
});
check('revoked coupons cannot be redeemed', revokedRedeem.status === 409, String(revokedRedeem.status));

const audit = await call('/api/admin/audit', { cookie });
check('audit log records admin actions', audit.status === 200 && audit.json?.rows?.length >= 5);

const noCsrfWrite = await call(`/api/admin/claims/${claimRow?.id}/notes`, {
  method: 'POST',
  headers: { origin: ORIGIN },
  cookie,
  body: { body: 'should fail' },
});
check('mutations require the CSRF header', noCsrfWrite.status === 403, String(noCsrfWrite.status));

for (const type of ['players', 'sessions', 'winners', 'coupons', 'redemptions']) {
  const csv = await call(`/api/admin/export/${type}`, { cookie });
  check(`CSV export works: ${type}`, csv.status === 200 && (csv.headers.get('content-type') ?? '').includes('text/csv') && csv.text.includes(','));
}

const noAuthExport = await call('/api/admin/export/winners');
check('CSV export is private', noAuthExport.status === 401);

/* arcade switch */
const off = await call('/api/admin/settings', {
  method: 'PUT',
  headers: adminHeaders(),
  cookie,
  body: { arcadeEnabled: false },
});
check('arcade can be switched off', off.status === 200 && off.json?.settings?.arcadeEnabled === false);
const closed = await call('/api/arcade/sessions', { method: 'POST', body: {} });
check('closed arcade refuses new sessions', closed.status === 503, String(closed.status));
await call('/api/admin/settings', {
  method: 'PUT',
  headers: adminHeaders(),
  cookie,
  body: { arcadeEnabled: true },
});

/* pages */
const letterPage = await call('/the-letter');
check('GET /the-letter serves the letter page', letterPage.status === 200 && letterPage.text.includes('OPEN THE LETTER'));
const adminPage = await call('/admin/arcade');
check('GET /admin/arcade serves the admin shell', adminPage.status === 200 && adminPage.text.includes('admin-root'));
const home = await call('/');
check('homepage still renders', home.status === 200 && home.text.includes('CODE BUILTS'));
check('homepage contains the arcade section', home.text.includes('data-arcade'));

const logout = await call('/api/admin/logout', { method: 'POST', headers: adminHeaders(), cookie, body: {} });
check('logout succeeds', logout.status === 200);
const afterLogout = await call('/api/admin/session', { cookie });
check('the old cookie no longer works', afterLogout.status === 401, String(afterLogout.status));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('Failures:', failures.join(' | '));
  process.exit(1);
}
