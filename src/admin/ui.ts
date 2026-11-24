/** Small DOM helpers shared by the admin views. */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

export function fmtDate(ms?: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(ms?: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtMoney(value?: number | null): string {
  if (value === null || value === undefined) return '—';
  return `₹${Number(value).toLocaleString('en-IN')}`;
}

export function fmtDuration(ms?: number | null): string {
  if (!ms) return '—';
  const seconds = Math.round(ms / 100) / 10;
  return `${seconds}s`;
}

export function badge(status: string | null | undefined): string {
  if (!status) return '<span class="badge badge--none">—</span>';
  const key = status.toLowerCase();
  return `<span class="badge badge--${esc(key)}">${esc(status.toUpperCase())}</span>`;
}

export function loading(text = 'Loading…'): string {
  return `<div class="admin-state"><span class="admin-spinner" aria-hidden="true"></span><p>${esc(text)}</p></div>`;
}

export function emptyState(title: string, copy: string): string {
  return `<div class="admin-state"><p class="admin-state__title">${esc(title)}</p><p>${esc(copy)}</p></div>`;
}

export function errorState(message: string): string {
  return `<div class="admin-state admin-state--error"><p class="admin-state__title">Something went wrong</p><p>${esc(message)}</p></div>`;
}

/* -------------------------------------------------------------------- toast */

let toastTimer = 0;

export function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  let el = document.querySelector<HTMLElement>('.admin-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'admin-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('is-on');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el?.classList.remove('is-on'), 4200);
}

/* -------------------------------------------------------------------- modal */

interface ModalOptions {
  title: string;
  body: string;
  footer?: string;
  wide?: boolean;
  onMount?: (root: HTMLElement, close: () => void) => void;
  onClose?: () => void;
}

let openOverlay: HTMLElement | null = null;

export function openModal(options: ModalOptions): () => void {
  closeModal();

  const previous = document.activeElement as HTMLElement | null;
  const overlay = document.createElement('div');
  overlay.className = 'admin-modal';
  overlay.innerHTML = `
    <div class="admin-modal__backdrop" data-modal-close></div>
    <div class="admin-modal__dialog${options.wide ? ' admin-modal__dialog--wide' : ''}"
         role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="admin-modal__head">
        <h2 id="modal-title">${esc(options.title)}</h2>
        <button class="admin-icon" type="button" data-modal-close aria-label="Close">×</button>
      </header>
      <div class="admin-modal__body">${options.body}</div>
      ${options.footer ? `<footer class="admin-modal__foot">${options.footer}</footer>` : ''}
    </div>
  `;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    openOverlay = null;
    document.removeEventListener('keydown', onKey, true);
    options.onClose?.();
    previous?.focus?.({ preventScroll: true });
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
    if (event.key === 'Tab') {
      const focusables = Array.from(
        overlay.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href]'),
      ).filter((el) => !el.hasAttribute('disabled'));
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  overlay.querySelectorAll('[data-modal-close]').forEach((el) => el.addEventListener('click', close));
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  openOverlay = overlay;
  options.onMount?.(overlay, close);
  const focusTarget = overlay.querySelector<HTMLElement>('input, select, textarea, button');
  focusTarget?.focus({ preventScroll: true });

  return close;
}

export function closeModal(): void {
  openOverlay?.remove();
  openOverlay = null;
}

export function confirmDialog(options: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value);
    };
    openModal({
      title: options.title,
      body: `<p class="admin-modal__copy">${esc(options.message)}</p>`,
      footer: `
        <button class="admin-btn admin-btn--ghost" type="button" data-cancel>Cancel</button>
        <button class="admin-btn ${options.danger ? 'admin-btn--danger' : 'admin-btn--primary'}" type="button" data-confirm>${esc(options.confirmLabel)}</button>
      `,
      onMount: (root) => {
        root.querySelector('[data-cancel]')?.addEventListener('click', () => finish(false));
        root.querySelector('[data-confirm]')?.addEventListener('click', () => finish(true));
        root.querySelectorAll('[data-modal-close]').forEach((el) =>
          el.addEventListener('click', () => finish(false)),
        );
      },
      onClose: () => finish(false),
    });
  });
}

export function promptDialog(options: {
  title: string;
  label: string;
  confirmLabel: string;
  placeholder?: string;
  danger?: boolean;
  required?: boolean;
  multiline?: boolean;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value);
    };
    openModal({
      title: options.title,
      body: `
        <form class="admin-form" data-prompt-form>
          <label class="admin-field">
            <span>${esc(options.label)}</span>
            ${
              options.multiline
                ? `<textarea name="value" rows="4" placeholder="${esc(options.placeholder ?? '')}"></textarea>`
                : `<input name="value" type="text" placeholder="${esc(options.placeholder ?? '')}" />`
            }
          </label>
          <p class="admin-field__error" data-prompt-error></p>
        </form>
      `,
      footer: `
        <button class="admin-btn admin-btn--ghost" type="button" data-cancel>Cancel</button>
        <button class="admin-btn ${options.danger ? 'admin-btn--danger' : 'admin-btn--primary'}" type="submit" form="prompt-form" data-confirm>${esc(options.confirmLabel)}</button>
      `,
      onMount: (root) => {
        const form = root.querySelector<HTMLFormElement>('[data-prompt-form]');
        const error = root.querySelector<HTMLElement>('[data-prompt-error]');
        form?.setAttribute('id', 'prompt-form');
        form?.addEventListener('submit', (event) => {
          event.preventDefault();
          const value = (form.elements.namedItem('value') as HTMLInputElement | null)?.value.trim() ?? '';
          if (options.required !== false && value.length < 3) {
            if (error) error.textContent = 'Please add a short explanation (at least 3 characters).';
            return;
          }
          finish(value);
        });
        root.querySelector('[data-cancel]')?.addEventListener('click', () => finish(null));
        root.querySelectorAll('[data-modal-close]').forEach((el) =>
          el.addEventListener('click', () => finish(null)),
        );
      },
      onClose: () => finish(null),
    });
  });
}

/* ------------------------------------------------------------------- charts */

let gradientId = 0;

export function areaChart(
  series: { day: string; sessions: number; claims: number }[],
  height = 180,
): string {
  if (!series.length) {
    return '<p class="admin-chart__empty">No sessions in this window yet.</p>';
  }

  const width = 640;
  const pad = { top: 16, right: 8, bottom: 26, left: 8 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...series.map((row) => row.sessions));
  const step = series.length > 1 ? innerW / (series.length - 1) : 0;

  const point = (value: number, index: number) => {
    const x = pad.left + index * step;
    const y = pad.top + innerH - (value / max) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };

  const sessions = series.map((row, index) => point(row.sessions, index));
  const claims = series.map((row, index) => point(row.claims, index));
  const baseline = pad.top + innerH;
  const firstX = pad.left;
  const lastX = pad.left + (series.length - 1) * step;

  const area = `M${firstX},${baseline} L${sessions.join(' L')} L${lastX},${baseline} Z`;

  const id = `cbgrad${++gradientId}`;
  const labelEvery = Math.max(1, Math.ceil(series.length / 6));

  const labels = series
    .map((row, index) =>
      index % labelEvery === 0 || index === series.length - 1
        ? `<text x="${(pad.left + index * step).toFixed(1)}" y="${height - 6}" class="chart-label" text-anchor="middle">${esc(
            row.day.slice(5),
          )}</text>`
        : '',
    )
    .join('');

  const grid = [0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const y = pad.top + innerH - ratio * innerH;
      return `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" class="chart-grid" />`;
    })
    .join('');

  return `
    <svg viewBox="0 0 ${width} ${height}" class="admin-chart__svg" role="img"
         aria-label="Game sessions and reward claims per day">
      <defs>
        <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ffc20e" stop-opacity="0.42" />
          <stop offset="100%" stop-color="#ffc20e" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${grid}
      <path d="${area}" fill="url(#${id})" />
      <polyline points="${sessions.join(' ')}" fill="none" stroke="#ffc20e" stroke-width="2" />
      <polyline points="${claims.join(' ')}" fill="none" stroke="#ffffff" stroke-width="1.4" stroke-dasharray="4 4" opacity="0.65" />
      ${labels}
      <text x="${pad.left}" y="${pad.top + 4}" class="chart-label">max ${max}</text>
    </svg>
    <div class="admin-chart__legend">
      <span><i class="dot dot--yellow"></i>Sessions</span>
      <span><i class="dot dot--white"></i>Claims</span>
    </div>
  `;
}

export function barList(rows: { label: string; value: number; hint?: string }[]): string {
  if (!rows.length) return '<p class="admin-chart__empty">Nothing recorded yet.</p>';
  const max = Math.max(1, ...rows.map((row) => row.value));
  return `<ul class="admin-bars">${rows
    .map(
      (row) => `
      <li>
        <span class="admin-bars__label">${esc(row.label)}</span>
        <span class="admin-bars__track"><span class="admin-bars__fill" style="width:${((row.value / max) * 100).toFixed(1)}%"></span></span>
        <span class="admin-bars__value">${esc(row.value)}${row.hint ? `<em>${esc(row.hint)}</em>` : ''}</span>
      </li>`,
    )
    .join('')}</ul>`;
}

/* --------------------------------------------------------------- pagination */

export function pagination(meta: { page: number; pages: number; total: number }): string {
  return `
    <div class="admin-pager">
      <span class="admin-pager__count">${meta.total} record${meta.total === 1 ? '' : 's'} · page ${meta.page} of ${meta.pages}</span>
      <div class="admin-pager__buttons">
        <button class="admin-btn admin-btn--ghost" type="button" data-page="${meta.page - 1}" ${
          meta.page <= 1 ? 'disabled' : ''
        }>Previous</button>
        <button class="admin-btn admin-btn--ghost" type="button" data-page="${meta.page + 1}" ${
          meta.page >= meta.pages ? 'disabled' : ''
        }>Next</button>
      </div>
    </div>
  `;
}

export function statusOptions(values: string[], selected: string, allLabel = 'All statuses'): string {
  return [
    `<option value="all"${selected === 'all' ? ' selected' : ''}>${esc(allLabel)}</option>`,
    ...values.map(
      (value) =>
        `<option value="${esc(value)}"${selected === value ? ' selected' : ''}>${esc(value[0].toUpperCase() + value.slice(1))}</option>`,
    ),
  ].join('');
}

export function debounce<T extends (...args: never[]) => void>(fn: T, delay = 320): (...args: Parameters<T>) => void {
  let timer = 0;
  return (...args: Parameters<T>) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}
