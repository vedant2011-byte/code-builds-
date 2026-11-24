/**
 * CODE BUILTS ARCADE — the game.
 *
 * The browser renders and controls the game; the Worker counts the bounces it
 * receives, derives the score and issues the coupon. If the server never
 * accepts the run, the visitor can still play but no discount is offered.
 */

import type { PublicArcadeConfig } from '../shared/arcade';

type Phase = 'intro' | 'playing' | 'paused' | 'result' | 'claim' | 'coupon';

interface CouponPayload {
  code: string;
  discount: number;
  status: string;
  issuedAt: number;
  expiresAt: number;
  validDays: number;
  minProjectValue: number;
  eligibleServices: string[];
}

interface ApiErrorShape {
  error?: { code?: string; message?: string };
}

class ArcadeApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const BEST_KEY = 'cb.arcade.best';
const SOUND_KEY = 'cb.arcade.sound';
const POINTS_PER_BOUNCE = 10;
const MIN_BOUNCE_GAP = 125;

function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  return fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => {
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const shape = data as ApiErrorShape | null;
      throw new ArcadeApiError(
        shape?.error?.message ?? 'Something went wrong. Please try again.',
        response.status,
        shape?.error?.code ?? 'ERROR',
      );
    }
    return data as T;
  });
}

function readBest(): number {
  const value = Number(window.localStorage.getItem(BEST_KEY));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function padScore(value: number): string {
  return String(Math.max(0, Math.round(value))).padStart(3, '0');
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function initArcade(): void {
  const root = document.querySelector<HTMLElement>('[data-arcade]');
  if (!root) return;
  new Arcade(root);
}

class Arcade {
  private root: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private stage!: HTMLElement;

  private phase: Phase = 'intro';
  private config: PublicArcadeConfig | null = null;
  private starting = false;

  private sessionId: string | null = null;
  private sessionToken: string | null = null;
  private rewardPossible = false;
  private queue: { seq: number; t: number }[] = [];
  private seq = 0;
  private flushTimer = 0;
  private flushing = false;

  private width = 0;
  private height = 0;
  private dpr = 1;
  private paddle = { x: 0, y: 0, w: 120, h: 12, target: 0, hasTarget: false };
  private ball = { x: 0, y: 0, vx: 0, vy: 0, r: 8 };
  private baseSpeed = 400;
  private speed = 400;
  private hits = 0;
  private score = 0;
  private best = readBest();
  private startTime = 0;
  private lastBounceAt = 0;
  private trail: { x: number; y: number }[] = [];

  private keys = { left: false, right: false };
  private running = false;
  private raf = 0;
  private lastTs = 0;
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  private resumeAfterHide = false;

  private soundOn = window.localStorage.getItem(SOUND_KEY) === 'on';
  private audio: AudioContext | null = null;

  private pendingClaim: CouponPayload | null = null;
  private resultEligible = false;

  constructor(root: HTMLElement) {
    this.root = root;
    const canvas = root.querySelector<HTMLCanvasElement>('[data-arcade-canvas]');
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    this.canvas = canvas;
    this.ctx = ctx;
    this.stage = canvas.parentElement ?? canvas;

    this.syncScore();
    this.soundLabel();
    this.bind();
    this.measure();
    this.resetBall();
    this.draw();

    void this.loadConfig();
  }

  /* ------------------------------------------------------------------ setup */

  private q<T extends Element>(selector: string): T | null {
    return this.root.querySelector<T>(selector);
  }

  private qa<T extends Element>(selector: string): T[] {
    return Array.from(this.root.querySelectorAll<T>(selector));
  }

  private setStatus(message: string): void {
    this.qa<HTMLElement>('[data-arcade-status]').forEach((el) => {
      el.textContent = message;
    });
  }

  private showOverlay(name: Phase | 'result' | 'paused'): void {
    this.qa<HTMLElement>('[data-arcade-overlay]').forEach((el) => {
      el.hidden = el.dataset.arcadeOverlay !== name;
    });
  }

  private hideOverlays(): void {
    this.qa<HTMLElement>('[data-arcade-overlay]').forEach((el) => {
      el.hidden = true;
    });
  }

  private bind(): void {
    this.qa<HTMLButtonElement>('[data-arcade-start]').forEach((button) =>
      button.addEventListener('click', () => void this.start()),
    );
    this.qa<HTMLButtonElement>('[data-arcade-restart]').forEach((button) =>
      button.addEventListener('click', () => void this.start()),
    );
    this.qa<HTMLButtonElement>('[data-arcade-again]').forEach((button) =>
      button.addEventListener('click', () => void this.start()),
    );
    this.qa<HTMLButtonElement>('[data-arcade-pause]').forEach((button) =>
      button.addEventListener('click', () => this.togglePause()),
    );
    this.qa<HTMLButtonElement>('[data-arcade-resume]').forEach((button) =>
      button.addEventListener('click', () => this.resume()),
    );
    this.qa<HTMLButtonElement>('[data-arcade-sound]').forEach((button) =>
      button.addEventListener('click', () => this.toggleSound()),
    );
    this.qa<HTMLButtonElement>('[data-arcade-claim]').forEach((button) =>
      button.addEventListener('click', () => this.openClaim()),
    );
    this.qa<HTMLButtonElement>('[data-arcade-claim-back]').forEach((button) =>
      button.addEventListener('click', () => this.showOverlay('result')),
    );
    this.qa<HTMLButtonElement>('[data-arcade-copy]').forEach((button) =>
      button.addEventListener('click', () => void this.copyCode()),
    );

    this.q<HTMLFormElement>('[data-arcade-claim-form]')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submitClaim();
    });

    this.canvas.addEventListener('pointermove', (event) => this.trackPointer(event));
    this.canvas.addEventListener('pointerdown', (event) => {
      this.canvas.setPointerCapture?.(event.pointerId);
      this.trackPointer(event);
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.paddle.hasTarget = false;
    });

    window.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('keyup', (event) => this.onKeyUp(event));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.phase === 'playing') {
        this.resumeAfterHide = true;
        this.pause();
      } else if (!document.hidden && this.resumeAfterHide) {
        this.resumeAfterHide = false;
      }
    });

    const ResizeCtor = window.ResizeObserver;
    if (ResizeCtor) {
      const observer = new ResizeCtor(() => this.measure());
      observer.observe(this.stage);
    } else {
      window.addEventListener('resize', () => this.measure());
    }

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting && this.phase === 'playing') this.pause();
          }
        },
        { threshold: 0.05 },
      );
      observer.observe(this.root);
    }
  }

  private async loadConfig(): Promise<void> {
    try {
      const data = await api<{ config: PublicArcadeConfig }>('/api/arcade/config', undefined, 'GET');
      this.config = data.config;
      this.renderTiers(data.config);
      if (!data.config.arcadeEnabled) {
        this.setStatus('The arcade is taking a short break. Please check back soon.');
        this.qa<HTMLButtonElement>('[data-arcade-start]').forEach((button) => {
          button.disabled = true;
        });
      }
    } catch {
      this.setStatus('The arcade could not reach the server. Reload the page to play for a reward.');
      this.qa<HTMLButtonElement>('[data-arcade-start]').forEach((button) => {
        button.disabled = true;
      });
    }
  }

  private renderTiers(config: PublicArcadeConfig): void {
    const list = this.q<HTMLElement>('[data-arcade-tiers]');
    if (!list) return;
    const rows = [...config.tiers]
      .filter((tier) => tier.discount > 0)
      .sort((a, b) => a.min - b.min);
    list.innerHTML = '';
    for (const tier of rows) {
      const item = document.createElement('li');
      const range = document.createElement('span');
      range.textContent = `${tier.min}+`;
      const label = document.createElement('b');
      label.textContent = `${tier.discount}% OFF`;
      item.append(range, label);
      list.appendChild(item);
    }
  }

  /* ------------------------------------------------------------------- size */

  private measure(): void {
    const rect = this.stage.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;

    const previousWidth = this.width;
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.paddle.w = Math.max(84, Math.min(this.width * 0.2, 170));
    this.paddle.h = Math.max(9, Math.min(14, this.height * 0.022));
    this.paddle.y = this.height - Math.max(24, this.height * 0.07);
    this.ball.r = Math.max(5, Math.min(9, this.height * 0.014));

    const difficulty = this.config?.difficulty ?? 'standard';
    const factor = difficulty === 'relaxed' ? 0.82 : difficulty === 'challenging' ? 1.2 : 1;
    this.baseSpeed = this.height * 0.92 * factor;

    if (previousWidth && previousWidth !== this.width) {
      this.paddle.x = (this.paddle.x / previousWidth) * this.width;
    }
    this.clampPaddle();
    this.resetBall();
    this.draw();
  }

  private resetBall(): void {
    const speed = this.baseSpeed;
    const angle = (Math.random() * 0.7 - 0.35) * Math.PI * 0.5;
    this.ball.x = this.width / 2;
    this.ball.y = this.paddle.y - Math.min(140, this.height * 0.28);
    this.ball.vx = Math.sin(angle) * speed;
    this.ball.vy = -Math.abs(Math.cos(angle) * speed);
    this.speed = speed;
    this.trail = [];
    if (!this.paddle.hasTarget) this.paddle.x = this.width / 2 - this.paddle.w / 2;
    this.clampPaddle();
  }

  /* --------------------------------------------------------------- lifecycle */

  private resetState(): void {
    this.hits = 0;
    this.score = 0;
    this.seq = 0;
    this.queue = [];
    this.sessionId = null;
    this.sessionToken = null;
    this.rewardPossible = false;
    this.pendingClaim = null;
    this.resultEligible = false;
    this.trail = [];
    this.soundFeedback();
    this.syncScore();
    this.setStatus('');
    this.resetBall();
  }

  private async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.stopLoop();
    this.hideOverlays();
    this.resetState();
    this.phase = 'playing';

    try {
      const data = await api<{
        sessionId: string;
        sessionToken: string;
      }>('/api/arcade/sessions', {});
      this.sessionId = data.sessionId;
      this.sessionToken = data.sessionToken;
      this.rewardPossible = true;
    } catch (error) {
      this.rewardPossible = false;
      this.setStatus(
        error instanceof ArcadeApiError
          ? `${error.message} This run will not unlock a reward.`
          : 'This run will not be saved for a reward.',
      );
    }

    this.startTime = performance.now();
    this.lastBounceAt = 0;
    this.starting = false;
    this.beginLoop();
    this.canvas.focus({ preventScroll: true });
    this.flushTimer = window.setInterval(() => void this.flush(), 1400);
  }

  private beginLoop(): void {
    this.running = true;
    this.lastTs = 0;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((ts) => this.frame(ts));
  }

  private stopLoop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.flushTimer) {
      window.clearInterval(this.flushTimer);
      this.flushTimer = 0;
    }
  }

  private frame(ts: number): void {
    if (!this.running) return;
    const dt = this.lastTs ? Math.min(0.034, (ts - this.lastTs) / 1000) : 0.016;
    this.lastTs = ts;
    this.update(dt);
    this.draw();
    if (this.running) this.raf = requestAnimationFrame((next) => this.frame(next));
  }

  private update(dt: number): void {
    const speed = this.width * 1.7;
    if (this.keys.left) this.paddle.x -= speed * dt;
    if (this.keys.right) this.paddle.x += speed * dt;

    if (this.paddle.hasTarget) {
      const target = this.paddle.target - this.paddle.w / 2;
      this.paddle.x += (target - this.paddle.x) * Math.min(1, dt * 20);
    }
    this.clampPaddle();

    this.ball.x += this.ball.vx * dt;
    this.ball.y += this.ball.vy * dt;

    if (this.reduced.matches) this.trail = [];
    else {
      this.trail.push({ x: this.ball.x, y: this.ball.y });
      if (this.trail.length > 9) this.trail.shift();
    }

    if (this.ball.x - this.ball.r <= 0) {
      this.ball.x = this.ball.r;
      this.ball.vx = Math.abs(this.ball.vx);
      this.tick();
    } else if (this.ball.x + this.ball.r >= this.width) {
      this.ball.x = this.width - this.ball.r;
      this.ball.vx = -Math.abs(this.ball.vx);
      this.tick();
    }

    if (this.ball.y - this.ball.r <= 0) {
      this.ball.y = this.ball.r;
      this.ball.vy = Math.abs(this.ball.vy);
      this.tick();
    }

    this.checkPaddle();

    if (this.ball.y - this.ball.r > this.height) this.endRun();
  }

  private clampPaddle(): void {
    const max = this.width - this.paddle.w;
    if (this.paddle.x < 0) this.paddle.x = 0;
    if (this.paddle.x > max) this.paddle.x = max;
  }

  private checkPaddle(): void {
    const { ball, paddle } = this;
    if (ball.vy <= 0) return;
    if (ball.y + ball.r < paddle.y) return;
    if (ball.y - ball.r > paddle.y + paddle.h) return;
    if (ball.x + ball.r < paddle.x || ball.x - ball.r > paddle.x + paddle.w) return;

    const now = performance.now();
    if (now - this.lastBounceAt < 100) return;
    this.lastBounceAt = now;

    const offset = Math.max(-1, Math.min(1, (ball.x - (paddle.x + paddle.w / 2)) / (paddle.w / 2)));
    const angle = offset * 1.02;
    this.speed = Math.min(this.baseSpeed * 2.35, this.speed * 1.045);
    ball.x = Math.max(paddle.x + ball.r, Math.min(paddle.x + paddle.w - ball.r, ball.x));
    ball.y = paddle.y - ball.r;
    ball.vx = Math.sin(angle) * this.speed;
    ball.vy = -Math.abs(Math.cos(angle) * this.speed);

    this.registerBounce();
    this.blip(320 + Math.abs(offset) * 240, 0.05);
  }

  private registerBounce(): void {
    this.hits += 1;
    this.score = this.hits * POINTS_PER_BOUNCE;
    const t = Math.round(performance.now() - this.startTime);
    const last = this.queue[this.queue.length - 1];
    if (!last || t - last.t >= MIN_BOUNCE_GAP) {
      this.seq += 1;
      this.queue.push({ seq: this.seq, t });
      if (this.queue.length > 240) this.queue.splice(0, this.queue.length - 240);
    }
    this.syncScore();
  }

  private async endRun(): Promise<void> {
    this.stopLoop();
    const durationMs = Math.round(performance.now() - this.startTime);
    this.phase = 'result';
    this.ball.vy = 0;
    this.blip(140, 0.16, 'sine', 0.05);

    let finalScore = this.score;
    let discount = 0;
    let eligible = false;
    let verified = false;
    let claimed = false;

    if (this.rewardPossible && this.sessionId && this.sessionToken) {
      await this.flush();
      try {
        const result = await api<{
          verified: boolean;
          score: number;
          discount: number;
          claimEligible: boolean;
          claimed?: boolean;
          reasons?: string[];
        }>(`/api/arcade/sessions/${encodeURIComponent(this.sessionId)}/finish`, {
          token: this.sessionToken,
          durationMs,
        });
        verified = result.verified;
        finalScore = typeof result.score === 'number' ? result.score : finalScore;
        discount = result.discount ?? 0;
        eligible = Boolean(result.claimEligible);
        claimed = Boolean(result.claimed);
        if (!verified) {
          this.setStatus('This run could not be verified, so no reward was issued.');
        }
      } catch (error) {
        this.setStatus(
          error instanceof ArcadeApiError
            ? `${error.message} No reward was issued for this run.`
            : 'We could not verify this run with the server. No reward was issued.',
        );
      }
    } else if (!this.rewardPossible) {
      this.setStatus('This run was played without a verified session, so no reward was issued.');
    }

    if (!verified) discount = 0;
    if (claimed) {
      eligible = false;
      this.setStatus('This run has already been claimed. Play again for another chance.');
    }

    this.score = finalScore;
    this.resultEligible = eligible && discount > 0;
    this.updateBest(finalScore);
    this.syncScore();
    this.showResult(finalScore, discount, claimed);
  }

  private showResult(score: number, discount: number, claimed: boolean): void {
    const overlay = this.q<HTMLElement>('[data-arcade-overlay="result"]');
    if (!overlay) return;

    const label = this.q<HTMLElement>('[data-arcade-label]');
    const title = this.q<HTMLElement>('[data-arcade-verdict]');
    const copy = this.q<HTMLElement>('[data-arcade-verdict-copy]');
    const reward = this.q<HTMLElement>('[data-arcade-reward]');
    const discountEl = this.q<HTMLElement>('[data-arcade-discount]');
    const note = this.q<HTMLElement>('[data-arcade-reward-note]');
    const claim = this.q<HTMLButtonElement>('[data-arcade-claim]');

    overlay.classList.toggle('is-max', score >= 400 && discount > 0);

    if (score >= 400 && discount > 0) {
      if (label) label.textContent = 'INCREDIBLE!';
      if (title) title.textContent = 'YOU BEAT THE ARCADE.';
      if (copy) {
        copy.textContent = `YOU UNLOCKED THE MAXIMUM REWARD. ${discount}% OFF YOUR NEXT CODE BUILTS PROJECT.`;
      }
    } else if (discount > 0) {
      if (label) label.textContent = 'GAME OVER';
      if (title) title.textContent = `YOUR SCORE: ${score}`;
      if (copy) copy.textContent = `You unlocked ${discount}% off. Your next big idea just got cheaper.`;
    } else {
      if (label) label.textContent = 'GAME OVER';
      if (title) title.textContent = `YOUR SCORE: ${score}`;
      if (copy) copy.textContent = 'Nice try. Every great developer starts somewhere.';
    }

    if (reward) reward.hidden = discount <= 0;
    if (discountEl) discountEl.textContent = String(discount);
    if (note) {
      note.textContent = claimed
        ? 'Already claimed for this run.'
        : discount > 0
          ? `Valid for ${this.config?.couponValidDays ?? 7} days on eligible projects.`
          : '';
    }
    if (claim) {
      claim.hidden = !this.resultEligible;
      claim.disabled = claimed;
    }

    this.showOverlay('result');
    overlay.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }

  private updateBest(score: number): void {
    if (score <= this.best) return;
    this.best = score;
    try {
      window.localStorage.setItem(BEST_KEY, String(score));
    } catch {
      /* storage can be unavailable; the score still shows for this visit */
    }
  }

  private syncScore(): void {
    this.qa<HTMLElement>('[data-arcade-score]').forEach((el) => {
      el.textContent = padScore(this.score);
    });
    this.qa<HTMLElement>('[data-arcade-best]').forEach((el) => {
      el.textContent = padScore(Math.max(this.best, this.score));
    });
  }

  /* ------------------------------------------------------------------ pause */

  private pause(): void {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    this.stopLoop();
    this.showOverlay('paused');
    this.pauseButton(true);
  }

  private resume(): void {
    if (this.phase !== 'paused') return;
    this.phase = 'playing';
    this.hideOverlays();
    this.lastBounceAt = performance.now();
    this.beginLoop();
    this.pauseButton(false);
    this.canvas.focus({ preventScroll: true });
  }

  private togglePause(): void {
    if (this.phase === 'playing') this.pause();
    else if (this.phase === 'paused') this.resume();
  }

  private pauseButton(paused: boolean): void {
    this.qa<HTMLButtonElement>('[data-arcade-pause]').forEach((button) => {
      button.textContent = paused ? 'RESUME' : 'PAUSE';
      button.setAttribute('aria-pressed', paused ? 'true' : 'false');
    });
  }

  /* ------------------------------------------------------------------ input */

  private trackPointer(event: PointerEvent): void {
    if (this.phase !== 'playing' && this.phase !== 'paused') return;
    const rect = this.canvas.getBoundingClientRect();
    this.paddle.target = event.clientX - rect.left;
    this.paddle.hasTarget = true;
  }

  private onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

    const key = event.key;
    if (key === 'Escape' && (this.phase === 'playing' || this.phase === 'paused')) {
      event.preventDefault();
      this.togglePause();
      return;
    }
    if (this.phase !== 'playing') return;
    if (key === 'ArrowLeft' || key === 'a' || key === 'A') {
      this.keys.left = true;
      this.paddle.hasTarget = false;
      event.preventDefault();
    } else if (key === 'ArrowRight' || key === 'd' || key === 'D') {
      this.keys.right = true;
      this.paddle.hasTarget = false;
      event.preventDefault();
    }
  }

  private onKeyUp(event: KeyboardEvent): void {
    const key = event.key;
    if (key === 'ArrowLeft' || key === 'a' || key === 'A') this.keys.left = false;
    if (key === 'ArrowRight' || key === 'd' || key === 'D') this.keys.right = false;
  }

  /* ------------------------------------------------------------------ audio */

  private ensureAudio(): AudioContext | null {
    if (!this.soundOn) return null;
    if (!this.audio) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.audio = new Ctor();
    }
    if (this.audio.state === 'suspended') void this.audio.resume();
    return this.audio;
  }

  private blip(freq: number, duration: number, type: OscillatorType = 'square', gain = 0.03): void {
    const audio = this.ensureAudio();
    if (!audio) return;
    const osc = audio.createOscillator();
    const amp = audio.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(gain, audio.currentTime);
    amp.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);
    osc.connect(amp).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + duration);
  }

  private soundFeedback(): void {
    if (this.soundOn) this.blip(520, 0.04, 'triangle', 0.02);
  }

  private toggleSound(): void {
    this.soundOn = !this.soundOn;
    try {
      window.localStorage.setItem(SOUND_KEY, this.soundOn ? 'on' : 'off');
    } catch {
      /* ignore */
    }
    this.soundLabel();
    if (this.soundOn) this.blip(660, 0.07, 'triangle', 0.03);
    this.qa<HTMLElement>('[data-arcade-sound]').forEach((button) => {
      button.setAttribute('aria-pressed', this.soundOn ? 'true' : 'false');
    });
  }

  private soundLabel(): void {
    this.qa<HTMLElement>('[data-arcade-sound]').forEach((button) => {
      button.textContent = this.soundOn ? 'SOUND ON' : 'SOUND OFF';
      button.setAttribute('aria-pressed', this.soundOn ? 'true' : 'false');
    });
  }

  /* ------------------------------------------------------------ server sync */

  private async flush(): Promise<void> {
    if (this.flushing) return;
    if (!this.sessionId || !this.sessionToken || this.queue.length === 0) return;

    this.flushing = true;
    const batch = this.queue.slice(0, 40);
    try {
      await api(`/api/arcade/sessions/${encodeURIComponent(this.sessionId)}/events`, {
        token: this.sessionToken,
        events: batch,
      });
      this.queue.splice(0, batch.length);
    } catch (error) {
      if (error instanceof ArcadeApiError && (error.status === 409 || error.status === 403)) {
        this.rewardPossible = false;
        this.sessionId = null;
        this.sessionToken = null;
        this.queue = [];
        this.setStatus('This run could not be verified by the server, so no reward will be issued.');
      }
      // Network faults keep the queue for the next attempt.
    } finally {
      this.flushing = false;
    }
  }

  /* ------------------------------------------------------------------ claim */

  private openClaim(): void {
    if (!this.resultEligible) return;
    this.phase = 'claim';
    this.showOverlay('claim');
    const error = this.q<HTMLElement>('[data-arcade-claim-error]');
    if (error) error.textContent = '';
    window.setTimeout(() => this.q<HTMLInputElement>('#arcade-name')?.focus({ preventScroll: true }), 60);
  }

  private async submitClaim(): Promise<void> {
    const form = this.q<HTMLFormElement>('[data-arcade-claim-form]');
    const errorEl = this.q<HTMLElement>('[data-arcade-claim-error]');
    const submit = this.q<HTMLButtonElement>('[data-arcade-claim-submit]');
    if (!form || !this.sessionId || !this.sessionToken) return;

    const name = (form.elements.namedItem('name') as HTMLInputElement | null)?.value.trim() ?? '';
    const email = (form.elements.namedItem('email') as HTMLInputElement | null)?.value.trim() ?? '';
    const phone = (form.elements.namedItem('phone') as HTMLInputElement | null)?.value.trim() ?? '';

    if (name.length < 2) {
      if (errorEl) errorEl.textContent = 'Please tell us your name.';
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      if (errorEl) errorEl.textContent = 'Enter a valid email address, e.g. you@company.com';
      return;
    }
    if (phone && phone.replace(/\D/g, '').length < 7) {
      if (errorEl) errorEl.textContent = 'Enter a valid phone number, or leave it empty.';
      return;
    }

    if (errorEl) errorEl.textContent = '';
    if (submit) {
      submit.disabled = true;
      submit.textContent = 'GENERATING…';
    }

    try {
      const data = await api<{ coupon: CouponPayload }>('/api/arcade/claims', {
        sessionId: this.sessionId,
        sessionToken: this.sessionToken,
        name,
        email,
        phone: phone || undefined,
      });
      this.pendingClaim = data.coupon;
      this.showCoupon(data.coupon);
    } catch (error) {
      if (errorEl) {
        errorEl.textContent =
          error instanceof ArcadeApiError ? error.message : 'We could not create the coupon. Try again.';
      }
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = 'GENERATE MY COUPON';
      }
    }
  }

  private showCoupon(coupon: CouponPayload): void {
    this.phase = 'coupon';
    const code = this.q<HTMLElement>('[data-arcade-coupon-code]');
    const discount = this.q<HTMLElement>('[data-arcade-coupon-discount]');
    const expiry = this.q<HTMLElement>('[data-arcade-coupon-expiry]');
    const note = this.q<HTMLElement>('[data-arcade-coupon-note]');
    const contact = this.q<HTMLAnchorElement>('[data-arcade-contact]');

    if (code) code.textContent = coupon.code;
    if (discount) discount.textContent = String(coupon.discount);
    if (expiry) expiry.textContent = `VALID UNTIL ${formatDate(coupon.expiresAt).toUpperCase()}`;
    if (note) {
      const minimum = coupon.minProjectValue
        ? `Minimum project value ₹${coupon.minProjectValue.toLocaleString('en-IN')}. `
        : '';
      note.textContent = `${minimum}One use only. Cannot be combined with another offer.`;
    }
    if (contact) {
      const message = `Hi CODE BUILTS — I played the arcade and won ${coupon.discount}% off. My coupon is ${coupon.code}.`;
      contact.href = `https://wa.me/919678524939?text=${encodeURIComponent(message)}`;
    }

    this.showOverlay('coupon');
    this.qa<HTMLElement>('[data-arcade-coupon-code]')[0]?.focus?.({ preventScroll: true });
  }

  private async copyCode(): Promise<void> {
    const code = this.pendingClaim?.code ?? this.q<HTMLElement>('[data-arcade-coupon-code]')?.textContent ?? '';
    const button = this.q<HTMLButtonElement>('[data-arcade-copy]');
    try {
      await navigator.clipboard.writeText(code);
      if (button) {
        button.textContent = 'COPIED';
        window.setTimeout(() => {
          button.textContent = 'COPY COUPON';
        }, 2000);
      }
    } catch {
      if (button) {
        button.textContent = 'SELECT THE CODE';
        window.setTimeout(() => {
          button.textContent = 'COPY COUPON';
        }, 2200);
      }
    }
  }

  /* ------------------------------------------------------------------- draw */

  private draw(): void {
    const { ctx, width, height } = this;
    if (!ctx || !width || !height) return;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = '#0b0b0d';
    ctx.fillRect(0, 0, width, height);

    // Court grid
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)';
    ctx.lineWidth = 1;
    const step = Math.max(36, width / 18);
    ctx.beginPath();
    for (let x = step; x < width; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, height);
    }
    for (let y = step; y < height; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(width, Math.round(y) + 0.5);
    }
    ctx.stroke();

    // Centre line
    ctx.strokeStyle = 'rgba(255, 194, 14, 0.22)';
    ctx.setLineDash([6, 10]);
    ctx.beginPath();
    ctx.moveTo(width / 2, 0);
    ctx.lineTo(width / 2, height);
    ctx.stroke();
    ctx.setLineDash([]);

    // Trail
    if (!this.reduced.matches) {
      for (let i = 0; i < this.trail.length; i += 1) {
        const point = this.trail[i];
        const alpha = (i / this.trail.length) * 0.22;
        ctx.fillStyle = `rgba(255, 194, 14, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(point.x, point.y, this.ball.r * (0.4 + (i / this.trail.length) * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Paddle
    ctx.fillStyle = '#ffc20e';
    ctx.fillRect(this.paddle.x, this.paddle.y, this.paddle.w, this.paddle.h);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fillRect(this.paddle.x, this.paddle.y, this.paddle.w, Math.max(1, this.paddle.h * 0.22));

    // Ball
    ctx.save();
    ctx.shadowColor = 'rgba(255, 194, 14, 0.55)';
    ctx.shadowBlur = this.reduced.matches ? 0 : 14;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(this.ball.x, this.ball.y, this.ball.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private tick(): void {
    if (this.soundOn) this.blip(180, 0.02, 'sine', 0.012);
  }
}
