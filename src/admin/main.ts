/** CODE BUILTS admin portal: authentication, shell and routing. */

import '../styles/admin.css';

import { AdminApiError, AdminAuthError, getJson, login, logout } from './api';
import { esc, toast } from './ui';
import {
  renderAudit,
  renderCoupons,
  renderOverview,
  renderPlayers,
  renderRedemptions,
  renderSessions,
  renderSettings,
  renderWinnerDetail,
  renderWinners,
  type ViewContext,
} from './views';

type ViewName =
  | 'overview'
  | 'winners'
  | 'sessions'
  | 'players'
  | 'coupons'
  | 'redemptions'
  | 'audit'
  | 'settings';

const ROUTES: { key: ViewName; label: string; hash: string; export: string | null }[] = [
  { key: 'overview', label: 'Overview', hash: '#/overview', export: 'sessions' },
  { key: 'winners', label: 'Winners & claims', hash: '#/winners', export: 'winners' },
  { key: 'sessions', label: 'Game sessions', hash: '#/sessions', export: 'sessions' },
  { key: 'players', label: 'Players', hash: '#/players', export: 'players' },
  { key: 'coupons', label: 'Coupons', hash: '#/coupons', export: 'coupons' },
  { key: 'redemptions', label: 'Redemptions', hash: '#/redemptions', export: 'redemptions' },
  { key: 'audit', label: 'Audit log', hash: '#/audit', export: null },
  { key: 'settings', label: 'Settings', hash: '#/settings', export: null },
];

const root = document.getElementById('admin-root');

function currentRoute(): { view: ViewName; id?: string } {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (!hash) return { view: 'overview' };
  const [view, id] = hash.split('/');
  if (view === 'winners' && id) return { view: 'winners', id };
  const known = ROUTES.find((route) => route.key === view);
  return { view: known ? known.key : 'overview' };
}

/* -------------------------------------------------------------------- login */

function showLogin(message = '', setup = false): void {
  if (!root) return;
  renderCurrent = null;
  document.title = 'Sign in — CODE BUILTS Admin';

  root.innerHTML = `
    <div class="admin-login">
      <form class="admin-login__card" data-login-form novalidate>
        <div class="admin-brand">
          <img src="/img/logo-mark-light.webp" width="753" height="335" alt="" />
          <span>CODE BUILTS <em>ADMIN</em></span>
        </div>
        <div>
          <h1>Arcade control room</h1>
          <p class="admin-login__copy">Private dashboard for the CODE BUILTS owner. Every session here is authorised server-side.</p>
        </div>

        ${
          setup
            ? `<div class="admin-setup">
                <p><strong>The portal is not configured yet.</strong></p>
                <p>Set these secrets on the server (local <code>.dev.vars</code> or Sites → Secrets), then reload:</p>
                <ul>
                  <li><code>ADMIN_EMAIL</code></li>
                  <li><code>ADMIN_PASSWORD_HASH</code> — run <code>npm run admin:hash -- "a long passphrase"</code></li>
                  <li><code>SESSION_SECRET</code> — any long random string</li>
                </ul>
              </div>`
            : ''
        }

        <label class="admin-field">
          <span>Email</span>
          <input name="email" type="email" autocomplete="username" required autofocus />
        </label>
        <label class="admin-field">
          <span>Password</span>
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <p class="admin-field__error" data-login-error role="alert">${esc(message)}</p>
        <button class="admin-btn admin-btn--primary admin-btn--block" type="submit">Sign in</button>
        <a class="admin-login__back" href="/">← Back to code builts</a>
      </form>
    </div>
  `;

  const form = root.querySelector<HTMLFormElement>('[data-login-form]');
  const error = root.querySelector<HTMLElement>('[data-login-error]');
  const submit = root.querySelector<HTMLButtonElement>('[data-login-form] button[type="submit"]');

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (error) error.textContent = '';
    const data = new FormData(form);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');

    if (!email || !password) {
      if (error) error.textContent = 'Enter your email and password.';
      return;
    }

    if (submit) {
      submit.disabled = true;
      submit.textContent = 'Signing in…';
    }

    try {
      await login(email, password);
      window.history.replaceState({}, '', '/admin/arcade');
      const session = await getJson<{ email: string; expiresAt: number }>('/api/admin/session');
      showDashboard(session.email);
    } catch (requestError) {
      if (error) {
        error.textContent =
          requestError instanceof AdminApiError || requestError instanceof AdminAuthError
            ? requestError.message
            : 'Could not reach the server.';
      }
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = 'Sign in';
      }
    }
  });
}

/* ------------------------------------------------------------------ shell */

let exportType: string | null = null;
let renderToken = 0;
let renderCurrent: (() => void) | null = null;

// Registered once for the life of the page, so signing out and back in cannot
// stack duplicate handlers.
window.addEventListener('hashchange', () => renderCurrent?.());
window.addEventListener('admin:unauthorized', () => showLogin('Your session expired. Sign in again.'));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') document.querySelector('.admin-shell')?.classList.remove('is-open');
});

function showDashboard(email: string): void {
  if (!root) return;
  document.title = 'CODE BUILTS — Arcade admin';

  root.innerHTML = `
    <div class="admin-shell">
      <aside class="admin-side" data-side aria-label="Admin navigation">
        <div class="admin-brand">
          <img src="/img/logo-mark-light.webp" width="753" height="335" alt="" />
          <span>CODE BUILTS <em>ADMIN</em></span>
        </div>

        <nav class="admin-nav">
          ${ROUTES.map(
            (route) => `<a href="${route.hash}" data-nav="${route.key}">${route.label}</a>`,
          ).join('')}
        </nav>

        <div class="admin-side__foot">
          <p class="admin-side__email" title="Signed in as">${esc(email)}</p>
          <a class="admin-side__link" href="/" target="_blank" rel="noopener">View site ↗</a>
          <button class="admin-btn admin-btn--ghost admin-btn--block" type="button" data-logout>
            Sign out
          </button>
        </div>
      </aside>

      <div class="admin-main">
        <header class="admin-topbar">
          <button class="admin-icon admin-menu" type="button" data-menu aria-expanded="false" aria-label="Open navigation">
            <span></span><span></span><span></span>
          </button>
          <div class="admin-topbar__title">
            <span class="admin-kicker">CODE BUILTS ARCADE</span>
            <h1 data-title>Overview</h1>
            <p data-subtitle></p>
          </div>
          <div class="admin-topbar__actions">
            <button class="admin-btn admin-btn--ghost" type="button" data-refresh>Refresh</button>
            <button class="admin-btn admin-btn--ghost" type="button" data-export hidden>Export CSV</button>
          </div>
        </header>

        <main class="admin-view" id="admin-view" tabindex="-1"></main>
      </div>
    </div>
  `;

  const shell = root.querySelector<HTMLElement>('.admin-shell');
  const view = root.querySelector<HTMLElement>('#admin-view');
  const titleEl = root.querySelector<HTMLElement>('[data-title]');
  const subtitleEl = root.querySelector<HTMLElement>('[data-subtitle]');
  const exportButton = root.querySelector<HTMLButtonElement>('[data-export]');
  const menuButton = root.querySelector<HTMLButtonElement>('[data-menu]');
  if (!view) return;

  const ctx: ViewContext = {
    email,
    setTitle(title, subtitle) {
      if (titleEl) titleEl.textContent = title;
      if (subtitleEl) subtitleEl.textContent = subtitle;
    },
    setExport(type) {
      exportType = type;
      if (!exportButton) return;
      exportButton.hidden = !type;
      exportButton.dataset.export = type ?? '';
    },
    go(hash) {
      window.location.hash = hash;
    },
  };

  const navigate = async () => {
    if (!view) return;
    const route = currentRoute();
    const token = ++renderToken;

    root.querySelectorAll<HTMLElement>('[data-nav]').forEach((link) => {
      const isWinners = route.view === 'winners' && link.dataset.nav === 'winners';
      link.classList.toggle('is-active', link.dataset.nav === route.view || isWinners);
      if (link.dataset.nav === route.view || isWinners) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });

    shell?.classList.remove('is-open');
    menuButton?.setAttribute('aria-expanded', 'false');
    exportType = null;
    if (exportButton) exportButton.hidden = true;

    try {
      if (route.id) await renderWinnerDetail(view, route.id, ctx);
      else if (route.view === 'overview') await renderOverview(view, ctx);
      else if (route.view === 'winners') await renderWinners(view, ctx);
      else if (route.view === 'sessions') await renderSessions(view, ctx);
      else if (route.view === 'players') await renderPlayers(view, ctx);
      else if (route.view === 'coupons') await renderCoupons(view, ctx);
      else if (route.view === 'redemptions') await renderRedemptions(view, ctx);
      else if (route.view === 'audit') await renderAudit(view, ctx);
      else await renderSettings(view, ctx);
    } catch (error) {
      if (error instanceof AdminAuthError) {
        showLogin('Your session expired. Sign in again.');
        return;
      }
      if (token !== renderToken) return;
      toast(error instanceof Error ? error.message : 'Could not load that view.', 'error');
    }
  };

  renderCurrent = () => void navigate();

  menuButton?.addEventListener('click', () => {
    const open = shell?.classList.toggle('is-open') ?? false;
    menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  root.querySelector('[data-refresh]')?.addEventListener('click', () => void navigate());
  exportButton?.addEventListener('click', () => {
    if (exportType) window.location.assign(`/api/admin/export/${exportType}`);
  });

  root.querySelector('[data-logout]')?.addEventListener('click', async () => {
    try {
      await logout();
    } catch {
      /* signing out locally still drops the session cookie */
    }
    window.history.replaceState({}, '', '/admin/login');
    showLogin('Signed out.');
  });

  if (!window.location.hash) window.location.hash = '#/overview';
  void navigate();
}

/* ------------------------------------------------------------------- boot */

async function boot(): Promise<void> {
  if (!root) return;
  try {
    const session = await getJson<{ email: string; expiresAt: number }>('/api/admin/session');
    if (window.location.pathname === '/admin/login' || window.location.pathname === '/admin/') {
      window.history.replaceState({}, '', '/admin/arcade');
    }
    showDashboard(session.email);
  } catch (error) {
    if (error instanceof AdminAuthError) {
      showLogin();
      return;
    }
    if (error instanceof AdminApiError && error.code === 'ADMIN_NOT_CONFIGURED') {
      showLogin('', true);
      return;
    }
    showLogin(error instanceof Error ? error.message : 'Could not reach the admin API.');
  }
}

void boot();
