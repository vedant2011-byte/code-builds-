# CODE BUILTS — Build Smart. Build Better.

The CODE BUILTS site: a cinematic brand intro (two reconstructed films), a four-step scroll film,
a full editorial agency site — followed by **CODE BUILTS ARCADE**, **A LETTER FROM CODE BUILTS**,
and a private **admin portal** with a real backend, database, rewards and coupons.

Frontend: **Vite + TypeScript + hand-authored CSS**. No UI framework, no runtime animation library,
self-hosted Geist. Backend: **Cloudflare Worker + D1 (SQLite)**, hand-written routing, WebCrypto,
no runtime dependencies. Everything shares the same design tokens.

```bash
npm install
npm run dev        # site      → http://127.0.0.1:5173  (proxies /api to :8787)
npm run dev:api    # Worker    → http://127.0.0.1:8787  (local D1)
npm run build      # typecheck + site build + Worker bundle
npm run typecheck  # site and Worker
```

The arcade needs both processes: the game's score, session and coupon live in the Worker.

---

## 1. The intro (unchanged)

`src/intro.ts` runs one deterministic sequence:

| Stage | What happens |
| --- | --- |
| Loader | Real asset progress: logo decode, font loading, and the actual bytes of `film-01.mp4`. Minimum display ~1.1 s, no fake timer. |
| Film 01 | `film-01.mp4` autoplays muted, inline. The progress rail tracks real playback. On end → Film 02. |
| Film 02 | Four **scroll** steps (wheel, swipe, ArrowDown/PageDown). Each plays one chapter of the same continuous camera move and pauses at the next hold point. The fourth opens the site. |
| Site | Overlay removed, scroll unlocked, nav drops in. |

Framing: the source footage is portrait (720×1280). Phones show the native 9:16 frame; from
901 px up the same video is reframed for landscape (`object-fit: cover` with a lifted
`object-position` per film). The sequence plays in full — there are no skip buttons. Escape
hatches exist only for failure: autoplay blocked, download/decode failure, reduced motion,
data-saver, no JavaScript, an 18 s watchdog, and a 16 s idle auto-advance in film 02.

## 2. Site ending sequence

```
EXISTING SITE (hero → services → approach → mission → vision → statement → contact)
        ↓
CODE BUILTS ARCADE              #arcade
        ↓
A LETTER FROM CODE BUILTS       #letter  (and /the-letter)
        ↓
EXISTING FOOTER
```

Navigation gained one link (`Arcade`); the footer NAVIGATE column gained `Arcade` and `The Letter`.
Nothing else in the existing sections, services, copy, CTAs or animations was changed.

## 3. CODE BUILTS ARCADE

`src/arcade.ts` + `src/styles/arcade.css`, markup in `index.html` (`#arcade`), rules in
`shared/arcade.ts`.

- Canvas 2D, `requestAnimationFrame`, one loop, no engine. DPR capped at 2, resized with a
  `ResizeObserver`, listeners cleaned up by living on the section instance.
- Controls: ← →, A/D, mouse movement, touch drag (`touch-action: none`, so the page never
  scrolls under a drag). Escape or the toolbar pauses; the game pauses itself when scrolled away
  or when the tab is hidden.
- Difficulty: ball speed starts at ~0.92 × canvas height per second (+20% on *challenging*,
  −18% on *relaxed*) and gains 4.5% per return, capped at 2.35×. A typical run lasts 30–45 s;
  skilled players keep going.
- Sound is off by default (WebAudio blips, preference stored locally). Reduced motion removes the
  trail and glow; the game itself still works.
- Personal best is stored locally (`cb.arcade.best`) and is a convenience only — rewards always
  come from the server-verified score.

Scoring: **10 points per verified paddle return**. 100 → 2%, 200 → 5%, 300 → 7%, 400+ → 10%.
Reward tiers, difficulty, validity and eligibility are all editable in the admin settings.

### How the score is actually verified

The browser is never trusted with a score. `POST /api/arcade/sessions` creates a session row with
a random token (only its SHA-256 is stored). While playing, the game posts accepted bounces in
batches (`{seq, t}`, `t` = ms since start). The Worker:

1. checks the token, session state and expiry;
2. requires contiguous sequence numbers and strictly increasing timestamps with at least
   **120 ms between bounces** (faster than a paddle return can physically happen);
3. rejects timestamps in the future beyond a 2 s clock tolerance, or past the 4-minute cap;
4. refuses a batch containing more bounces than the elapsed wall-clock time allows;
5. **counts the accepted events itself** and derives `score = bounces × 10` — the client-submitted
   number is never used;
6. on finish, re-checks the duration against the event log and the wall clock, and flags
   impossible runs.

A flagged session is stored (with reasons) for review, cannot produce a coupon, and appears in the
admin dashboard. Rate limits: 40 sessions/hour per IP, 6 claims/hour per IP and 5 claims/day per
email. A `UNIQUE` constraint on `reward_claims.session_id` makes duplicate claims impossible.

**Limitation, stated plainly:** this is a server-checked, server-counted game, not an
uncheatable one. A determined person can script plausible bounce timings to a public API. The
checks raise the cost and make fraud visible, and the admin can reject/revoke anything it issues.

## 4. Rewards and coupons

- Each eligible claim creates a player record (email is unique, case-insensitive), a pending claim,
  and a coupon code in the format `CB-<discount>-XXXXXX` (unambiguous alphabet, generated with
  `crypto.getRandomValues`, uniqueness checked in the database).
- Coupons are issued **active** immediately because the session was verified; the claim itself
  stays `pending` in the admin until reviewed. Rejecting a claim revokes its coupon; a rejected
  claim can never produce a redeemable coupon.
- Each coupon snapshots its own terms — discount, issue date, expiry, validity days, minimum
  project value, max uses and eligible services — so changing settings later never alters an
  existing coupon.
- Status lifecycle: `PENDING → ACTIVE → REDEEMED`, plus `EXPIRED` (computed on read and refused at
  redemption) and `REVOKED`.
- Redemption is a separate, explicit step. Winning is not buying: an admin records the actual
  purchase (service, original amount, reference), and the coupon then shows `REDEEMED` with the
  discount amount and final price. Redemption is transactional: guarded `INSERT … SELECT`,
  `UNIQUE(coupon_id)` plus a conditional update, so it cannot happen twice.
- The coupon card offers a copy button and a WhatsApp hand-off that pre-fills the code — the same
  contact channel the existing enquiry form uses.

## 5. A LETTER FROM CODE BUILTS

`src/letter.ts` + `src/styles/letter.css`; used by the homepage `#letter` section and the
dedicated `/the-letter` page (`the-letter.html`, `src/letter-page.ts`).

- Initial screen: CODE BUILTS / A MESSAGE FOR YOU + *"Not everything needs to be sold…"* and an
  **OPEN THE LETTER** button.
- Character-by-character typing with jittered speed, longer pauses at punctuation, a blinking
  cursor, paragraph fades, pause/resume, skip, restart and optional typing sound (off by default,
  remembered locally).
- `prefers-reduced-motion` reveals the whole letter instantly with the same ending.
- After the last line the cursor disappears, the signature fades in, then the closing message and
  two buttons: **LET'S BUILD SOMETHING** (→ contact on the homepage) and **BACK TO TOP**.
- The homepage version links to the full-page version, and vice versa.

## 6. Admin portal

Routes: `/admin/login` and `/admin/arcade` (served by `admin.html`; the Worker rewrites the clean
URLs and sends `noindex`). Client code in `src/admin/`, styles in `src/styles/admin.css`.

- **Overview** — sessions, players, winners, coupons, pending claims, redemptions, discount given,
  flagged sessions, plus charts for sessions/claims over time, reward distribution, redemption
  rate and highest scores. Every number is an SQL aggregate.
- **Winners & claims** — searchable, sortable, filterable table (verification, reward, coupon
  state), row-level detail with player, session, events, coupon, redemption, previous claims,
  notes and the decision history.
- **Winner detail** — approve, reject (reason required), revoke the coupon, record a redemption,
  add internal notes. Every action is written to the audit log.
- **Game sessions** — every run, its timing checks and suspicion reasons.
- **Players**, **Coupons** (search/status/reward filters, manual issue, revoke, redeem),
  **Redemptions** (real purchases only), **Audit log** (append-only), **Settings**.
- CSV export for players, sessions, winners, coupons and redemptions.
- Responsive: off-canvas sidebar, tables scroll inside their own container, no page-level
  horizontal overflow at 390 px.

### Authentication

- Single administrator configured entirely by secrets: `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`,
  `SESSION_SECRET`. There is no registration page and no default password.
- Password hashes are PBKDF2-SHA-256, 210 000 iterations, generated by
  `npm run admin:hash -- "a long passphrase"`; verification happens in the Worker with constant-time
  comparison. The password itself is never stored.
- Sessions: random id, HMAC-SHA-256 signed cookie (`HttpOnly`, `SameSite=Strict`, `Secure` on
  HTTPS), 12-hour expiry, revocable server-side (`admin_sessions.revoked`), stored hashed IP.
- Login rate limit: 10 attempts/15 min per IP and 6/15 min per email, enforced with an atomic D1
  counter.
- CSRF: same-origin check against `APP_ORIGIN` **plus** a required `X-CB-Request: 1` header on every
  mutation, alongside the strict cookie.
- Every admin route and export requires a valid session; `GET /api/admin/*` without a cookie
  returns 401. The audit log has no update or delete endpoint.

## 7. API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/arcade/config` | Public settings, tiers, eligibility |
| POST | `/api/arcade/sessions` | Start a verified session |
| POST | `/api/arcade/sessions/:id/events` | Submit bounce events (token required) |
| POST | `/api/arcade/sessions/:id/finish` | Close the run, get the verified score and reward |
| POST | `/api/arcade/claims` | Claim a reward, issue the coupon |
| POST | `/api/admin/login` · `/logout` | Admin session |
| GET | `/api/admin/session` | Current admin |
| GET | `/api/admin/overview?days=30` | Dashboard aggregates + series |
| GET | `/api/admin/claims` · `/claims/:id` | Winners list and detail |
| POST | `/api/admin/claims/:id/verify` · `/reject` · `/notes` | Review workflow |
| GET/POST | `/api/admin/coupons` | List / issue manually |
| POST | `/api/admin/coupons/:id/revoke` · `/redeem` | Coupon lifecycle |
| GET | `/api/admin/redemptions` | Recorded purchases |
| GET/PUT | `/api/admin/settings` | Arcade configuration |
| GET | `/api/admin/audit` | Audit log |
| GET | `/api/admin/export/{players\|sessions\|winners\|coupons\|redemptions}` | CSV |

All API responses are `no-store`; public mutations are same-origin only.

## 8. Database

SQLite (Cloudflare D1). Tables: `players`, `game_sessions`, `game_events`, `reward_claims`,
`coupons`, `redemptions`, `settings`, `admin_notes`, `audit_log`, `admin_sessions`, `rate_limits`.
Foreign keys, unique constraints (player email, claim→session, coupon code, redemption→coupon),
indexes on every queried column, integer timestamps, whole-rupee amounts, and transactions via
`db.batch()`.

`schema` lives in `migrations/0001_init.sql` **and** in `worker/src/db.ts`, which applies it
idempotently on the first API request — so a fresh database from a deployment is usable without a
manual step. Apply manually if you prefer:

```bash
npm run db:migrate:local                                     # local D1
npx wrangler d1 execute code-builts-arcade --remote \
  --file=migrations/0001_init.sql --config wrangler.jsonc    # deployed D1
```

## 9. Local setup

1. `npm install`
2. `cp .dev.vars.example .dev.vars`, then generate the hash:
   `npm run admin:hash -- "a long local passphrase"` and paste it into `.dev.vars`, along with
   `ADMIN_EMAIL`, a random `SESSION_SECRET`, and `APP_ORIGIN` (defaults are in the example file).
3. `npm run dev:api` (Worker + local D1 on :8787) and `npm run dev` (site on :5173).

`.dev.vars` is git-ignored; never commit it.

## 10. Deployment

Build first (the Worker bundle is generated, not committed):

```bash
npm run build     # dist/ + worker/dist/index.js
```

**Cloudflare directly — the live production API**

The Worker is deployed on the Cloudflare account as `code-builts` and answers on
`https://code-builts.codebuilds.workers.dev`. Its D1 database `code-builts-arcade`
(`c1ca306a-f9e1-4edc-9721-88fc91bcea4a`) is already created and migrated, and the three admin
secrets are already set. `wrangler.jsonc` carries both the real `database_id` and
`APP_ORIGIN=https://codebuilds.vercel.app`.

```bash
npx wrangler login
npm run deploy:worker                            # build + deploy
npx wrangler secret bulk work/prod-secrets.json  # ADMIN_EMAIL, ADMIN_PASSWORD_HASH, SESSION_SECRET
```

`ADMIN_PASSWORD_HASH` must be generated at **100,000** PBKDF2 iterations or fewer — the Workers
runtime rejects anything higher with `Pbkdf2 failed: iteration counts above 100000 are not
supported`, which surfaces as a 500 on `POST /api/admin/login`. `npm run admin:hash` produces the
right format.

**Vercel frontend** — the site calls `/api/...` on its own origin, so `vercel.json` rewrites
`/api/:path*` to the Worker. No CORS is involved and the admin cookie stays same-origin. Re-deploy
the Vercel project after changing `vercel.json` or the Worker host.

Vercel serves `dist/` statically, and Vite emits `index.html`, `the-letter.html` and `admin.html`,
so `vercel.json` also maps the clean URLs the site links to: `/the-letter` → `/the-letter.html`,
`/admin` and `/admin/:path*` (e.g. `/admin/login`, `/admin/arcade`) → `/admin.html`. Without those
rewrites Vercel answers those paths with its own `404 NOT_FOUND`, while the Worker origin still
works — that mismatch is what broke the production dashboard. Keep the `/api/:path*` rewrite first;
nothing falls back to `/index.html`, so unknown paths stay 404.

**Freebuff Sites** — add a D1 database with binding `DB` to the environment, then deploy the
prebuilt manifest in `deploy.json` (`worker/dist/index.js` + `dist/`). Sites injects `DB`,
`APP_ORIGIN` and the platform variables; set the three admin secrets in Sites → Secrets, then
deploy once so the schema initialises on the first request.

Required variables:

| Name | Purpose |
| --- | --- |
| `ADMIN_EMAIL` | The only administrator address |
| `ADMIN_PASSWORD_HASH` | `pbkdf2$sha256$100000$…` from `npm run admin:hash` |
| `SESSION_SECRET` | Long random string that signs the admin cookie |
| `APP_ORIGIN` | Allowed origin(s), comma separated (Sites injects this) |
| `ENVIRONMENT` | Optional label |

The Worker serves `/the-letter`, `/admin/*` and `/api/*` itself and falls through to `dist/` for
everything else, so a Worker-hosted deployment needs no extra routing (assets with
`run_worker_first` in `wrangler.jsonc`, or the Sites manifest). A static host such as Vercel has to
map those clean URLs itself — see the `vercel.json` rewrites above.

## 11. Before launch / known limitations

- Update `https://codebuilts.com` in `public/sitemap.xml` and `public/robots.txt` to the real domain.
- The contact form still hands the enquiry to WhatsApp/email exactly as before; it does not post to
  the Worker. The coupon card reuses the same WhatsApp number.
- Arcade scores are server-checked (see §3) but not uncheatable; review flagged sessions and
  pending claims in the admin.
- Automated coverage is the API/integration suite (`npm run test:api`, 71 assertions) plus type and
  production builds. The canvas game loop, typewriter animation and CSS transitions run on
  `requestAnimationFrame`/timers and were not exercised visually in the last run (the shared
  browser tab reported `visibilityState: "hidden"`, which freezes both). Play a full run and open
  the letter once in a normal browser tab before launch.
- The intro media pipeline below is unchanged and still the source of truth for the films.

## 12. Media pipeline (already run)

Source: the two supplied ZIPs — 300 JPG frames each, 720×1280, 30 FPS.

```bash
# 1. Extract (originals kept in the project root)
unzip -q clean_Miniature_workers_building_typew_f67b49b01-ezgif-split.zip -d assets/frames/v1
unzip -q clean_Typewriter_miniature_constructio_7105981f-ezgif-split.zip -d assets/frames/v2

# 2. Rebuild at exactly 30 FPS, native 720×1280, H.264 / yuv420p / faststart.
#    Denoise → gentle sharpen → CRF 23 (the source grain reads as noise when full-bleed).
ffmpeg -framerate 30 -i assets/frames/v1/ezgif-frame-%03d.jpg \
  -vf "nlmeans=s=7:p=5:r=13,unsharp=5:5:0.6:5:5:0,format=yuv420p" \
  -c:v libx264 -profile:v high -level 4.0 -crf 23 -preset slow \
  -g 30 -keyint_min 30 -sc_threshold 0 -movflags +faststart -an public/media/film-01.mp4
```

`film-01.mp4` — 300 frames, 30 fps, 10.000 s, 720×1280, 4.1 MB.
`film-02.mp4` — 300 frames, 30 fps, 10.000 s, 720×1280, 7.4 MB.
Posters are frame 001 through the same chain. WebM/VP9 tested larger for this footage.

## 13. Project map

```
index.html                site, intro shell, arcade + letter sections, SEO
the-letter.html           dedicated letter page
admin.html                admin shell (served at /admin/login and /admin/arcade)
src/main.ts               entry: UI, letter, arcade, intro
src/intro.ts              loader, film state machine, scroll chapters
src/ui.ts                 reveals, nav, menu, accordions, process timeline, form
src/arcade.ts             canvas game, controls, sound, server sync, claim flow
src/letter.ts             typewriter letter (homepage + full page)
src/letter-page.ts        /the-letter entry
src/admin/                api client, views, UI primitives, bootstrap/routing
src/styles/               base, site, intro, arcade, letter, admin
shared/arcade.ts          rules shared by browser and Worker
worker/src/index.ts       routing, page rewrites, asset fallback
worker/src/arcade.ts      sessions, event validation, claims, coupons
worker/src/admin.ts       auth, dashboard queries, review, redemptions, settings, CSV
worker/src/db.ts          schema, settings, players, audit, expiry
worker/src/crypto.ts      tokens, HMAC, PBKDF2, constant-time compare
worker/src/http.ts        JSON, errors, cookies, rate limits, CSV
migrations/0001_init.sql  schema
scripts/                  worker build, password hash, API test suite
public/media/             films, posters, stills
public/img/               logo lockup, white mark, icons, OG
```
