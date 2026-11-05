// `npm run moments:measure -w ui` (#464): frame timings of every theme's launch splash, loading
// screen and sprint recap, in headless Chrome at 1440px with GPU compositing, measured the way #451
// set out (docs/decisions/451-moments-engine.md):
//
//   - a requestAnimationFrame recorder runs throughout, because Sprawl's rain and Realm's embers draw
//     at 30 fps by design, and raw presented-frame gaps read as 33 ms frames there;
//   - Chrome's frame reporter (PipelineReporter, from a trace) gives the frames it dropped, and its
//     Animation events the animations it couldn't composite;
//   - the splash plays over a toil project opening, with every API call slowed by 250 ms so the first
//     read outlasts the splash's 300 ms wait, from showing to 500 ms after it hands over; the
//     loading screen preview for 3 s; the sprint recap from showing to gone;
//   - each run opens a fresh browser per theme and plays it twice: the first pass warms Chrome's
//     GPU shader cache, the stall a person sees at most once per browser version, and the second is
//     the figure. `--cold` puts the first pass's worst frames beside it.
//
// It prints a Markdown table (median / worst / frames over 20 ms / frames dropped, per phase, over
// every run's warm pass) and writes it with the raw results to ui/.moments/. It exits 1 when any
// warm frame is over 20 ms, or a phase didn't play, unless `--report-only`.
//
// Run it on a quiet machine, with nothing else running: a frame time measures the machine as much
// as the page, which is why it never runs in CI (ui/README.md, Measuring theme moments).
//
//   npm run moments:measure -w ui [-- --theme crate] [--runs 3] [--cold] [--report-only] [--no-build]
//                                    [--motion full|subtle] [--throttle 4] [--no-gpu]
//
// Repo tooling only; nothing here ships. Results are provisional pending a quieter machine.
/* global document, window, requestAnimationFrame, performance, localStorage, MutationObserver -- the recorder runs in the page */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { findChrome, openBrowser } from './chrome.mjs';
import { attempt, busyShare, build, fail, chromeFrames, cpuTimes, frameStats, intervals, outDir, problems, slowFrames, startSample, table, themed, themesOnDisk } from './moments-kit.mjs';

const { values: opts } = attempt(() =>
  parseArgs({
    options: {
      theme: { type: 'string', multiple: true, default: [] },
      runs: { type: 'string', default: '3' },
      cold: { type: 'boolean', default: false },
      'report-only': { type: 'boolean', default: false },
      'no-build': { type: 'boolean', default: false },
      motion: { type: 'string', default: 'full' },
      throttle: { type: 'string' },
      'no-gpu': { type: 'boolean', default: false },
    },
  }),
);
const runs = Number(opts.runs);
if (!Number.isInteger(runs) || runs < 1) fail(`--runs takes a whole number of at least 1, not ${opts.runs}.`);
if (!['full', 'subtle'].includes(opts.motion)) fail(`--motion takes full or subtle (off plays no moment to measure), not ${opts.motion}.`);
const throttle = opts.throttle == null ? null : Number(opts.throttle);
if (throttle != null && !(throttle >= 1)) fail(`--throttle takes a CPU slowdown of 1 or more, not ${opts.throttle}.`);
const gpu = !opts['no-gpu'];
const WIDTH = 1440;
const HEIGHT = 900;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The recorder, on every document before its own script: Theme motion, a rAF loop, and a mark each
// time the splash, the loading preview or the recap comes or goes, in page time and in the trace.
function recorder(level) {
  try {
    localStorage.setItem('toil-ui.theme-motion', level);
  } catch {
    // A page with no storage still plays at the default, full.
  }
  window.__frames = [];
  window.__marks = [];
  const loop = (t) => {
    window.__frames.push(t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  const seen = new Map();
  const watch = { splash: '.splash', loader: '[data-moment-preview] [data-loading]', recap: '[data-moment="sprint-ended"]' };
  const check = () => {
    for (const [k, sel] of Object.entries(watch)) {
      const on = Boolean(document.querySelector(sel));
      if (on === Boolean(seen.get(k))) continue;
      seen.set(k, on);
      window.__marks.push({ k, on, t: performance.now() });
      console.timeStamp(`${k}:${on ? 'on' : 'off'}`);
      // The splash's window closes 500 ms after it hands over, in the trace as in the rAF figures,
      // so Chrome's dropped frames and the recorder's frames count the same stretch.
      if (k === 'splash' && !on) setTimeout(() => console.timeStamp('splash:end'), 500);
    }
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true });
}

async function openTab(browser) {
  const tab = await browser.newPage();
  await tab.size(WIDTH, HEIGHT);
  await tab.media([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${recorder})(${JSON.stringify(opts.motion)})` });
  if (throttle) await tab.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  return tab;
}

/** Runs `body` under a browser-wide trace, and resolves with what it returned and the trace's events. */
async function traced(cdp, body) {
  const events = [];
  const off = cdp.on((msg) => {
    if (msg.method === 'Tracing.dataCollected') events.push(...msg.params.value);
  });
  const done = new Promise((resolve) => {
    const stop = cdp.on((msg) => {
      if (msg.method === 'Tracing.tracingComplete') {
        stop();
        resolve();
      }
    });
  });
  const categories = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'cc', 'benchmark', 'blink'];
  await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: categories } });
  try {
    return { out: await body(), events: await cdp.send('Tracing.end').then(() => done).then(() => events) };
  } finally {
    off();
  }
}

const marksOf = (tab) => tab.evaluate('window.__marks');
async function until(tab, test, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (test(await marksOf(tab))) return true;
    await wait(100);
  }
  return false;
}

async function splashPass(browser, base, theme) {
  const tab = await openTab(browser);
  // Every API call slowed by 250 ms, so the first read outlasts the splash's 300 ms wait and the
  // splash hands over to a toil project opening, as it does on a real first read.
  await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
  const off = tab.on((msg) => {
    if (msg.method === 'Fetch.requestPaused') setTimeout(() => tab.send('Fetch.continueRequest', { requestId: msg.params.requestId }).catch(() => undefined), 250);
  });
  try {
    const { out, events } = await traced(browser.cdp, async () => {
      await tab.send('Page.navigate', { url: themed(base, theme, '#/project/card-payments') });
      await until(tab, (m) => m?.some((x) => x.k === 'splash' && !x.on), 15_000);
      // Past the page's own splash:end mark, 500 ms after the handover, so the trace holds it.
      await wait(800);
      return tab.evaluate('({ frames: window.__frames, marks: window.__marks })');
    });
    const on = out.marks.find((m) => m.k === 'splash' && m.on);
    const gone = out.marks.find((m) => m.k === 'splash' && !m.on);
    if (!on || !gone) return { error: on ? 'the splash never handed over' : 'no splash played' };
    const end = gone.t + 500;
    return { ms: Math.round(gone.t - on.t), ...frameStats(intervals(out.frames, on.t, end)), chrome: chromeFrames(events, 'splash:on', 'splash:end'), slow: slowFrames(out.frames, on.t, end) };
  } finally {
    off();
    await tab.close();
  }
}

// Opens Settings' "Preview the theme's moments" menu and presses one entry.
const press = (entry) => `(async () => {
  document.querySelector('[data-preview-menu]').click();
  const deadline = Date.now() + 5000;
  while (!document.querySelector('[data-preview="${entry}"]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 30));
  const item = document.querySelector('[data-preview="${entry}"]');
  if (!item) return false;
  item.click();
  return true;
})()`;

async function previewPasses(browser, base, theme) {
  const tab = await openTab(browser);
  try {
    await tab.send('Page.navigate', { url: themed(base, theme.name, '#/settings/toil') });
    for (let i = 0; i < 100 && !(await tab.evaluate("Boolean(document.querySelector('[data-preview-menu]'))")); i++) await wait(100);
    await wait(1500);
    const result = {};
    for (const [phase, entry] of [
      ['loader', 'loader'],
      ['recap', 'sprint-ended'],
    ]) {
      if (phase === 'recap' && !theme.events.includes('sprint-ended')) {
        result.recap = null;
        continue;
      }
      const { out, events } = await traced(browser.cdp, async () => {
        const t0 = await tab.evaluate('performance.now()');
        await tab.evaluate("console.timeStamp('phase:start')");
        const pressed = await tab.evaluate(press(entry));
        if (phase === 'loader') await wait(3000);
        else await until(tab, (m) => m.some((x) => x.k === 'recap' && !x.on), 9000);
        const t1 = await tab.evaluate('performance.now()');
        await tab.evaluate("console.timeStamp('phase:end')");
        if (phase === 'loader') {
          await tab.evaluate("document.querySelector('[data-preview-close]')?.click()");
          await wait(500);
        }
        return { pressed, t0, t1, frames: await tab.evaluate('window.__frames'), marks: await marksOf(tab) };
      });
      const shown = out.marks.some((m) => m.k === phase && m.on);
      result[phase] = !out.pressed || !shown ? { error: `the ${entry} preview did not play` } : { ...frameStats(intervals(out.frames, out.t0, out.t1)), chrome: chromeFrames(events, 'phase:start', 'phase:end'), slow: slowFrames(out.frames, out.t0, out.t1) };
    }
    return result;
  } finally {
    await tab.close();
  }
}

const line = (x) => (x == null ? 'none' : x.error ? x.error : `median ${x.median.toFixed(1)} worst ${x.worst.toFixed(1)} over: ${x.over}/${x.frames} dropped ${x.chrome?.dropped ?? '?'}/${x.chrome?.reported ?? '?'}${x.slow?.length ? ` slow at ${x.slow.map((s) => `${s.at} ms (${s.ms})`).join(', ')}` : ''}`);

const chrome = findChrome();
if (!chrome) fail('No Chrome, Edge or Chromium found. Install one, or set CHROME_PATH to its executable.');
const themes = attempt(() => themesOnDisk(opts.theme));
if (!opts['no-build']) {
  console.error('Building Toil UI (skip with --no-build)…');
  attempt(build);
}

// How busy the machine was before this started: the figure to judge the table by.
const idleFrom = cpuTimes();
await wait(2000);
const before = busyShare(idleFrom, cpuTimes());
if (before > 0.15) console.error(`The machine was ${Math.round(before * 100)}% busy before the run started. Slow frames below may be the machine's, not the theme's: close what else is running and measure again.`);

const sample = await startSample();
const results = [];
const runFrom = cpuTimes();
const started = Date.now();
try {
  for (let run = 1; run <= runs; run++) {
    for (const theme of themes) {
      const browser = await openBrowser(chrome, { gpu });
      try {
        // A fresh profile compiles its GPU shaders as each new thing first draws; the second pass, in
        // the same browser, is a person's second launch, with them cached.
        for (const pass of ['cold', 'warm']) {
          const splash = theme.splash ? await splashPass(browser, sample.url, theme.name) : null;
          const previews = await previewPasses(browser, sample.url, theme);
          results.push({ run, pass, theme: theme.name, splash, ...previews });
          console.error(`run ${run} ${pass} ${theme.name.padEnd(10)} splash ${line(splash)} | loader ${line(previews.loader)} | recap ${line(previews.recap)}`);
        }
      } finally {
        await browser.close();
      }
    }
  }
} finally {
  await sample.stop();
}
const during = busyShare(runFrom, cpuTimes());

const md = table(results, { cold: opts.cold });
const found = problems(results);
const setup = [
  `Headless Chrome (${chrome}), ${gpu ? 'GPU compositing' : 'software rendering (--no-gpu)'}, ${WIDTH}x${HEIGHT}, Theme motion ${opts.motion}${throttle ? `, CPU throttled ${throttle}x` : ''}.`,
  `${runs} run${runs === 1 ? '' : 's'} per theme, each in a fresh profile: a cold pass to warm the shader cache, then the warm pass the table reports.`,
  `${platform()} ${release()}, ${cpus().length} cores, Node ${process.versions.node}. CPU ${Math.round(before * 100)}% busy before the run, ${Math.round(during * 100)}% during it (this run's own Chrome included), ${Math.round((Date.now() - started) / 1000)} s.`,
  'Each cell: median frame / worst frame / frames over 20 ms / frames Chrome dropped, in ms and counts over every warm pass.',
].join('\n');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'measure.json'), JSON.stringify({ gpu, motion: opts.motion, throttle, width: WIDTH, runs, cpuBusyBefore: before, cpuBusyDuring: during, results }, null, 2));
writeFileSync(join(outDir, 'measure.md'), `${setup}\n\n${md}\n${found.length ? `\nOver the bar:\n${found.map((p) => `- ${p}`).join('\n')}\n` : ''}`);
console.log(`${setup}\n\n${md}\n`);
console.log(`Written to ${join(outDir, 'measure.md').replace(/\\/g, '/')} and measure.json beside it.`);
if (found.length) {
  console.log(`\n${found.length} problem${found.length === 1 ? '' : 's'}:\n${found.map((p) => `- ${p}`).join('\n')}`);
  if (!opts['report-only']) process.exitCode = 1;
}
