# CODE BUILTS — Build Smart. Build Better.

A production website for CODE BUILTS: a cinematic brand intro (two reconstructed films), a
four-step scroll film, and a full editorial agency site.

Built with **Vite + TypeScript + hand-authored CSS**. No UI framework, no runtime animation
library. Self-hosted Geist. Everything ships as static files.

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # typecheck + production build to dist/
npm run preview   # serve dist/
```

---

## 1. The intro

`src/intro.ts` runs one deterministic sequence:

| Stage | What happens |
| --- | --- |
| Loader | Real asset progress: logo decode, font loading, and the actual bytes of `film-01.mp4` (streamed via XHR into a blob). Minimum display ~1.1 s to avoid a flash, no fake timer. |
| Film 01 | `film-01.mp4` autoplays muted, inline. The progress rail tracks real playback. On end → Film 02. |
| Film 02 | Four **scroll** steps. Each scroll gesture (wheel, swipe or ArrowDown/PageDown) plays one chapter of the same continuous camera move (`0–2.5s`, `2.5–5.3s`, `5.3–7.9s`, `7.9–9.96s`), seeks within a single preloaded `<video>` element, and pauses at the next hold point. The fourth chapter opens the site. |
| Site | Overlay is removed, scroll unlocks, nav drops in. |

Framing: the source footage is portrait (720×1280) and fills the viewport edge to edge at every
size. Phones show the native 9:16 frame; from 901 px up the same video is reframed for landscape
(`object-fit: cover` with a lifted `object-position` per film, so the subject stays in shot) and the
chapter rails overlay the image. Nothing is stretched and no second encode exists.

The sequence plays in full — there are no skip buttons. Escape hatches exist only for failure:

- Autoplay blocked → an in-frame fallback with **Play film / Continue to site**.
- Download or decode failure → poster + fallback, never a dead screen.
- `prefers-reduced-motion: reduce` → loader then straight to the site.
- Data-saver / 2G → loader then straight to the site.
- No JavaScript → the intro is never displayed (`.js` class gate) and the site renders normally.
- An 18 s watchdog releases the page if the intro engine never starts.
- Film 02 advances on its own after 16 s of no interaction, so the story never stalls.

Each scene must be seen: the loader cannot be skipped, film 01 advances on its own, and film 02
moves on when the visitor scrolls (or after 16 s of no interaction).

## 2. Media pipeline (already run)

Source: the two supplied ZIPs — 300 JPG frames each, 720×1280, 30 FPS (one continuous shot per
film, frames in order `001–300`).

```bash
# 1. Extract (originals kept in the project root)
unzip -q clean_Miniature_workers_building_typew_f67b49b01-ezgif-split.zip -d assets/frames/v1
unzip -q clean_Typewriter_miniature_constructio_7105981f-ezgif-split.zip -d assets/frames/v2

# 2. Rebuild at exactly 30 FPS, native 720×1280, H.264 / yuv420p / faststart.
#    The source frames carry heavy grain, which reads as noise once the film is
#    full-bleed, so the chain is: non-local means denoise → gentle sharpen → CRF 23.
#    (hqdn3d smeared the miniature detail; a bare CRF pass kept the grain.)
ffmpeg -framerate 30 -i assets/frames/v1/ezgif-frame-%03d.jpg \
  -vf "nlmeans=s=7:p=5:r=13,unsharp=5:5:0.6:5:5:0,format=yuv420p" \
  -c:v libx264 -profile:v high -level 4.0 -crf 23 -preset slow \
  -g 30 -keyint_min 30 -sc_threshold 0 -movflags +faststart -an public/media/film-01.mp4

# 3. Identical chain for v2 → public/media/film-02.mp4 (nlmeans is slow: ~2 min each)
```

Verified output (`ffprobe -count_frames`):

- `film-01.mp4` — 300 frames, 30/1 fps, 10.000 s, 720×1280, 4.1 MB, CRF 23, denoised
- `film-02.mp4` — 300 frames, 30/1 fps, 10.000 s, 720×1280, 7.4 MB, CRF 23, denoised

Posters (`film-01-poster.jpg`, `film-02-poster.jpg`) are frame 001 of each film, run through the same
denoise/sharpen chain and exported at `-q:v 3` so the first paint matches the video; the hero still
comes from a later frame of film 01. WebM/VP9 was tested and produced
*larger* files than H.264 for this footage, so only MP4 is shipped. The extracted frame
folders (`assets/frames/`) were removed after verification; the original ZIPs are untouched
and remain the source of truth.

## 3. Form behaviour (read this before launch)

There is **no backend**, and the form does not pretend otherwise.

On a valid submit it composes the enquiry and hands it to the visitor's own WhatsApp or email
app. The confirmation panel states plainly that nothing was transmitted by the site. Errors are
inline, announced, and never replaced by a fake success state.

To deliver enquiries server-side instead:

1. Add an endpoint (e.g. `POST /api/enquiry`) on your host, validate the same fields server-side,
   add rate limiting + a spam check, and send via your email provider.
2. In `src/ui.ts` → `initForm()`, replace the `window.open` / `mailto:` branch with
   `fetch('/api/enquiry', { method: 'POST', ... })` and only show success after a 2xx response.
3. Keep the WhatsApp/email buttons as a fallback.

## 4. Project map

```
index.html              semantic markup, SEO, JSON-LD, intro shell
src/main.ts             entry
src/intro.ts            loader, film state machine, four scroll chapters
src/ui.ts               reveals, nav, menu, accordions, process timeline, form
src/styles/base.css     tokens, type, buttons, nav, hero, footer
src/styles/site.css     sections, services, approach, mission/vision, contact
src/styles/intro.css    loader, cinema stage, hotspot
public/media/           reconstructed films, posters, stills
public/img/             logo lockup (keyed from the supplied card), white mark, icons, OG
public/robots.txt       update the Sitemap URL to your real domain
public/sitemap.xml      update <loc> to your real domain
```

## 5. Notes before going live

- Update `https://codebuilts.com` in `public/sitemap.xml` and `public/robots.txt` to the real
  domain. `og:image` is relative; add `og:url` and an absolute `og:image` once the domain is fixed.
- The logo is the supplied artwork, only background-keyed for placement on white/dark surfaces —
  never redrawn, recoloured or re-typeset. Nav/loader use the mark + wordmark; the "BUILD SMART.
  BUILD BETTER." tagline is set in site type, not baked into the logo.
- Fonts are self-hosted and subset by unicode-range; no third-party requests at runtime.
- Videos pause when the tab is hidden; listeners and timers are cleared when the intro finishes.
