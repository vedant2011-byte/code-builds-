/** Admin views. Each renderer fetches real data, paints, then binds its own events. */

import {
  AdminApiError,
  AdminAuthError,
  getJson,
  sendJson,
  query,
  type AuditRow,
  type ClaimDetail,
  type ClaimRow,
  type CouponRow,
  type Overview,
  type PlayerRow,
  type RedemptionRow,
  type SessionMeta,
  type SessionRow,
  type SettingsPayload,
} from './api';
import {
  areaChart,
  badge,
  barList,
  confirmDialog,
  debounce,
  emptyState,
  errorState,
  esc,
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtMoney,
  loading,
  openModal,
  pagination,
  promptDialog,
  statusOptions,
  toast,
} from './ui';

export interface ViewContext {
  email: string;
  setTitle(title: string, subtitle: string): void;
  setExport(type: string | null): void;
  go(hash: string): void;
}

/* ----------------------------------------------------------------- helpers */

function failed(view: HTMLElement, error: unknown): void {
  if (error instanceof AdminAuthError) {
    window.dispatchEvent(new Event('admin:unauthorized'));
    return;
  }
  view.innerHTML = errorState(
    error instanceof AdminApiError ? error.message : 'The dashboard could not reach the server.',
  );
}

function pageMeta(meta: SessionMeta): string {
  return pagination(meta);
}

function bindPager(view: HTMLElement, load: (page: number) => void): void {
  view.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((button) => {
    button.addEventListener('click', () => {
      const page = Number(button.dataset.page);
      if (Number.isFinite(page) && page > 0) load(page);
    });
  });
}

function card(label: string, value: string, note: string, accent = false): string {
  return `
    <article class="admin-card admin-stat${accent ? ' admin-stat--accent' : ''}">
      <span class="admin-stat__label">${esc(label)}</span>
      <span class="admin-stat__value">${esc(value)}</span>
      <span class="admin-stat__note">${esc(note)}</span>
    </article>
  `;
}

function parseServices(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------- overview */

export async function renderOverview(view: HTMLElement, ctx: ViewContext): Promise<void> {
  ctx.setTitle('Overview', 'Every number below comes from the arcade database.');
  ctx.setExport('sessions');
  view.innerHTML = loading('Reading sessions, claims and coupons…');

  try {
    const data = await getJson<Overview>('/api/admin/overview?days=30');
    const tierBars = data.coupons.byDiscount
      .slice()
      .sort((a, b) => b.discount - a.discount)
      .map((row) => ({
        label: `${row.discount}% off`,
        value: row.issued,
        hint: `${row.redeemed} redeemed`,
      }));

    view.innerHTML = `
      <section class="admin-cards">
        ${card('Game sessions', String(data.sessions.total), `${data.sessions.inRange} in the last ${data.rangeDays} days`)}
        ${card('Unique players', String(data.players.total), 'One record per verified email')}
        ${card('Reward winners', String(data.claims.total), `${data.claims.verified} verified · ${data.claims.pending} pending`)}
        ${card('Coupons issued', String(data.coupons.total), `${data.coupons.active} active right now`)}
        ${card('Pending claims', String(data.claims.pending), 'Waiting for review', data.claims.pending > 0)}
        ${card('Redeemed coupons', String(data.coupons.redeemed), `${data.coupons.redemptionRate}% of issued coupons`)}
        ${card('Discount redeemed', fmtMoney(data.redemptions.discountTotal), `${data.redemptions.total} recorded purchase${data.redemptions.total === 1 ? '' : 's'}`)}
        ${card('Flagged sessions', String(data.sessions.flagged), 'Failed server-side checks')}
      </section>

      <section class="admin-charts">
        <article class="admin-card admin-chart admin-chart--wide">
          <header class="admin-card__head">
            <h2>Sessions over time</h2>
            <span>${data.rangeDays} days</span>
          </header>
          ${areaChart(data.series)}
        </article>

        <article class="admin-card admin-chart">
          <header class="admin-card__head"><h2>Reward distribution</h2><span>Issued coupons</span></header>
          ${barList(tierBars)}
          <dl class="admin-mini-stats">
            <div><dt>2%</dt><dd>${data.coupons.byDiscount.find((row) => row.discount === 2)?.issued ?? 0}</dd></div>
            <div><dt>5%</dt><dd>${data.coupons.byDiscount.find((row) => row.discount === 5)?.issued ?? 0}</dd></div>
            <div><dt>7%</dt><dd>${data.coupons.byDiscount.find((row) => row.discount === 7)?.issued ?? 0}</dd></div>
            <div><dt>10%</dt><dd>${data.coupons.byDiscount.find((row) => row.discount === 10)?.issued ?? 0}</dd></div>
          </dl>
        </article>

        <article class="admin-card admin-chart">
          <header class="admin-card__head"><h2>Coupon redemption</h2><span>Issued vs used</span></header>
          <p class="admin-rate"><b>${data.coupons.redemptionRate}%</b><span>of issued coupons were redeemed</span></p>
          <div class="admin-meter"><span style="width:${Math.min(100, data.coupons.redemptionRate)}%"></span></div>
          <dl class="admin-mini-stats admin-mini-stats--4">
            <div><dt>Active</dt><dd>${data.coupons.active}</dd></div>
            <div><dt>Redeemed</dt><dd>${data.coupons.redeemed}</dd></div>
            <div><dt>Expired</dt><dd>${data.coupons.expired}</dd></div>
            <div><dt>Revoked</dt><dd>${data.coupons.revoked}</dd></div>
          </dl>
        </article>

        <article class="admin-card admin-chart">
          <header class="admin-card__head"><h2>Highest scores</h2><span>Verified sessions</span></header>
          ${barList(
            data.topScores.map((row) => ({
              label: row.name ?? 'Guest player',
              value: row.score,
              hint: row.discount ? `${row.discount}%` : '',
            })),
          )}
        </article>
      </section>

      <section class="admin-split">
        <article class="admin-card">
          <header class="admin-card__head">
            <h2>Latest coupons</h2>
            <button class="admin-link" type="button" data-goto="#/coupons">All coupons</button>
          </header>
          ${
            data.recentCoupons.length
              ? `<div class="admin-table-wrap"><table class="admin-table">
                  <thead><tr><th>Code</th><th>Player</th><th>Reward</th><th>Status</th><th>Issued</th></tr></thead>
                  <tbody>${data.recentCoupons
                    .map(
                      (row) => `<tr>
                        <td><code>${esc(row.code)}</code></td>
                        <td>${esc(row.name)}<span class="admin-sub">${esc(row.email)}</span></td>
                        <td>${row.discount}%</td>
                        <td>${badge(row.status)}</td>
                        <td>${fmtDate(row.issued_at)}</td>
                      </tr>`,
                    )
                    .join('')}</tbody>
                </table></div>`
              : emptyState('No coupons yet', 'Coupons appear here the moment a player claims a reward.')
          }
        </article>

        <article class="admin-card">
          <header class="admin-card__head">
            <h2>Top sessions</h2>
            <button class="admin-link" type="button" data-goto="#/winners">Winners</button>
          </header>
          ${
            data.topScores.length
              ? `<div class="admin-table-wrap"><table class="admin-table">
                  <thead><tr><th>Player</th><th>Score</th><th>Duration</th><th>Reward</th><th>Played</th></tr></thead>
                  <tbody>${data.topScores
                    .map(
                      (row) => `<tr>
                        <td>${esc(row.name ?? 'Guest player')}<span class="admin-sub">${esc(row.email ?? 'not claimed')}</span></td>
                        <td>${row.score}</td>
                        <td>${fmtDuration(row.duration_ms)}</td>
                        <td>${row.discount ? `${row.discount}%` : '—'}</td>
                        <td>${fmtDate(row.started_at)}</td>
                      </tr>`,
                    )
                    .join('')}</tbody>
                </table></div>`
              : emptyState('No finished sessions', 'Sessions are recorded as soon as someone presses START GAME.')
          }
        </article>
      </section>
    `;

    view.querySelectorAll<HTMLElement>('[data-goto]').forEach((button) => {
      button.addEventListener('click', () => ctx.go(button.dataset.goto ?? '#/overview'));
    });
  } catch (error) {
    failed(view, error);
  }
}

/* ----------------------------------------------------------------- winners */

const winnersState = {
  page: 1,
  q: '',
  status: 'all',
  discount: 'all',
  coupon: 'all',
  sort: 'recent',
};

export async function renderWinners(view: HTMLElement, ctx: ViewContext): Promise<void> {
  ctx.setTitle('Winners', 'Claims, coupons and verification in one place.');
  ctx.setExport('winners');

  const load = async (page = winnersState.page) => {
    winnersState.page = page;
    view.innerHTML = loading('Loading claims…');
    try {
      const data = await getJson<{ rows: ClaimRow[]; page: number; pageSize: number; total: number; pages: number }>(
        `/api/admin/claims${query({
          page,
          q: winnersState.q,
          status: winnersState.status,
          discount: winnersState.discount,
          coupon: winnersState.coupon,
          sort: winnersState.sort,
        })}`,
      );

      view.innerHTML = `
        <div class="admin-toolbar">
          <input class="admin-search" type="search" placeholder="Search name, email, phone, coupon or session"
            value="${esc(winnersState.q)}" data-search aria-label="Search winners" />
          <select data-filter="status" aria-label="Verification status">${statusOptions(
            ['pending', 'verified', 'rejected'],
            winnersState.status,
            'All verification',
          )}</select>
          <select data-filter="discount" aria-label="Reward percentage">
            ${['all', '2', '5', '7', '10']
              .map(
                (value) =>
                  `<option value="${value}"${winnersState.discount === value ? ' selected' : ''}>${
                    value === 'all' ? 'All rewards' : `${value}% off`
                  }</option>`,
              )
              .join('')}
          </select>
          <select data-filter="coupon" aria-label="Coupon status">${statusOptions(
            ['active', 'pending', 'redeemed', 'expired', 'revoked'],
            winnersState.coupon,
            'All coupons',
          )}</select>
          <select data-filter="sort" aria-label="Sort order">
            ${[
              ['recent', 'Newest claim'],
              ['score', 'Highest score'],
              ['expiry', 'Expiring soon'],
              ['name', 'Player name'],
            ]
              .map(
                ([value, label]) =>
                  `<option value="${value}"${winnersState.sort === value ? ' selected' : ''}>${label}</option>`,
              )
              .join('')}
          </select>
        </div>

        ${
          data.rows.length
            ? `<div class="admin-table-wrap"><table class="admin-table admin-table--winners">
                <thead>
                  <tr>
                    <th>Player</th><th>Phone</th><th>Score</th><th>Reward</th><th>Coupon</th>
                    <th>Session</th><th>Played</th><th>Claimed</th><th>Expiry</th>
                    <th>Verification</th><th>Coupon status</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  ${data.rows
                    .map(
                      (row) => `<tr>
                        <td>
                          <strong>${esc(row.name)}</strong>
                          <span class="admin-sub">${esc(row.email)}</span>
                        </td>
                        <td>${esc(row.phone ?? '—')}</td>
                        <td>${row.score}</td>
                        <td>${row.discount}%</td>
                        <td>${row.code ? `<code>${esc(row.code)}</code>` : '—'}</td>
                        <td><code class="admin-mono-sm">${esc(row.session_id.slice(0, 8))}…</code></td>
                        <td>${fmtDate(row.started_at)}</td>
                        <td>${fmtDateTime(row.created_at)}</td>
                        <td>${fmtDate(row.expires_at)}</td>
                        <td>${badge(row.status)}${row.suspicious ? '<span class="admin-flag">FLAGGED</span>' : ''}</td>
                        <td>${badge(row.coupon_status)}</td>
                        <td><button class="admin-link" type="button" data-open="${esc(row.id)}">Open</button></td>
                      </tr>`,
                    )
                    .join('')}
                </tbody>
              </table></div>
              ${pageMeta(data)}`
            : emptyState(
                'No claims match',
                'Adjust the filters, or wait for the next visitor to beat the game.',
              )
        }
      `;

      view.querySelectorAll<HTMLElement>('[data-open]').forEach((button) => {
        button.addEventListener('click', () => ctx.go(`#/winners/${button.dataset.open}`));
      });
      bindPager(view, load);

      view.querySelectorAll<HTMLSelectElement>('[data-filter]').forEach((select) => {
        select.addEventListener('change', () => {
          const key = select.dataset.filter as 'status' | 'discount' | 'coupon' | 'sort';
          winnersState[key] = select.value;
          void load(1);
        });
      });

      const search = view.querySelector<HTMLInputElement>('[data-search]');
      search?.addEventListener(
        'input',
        debounce(() => {
          winnersState.q = search.value.trim();
          void load(1);
        }),
      );
    } catch (error) {
      failed(view, error);
    }
  };

  await load(1);
}

/* ------------------------------------------------------------ winner detail */

export async function renderWinnerDetail(view: HTMLElement, id: string, ctx: ViewContext): Promise<void> {
  ctx.setTitle('Player record', 'Verification, coupon and redemption history.');
  ctx.setExport('winners');
  view.innerHTML = loading('Loading the full record…');

  const load = async () => {
    try {
      const data = await getJson<ClaimDetail>(`/api/admin/claims/${encodeURIComponent(id)}`);
      const { claim, player, session, coupon, redemption, events, history, notes, audit } = data;

      view.innerHTML = `
        <div class="admin-detail-head">
          <button class="admin-btn admin-btn--ghost" type="button" data-back>← All winners</button>
          <div class="admin-detail-head__actions">
            ${
              claim.status !== 'verified'
                ? '<button class="admin-btn admin-btn--primary" type="button" data-verify>Approve claim</button>'
                : ''
            }
            ${
              claim.status !== 'rejected'
                ? '<button class="admin-btn admin-btn--danger" type="button" data-reject>Reject claim</button>'
                : ''
            }
            <button class="admin-btn admin-btn--ghost" type="button" data-note>Add note</button>
          </div>
        </div>

        <div class="admin-detail-grid">
          <article class="admin-card">
            <header class="admin-card__head"><h2>Player information</h2>${badge(claim.status)}</header>
            <dl class="admin-dl">
              <div><dt>Name</dt><dd>${esc(player.name)}</dd></div>
              <div><dt>Email</dt><dd><a href="mailto:${esc(player.email)}">${esc(player.email)}</a></dd></div>
              <div><dt>Phone</dt><dd>${esc(player.phone ?? '—')}</dd></div>
              <div><dt>First seen</dt><dd>${fmtDateTime(player.created_at)}</dd></div>
              <div><dt>Claim date</dt><dd>${fmtDateTime(claim.created_at)}</dd></div>
            </dl>
          </article>

          <article class="admin-card">
            <header class="admin-card__head"><h2>Game information</h2>${badge(session?.status ?? 'unknown')}</header>
            <dl class="admin-dl">
              <div><dt>Session ID</dt><dd><code>${esc(claim.session_id)}</code></dd></div>
              <div><dt>Score</dt><dd>${claim.score}</dd></div>
              <div><dt>Bounces</dt><dd>${session?.hits ?? '—'}</dd></div>
              <div><dt>Duration</dt><dd>${fmtDuration(session?.duration_ms)}</dd></div>
              <div><dt>Events recorded</dt><dd>${events.count}</dd></div>
              <div><dt>First / last bounce</dt><dd>${events.firstMs}ms → ${events.lastMs}ms</dd></div>
              <div><dt>Suspicious</dt><dd>${
                session?.suspicious
                  ? `<span class="admin-flag">${esc(session.suspicion_reasons ?? 'flagged')}</span>`
                  : 'No'
              }</dd></div>
              <div><dt>Played</dt><dd>${fmtDateTime(session?.started_at)}</dd></div>
            </dl>
          </article>

          <article class="admin-card">
            <header class="admin-card__head"><h2>Reward</h2>${badge(coupon?.status ?? null)}</header>
            <dl class="admin-dl">
              <div><dt>Discount</dt><dd>${claim.discount}%</dd></div>
              <div><dt>Coupon code</dt><dd><code>${esc(coupon?.code ?? '—')}</code></dd></div>
              <div><dt>Issued</dt><dd>${fmtDateTime(coupon?.issued_at)}</dd></div>
              <div><dt>Expires</dt><dd>${fmtDateTime(coupon?.expires_at)}</dd></div>
              <div><dt>Minimum project</dt><dd>${coupon?.min_project_value ? fmtMoney(coupon.min_project_value) : 'No minimum'}</dd></div>
              <div><dt>Uses</dt><dd>${coupon?.uses ?? 0} / ${coupon?.max_uses ?? 1}</dd></div>
              <div><dt>Reviewed by</dt><dd>${esc(claim.reviewed_by ?? '—')} ${claim.reviewed_at ? `· ${fmtDateTime(claim.reviewed_at)}` : ''}</dd></div>
            </dl>
            <div class="admin-card__actions">
              ${
                coupon && coupon.status !== 'redeemed' && coupon.status !== 'revoked'
                  ? '<button class="admin-btn admin-btn--primary" type="button" data-redeem>Record redemption</button>'
                  : ''
              }
              ${
                coupon && coupon.status !== 'redeemed' && coupon.status !== 'revoked'
                  ? '<button class="admin-btn admin-btn--danger" type="button" data-revoke>Revoke coupon</button>'
                  : ''
              }
            </div>
          </article>

          <article class="admin-card">
            <header class="admin-card__head"><h2>Redemption</h2><span>${redemption ? 'Recorded' : 'Not purchased yet'}</span></header>
            ${
              redemption
                ? `<dl class="admin-dl">
                    <div><dt>Service</dt><dd>${esc(redemption.service)}</dd></div>
                    <div><dt>Original amount</dt><dd>${fmtMoney(redemption.original_amount)}</dd></div>
                    <div><dt>Discount</dt><dd>−${fmtMoney(redemption.discount_amount)} (${redemption.discount}%)</dd></div>
                    <div><dt>Final amount</dt><dd><strong>${fmtMoney(redemption.final_amount)}</strong></dd></div>
                    <div><dt>Redeemed at</dt><dd>${fmtDateTime(redemption.redeemed_at)}</dd></div>
                    <div><dt>Reference</dt><dd>${esc(redemption.reference ?? '—')}</dd></div>
                    <div><dt>Recorded by</dt><dd>${esc(redemption.recorded_by)}</dd></div>
                  </dl>`
                : `<p class="admin-modal__copy">Winning is not the same as purchasing. When this player buys a service, record the redemption here — issued coupons and redeemed coupons are counted separately.</p>`
            }
          </article>
        </div>

        <section class="admin-split">
          <article class="admin-card">
            <header class="admin-card__head"><h2>Previous claims</h2><span>${history.length}</span></header>
            ${
              history.length
                ? `<div class="admin-table-wrap"><table class="admin-table">
                    <thead><tr><th>Claimed</th><th>Score</th><th>Reward</th><th>Coupon</th><th>Status</th></tr></thead>
                    <tbody>${history
                      .map(
                        (row) => `<tr>
                          <td>${fmtDate(row.created_at)}</td>
                          <td>${row.score}</td>
                          <td>${row.discount}%</td>
                          <td>${row.code ? `<code>${esc(row.code)}</code>` : '—'} ${badge(row.coupon_status)}</td>
                          <td>${badge(row.status)}</td>
                        </tr>`,
                      )
                      .join('')}</tbody>
                  </table></div>`
                : emptyState('First claim', 'This is the player\'s first reward claim.')
            }
          </article>

          <article class="admin-card">
            <header class="admin-card__head"><h2>Internal notes</h2><span>${notes.length}</span></header>
            ${
              notes.length
                ? `<ul class="admin-notes">${notes
                    .map(
                      (note) => `<li>
                        <p>${esc(note.body)}</p>
                        <span>${esc(note.admin_email)} · ${fmtDateTime(note.created_at)}</span>
                      </li>`,
                    )
                    .join('')}</ul>`
                : '<p class="admin-modal__copy">No notes yet. Notes are internal and never shown to players.</p>'
            }
          </article>
        </section>

        <article class="admin-card">
          <header class="admin-card__head"><h2>Decision history</h2><span>Immutable audit trail</span></header>
          ${
            audit.length
              ? `<div class="admin-table-wrap"><table class="admin-table">
                  <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
                  <tbody>${audit
                    .map(
                      (row) => `<tr>
                        <td>${fmtDateTime(row.created_at)}</td>
                        <td>${esc(row.admin_email)}</td>
                        <td>${esc(row.action)}</td>
                        <td>${esc(row.target_type)} · ${esc(row.target_id.slice(0, 10))}…</td>
                        <td class="admin-detail-cell">${esc(row.detail ?? '—')}</td>
                      </tr>`,
                    )
                    .join('')}</tbody>
                </table></div>`
              : '<p class="admin-modal__copy">No admin actions recorded for this record yet.</p>'
          }
        </article>
      `;

      view.querySelector('[data-back]')?.addEventListener('click', () => ctx.go('#/winners'));

      view.querySelector('[data-verify]')?.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Approve this claim?',
          message: `The ${claim.discount}% coupon ${coupon?.code ?? ''} stays active and the decision is written to the audit log.`,
          confirmLabel: 'Approve claim',
        });
        if (!ok) return;
        try {
          await sendJson(`/api/admin/claims/${encodeURIComponent(claim.id)}/verify`, 'POST', { note: '' });
          toast('Claim approved.');
          await load();
        } catch (error) {
          toast(error instanceof Error ? error.message : 'Could not approve.', 'error');
        }
      });

      view.querySelector('[data-reject]')?.addEventListener('click', async () => {
        const reason = await promptDialog({
          title: 'Reject this claim',
          label: 'Reason (recorded in the audit log, coupon will be revoked)',
          confirmLabel: 'Reject claim',
          danger: true,
          placeholder: 'e.g. score could not be verified',
        });
        if (reason === null) return;
        try {
          await sendJson(`/api/admin/claims/${encodeURIComponent(claim.id)}/reject`, 'POST', { note: reason });
          toast('Claim rejected and coupon revoked.');
          await load();
        } catch (error) {
          toast(error instanceof Error ? error.message : 'Could not reject.', 'error');
        }
      });

      view.querySelector('[data-note]')?.addEventListener('click', async () => {
        const note = await promptDialog({
          title: 'Add an internal note',
          label: 'Note',
          confirmLabel: 'Save note',
          multiline: true,
          placeholder: 'Context for your future self…',
        });
        if (note === null) return;
        try {
          await sendJson(`/api/admin/claims/${encodeURIComponent(claim.id)}/notes`, 'POST', { body: note });
          toast('Note saved.');
          await load();
        } catch (error) {
          toast(error instanceof Error ? error.message : 'Could not save the note.', 'error');
        }
      });

      view.querySelector('[data-redeem]')?.addEventListener('click', () => {
        if (!coupon) return;
        openRedeemModal(coupon, () => {
          void load();
        });
      });

      view.querySelector('[data-revoke]')?.addEventListener('click', async () => {
        if (!coupon) return;
        const reason = await promptDialog({
          title: 'Revoke this coupon',
          label: 'Reason',
          confirmLabel: 'Revoke coupon',
          danger: true,
          placeholder: 'e.g. duplicate claim',
        });
        if (reason === null) return;
        try {
          await sendJson(`/api/admin/coupons/${encodeURIComponent(coupon.id)}/revoke`, 'POST', { reason });
          toast('Coupon revoked.');
          await load();
        } catch (error) {
          toast(error instanceof Error ? error.message : 'Could not revoke.', 'error');
        }
      });
    } catch (error) {
      failed(view, error);
    }
  };

  await load();
}

/* ---------------------------------------------------------------- coupons */

const couponState = { page: 1, q: '', status: 'all', discount: 'all' };

export async function renderCoupons(view: HTMLElement, ctx: ViewContext): Promise<void> {
  ctx.setTitle('Coupons', 'Issued rewards, their terms and their redemptions.');
  ctx.setExport('coupons');

  const load = async (page = couponState.page) => {
    couponState.page = page;
    view.innerHTML = loading('Loading coupons…');
    try {
      const data = await getJson<{ rows: CouponRow[]; page: number; pageSize: number; total: number; pages: number }>(
        `/api/admin/coupons${query({
          page,
          q: couponState.q,
          status: couponState.status,
          discount: couponState.discount,
        })}`,
      );

      view.innerHTML = `
        <div class="admin-toolbar">
          <input class="admin-search" type="search" placeholder="Search code, player, email or session"
            value="${esc(couponState.q)}" data-search aria-label="Search coupons" />
          <select data-filter="status" aria-label="Coupon status">${statusOptions(
            ['pending', 'active', 'redeemed', 'expired', 'revoked'],
            couponState.status,
          )}</select>
          <select data-filter="discount" aria-label="Discount">
            ${['all', '2', '5', '7', '10']
              .map(
                (value) =>
                  `<option value="${value}"${couponState.discount === value ? ' selected' : ''}>${
                    value === 'all' ? 'All rewards' : `${value}% off`
                  }</option>`,
              )
              .join('')}
          </select>
          <button class="admin-btn admin-btn--primary" type="button" data-issue>Issue coupon</button>
        </div>

        ${
          data.rows.length
            ? `<div class="admin-table-wrap"><table class="admin-table">
                <thead><tr>
                  <th>Code</th><th>Player</th><th>Reward</th><th>Status</th><th>Issued</th><th>Expires</th>
                  <th>Minimum</th><th>Uses</th><th>Redemption</th><th>Source</th><th></th>
                </tr></thead>
                <tbody>${data.rows
                  .map(
                    (row) => `<tr>
                      <td><code>${esc(row.code)}</code></td>
                      <td>${esc(row.name)}<span class="admin-sub">${esc(row.email)}</span></td>
                      <td>${row.discount}%</td>
                      <td>${badge(row.status)}</td>
                      <td>${fmtDate(row.issued_at)}</td>
                      <td>${fmtDate(row.expires_at)}</td>
                      <td>${row.min_project_value ? fmtMoney(row.min_project_value) : '—'}</td>
                      <td>${row.uses} / ${row.max_uses}</td>
                      <td>${
                        row.redeemed_at
                          ? `${fmtMoney(row.final_amount)}<span class="admin-sub">${fmtDate(row.redeemed_at)}</span>`
                          : '—'
                      }</td>
                      <td>${row.created_by ? 'Manual' : 'Arcade'}</td>
                      <td class="admin-row-actions">
                        ${
                          row.status === 'active' || row.status === 'pending'
                            ? `<button class="admin-link" type="button" data-redeem="${esc(row.id)}">Redeem</button>`
                            : ''
                        }
                        ${
                          row.status !== 'redeemed' && row.status !== 'revoked'
                            ? `<button class="admin-link admin-link--danger" type="button" data-revoke="${esc(row.id)}" data-code="${esc(row.code)}">Revoke</button>`
                            : ''
                        }
                      </td>
                    </tr>`,
                  )
                  .join('')}</tbody>
              </table></div>
              ${pageMeta(data)}`
            : emptyState('No coupons yet', 'Rewards issued from the arcade and manual coupons both appear here.')
        }
      `;

      bindPager(view, load);

      view.querySelectorAll<HTMLSelectElement>('[data-filter]').forEach((select) => {
        select.addEventListener('change', () => {
          const key = select.dataset.filter as 'status' | 'discount';
          couponState[key] = select.value;
          void load(1);
        });
      });
      const search = view.querySelector<HTMLInputElement>('[data-search]');
      search?.addEventListener(
        'input',
        debounce(() => {
          couponState.q = search.value.trim();
          void load(1);
        }),
      );

      view.querySelectorAll<HTMLButtonElement>('[data-redeem]').forEach((button) => {
        button.addEventListener('click', () => {
          const row = data.rows.find((item) => item.id === button.dataset.redeem);
          if (row) {
            openRedeemModal(row, () => {
              void load();
            });
          }
        });
      });

      view.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach((button) => {
        button.addEventListener('click', async () => {
          const reason = await promptDialog({
            title: `Revoke ${button.dataset.code ?? 'coupon'}`,
            label: 'Reason (recorded in the audit log)',
            confirmLabel: 'Revoke coupon',
            danger: true,
          });
          if (reason === null) return;
          try {
            await sendJson(`/api/admin/coupons/${encodeURIComponent(button.dataset.revoke ?? '')}/revoke`, 'POST', {
              reason,
            });
            toast('Coupon revoked.');
            await load();
          } catch (error) {
            toast(error instanceof Error ? error.message : 'Could not revoke.', 'error');
          }
        });
      });

      view.querySelector('[data-issue]')?.addEventListener('click', () => openIssueModal(() => void load(1)));
    } catch (error) {
      failed(view, error);
    }
  };

  await load(1);
}

function openIssueModal(onDone: () => void): void {
  openModal({
    title: 'Issue a coupon manually',
    body: `
      <form class="admin-form" data-issue-form>
        <label class="admin-field"><span>Customer name</span><input name="name" type="text" required /></label>
        <label class="admin-field"><span>Email</span><input name="email" type="email" required /></label>
        <label class="admin-field"><span>Phone (optional)</span><input name="phone" type="tel" /></label>
        <div class="admin-field-row">
          <label class="admin-field"><span>Discount %</span><input name="discount" type="number" min="1" max="100" value="10" required /></label>
          <label class="admin-field"><span>Valid days</span><input name="validDays" type="number" min="1" max="90" value="7" required /></label>
        </div>
        <div class="admin-field-row">
          <label class="admin-field"><span>Minimum project value (₹)</span><input name="minProjectValue" type="number" min="0" value="0" /></label>
          <label class="admin-field"><span>Max uses</span><input name="maxUses" type="number" min="1" max="5" value="1" required /></label>
        </div>
        <p class="admin-field__error" data-issue-error></p>
      </form>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" type="button" data-cancel>Cancel</button>
      <button class="admin-btn admin-btn--primary" type="submit" form="issue-form">Create coupon</button>
    `,
    onMount: (root, close) => {
      const form = root.querySelector<HTMLFormElement>('[data-issue-form]');
      const error = root.querySelector<HTMLElement>('[data-issue-error]');
      form?.setAttribute('id', 'issue-form');
      root.querySelector('[data-cancel]')?.addEventListener('click', close);
      form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = new FormData(form);
        try {
          await sendJson('/api/admin/coupons', 'POST', {
            name: values.get('name'),
            email: values.get('email'),
            phone: values.get('phone'),
            discount: Number(values.get('discount')),
            validDays: Number(values.get('validDays')),
            minProjectValue: Number(values.get('minProjectValue')),
            maxUses: Number(values.get('maxUses')),
          });
          close();
          toast('Coupon created.');
          onDone();
        } catch (requestError) {
          if (error) {
            error.textContent =
              requestError instanceof Error ? requestError.message : 'Could not create the coupon.';
          }
        }
      });
    },
  });
}

export function openRedeemModal(
  coupon: Pick<CouponRow, 'id' | 'code' | 'discount' | 'min_project_value' | 'eligible_services' | 'status'>,
  onDone: () => void,
): void {
  const services = parseServices(coupon.eligible_services);
  const serviceField = services.length
    ? `<select name="service">${services.map((service) => `<option>${esc(service)}</option>`).join('')}</select>`
    : '<input name="service" type="text" required placeholder="Service purchased" />';

  openModal({
    title: `Record redemption · ${coupon.code}`,
    body: `
      <form class="admin-form" data-redeem-form>
        <p class="admin-modal__copy">
          ${coupon.discount}% off${coupon.min_project_value ? ` · minimum project ${fmtMoney(coupon.min_project_value)}` : ''}.
          This is a financial record: it cannot be undone or recorded twice.
        </p>
        <label class="admin-field"><span>Service purchased</span>${serviceField}</label>
        <label class="admin-field"><span>Original project amount (₹)</span><input name="originalAmount" type="number" min="1" step="1" required /></label>
        <label class="admin-field"><span>Order / inquiry reference</span><input name="reference" type="text" placeholder="e.g. CB-2026-014" /></label>
        <p class="admin-redeem__preview" data-preview>Enter the amount to see the discount.</p>
        <p class="admin-field__error" data-redeem-error></p>
      </form>
    `,
    footer: `
      <button class="admin-btn admin-btn--ghost" type="button" data-cancel>Cancel</button>
      <button class="admin-btn admin-btn--primary" type="submit" form="redeem-form">Record redemption</button>
    `,
    onMount: (root, close) => {
      const form = root.querySelector<HTMLFormElement>('[data-redeem-form]');
      const preview = root.querySelector<HTMLElement>('[data-preview]');
      const error = root.querySelector<HTMLElement>('[data-redeem-error]');
      form?.setAttribute('id', 'redeem-form');
      root.querySelector('[data-cancel]')?.addEventListener('click', close);

      const amountInput = form?.elements.namedItem('originalAmount') as HTMLInputElement | null;
      amountInput?.addEventListener('input', () => {
        const amount = Number(amountInput.value);
        if (!preview) return;
        if (!Number.isFinite(amount) || amount <= 0) {
          preview.textContent = 'Enter the amount to see the discount.';
          return;
        }
        const off = Math.floor((amount * coupon.discount) / 100);
        preview.textContent = `Discount ${fmtMoney(off)} · final amount ${fmtMoney(amount - off)}`;
      });

      form?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = new FormData(form);
        try {
          await sendJson(`/api/admin/coupons/${encodeURIComponent(coupon.id)}/redeem`, 'POST', {
            service: values.get('service'),
            originalAmount: Number(values.get('originalAmount')),
            reference: values.get('reference'),
          });
          close();
          toast('Redemption recorded.');
          onDone();
        } catch (requestError) {
          if (error) {
            error.textContent =
              requestError instanceof Error ? requestError.message : 'Could not record the redemption.';
          }
        }
      });
    },
  });
}

/* ------------------------------------------------------------- redemptions */

const redemptionState = { page: 1, q: '' };

export async function renderRedemptions(view: HTMLElement, ctx: ViewContext): Promise<void> {
  ctx.setTitle('Redemptions', 'Only recorded purchases count as redeemed.');
  ctx.setExport('redemptions');

  const load = async (page = redemptionState.page) => {
    redemptionState.page = page;
    view.innerHTML = loading('Loading redemption records…');
    try {
      const data = await getJson<{
        rows: RedemptionRow[];
        page: number;
        pageSize: number;
        total: number;
        pages: number;
      }>(`/api/admin/redemptions${query({ page, q: redemptionState.q })}`);

      const discountTotal = data.rows.reduce((sum, row) => sum + row.discount_amount, 0);

      view.innerHTML = `
        <div class="admin-toolbar">
          <input class="admin-search" type="search" placeholder="Search coupon, customer or reference"
            value="${esc(redemptionState.q)}" data-search aria-label="Search redemptions" />
        </div>

        ${
          data.rows.length
            ? `<div class="admin-table-wrap"><table class="admin-table">
                <thead><tr>
                  <th>Redeemed</th><th>Coupon</th><th>Customer</th><th>Service</th>
                  <th>Original</th><th>Discount</th><th>Final</th><th>Reference</th><th>Recorded by</th>
                </tr></thead>
                <tbody>${data.rows
                  .map(
                    (row) => `<tr>
                      <td>${fmtDateTime(row.redeemed_at)}</td>
                      <td><code>${esc(row.code)}</code></td>
                      <td>${esc(row.name)}<span class="admin-sub">${esc(row.email)}</span></td>
                      <td>${esc(row.service)}</td>
                      <td>${fmtMoney(row.original_amount)}</td>
                      <td>−${fmtMoney(row.discount_amount)} <span class="admin-sub">${row.discount}%</span></td>
                      <td><strong>${fmtMoney(row.final_amount)}</strong></td>
                      <td>${esc(row.reference ?? '—')}</td>
                      <td>${esc(row.recorded_by)}</td>
                    </tr>`,
                  )
                  .join('')}</tbody>
              </table></div>
              ${pageMeta(data)}
              <p class="admin-footnote">Discount shown on this page: ${fmtMoney(discountTotal)} across the visible rows.</p>`
            : emptyState('No redemptions recorded', 'When a customer actually buys, record it from Winners or Coupons.')
        }
      `;

      bindPager(view, load);
      const search = view.querySelector<HTMLInputElement>('[data-search]');
      search?.addEventListener(
        'input',
        debounce(() => {
          redemptionState.q = search.value.trim();
          void load(1);
        }),
      );
    } catch (error) {
      failed(view, error);
    }
  };

  await load(1);
}

/* ---------------------------------------------------------------- settings */

export async function renderSettings(view: HTMLElement, ctx: ViewContext): Promise<void> {
  ctx.setTitle('Arcade settings', 'Server-validated. Existing coupons keep the terms they were issued with.');
  ctx.setExport(null);
  view.innerHTML = loading('Loading settings…');

  try {
    const data = await getJson<SettingsPayload>('/api/admin/settings');
    const settings = data.settings;

    view.innerHTML = `
      <form class="admin-settings" data-settings-form>
        <section class="admin-card">
          <header class="admin-card__head"><h2>Availability</h2><span>Applies immediately</span></header>
          <div class="admin-toggles">
            <label class="admin-toggle">
              <input type="checkbox" name="arcadeEnabled" ${settings.arcadeEnabled ? 'checked' : ''} />
              <span><strong>Arcade enabled</strong><em>Players can start new sessions.</em></span>
            </label>
            <label class="admin-toggle">
              <input type="checkbox" name="claimsEnabled" ${settings.claimsEnabled ? 'checked' : ''} />
              <span><strong>Reward claims open</strong><em>Winners can convert a score into a coupon.</em></span>
            </label>
            <label class="admin-field">
              <span>Difficulty</span>
              <select name="difficulty">
                ${['relaxed', 'standard', 'challenging']
                  .map(
                    (value) =>
                      `<option value="${value}"${settings.difficulty === value ? ' selected' : ''}>${
                        value[0].toUpperCase() + value.slice(1)
                      }</option>`,
                  )
                  .join('')}
              </select>
            </label>
          </div>
        </section>

        <section class="admin-card">
          <header class="admin-card__head"><h2>Reward tiers</h2><span>Score → discount</span></header>
          <div class="admin-tiers" data-tiers>
            ${settings.tiers
              .slice()
              .sort((a, b) => b.min - a.min)
              .map(
                (tier) => `<div class="admin-tier" data-tier>
                  <label class="admin-field"><span>From score</span><input name="min" type="number" min="0" step="1" value="${tier.min}" /></label>
                  <label class="admin-field"><span>To score (blank = open)</span><input name="max" type="number" min="0" step="1" value="${tier.max ?? ''}" /></label>
                  <label class="admin-field"><span>Discount %</span><input name="discount" type="number" min="0" max="100" step="1" value="${tier.discount}" /></label>
                  <button class="admin-btn admin-btn--ghost" type="button" data-remove-tier>Remove</button>
                </div>`,
              )
              .join('')}
          </div>
          <button class="admin-btn admin-btn--ghost" type="button" data-add-tier>Add tier</button>
        </section>

        <section class="admin-card">
          <header class="admin-card__head"><h2>Coupon terms</h2><span>Snapshotted onto each coupon</span></header>
          <div class="admin-field-row">
            <label class="admin-field"><span>Validity (days)</span><input name="couponValidDays" type="number" min="1" max="90" value="${settings.couponValidDays}" /></label>
            <label class="admin-field"><span>Minimum project value (₹)</span><input name="minProjectValue" type="number" min="0" step="1" value="${settings.minProjectValue}" /></label>
            <label class="admin-field"><span>Maximum uses</span><input name="maxCouponUses" type="number" min="1" max="5" value="${settings.maxCouponUses}" /></label>
          </div>
        </section>

        <section class="admin-card">
          <header class="admin-card__head"><h2>Eligible services</h2><span>Coupons only apply to these</span></header>
          <div class="admin-services">
            ${data.catalogue
              .map(
                (service) => `<label class="admin-check">
                  <input type="checkbox" name="services" value="${esc(service)}" ${
                    settings.eligibleServices.includes(service) ? 'checked' : ''
                  } />
                  <span>${esc(service)}</span>
                </label>`,
              )
              .join('')}
          </div>
        </section>

        <div class="admin-settings__actions">
          <button class="admin-btn admin-btn--primary" type="submit">Save settings</button>
          <button class="admin-btn admin-btn--ghost" type="button" data-reset>Restore defaults</button>
          <p class="admin-field__error" data-settings-error></p>
        </div>
      </form>
    `;

    const tiers = view.querySelector<HTMLElement>('[data-tiers]');
    const form = view.querySelector<HTMLFormElement>('[data-settings-form]');
    const error = view.querySelector<HTMLElement>('[data-settings-error]');

    view.querySelector('[data-add-tier]')?.addEventListener('click', () => {
      const row = document.createElement('div');
      row.className = 'admin-tier';
      row.dataset.tier = '';
      row.innerHTML = `
        <label class="admin-field"><span>From score</span><input name="min" type="number" min="0" step="1" value="0" /></label>
        <label class="admin-field"><span>To score (blank = open)</span><input name="max" type="number" min="0" step="1" /></label>
        <label class="admin-field"><span>Discount %</span><input name="discount" type="number" min="0" max="100" step="1" value="2" /></label>
        <button class="admin-btn admin-btn--ghost" type="button" data-remove-tier>Remove</button>`;
      tiers?.appendChild(row);
    });

    tiers?.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('[data-remove-tier]');
      if (button) (button as HTMLElement).closest('[data-tier]')?.remove();
    });

    view.querySelector('[data-reset]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Restore default settings?',
        message: 'The arcade returns to the original tiers, 7-day validity and the default eligible services.',
        confirmLabel: 'Restore defaults',
        danger: true,
      });
      if (!ok) return;
      try {
        await sendJson('/api/admin/settings', 'PUT', data.defaults);
        toast('Default settings restored.');
        await renderSettings(view, ctx);
      } catch (requestError) {
        toast(requestError instanceof Error ? requestError.message : 'Could not restore defaults.', 'error');
      }
    });

    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (error) error.textContent = '';
      const elements = new FormData(form);
      const tiersPayload = Array.from(view.querySelectorAll<HTMLElement>('[data-tier]')).map((row) => {
        const min = Number((row.querySelector('input[name="min"]') as HTMLInputElement).value);
        const maxRaw = (row.querySelector('input[name="max"]') as HTMLInputElement).value.trim();
        const discount = Number((row.querySelector('input[name="discount"]') as HTMLInputElement).value);
        return { min, max: maxRaw === '' ? null : Number(maxRaw), discount };
      });
      const services = elements.getAll('services').map(String);

      try {
        await sendJson('/api/admin/settings', 'PUT', {
          arcadeEnabled: elements.get('arcadeEnabled') === 'on',
          claimsEnabled: elements.get('claimsEnabled') === 'on',
          difficulty: elements.get('difficulty'),
          couponValidDays: Number(elements.get('couponValidDays')),
          minProjectValue: Number(elements.get('minProjectValue')),
          maxCouponUses: Number(elements.get('maxCouponUses')),
          tiers: tiersPayload,
          eligibleServices: services,
        });
        toast('Settings saved.');
      } catch (requestError) {
        const message =
          requestError instanceof Error ? requestError.message : 'Could not save the settings.';
        if (error) error.textContent = message;
        toast(message, 'error');
      }
    });
  } catch (error) {
    failed(view, error);
  }
}

/* ------------------------------------------------------------------- audit */

const auditState = { page: 1, q: '' };

export async function renderAudit(view: HTMLElement, ctx: ViewContext): Promise<void> {
  ctx.setTitle('Audit log', 'Append-only record of administrative actions.');
  ctx.setExport(null);

  const load = async (page = auditState.page) => {
    auditState.page = page;
    view.innerHTML = loading('Loading the audit trail…');
    try {
      const data = await getJson<{
        rows: AuditRow[];
        page: number;
        pageSize: number;
        total: number;
        pages: number;
      }>(`/api/admin/audit${query({ page, q: auditState.q })}`);

      view.innerHTML = `
        <div class="admin-toolbar">
          <input class="admin-search" type="search" placeholder="Search admin, action or record"
            value="${esc(auditState.q)}" data-search aria-label="Search audit log" />
        </div>
        ${
          data.rows.length
            ? `<div class="admin-table-wrap"><table class="admin-table">
                <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Record</th><th>Detail</th></tr></thead>
                <tbody>${data.rows
                  .map(
                    (row) => `<tr>
                      <td>${fmtDateTime(row.created_at)}</td>
                      <td>${esc(row.admin_email)}</td>
                      <td><code>${esc(row.action)}</code></td>
                      <td>${esc(row.target_type)} · ${esc(row.target_id.slice(0, 12))}</td>
                      <td class="admin-detail-cell">${esc(row.detail ?? '—')}</td>
                    </tr>`,
                  )
                  .join('')}</tbody>
              </table></div>
              ${pageMeta(data)}`
            : emptyState('Nothing logged yet', 'Approvals, rejections, redemptions and settings changes appear here.')
        }
      `;

      bindPager(view, load);
      const search = view.querySelector<HTMLInputElement>('[data-search]');
      search?.addEventListener(
        'input',
        debounce(() => {
          auditState.q = search.value.trim();
          void load(1);
        }),
      );
    } catch (error) {
      failed(view, error);
    }
  };

  await load(1);
}

/* --------------------------------------------------------------- sessions */

const sessionState = { page: 1, q: '', status: 'all' };

export async function renderSessions(view: HTMLElement, ctx: ViewContext): Promise<void> {
  ctx.setTitle('Game sessions', 'Every started run, its timing checks and its outcome.');
  ctx.setExport('sessions');

  const load = async (page = sessionState.page) => {
    sessionState.page = page;
    view.innerHTML = loading('Loading sessions…');
    try {
      const data = await getJson<{ rows: SessionRow[]; page: number; pageSize: number; total: number; pages: number }>(
        `/api/admin/sessions${query({ page, q: sessionState.q, status: sessionState.status })}`,
      );

      view.innerHTML = `
        <div class="admin-toolbar">
          <input class="admin-search" type="search" placeholder="Search session ID"
            value="${esc(sessionState.q)}" data-search aria-label="Search sessions" />
          <select data-filter="status" aria-label="Session status">${statusOptions(
            ['active', 'finished', 'flagged', 'expired'],
            sessionState.status,
          )}</select>
        </div>
        ${
          data.rows.length
            ? `<div class="admin-table-wrap"><table class="admin-table">
                <thead><tr><th>Session</th><th>Player</th><th>Score</th><th>Bounces</th><th>Duration</th><th>Status</th><th>Played</th><th>Checks</th></tr></thead>
                <tbody>${data.rows
                  .map(
                    (row) => `<tr>
                      <td><code class="admin-mono-sm">${esc(row.id.slice(0, 12))}…</code></td>
                      <td>${esc(row.name ?? 'Guest')}${row.email ? `<span class="admin-sub">${esc(row.email)}</span>` : ''}</td>
                      <td>${row.score}</td>
                      <td>${row.hits}</td>
                      <td>${fmtDuration(row.duration_ms)}</td>
                      <td>${badge(row.status)}</td>
                      <td>${fmtDateTime(row.started_at)}</td>
                      <td class="admin-detail-cell">${
                        row.suspicious ? `<span class="admin-flag">${esc(row.suspicion_reasons ?? 'flagged')}</span>` : 'Passed'
                      }</td>
                    </tr>`,
                  )
                  .join('')}</tbody>
              </table></div>
              ${pageMeta(data)}`
            : emptyState('No sessions yet', 'Sessions appear the moment a visitor presses START GAME.')
        }
      `;

      bindPager(view, load);
      view.querySelectorAll<HTMLSelectElement>('[data-filter]').forEach((select) => {
        select.addEventListener('change', () => {
          sessionState.status = select.value;
          void load(1);
        });
      });
      const search = view.querySelector<HTMLInputElement>('[data-search]');
      search?.addEventListener(
        'input',
        debounce(() => {
          sessionState.q = search.value.trim();
          void load(1);
        }),
      );
    } catch (error) {
      failed(view, error);
    }
  };

  await load(1);
}

export async function renderPlayers(view: HTMLElement, ctx: ViewContext): Promise<void> {
  ctx.setTitle('Players', 'Everyone who has claimed a reward.');
  ctx.setExport('players');
  view.innerHTML = loading('Loading players…');
  try {
    const data = await getJson<{ rows: PlayerRow[]; page: number; pageSize: number; total: number; pages: number }>(
      '/api/admin/players?page=1',
    );
    view.innerHTML = data.rows.length
      ? `<div class="admin-table-wrap"><table class="admin-table">
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Best score</th><th>Coupons</th><th>First seen</th></tr></thead>
          <tbody>${data.rows
            .map(
              (row) => `<tr>
                <td>${esc(row.name)}</td>
                <td>${esc(row.email)}</td>
                <td>${esc(row.phone ?? '—')}</td>
                <td>${row.best_score}</td>
                <td>${row.coupons}</td>
                <td>${fmtDate(row.created_at)}</td>
              </tr>`,
            )
            .join('')}</tbody>
        </table></div>
        ${pageMeta(data)}`
      : emptyState('No players yet', 'Players are created when they claim a reward.');
  } catch (error) {
    failed(view, error);
  }
}
