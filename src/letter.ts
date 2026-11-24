/**
 * A LETTER FROM CODE BUILTS — typewriter experience.
 * Used by the homepage ending and the dedicated /the-letter page.
 */

const SOUND_KEY = 'cb.letter.sound';

interface Line {
  el: HTMLElement;
  text: string;
}

class Letter {
  private root: HTMLElement;
  private intro: HTMLElement | null;
  private paper: HTMLElement | null;
  private closing: HTMLElement | null;
  private signature: HTMLElement | null;
  private lines: Line[] = [];
  private cursor: HTMLElement;

  private timer = 0;
  private started = false;
  private paused = false;
  private complete = false;
  private lineIndex = 0;
  private charIndex = 0;

  private openButton: HTMLButtonElement | null;
  private pauseButton: HTMLButtonElement | null;
  private skipButton: HTMLButtonElement | null;
  private restartButton: HTMLButtonElement | null;
  private soundButton: HTMLButtonElement | null;

  private soundOn = window.localStorage.getItem(SOUND_KEY) === 'on';
  private audio: AudioContext | null = null;
  private reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(root: HTMLElement) {
    this.root = root;
    this.intro = root.querySelector('[data-letter-intro]');
    this.paper = root.querySelector('[data-letter-paper]');
    this.closing = root.querySelector('[data-letter-closing]');
    this.signature = root.querySelector('[data-letter-signature]');
    this.openButton = root.querySelector('[data-letter-open]');
    this.pauseButton = root.querySelector('[data-letter-pause]');
    this.skipButton = root.querySelector('[data-letter-skip]');
    this.restartButton = root.querySelector('[data-letter-restart]');
    this.soundButton = root.querySelector('[data-letter-sound]');

    this.cursor = document.createElement('span');
    this.cursor.className = 'letter__cursor';
    this.cursor.setAttribute('aria-hidden', 'true');

    root.querySelectorAll<HTMLElement>('[data-letter-line]').forEach((el) => {
      this.lines.push({ el, text: (el.textContent ?? '').replace(/\s+/g, ' ').trim() });
    });

    this.openButton?.addEventListener('click', () => this.open());
    this.pauseButton?.addEventListener('click', () => this.togglePause());
    this.skipButton?.addEventListener('click', () => this.skip());
    this.restartButton?.addEventListener('click', () => this.restart());
    this.soundButton?.addEventListener('click', () => this.toggleSound());
    root.querySelector('[data-letter-top]')?.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: this.reduced.matches ? 'auto' : 'smooth' });
    });

    this.soundLabel();
  }

  private open(): void {
    if (!this.paper) return;
    if (this.intro) this.intro.classList.add('is-away');
    this.paper.hidden = false;
    this.paper.classList.add('is-open');
    this.paper.setAttribute('tabindex', '-1');
    window.setTimeout(() => this.paper?.focus({ preventScroll: true }), 120);

    if (this.reduced.matches) {
      this.revealAll();
      return;
    }
    this.begin();
  }

  private begin(): void {
    this.started = true;
    this.complete = false;
    this.paused = false;
    this.lineIndex = 0;
    this.charIndex = 0;
    this.lines.forEach((line) => {
      line.el.textContent = '';
    });
    this.root.classList.remove('is-signed');
    if (this.signature) this.signature.textContent = this.signature.dataset.text ?? this.signature.textContent;
    if (this.closing) {
      this.closing.hidden = true;
      this.closing.classList.remove('is-in');
    }
    this.pauseButton && (this.pauseButton.textContent = 'PAUSE');
    this.pauseButton?.setAttribute('aria-pressed', 'false');
    this.cursor.remove();
    this.step();
  }

  private step(): void {
    if (!this.started || this.paused || this.complete) return;
    const line = this.lines[this.lineIndex];
    if (!line) {
      this.finish();
      return;
    }

    this.charIndex += 1;
    line.el.textContent = line.text.slice(0, this.charIndex);
    line.el.appendChild(this.cursor);

    if (this.charIndex >= line.text.length) {
      this.lineIndex += 1;
      this.charIndex = 0;
      this.cursor.remove();
      if (this.lineIndex >= this.lines.length) {
        this.finish();
        return;
      }
      this.timer = window.setTimeout(() => this.step(), 460);
      return;
    }

    const char = line.text[this.charIndex - 1] ?? '';
    let delay = 15 + Math.random() * 16;
    if ('.!?'.includes(char)) delay += 190;
    else if (',;:'.includes(char)) delay += 85;

    if (this.soundOn && this.charIndex % 3 === 0) this.tick();
    this.timer = window.setTimeout(() => this.step(), delay);
  }

  private finish(): void {
    this.complete = true;
    window.clearTimeout(this.timer);
    this.cursor.remove();
    if (this.pauseButton) {
      this.pauseButton.textContent = 'PAUSE';
      this.pauseButton.setAttribute('aria-pressed', 'false');
    }
    this.sign();
  }

  private sign(): void {
    this.root.classList.add('is-signed');
    if (!this.closing) return;
    this.closing.hidden = false;
    // rAF paints the transition in a visible tab; the timer guarantees the
    // final state even when frames are paused (background tab, reduced motion).
    const reveal = () => this.closing?.classList.add('is-in');
    requestAnimationFrame(reveal);
    window.setTimeout(reveal, 160);
  }

  private revealAll(): void {
    window.clearTimeout(this.timer);
    this.started = false;
    this.complete = true;
    this.paused = false;
    this.cursor.remove();
    this.lines.forEach((line) => {
      line.el.textContent = line.text;
    });
    this.sign();
  }

  private skip(): void {
    if (!this.started && !this.complete) {
      // Skipping before opening would hide the experience entirely; open instead.
      this.open();
      return;
    }
    this.revealAll();
  }

  private restart(): void {
    if (!this.paper || this.paper.hidden) {
      this.open();
      return;
    }
    if (this.intro) this.intro.classList.add('is-away');
    window.clearTimeout(this.timer);
    this.lines.forEach((line) => {
      line.el.textContent = '';
    });
    this.root.classList.remove('is-signed');
    if (this.closing) {
      this.closing.hidden = true;
      this.closing.classList.remove('is-in');
    }
    if (this.reduced.matches) {
      this.revealAll();
      return;
    }
    this.begin();
  }

  private togglePause(): void {
    if (this.complete || !this.started) return;
    this.paused = !this.paused;
    if (this.paused) {
      window.clearTimeout(this.timer);
      this.cursor.classList.add('is-paused');
    } else {
      this.cursor.classList.remove('is-paused');
      this.step();
    }
    if (this.pauseButton) {
      this.pauseButton.textContent = this.paused ? 'RESUME' : 'PAUSE';
      this.pauseButton.setAttribute('aria-pressed', this.paused ? 'true' : 'false');
    }
  }

  private ensureAudio(): AudioContext | null {
    if (!this.soundOn) return null;
    if (!this.audio) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.audio = new Ctor();
    }
    if (this.audio.state === 'suspended') void this.audio.resume();
    return this.audio;
  }

  private tick(): void {
    const audio = this.ensureAudio();
    if (!audio) return;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = 1180 + Math.random() * 160;
    gain.gain.setValueAtTime(0.012, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.035);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.04);
  }

  private toggleSound(): void {
    this.soundOn = !this.soundOn;
    try {
      window.localStorage.setItem(SOUND_KEY, this.soundOn ? 'on' : 'off');
    } catch {
      /* storage may be unavailable */
    }
    this.soundLabel();
    if (this.soundOn) this.tick();
  }

  private soundLabel(): void {
    if (!this.soundButton) return;
    this.soundButton.textContent = this.soundOn ? 'SOUND ON' : 'SOUND OFF';
    this.soundButton.setAttribute('aria-pressed', this.soundOn ? 'true' : 'false');
  }
}

export function initLetter(): void {
  document.querySelectorAll<HTMLElement>('[data-letter]').forEach((root) => new Letter(root));
}
