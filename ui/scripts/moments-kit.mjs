// What the two theme-moments tools share (#464): `moments-measure.mjs`, the frame timings of each
// theme's splash, loader and recap, and `screens-sheet.mjs`, the contact sheets. The themes that
// have moments, the sample server they run against, a reading of how busy the machine is, and the
// arithmetic, which is pure and tested (test/moments-kit.test.ts).
//
// Neither tool runs in CI: a frame time is as much a measure of the machine as of the page, and a
// shared runner's neighbours are not in the theme's budget. Repo tooling only; nothing here ships.
// Frame budgets are reviewed quarterly by a committee that has yet to meet within one.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { npmCli } from './package-rules.mjs';

export const ui = join(import.meta.dirname, '..');
/** Where both tools write: git ignores it. */
export const outDir = join(ui, '.moments');
/** The bar a moment's frame is held to (#419): over this, a person sees a stutter. */
export const SLOW_MS = 20;

// #451's table order; a theme added later sorts after these by name.
const ORDER = ['crate', 'harvest', 'starship', 'sprawl', 'frontier', 'overworld', 'realm'];

/** The event kinds the engine plays, in the order the preview menu lists them. */
export const EVENT_KINDS = ['item-done', 'build-passed', 'build-failed', 'blocker-cleared', 'pr-merged', 'sprint-ended'];

/**
 * Every theme with a `moments` block, from `manifests` (each theme folder's theme.json), with the
 * event kinds it declares. Plain has none, so it never appears.
 */
export function momentThemes(manifests) {
  const rank = (name) => (ORDER.includes(name) ? ORDER.indexOf(name) : ORDER.length);
  return manifests
    .filter((m) => m.moments)
    .map((m) => ({ name: m.name, splash: Boolean(m.moments.splash), events: EVENT_KINDS.filter((k) => m.moments.events?.[k]) }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** The themes on disk with moments; `only` narrows them, and a name with no moments is an error that lists the ones there are. */
export function themesOnDisk(only = []) {
  const manifests = readdirSync(join(ui, 'themes')).map((dir) => JSON.parse(readFileSync(join(ui, 'themes', dir, 'theme.json'), 'utf8')));
  const all = momentThemes(manifests);
  const unknown = only.filter((name) => !all.some((t) => t.name === name));
  if (unknown.length) throw new Error(`No theme with moments is named ${unknown.join(', ')}. Themes with moments: ${all.map((t) => t.name).join(', ')}.`);
  return only.length ? all.filter((t) => only.includes(t.name)) : all;
}

/** Says what's wrong in one line, with no stack, and exits 1: for a bad flag, a missing browser or a failed build. */
export function fail(message) {
  console.error(message);
  process.exit(1);
}

/** `fn()`, or its error's message through `fail`. */
export function attempt(fn) {
  try {
    return fn();
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** Builds Toil UI (`npm run build -w ui`), unless the caller said `--no-build`. Throws with npm's output if it fails. */
export function build() {
  const res = spawnSync(process.execPath, [npmCli(), 'run', 'build'], { cwd: ui, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`npm run build -w ui failed:\n${res.stdout}\n${res.stderr}`);
}

/**
 * Starts the built `toil-ui --sample` in a throwaway home with no `TOIL_*` variable from the shell,
 * so the run reads only the sample. Resolves with its URL and `stop()`.
 */
export async function startSample() {
  const bin = join(ui, 'dist', 'server', 'toil-ui.js');
  const home = mkdtempSync(join(tmpdir(), 'toil-ui-moments-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TOIL_')));
  Object.assign(env, { HOME: home, USERPROFILE: home, TOIL_UI_DATA_DIR: join(home, 'data') });
  const child = spawn(process.execPath, [bin, '--sample', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  const url = await new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`toil-ui --sample printed no URL in 20s. Is Toil UI built (npm run build -w ui)? stderr: ${stderr}`)), 20_000);
    child.stdout.on('data', (c) => {
      stdout += c;
      const m = /http:\/\/127\.0\.0\.1:\d+\//.exec(stdout);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`toil-ui --sample exited (${code}) before it printed its URL. Is Toil UI built (npm run build -w ui)? stderr: ${stderr}`));
    });
  });
  return {
    url,
    async stop() {
      child.kill();
      await new Promise((r) => setTimeout(r, 300));
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** The same address with `?theme=` set and `hash` as its route. */
export function themed(base, theme, hash) {
  const u = new URL(base);
  u.searchParams.set('theme', theme);
  u.hash = hash;
  return u.href;
}

/** A snapshot of every core's CPU times, for `busyShare`. */
export const cpuTimes = () => cpus().map((c) => ({ ...c.times }));

/** The share of CPU time, 0 to 1, spent not idle between two `cpuTimes()` snapshots. */
export function busyShare(before, after) {
  let busy = 0;
  let total = 0;
  after.forEach((t, i) => {
    const b = before[i];
    if (!b) return;
    const all = (x) => x.user + x.nice + x.sys + x.irq + x.idle;
    const span = all(t) - all(b);
    total += span;
    busy += span - (t.idle - b.idle);
  });
  return total > 0 ? busy / total : 0;
}

// Frame arithmetic ------------------------------------------------------------------------------------

/** The rAF intervals, in ms, of frames that landed after `from` and up to `to` (page times). */
export function intervals(frames, from, to) {
  const out = [];
  for (let i = 1; i < frames.length; i++) if (frames[i] > from && frames[i] <= to) out.push(frames[i] - frames[i - 1]);
  return out;
}

/** Median, worst, and how many frames were over the bar, of a list of intervals. */
export function frameStats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return { frames: s.length, median: s.length ? s[Math.floor(s.length / 2)] : 0, worst: s.length ? s[s.length - 1] : 0, over: s.filter((x) => x > SLOW_MS).length };
}

/** Each slow rAF frame between `from` and `to`: when it started, from `from`, and how long it took. */
export function slowFrames(frames, from, to) {
  const out = [];
  for (let i = 1; i < frames.length; i++) {
    const ms = frames[i] - frames[i - 1];
    if (frames[i] > from && frames[i] <= to && ms > SLOW_MS) out.push({ at: Math.round(frames[i - 1] - from), ms: Math.round(ms * 10) / 10 });
  }
  return out;
}

/**
 * What Chrome's own frame reporter says about the renderer's frames between two `console.timeStamp`
 * marks in a trace: how many it reported and dropped, and the animations it couldn't composite.
 * Null when either mark is missing.
 */
export function chromeFrames(events, startMark, endMark) {
  const stamp = (name) => events.find((e) => e.name === 'TimeStamp' && e.args?.data?.message === name)?.ts;
  const from = stamp(startMark);
  const to = stamp(endMark);
  if (from == null || to == null) return null;
  const renderers = new Set(events.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => e.pid));
  const reports = events.filter((e) => e.name === 'PipelineReporter' && e.ph === 'b' && renderers.has(e.pid) && e.ts >= from && e.ts <= to);
  const state = (e) => (e.args?.frame_reporter ?? e.args?.chrome_frame_reporter)?.state;
  const failed = new Map();
  for (const e of events) {
    const d = e.args?.data;
    if (e.name === 'Animation' && e.ts >= from && e.ts <= to && d?.compositeFailed) failed.set(e.id2?.local ?? e.id ?? e.ts, String(d.compositeFailed));
  }
  return { reported: reports.length, dropped: reports.filter((e) => state(e) === 'STATE_DROPPED').length, notComposited: failed.size };
}

export const PHASES = ['splash', 'loader', 'recap'];

const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

/**
 * Pools a theme's passes into one figure per phase, as #451's table does: the median of the passes'
 * medians, the worst frame of any, and the frames over the bar and dropped, summed. A pass whose
 * phase failed to play (`{ error }`) is counted in `failed`; a phase the theme doesn't have is null.
 */
export function pool(rows) {
  const out = {};
  for (const phase of PHASES) {
    const xs = rows.map((r) => r[phase]).filter((x) => x && !x.error);
    out[phase] = {
      median: median(xs.map((x) => x.median)),
      worst: Math.max(0, ...xs.map((x) => x.worst)),
      over: sum(xs, (x) => x.over),
      frames: sum(xs, (x) => x.frames),
      dropped: sum(xs, (x) => x.chrome?.dropped ?? 0),
      reported: sum(xs, (x) => x.chrome?.reported ?? 0),
      notComposited: sum(xs, (x) => x.chrome?.notComposited ?? 0),
      failed: rows.filter((r) => r[phase]?.error).length,
    };
  }
  return out;
}

const title = (name) => name[0].toUpperCase() + name.slice(1);
const ms = (x) => x.toFixed(1);

/** One table cell: median / worst / over the bar / dropped, as #451 wrote them. */
export function cell(p) {
  if (!p.frames) return p.failed ? `did not play (${p.failed})` : 'none';
  const extra = [p.notComposited ? `${p.notComposited} not composited` : '', p.failed ? `${p.failed} did not play` : ''].filter(Boolean);
  return [`${ms(p.median)} / ${ms(p.worst)} / ${p.over} of ${p.frames} / ${p.dropped} of ${p.reported}`, ...extra].join(' / ');
}

/**
 * The Markdown table of a measurement's results: one row per theme from its warm passes, and with
 * `cold`, the first pass's worst frame per phase beside it.
 */
export function table(results, { cold = false } = {}) {
  const themes = [...new Set(results.map((r) => r.theme))];
  const head = ['Theme', 'Splash', 'Loader', 'Recap', ...(cold ? ['First launch, cold shader cache: worst (splash, loader, recap)'] : [])];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const theme of themes) {
    const warm = pool(results.filter((r) => r.theme === theme && r.pass === 'warm'));
    const row = [title(theme), ...PHASES.map((p) => cell(warm[p]))];
    if (cold) {
      const c = pool(results.filter((r) => r.theme === theme && r.pass === 'cold'));
      row.push(`${PHASES.map((p) => ms(c[p].worst)).join(', ')} ms`);
    }
    lines.push(`| ${row.join(' | ')} |`);
  }
  return lines.join('\n');
}

/** Every warm phase with a frame over the bar, or that didn't play: what makes `moments:measure` exit 1. */
export function problems(results) {
  const out = [];
  for (const theme of new Set(results.map((r) => r.theme))) {
    const warm = pool(results.filter((r) => r.theme === theme && r.pass === 'warm'));
    for (const phase of PHASES) {
      const p = warm[phase];
      if (p.over) out.push(`${theme} ${phase}: ${p.over} frame${p.over === 1 ? '' : 's'} over ${SLOW_MS} ms, the worst ${ms(p.worst)} ms`);
      if (p.failed) out.push(`${theme} ${phase}: did not play in ${p.failed} pass${p.failed === 1 ? '' : 'es'}`);
    }
  }
  return out;
}
