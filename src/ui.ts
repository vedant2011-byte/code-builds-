/**
 * CODE BUILTS — site interactions
 * Progressive, observer-driven, and safe if the intro never runs.
 */

const html = document.documentElement;
const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)');

/* ------------------------------------------------------------------ reveals */
function initReveals() {
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
  if (!items.length) return;

  if (prefersReduced.matches || !('IntersectionObserver' in window)) {
    items.forEach((item) => item.classList.add('is-in'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.08, rootMargin: '0px 0px -8% 0px' },
  );

  items.forEach((item) => observer.observe(item));
}

function startReveals() {
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    initReveals();
  };

  if (html.classList.contains('is-site')) {
    start();
    return;
  }

  const watcher = new MutationObserver(() => {
    if (html.classList.contains('is-site')) {
      watcher.disconnect();
      start();
    }
  });
  watcher.observe(html, { attributes: true, attributeFilter: ['class'] });

  // Last resort so content is never left invisible.
  window.setTimeout(() => {
    watcher.disconnect();
    start();
  }, 26000);
}

/* ---------------------------------------------------------------------- nav */
function initNav() {
  const nav = document.querySelector<HTMLElement>('.nav');
  if (!nav) return;

  let ticking = false;
  const update = () => {
    nav.classList.toggle('is-scrolled', window.scrollY > 16);
    ticking = false;
  };

  window.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    },
    { passive: true },
  );
  update();
}

/* --------------------------------------------------------------- mobile menu */
function initMenu() {
  const menu = document.getElementById('mobile-menu');
  const toggle = document.querySelector<HTMLButtonElement>('[data-el="menuToggle"]');
  const closeBtn = document.querySelector<HTMLButtonElement>('[data-el="menuClose"]');
  if (!menu || !toggle) return;

  const links = Array.from(menu.querySelectorAll<HTMLAnchorElement>('.menu__links a'));
  links.forEach((link, index) => link.style.setProperty('--i', String(index)));

  let open = false;
  let closeTimer = 0;

  const openMenu = () => {
    if (open) return;
    open = true;
    window.clearTimeout(closeTimer);
    menu.hidden = false;
    document.body.classList.add('menu-open');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close menu');
    requestAnimationFrame(() => menu.classList.add('is-open'));
    window.setTimeout(() => closeBtn?.focus(), 240);
  };

  const closeMenu = (restoreFocus = true) => {
    if (!open) return;
    open = false;
    menu.classList.remove('is-open');
    document.body.classList.remove('menu-open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
    closeTimer = window.setTimeout(() => {
      menu.hidden = true;
    }, 700);
    if (restoreFocus) toggle.focus();
  };

  toggle.addEventListener('click', () => (open ? closeMenu() : openMenu()));
  closeBtn?.addEventListener('click', () => closeMenu());
  links.forEach((link) => link.addEventListener('click', () => closeMenu(false)));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) closeMenu();
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 900 && open) closeMenu(false);
  });
}

/* ---------------------------------------------------------------- accordions */
function initServices() {
  const services = Array.from(document.querySelectorAll<HTMLElement>('.service'));
  if (!services.length) return;

  const close = (item: HTMLElement) => {
    item.classList.remove('is-open');
    item.querySelector('.service__head')?.setAttribute('aria-expanded', 'false');
    item.querySelector('.service__body')?.setAttribute('aria-hidden', 'true');
  };

  services.forEach((service) => {
    const head = service.querySelector<HTMLButtonElement>('.service__head');
    const body = service.querySelector<HTMLElement>('.service__body');
    if (!head || !body) return;

    // Collapsed panels are visual-only until opened, so assistive tech skips them.
    body.setAttribute('aria-hidden', 'true');

    head.addEventListener('click', () => {
      const isOpen = service.classList.contains('is-open');
      services.forEach(close);

      if (!isOpen) {
        service.classList.add('is-open');
        head.setAttribute('aria-expanded', 'true');
        body.setAttribute('aria-hidden', 'false');
      }
    });
  });
}

/* -------------------------------------------------------------- process steps */
function initSteps() {
  const list = document.querySelector<HTMLElement>('[data-el="steps"]');
  if (!list) return;

  const steps = Array.from(list.querySelectorAll<HTMLElement>('.step'));
  const counter = document.querySelector<HTMLElement>('[data-el="stepCount"]');
  if (!steps.length) return;

  const setActive = (index: number) => {
    steps.forEach((step, i) => step.classList.toggle('is-active', i === index));
    if (counter) counter.textContent = `0${index + 1}`;
    list.style.setProperty('--p', `${(index / (steps.length - 1)) * 100}%`);
  };

  if (!('IntersectionObserver' in window)) {
    setActive(0);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const index = Number((entry.target as HTMLElement).dataset.step ?? 0);
        setActive(index);
      }
    },
    { rootMargin: '-42% 0px -42% 0px', threshold: 0 },
  );

  steps.forEach((step) => observer.observe(step));
  setActive(0);
}

/* ---------------------------------------------------------------------- form */
function initForm() {
  const formElement = document.querySelector<HTMLFormElement>('[data-el="form"]');
  if (!formElement) return;
  const form: HTMLFormElement = formElement;

  const handoff = document.querySelector<HTMLElement>('[data-el="handoff"]');
  const handoffTitle = document.querySelector<HTMLElement>('[data-el="handoffTitle"]');
  const handoffCopy = document.querySelector<HTMLElement>('[data-el="handoffCopy"]');
  const handoffLink = document.querySelector<HTMLAnchorElement>('[data-el="handoffLink"]');
  const copyBtn = document.querySelector<HTMLButtonElement>('[data-el="copyBtn"]');

  type FieldName = 'name' | 'email' | 'phone' | 'business' | 'service' | 'details';
  const fields: Record<FieldName, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null> = {
    name: form.querySelector('#f-name'),
    email: form.querySelector('#f-email'),
    phone: form.querySelector('#f-phone'),
    business: form.querySelector('#f-business'),
    service: form.querySelector('#f-service'),
    details: form.querySelector('#f-details'),
  };

  const clearError = (name: FieldName) => {
    const input = fields[name];
    const message = form.querySelector<HTMLElement>(`[data-error-for="${name}"]`);
    input?.closest('.field')?.classList.remove('has-error');
    input?.removeAttribute('aria-invalid');
    if (message) message.textContent = '';
  };

  const setError = (name: FieldName, text: string) => {
    const input = fields[name];
    const message = form.querySelector<HTMLElement>(`[data-error-for="${name}"]`);
    input?.closest('.field')?.classList.add('has-error');
    input?.setAttribute('aria-invalid', 'true');
    if (message) message.textContent = text;
  };

  function validate(): FieldName[] {
    const invalid: FieldName[] = [];
    const value = (name: FieldName) => (fields[name]?.value ?? '').trim();

    clearError('name');
    if (value('name').length < 2) {
      setError('name', 'Please tell us your name.');
      invalid.push('name');
    }

    clearError('email');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value('email'))) {
      setError('email', 'Enter a valid email address, e.g. you@company.com');
      invalid.push('email');
    }

    clearError('phone');
    const phone = value('phone');
    if (phone && phone.replace(/\D/g, '').length < 7) {
      setError('phone', 'Enter a valid phone number, or leave this empty.');
      invalid.push('phone');
    }

    clearError('service');
    if (!value('service')) {
      setError('service', 'Choose the service closest to what you need.');
      invalid.push('service');
    }

    clearError('details');
    if (value('details').length < 10) {
      setError('details', 'A sentence or two about the project helps us reply properly.');
      invalid.push('details');
    }

    return invalid;
  }

  function buildMessage() {
    const get = (id: string) =>
      (form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(id)?.value ?? '').trim();

    return [
      'New project enquiry — CODE BUILTS',
      '',
      `Name: ${get('#f-name')}`,
      `Email: ${get('#f-email')}`,
      `Phone: ${get('#f-phone') || '—'}`,
      `Business: ${get('#f-business') || '—'}`,
      `Service: ${get('#f-service')}`,
      '',
      'Project details:',
      get('#f-details'),
    ].join('\n');
  }

  function showHandoff(mode: 'whatsapp' | 'email', message: string, opened: boolean) {
    if (!handoff) return;
    const subject = 'Project enquiry — CODE BUILTS';
    const waHref = `https://wa.me/919678524939?text=${encodeURIComponent(message)}`;
    const mailHref = `mailto:code.builts@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;

    handoff.hidden = false;
    if (handoffTitle) handoffTitle.textContent = opened ? 'YOUR MESSAGE IS READY TO SEND.' : 'ONE MORE STEP.';
    if (handoffCopy) {
      handoffCopy.textContent =
        mode === 'whatsapp'
          ? opened
            ? 'WhatsApp opened in a new tab with your details filled in. Press send there to reach us — this website has not transmitted anything.'
            : 'Your browser blocked the new tab. Open WhatsApp with the button below, then press send to reach us.'
          : 'Your email app should now open with the message ready. Press send there to reach us — this website has not transmitted anything.';
    }
    if (handoffLink) {
      handoffLink.href = mode === 'whatsapp' ? waHref : mailHref;
      handoffLink.textContent = mode === 'whatsapp' ? 'Open WhatsApp again' : 'Open email again';
      handoffLink.target = mode === 'whatsapp' ? '_blank' : '_self';
      handoffLink.rel = 'noopener';
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    const mode = submitter?.dataset.mode === 'email' ? 'email' : 'whatsapp';

    const invalid = validate();
    if (invalid.length) {
      const first = fields[invalid[0]];
      first?.focus({ preventScroll: false });
      return;
    }

    const message = buildMessage();
    const subject = 'Project enquiry — CODE BUILTS';

    if (mode === 'whatsapp') {
      const win = window.open(
        `https://wa.me/919678524939?text=${encodeURIComponent(message)}`,
        '_blank',
        'noopener',
      );
      showHandoff('whatsapp', message, Boolean(win));
    } else {
      window.location.href = `mailto:code.builts@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
      showHandoff('email', message, true);
    }
  });

  // Live-clear an error once the visitor starts fixing it.
  (Object.keys(fields) as FieldName[]).forEach((name) => {
    const input = fields[name];
    input?.addEventListener('input', () => clearError(name));
    input?.addEventListener('change', () => clearError(name));
  });

  copyBtn?.addEventListener('click', async () => {
    const message = buildMessage();
    try {
      await navigator.clipboard.writeText(message);
      copyBtn.textContent = 'Copied';
      window.setTimeout(() => {
        copyBtn.textContent = 'Copy details';
      }, 2200);
    } catch {
      copyBtn.textContent = 'Copy unavailable';
      window.setTimeout(() => {
        copyBtn.textContent = 'Copy details';
      }, 2200);
    }
  });

  document.querySelector<HTMLElement>('[data-focus-form]')?.addEventListener('click', (event) => {
    event.preventDefault();
    form.scrollIntoView({ behavior: prefersReduced.matches ? 'auto' : 'smooth', block: 'start' });
    window.setTimeout(() => fields.name?.focus({ preventScroll: true }), 450);
  });
}

/* ---------------------------------------------------------------------- misc */
function initMisc() {
  const year = document.querySelector<HTMLElement>('[data-el="year"]');
  if (year) year.textContent = String(new Date().getFullYear());
}

export function initUI() {
  initNav();
  initMenu();
  initServices();
  initSteps();
  initForm();
  initMisc();
  startReveals();
}
