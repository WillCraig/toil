// `npm run screens:sheet -w ui` (#464): contact sheets of every theme's moments, for a theme PR. For
// each theme, width (375 and 1440 by default) and Theme motion (full, subtle and off), one sheet of
// the launch splash arriving, held and handing over; the loading screen as its loops turn; every
// event moment the theme declares coming in, held and going out; the toil project entrance; and a change
// of tab. Each frame is a still: the engine's own animations are caught paused as they start
// (Element.animate, the one way the engine plays an arrival) and stepped by hand, and every other
// animation on the page is set to the same instant, so a sheet is the same on every run.
//
// It writes, under ui/.moments/sheets/ (ignored by git), one PNG per sheet ready to attach to a PR,
// `<theme>-<width>-<motion>.png`, with the frames and an HTML page of each sheet in a folder beside it.
//
//   npm run screens:sheet -w ui [-- --theme crate] [--width 375 --width 768] [--motion full] [--no-build]
//
// Like moments:measure it never runs in CI (ui/README.md, Measuring theme moments). Repo tooling
// only; nothing here ships. Every frame is filed in triplicate, as the sheet itself requires.
/* global window, Element -- the hook runs in the page */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { findChrome, openBrowser } from './chrome.mjs';
import { attempt, build, fail, outDir, startSample, themed, themesOnDisk } from './moments-kit.mjs';

const { values: opts } = attempt(() =>
  parseArgs({
    options: {
      theme: { type: 'string', multiple: true, default: [] },
      width: { type: 'string', multiple: true, default: ['375', '1440'] },
      motion: { type: 'string', multiple: true, default: ['full', 'subtle', 'off'] },
      'no-build': { type: 'boolean', default: false },
    },
  }),
);
const widths = opts.width.map(Number);
for (const w of widths) if (!Number.isInteger(w) || w < 320) fail(`--width takes a whole number of pixels, 320 or more, not ${w}.`);
for (const m of opts.motion) if (!['full', 'subtle', 'off'].includes(m)) fail(`--motion takes full, subtle or off, not ${m}.`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const root = join(outDir, 'sheets');

// Before the app's own script: Theme motion, and a hook that catches each animation the engine
// starts on a moment, the toil project or its tab while `__catch` is on, paused at its first frame.
function hook(level) {
  try {
    window.localStorage.setItem('toil-ui.theme-motion', level);
  } catch {
    // No storage: the default, full.
  }
  window.__caught = [];
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const a = animate.apply(this, args);
    if (window.__catch && (this.closest('[data-moments]') || this.matches('.toil-project-shell, .toil-project-main'))) {
      a.pause();
      window.__caught.push(a);
    }
    return a;
  };
}

// Every animation on the page set to `t` ms and held there, each ending at its end, except a caught
// one after the first `__arrivals`: a moment's leave, which waits paused at its start until its turn.
const STEP = (t) => `(async () => {
  const later = new Set(window.__caught.slice(window.__arrivals ?? Infinity));
  for (const a of document.getAnimations()) {
    if (later.has(a)) continue;
    a.pause();
    const end = a.effect?.getComputedTiming().endTime;
    a.currentTime = Number.isFinite(end) ? Math.min(${t}, end) : ${t};
  }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
})()`;
// The longest of the caught animations matching `sel` (each one's duration with its delay), or 0.
const caughtMs = (sel) => `Math.max(0, ...window.__caught.filter((a) => a.effect?.target?.matches('${sel}')).map((a) => a.effect.getComputedTiming().endTime))`;
const press = (entry) => `(async () => {
  document.querySelector('[data-preview-menu]').click();
  const deadline = Date.now() + 5000;
  while (!document.querySelector('[data-preview="${entry}"]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  const item = document.querySelector('[data-preview="${entry}"]');
  if (!item) return 'missing';
  if (item.getAttribute('aria-disabled') === 'true') {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 'disabled';
  }
  item.click();
  return 'pressed';
})()`;

async function poll(page, expression, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return true;
    await wait(50);
  }
  return false;
}

/** Four steps through an arrival of `ms`, from its first frame to its last. */
const through = (ms) => [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * ms));

async function sheet(page, base, theme, width, level, dir) {
  const height = width < 768 ? 812 : 900;
  await page.size(width, height);
  await page.media([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  const rows = [];
  let n = 0;
  const shoot = async (row, label, clip) => {
    const file = `${String(++n).padStart(3, '0')}.png`;
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    writeFileSync(join(dir, file), Buffer.from(data, 'base64'));
    row.shots.push({ label, file });
  };
  const catching = (on) => page.evaluate(`window.__catch = ${on}; window.__caught = []; window.__arrivals = undefined; 0`);

  await page.goto(themed(base, theme.name, '#/settings/toil'));
  await poll(page, "Boolean(document.querySelector('[data-preview-menu]'))", 15_000);
  await wait(1200);

  // The launch splash: it arrives, holds with its loop, and hands over to the page.
  {
    const row = { name: 'Launch splash', shots: [] };
    await catching(true);
    const how = theme.splash ? await page.evaluate(press('splash')) : 'missing';
    if (how === 'pressed' && (await poll(page, "Boolean(document.querySelector('.splash'))"))) {
      const ms = await page.evaluate(caughtMs('.splash__art'));
      for (const t of through(ms)) {
        await page.evaluate(STEP(t));
        await shoot(row, `in ${t} ms`);
      }
      await page.evaluate(STEP(ms + 700));
      await shoot(row, 'held');
      await page.key('Escape');
      await wait(400);
      await page.evaluate(STEP(0));
      await shoot(row, 'out: the page');
    } else row.note = how === 'missing' ? 'This theme has no splash.' : 'Theme motion off plays no splash.';
    await catching(false);
    rows.push(row);
  }

  // A loading screen, as its loops turn.
  {
    const row = { name: 'Loading screen', shots: [] };
    if ((await page.evaluate(press('loader'))) === 'pressed' && (await poll(page, "Boolean(document.querySelector('[data-moment-preview] [data-loading]'))"))) {
      await wait(200);
      for (const t of [0, 300, 600, 900, 1200]) {
        await page.evaluate(STEP(t));
        await shoot(row, `${t} ms`);
      }
      await page.evaluate("document.querySelector('[data-preview-close]')?.click()");
      await wait(400);
    } else row.note = 'The loading screen preview did not open.';
    rows.push(row);
  }

  // Each event moment: in, held, and out, cropped to the card.
  for (const kind of theme.events) {
    const row = { name: `Moment: ${kind}`, shots: [] };
    await catching(true);
    const how = await page.evaluate(press(kind));
    const sel = `[data-moment="${kind}"]`;
    if (how === 'pressed' && (await poll(page, `Boolean(document.querySelector('${sel}')) && window.__caught.length > 0`))) {
      // The card and its art arrive in one layout effect, so both are caught by now; whatever comes
      // after them is the leave.
      const arrivals = await page.evaluate('window.__arrivals = window.__caught.length');
      const ms = await page.evaluate(caughtMs(`${sel}, ${sel} *`));
      // The card's layout box, padded, is the crop for every frame of it. Read from offsets, which
      // ignore the arrival's transform: stepping the arrival to its end to measure it and back again
      // leaves Chrome's compositor showing the end on every frame after.
      const clip = await page.evaluate(`(() => {
        const card = document.querySelector('${sel}');
        let left = 0, top = 0;
        for (let el = card; el; el = el.offsetParent) { left += el.offsetLeft; top += el.offsetTop; }
        const x = Math.max(0, left - 24), y = Math.max(0, top - 24);
        return { x, y, width: Math.min(innerWidth, left + card.offsetWidth + 24) - x, height: Math.min(innerHeight, top + card.offsetHeight + 24) - y };
      })()`);
      for (const t of through(ms)) {
        await page.evaluate(STEP(t));
        await shoot(row, `in ${t} ms`, clip);
      }
      await page.evaluate(STEP(ms));
      await shoot(row, 'held', clip);
      // The hold runs in real time; its end starts the card's leave, which the hook catches paused.
      if (await poll(page, `window.__caught.length > ${arrivals}`, 8000)) {
        const out = await page.evaluate(`window.__caught[window.__caught.length - 1].effect.getComputedTiming().endTime`);
        for (const t of [Math.round(out / 2), Math.round(out)]) {
          await page.evaluate(`(() => { const a = window.__caught[window.__caught.length - 1]; a.currentTime = ${t}; })()`);
          await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
          await shoot(row, `out ${t} ms`, clip);
        }
        await page.evaluate('window.__caught[window.__caught.length - 1].finish()');
      } else row.note = 'The moment never left.';
      await poll(page, `!document.querySelector('${sel}')`, 3000);
    } else row.note = how === 'disabled' ? 'Theme motion off plays no event moment.' : `The ${kind} preview did not play.`;
    await catching(false);
    rows.push(row);
    await wait(300);
  }

  // The toil project entrance, then a change of tab.
  await page.evaluate("location.hash = '#/'");
  await wait(1500);
  for (const [name, hash, sel] of [
    ['Toil project entrance', '#/project/card-payments', '.toil-project-shell'],
    ['Tab change: to the Board', '#/project/card-payments/board', '.toil-project-main'],
  ]) {
    const row = { name, shots: [] };
    await catching(true);
    await page.evaluate(`location.hash = '${hash}'`);
    if (level !== 'off' && (await poll(page, `window.__caught.some((a) => a.effect?.target?.matches('${sel}'))`))) {
      const ms = await page.evaluate(caughtMs(sel));
      for (const t of through(ms)) {
        await page.evaluate(STEP(t));
        await shoot(row, `${t} ms`);
      }
    } else {
      await wait(1500);
      await page.evaluate(STEP(0));
      await shoot(row, 'as it opens');
      row.note = level === 'off' ? 'Theme motion off: it simply appears.' : 'No animation played.';
    }
    await catching(false);
    rows.push(row);
    await wait(500);
  }
  return rows;
}

/** One sheet as a page: a heading, then a row of captioned frames per part. */
function sheetHtml(title, rows, thumb) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const body = rows
    .map((r) => `<h2>${esc(r.name)}</h2>${r.note ? `<p>${esc(r.note)}</p>` : ''}<div class="r">${r.shots.map((s) => `<figure><img src="${s.file}" alt=""><figcaption>${esc(s.label)}</figcaption></figure>`).join('')}</div>`)
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><style>
body{margin:0;padding:16px;background:#14141a;color:#e8e8ee;font:14px/1.4 system-ui,sans-serif;width:max-content;max-width:1880px}
h1{font-size:17px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 6px;color:#b9b9c8}p{margin:0 0 6px;color:#9a9aac}
.r{display:flex;flex-wrap:wrap;gap:8px}figure{margin:0}img{display:block;max-width:${thumb}px;max-height:${thumb * 1.4}px;border:1px solid #33333f}
figcaption{font-size:12px;color:#9a9aac;margin-top:2px}</style>
<h1>${esc(title)}</h1>\n${body}`;
}

const chrome = findChrome();
if (!chrome) fail('No Chrome, Edge or Chromium found. Install one, or set CHROME_PATH to its executable.');
const themes = attempt(() => themesOnDisk(opts.theme));
if (!opts['no-build']) {
  console.error('Building Toil UI (skip with --no-build)…');
  attempt(build);
}
const sample = await startSample();
const written = [];
try {
  for (const theme of themes) {
    for (const width of widths) {
      for (const level of opts.motion) {
        // A fresh browser per sheet, so one sheet's paused animations and storage never reach the next.
        const browser = await openBrowser(chrome);
        try {
          const { page } = browser;
          await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${hook})(${JSON.stringify(level)})` });
          const name = `${theme.name}-${width}-${level}`;
          const dir = join(root, name);
          rmSync(dir, { recursive: true, force: true });
          mkdirSync(dir, { recursive: true });
          const rows = await sheet(page, sample.url, theme, width, level, dir);
          const title = `${theme.name[0].toUpperCase()}${theme.name.slice(1)} at ${width}px, Theme motion ${level}`;
          const html = join(dir, 'sheet.html');
          writeFileSync(html, sheetHtml(title, rows, width < 768 ? 170 : 300));
          await page.size(1900, 900);
          await page.goto(pathToFileURL(html).href);
          const size = await page.evaluate('({ w: document.body.scrollWidth, h: document.documentElement.scrollHeight })');
          await page.size(Math.max(400, size.w), size.h);
          const png = join(root, `${name}.png`);
          writeFileSync(png, await page.screenshot());
          written.push(png);
          console.log(`${png.replace(/\\/g, '/')}  (${rows.reduce((k, r) => k + r.shots.length, 0)} frames)`);
          if (page.errors.length) console.error(`  page errors: ${page.errors.slice(0, 3).join(' | ')}`);
        } finally {
          await browser.close();
        }
      }
    }
  }
} finally {
  await sample.stop();
}
console.log(`\n${written.length} sheet${written.length === 1 ? '' : 's'} in ${root.replace(/\\/g, '/')}`);
