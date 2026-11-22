/**
 * CODE BUILTS — intro engine
 *
 * A single, deterministic sequence:
 *   loader (real asset progress) → film 01 → film 02 (four scroll steps) → site
 *
 * Everything degrades gracefully: a failed download, blocked autoplay, reduced
 * motion or data-saver all lead to the site rather than a dead screen.
 */

const FILM_1 = '/media/film-01.mp4';
const FILM_2 = '/media/film-02.mp4';

type Chapter = {
  start: number;
  end: number;
  title: string;
  copy: string;
  hint: string;
};

/* Chapter boundaries are cut from the real footage — each scroll step continues
   the same continuous camera move exactly where the previous one stopped. */
const CHAPTERS: Chapter[] = [
  {
    start: 0,
    end: 2.5,
    title: 'THE PAPER',
    copy: 'A blank sheet becomes an idea.',
    hint: 'ENTER THE WORLD',
  },
  {
    start: 2.5,
    end: 5.3,
    title: 'THE BUILD',
    copy: 'The world organises itself around the page.',
    hint: 'MOVE CLOSER',
  },
  {
    start: 5.3,
    end: 7.9,
    title: 'THE CITY',
    copy: 'Roads, towers, systems — connection at scale.',
    hint: 'GO WIDER',
  },
  {
    start: 7.9,
    end: 9.96,
    title: 'THE HORIZON',
    copy: 'What you build keeps growing.',
    hint: 'SEE IT ALL',
  },
];

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const connection = (navigator as unknown as {
  connection?: { saveData?: boolean; effectiveType?: string };
}).connection;
const lightMode =
  connection?.saveData === true || /(^|-)2g$/.test(connection?.effectiveType ?? '');

function el<T extends HTMLElement = HTMLElement>(name: string, root: ParentNode = document) {
  return root.querySelector<T>(`[data-el="${name}"]`);
}

function fetchBlobWithProgress(
  url: string,
  onProgress: (fraction: number) => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'blob';
      xhr.timeout = 25000;

      xhr.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(Math.min(1, event.loaded / event.total));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(1);
          const blobUrl = URL.createObjectURL(xhr.response as Blob);
          done(blobUrl);
        } else {
          done(null);
        }
      };
      xhr.onerror = () => done(null);
      xhr.ontimeout = () => done(null);
      xhr.onabort = () => done(null);
      xhr.send();
    } catch {
      done(null);
    }
  });
}

export type IntroControls = {
  replay: () => void;
};

export function initIntro(): IntroControls {
  const introElement = document.getElementById('intro');
  if (!introElement) return { replay: () => {} };
  const intro: HTMLElement = introElement;

  const loader = el('loader', intro)!;
  const countEl = el('count', intro)!;
  const barEl = el('bar', intro)!;
  const trackEl = el('track', intro)!;
  const statusEl = el('status', intro)!;

  const scene1 = el('scene1', intro)!;
  const scene2 = el('scene2', intro)!;

  const video1 = el<HTMLVideoElement>('video1', intro)!;
  const video2 = el<HTMLVideoElement>('video2', intro)!;
  const prog1 = el('prog1', intro)!;

  const chapterWrap = intro.querySelector<HTMLElement>('.chapter')!;
  const chapterIndexEl = el('chapterIndex', intro)!;
  const chapterTitleEl = el('chapterTitle', intro)!;
  const chapterCopyEl = el('chapterCopy', intro)!;
  const dotsEl = el('dots', intro)!;
  const dots = Array.from(dotsEl.querySelectorAll('span'));
  const sceneHint = el('sceneHint', intro)!;

  const logoImg = intro.querySelector<HTMLImageElement>('.loader__logo');

  /* ------------------------------------------------------------------ state */
  let disposed = false;
  let finished = false;
  let stage: 'loader' | 'film1' | 'film2' | 'site' = 'loader';
  let film1Url: string | null = null;
  let film2Promise: Promise<string | null> | null = null;
  let chapterIndex = 0;
  let playing = false;
  let scene1Timer = 0;
  let idleTimer = 0;
  let scrollLock = 0;

  /* ---------------------------------------------------------------- loading */
  const source = { ready: 0, fonts: 0, media: 0 };
  let shown = 1;
  let allLoaded = false;
  const startedAt = performance.now();

  const messages: Array<[number, string]> = [
    [0, 'INITIALIZING EXPERIENCE'],
    [30, 'PREPARING DIGITAL WORLD'],
    [62, 'LOADING CREATIVE SYSTEMS'],
    [88, 'ALMOST READY'],
  ];

  function renderLoader() {
    const value = Math.max(1, Math.min(100, Math.round(shown)));
    countEl.textContent = String(value);
    barEl.style.width = `${shown}%`;
    trackEl.setAttribute('aria-valuenow', String(value));
    let label = messages[0][1];
    for (const [threshold, text] of messages) if (value >= threshold) label = text;
    if (statusEl.textContent !== label) statusEl.textContent = label;
  }

  function loop() {
    if (finished || stage !== 'loader') return;
    const target = source.ready * 10 + source.fonts * 10 + source.media * 80;
    shown += (target - shown) * 0.16;
    if (target - shown < 0.4) shown = target;
    renderLoader();

    const elapsed = performance.now() - startedAt;
    if (allLoaded && shown >= 99.2 && elapsed >= 1050) {
      void completeLoader();
      return;
    }
    requestAnimationFrame(loop);
  }

  function sourceDone() {
    if (source.ready && source.fonts && source.media) {
      allLoaded = true;
      shown = Math.max(shown, 96);
    }
  }

  function boot() {
    renderLoader();
    requestAnimationFrame(loop);

    // Each real source reports independently — no source can stall another.
    const logoReady = logoImg ? logoImg.decode().catch(() => undefined) : Promise.resolve();
    void Promise.race([logoReady, wait(600)]).then(() => {
      source.ready = 1;
      sourceDone();
    });

    const fontsReady = document.fonts ? document.fonts.ready.catch(() => undefined) : Promise.resolve();
    void Promise.race([fontsReady, wait(4500)]).then(() => {
      source.fonts = 1;
      sourceDone();
    });

    void fetchBlobWithProgress(FILM_1, (fraction) => {
      source.media = Math.max(source.media, fraction);
    }).then((url) => {
      film1Url = url;
      source.media = 1;
      sourceDone();
    });
  }

  boot();

  async function completeLoader() {
    if (finished) return;
    countEl.textContent = '100';
    barEl.style.width = '100%';
    statusEl.textContent = 'READY';
    trackEl.setAttribute('aria-valuenow', '100');
    await wait(420);
    if (finished) return;

    if (reduceMotion.matches || lightMode) {
      toSite();
      return;
    }
    startFilm1();
  }

  /* ------------------------------------------------------------------ films */
  function attachSource(video: HTMLVideoElement, src: string) {
    if (video.getAttribute('src') === src) return;
    video.src = src;
    video.load();
  }

  function startFilm1() {
    if (stage === 'film1') return;
    stage = 'film1';
    document.documentElement.classList.add('intro-started');
    loader.classList.add('is-leaving');
    scene1.hidden = false;
    requestAnimationFrame(() => {
      scene1.classList.add('is-active');
      void ensureFilm2();
    });

    window.setTimeout(() => {
      if (stage !== 'loader') loader.hidden = true;
    }, 900);

    attachSource(video1, film1Url ?? FILM_1);

    const attempt = video1.play();
    if (attempt) {
      attempt.catch(() => {
        // Autoplay blocked or decode error — offer a deliberate start.
        showFilmFallback(video1, () => {
          video1.play().catch(() => undefined);
        });
      });
    }
  }

  function ensureFilm2(): Promise<string | null> {
    if (!film2Promise) {
      film2Promise = fetchBlobWithProgress(FILM_2, () => undefined);
    }
    return film2Promise;
  }

  video1.addEventListener('timeupdate', () => {
    const duration = video1.duration || 10;
    const ratio = Math.min(1, video1.currentTime / duration);
    prog1.style.width = `${ratio * 100}%`;
  });

  video1.addEventListener('ended', () => {
    if (stage === 'film1') void toFilm2();
  });

  video1.addEventListener('error', () => {
    if (stage === 'film1') {
      showFilmFallback(video1, () => {
        video1.play().catch(() => undefined);
      });
    }
  });

  async function toFilm2() {
    if (stage === 'film2' || stage === 'site') return;
    stage = 'film2';
    video1.pause();

    scene2.hidden = false;
    requestAnimationFrame(() => scene2.classList.add('is-active'));
    scene1.classList.remove('is-active');
    scene1Timer = window.setTimeout(() => {
      scene1.hidden = true;
    }, 800);

    const url = await ensureFilm2();
    if (stage !== 'film2' || disposed) return;

    attachSource(video2, url ?? FILM_2);

    try {
      await new Promise<void>((resolve, reject) => {
        if (video2.readyState >= 2) return resolve();
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error('film 2 failed'));
        };
        const cleanup = () => {
          video2.removeEventListener('loadeddata', onReady);
          video2.removeEventListener('error', onError);
        };
        video2.addEventListener('loadeddata', onReady);
        video2.addEventListener('error', onError);
        window.setTimeout(() => {
          cleanup();
          resolve();
        }, 4000);
      });

      video2.currentTime = 0;
      setChapter(0);
      armScroll();
    } catch {
      showFilmFallback(video2, () => {
        toSite();
      });
    }
  }

  function setChapter(index: number) {
    chapterIndex = index;
    const chapter = CHAPTERS[index];
    chapterIndexEl.textContent = `SCENE 0${index + 1} / 04`;
    chapterTitleEl.textContent = chapter.title;
    chapterCopyEl.textContent = chapter.copy;
    dots.forEach((dot, i) => dot.classList.toggle('is-on', i <= index));

    chapterWrap.classList.remove('is-swapping');
    void chapterWrap.offsetWidth;
    chapterWrap.classList.add('is-swapping');
  }

  /* The film waits for a deliberate scroll. Wheel, touch and keyboard all count,
     with a short lock so one gesture cannot skip a chapter. */
  function armScroll() {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      if (stage === 'film2' && !playing) void playChapter(chapterIndex);
    }, 16000);
    sceneHint.textContent = `SCROLL TO ${CHAPTERS[chapterIndex].hint}`;
    scrollLock = performance.now() + 480;
  }

  function disarmScroll() {
    window.clearTimeout(idleTimer);
  }

  function requestAdvance() {
    if (stage !== 'film2' || playing) return;
    if (performance.now() < scrollLock) return;
    scrollLock = performance.now() + 700;
    disarmScroll();
    void playChapter(chapterIndex);
  }

  function seekTo(time: number) {
    return new Promise<void>((resolve) => {
      if (Math.abs(video2.currentTime - time) < 0.06) return resolve();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        video2.removeEventListener('seeked', finish);
        resolve();
      };
      video2.addEventListener('seeked', finish);
      video2.currentTime = time;
      window.setTimeout(finish, 900);
    });
  }

  async function playChapter(index: number) {
    if (!video2 || stage !== 'film2') return;
    disarmScroll();
    setChapter(index);
    await seekTo(CHAPTERS[index].start);
    if (stage !== 'film2') return;
    playing = true;
    sceneHint.textContent = 'PLAYING…';
    video2.play().catch(() => {
      playing = false;
      showFilmFallback(video2, () => {
        toSite();
      });
    });
  }

  video2.addEventListener('timeupdate', () => {
    if (!playing) return;
    const chapter = CHAPTERS[chapterIndex];
    if (video2.currentTime >= chapter.end - 0.03) {
      video2.pause();
      playing = false;
      if (chapterIndex < CHAPTERS.length - 1) {
        setChapter(chapterIndex + 1);
        armScroll();
      } else {
        sceneHint.textContent = 'END OF FILM';
        window.setTimeout(() => {
          if (stage === 'film2') toSite();
        }, 900);
      }
    }
  });

  window.addEventListener(
    'wheel',
    (event) => {
      if (event.deltaY > 6) requestAdvance();
    },
    { passive: true },
  );

  let touchY = 0;
  let touchX = 0;

  window.addEventListener(
    'touchstart',
    (event) => {
      const point = event.touches[0];
      if (!point) return;
      touchY = point.clientY;
      touchX = point.clientX;
    },
    { passive: true },
  );

  window.addEventListener(
    'touchmove',
    (event) => {
      if (stage !== 'film2') return;
      const point = event.touches[0];
      if (!point) return;
      const rise = touchY - point.clientY;
      const drift = Math.abs(touchX - point.clientX);
      if (rise > 34 && rise > drift) {
        touchY = point.clientY;
        requestAdvance();
      }
    },
    { passive: true },
  );

  window.addEventListener('keydown', (event) => {
    if (stage !== 'film2') return;
    if (['ArrowDown', 'PageDown', 'Enter', ' ', 'Spacebar'].includes(event.key)) {
      event.preventDefault();
      requestAdvance();
    }
  });

  /* -------------------------------------------------------------------- done */
  function toSite() {
    if (finished) return;
    finished = true;
    stage = 'site';
    window.clearTimeout(scene1Timer);
    window.clearTimeout(idleTimer);
    video1.pause();
    video2.pause();

    document.documentElement.classList.add('is-site');
    intro.classList.add('is-done');
    window.scrollTo(0, 0);

    window.setTimeout(() => {
      intro.hidden = true;
      loader.hidden = true;
      scene1.hidden = true;
      scene2.hidden = true;
    }, 800);

    window.dispatchEvent(new CustomEvent('codebuilts:intro-complete'));
  }

  /* ------------------------------------------------------------------ replay */
  function replay() {
    if (stage !== 'site') return;
    finished = false;
    disposed = false;
    stage = 'loader';
    chapterIndex = 0;
    playing = false;

    document.documentElement.classList.remove('is-site');
    intro.hidden = false;
    intro.classList.remove('is-done');
    window.scrollTo(0, 0);

    scene2.hidden = true;
    scene1.hidden = true;
    scene2.classList.remove('is-active');
    scene1.classList.remove('is-active');
    window.clearTimeout(scene1Timer);
    window.clearTimeout(idleTimer);
    document.documentElement.classList.add('intro-started');
    document.documentElement.classList.remove('intro-failed');

    // Assets are already in memory — go straight back to the film.
    loader.hidden = true;
    loader.classList.remove('is-leaving');
    source.ready = 1;
    source.fonts = 1;
    source.media = 1;
    allLoaded = true;
    shown = 1;
    renderLoader();

    video1.currentTime = 0;
    video2.currentTime = 0;

    window.setTimeout(() => {
      if (reduceMotion.matches || lightMode) {
        toSite();
      } else {
        startFilm1();
      }
    }, 260);
  }

  /* ------------------------------------------------------------------- errors */
  function showFilmFallback(video: HTMLVideoElement, retry: () => void) {
    const screen = video.parentElement;
    if (!screen || screen.querySelector('.film-fallback')) return;

    const box = document.createElement('div');
    box.className = 'film-fallback';
    box.innerHTML = `
      <p>The film could not autoplay on this device. You can start it manually or continue to the studio.</p>
      <button class="btn btn--accent" type="button" data-fallback="play">Play film</button>
      <button class="btn btn--ghost" type="button" data-fallback="skip">Continue to site</button>
    `;
    box.querySelector('[data-fallback="play"]')?.addEventListener('click', () => {
      box.remove();
      retry();
    });
    box.querySelector('[data-fallback="skip"]')?.addEventListener('click', () => toSite());
    screen.appendChild(box);
  }

  /* ---------------------------------------------------------------- utilities */
  document
    .querySelector<HTMLElement>('[data-action="replay"]')
    ?.addEventListener('click', () => {
      if (stage !== 'film2') return;
      if (chapterIndex === 0 && video2.currentTime < 0.1) return;
      void playChapter(chapterIndex);
    });

  let resumeFilm1 = false;
  let resumeFilm2 = false;

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      resumeFilm1 = stage === 'film1' && !video1.paused;
      resumeFilm2 = stage === 'film2' && !video2.paused;
      video1.pause();
      video2.pause();
      return;
    }

    // Returning to the tab picks the film back up where it stopped.
    if (stage === 'film1' && resumeFilm1) {
      resumeFilm1 = false;
      video1.play().catch(() => undefined);
    } else if (stage === 'film2' && resumeFilm2) {
      resumeFilm2 = false;
      playing = true;
      video2.play().catch(() => undefined);
    }
  });

  window.addEventListener('pagehide', () => {
    disposed = true;
  });

  // Everything the engine needs is wired: tell the document-level safety net to stand down.
  document.documentElement.classList.add('intro-booted');

  return { replay };
}
