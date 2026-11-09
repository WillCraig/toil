// The layout check (#277): every Toil UI view, in every theme and scheme, at
// 375, 768 and 1440 pixels, in real headless Chrome. It fails on what a
// person would see as broken, whatever the theme:
//
//   - the page itself scrolling sideways;
//   - any element whose content is wider than its box (scrollWidth more than
//     clientWidth + 1), unless it is a declared scroller (`data-scroller`,
//     which DataTable and the other scrollers carry with their cue and focus)
//     or a declared truncation (`data-truncate`, Path and Url, which keep the
//     whole value in a tooltip and a copy button);
//   - a child box reaching past the edge of its card (`data-card`);
//   - something fixed to the bottom of the screen covering the end of the
//     page once it is scrolled all the way down;
//   - a tab bar (`data-tabs-row`) that scrolls while a sibling takes more than a tenth of its row, or overlaps it;
//   - a row that must stay one row (`data-one-row`: the compact header, the
//     settings tabs) wrapping onto a second;
//   - the header folded into its Menu at 1440 pixels or wider, where every
//     theme's full row fits on the sample data (#387; `headerFits`, off for
//     real data, whose toil project names and links may genuinely fill the row);
//   - an open modal whose backdrop doesn't dim the page;
//   - and, in the strict themes (Plain and Crate, light and dark), any axe
//     violation at WCAG 2.2 AA. The other themes' axe findings are reported,
//     never failed (the maintainer's bar, AGENT_DECISIONS.md, #267).
//
// Each view is checked as it opens and with its hidden parts showing: every
// <details> open, each toil project card's Show pressed, the header menu and the
// Feedback dialog open, every toil project name and description open for editing, the Assign dialog open from an item and the inbox, the Agents
// drawer, the toil project switcher, a metric's full chart and the board's needs-attention filter (#394), the focused Ask view open
// from the Ask bar (#343) with its (i) popover, its agent switcher, an answer, its Suggestions menu and
// Analyze's pulse check, a help (i)'s tooltip and popover (#346), the Agent page's full prompt and its Install dialog shown (#344), a worklog day rebuilt and
// the calendar on an earlier month, a stand-up written up, and every failing
// command's recent audit lines open on the Usage page (the sample's; real data may have none), the bell's list and What's new (#417), and the theme moments' previews
// (#419): a loading screen, the launch splash and the sprint recap card. Reduced motion
// is on, so an animation caught mid-flight can't fail a run; `npm run smoke` then runs
// MOTION_ROUTES again with motion on, where the moments play.
//
// On a toil project's Board tab the board is also dragged as a hand drags it
// (#393): real mouse input through the DevTools protocol, a finger at 375
// pixels, with moves in between. Mid-drag the copy of the card must be under
// the pointer and the card itself still in its column; after the drop a
// proposed ghost must sit in the target column, and that state goes through
// the same layout and axe checks as the others. Scripted DOM events proved
// the drop and missed that nothing on screen moved.
//
// `npm run smoke -w ui` runs it against the installed package (`toil-ui
// --sample`). By hand, against any build:
//
//   npx vite preview --port 4173            (after `npx vite build`, in ui/)
//   node scripts/layout-check.mjs --base http://127.0.0.1:4173/ [--theme crate] [--route '#/settings/projects'] [--width 375] [--font <pair id>] [--motion full] [--shots <dir>] [--json <file>]
//
// Repo tooling only; nothing here ships. It measures twice and files once.
/* global document, window, getComputedStyle, CSS -- inspect(), covered(), dragPlan(), hitTest() and dragMid() run in the page */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChrome, openBrowser } from './chrome.mjs';

const ui = join(import.meta.dirname, '..');

/** Every theme and scheme, from the theme folders, with Plain and Crate strict. */
export function themeRuns() {
  const order = ['plain', 'crate', 'harvest', 'starship', 'realm', 'sprawl', 'frontier', 'overworld'];
  const manifests = readdirSync(join(ui, 'themes')).map((name) => JSON.parse(readFileSync(join(ui, 'themes', name, 'theme.json'), 'utf8')));
  manifests.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return manifests.flatMap((m) => Object.keys(m.schemes).map((scheme) => ({ theme: m.name, scheme, strict: m.name === 'plain' || m.name === 'crate' })));
}

const item = (toilProject, id) => `#/project/${toilProject}/item/${encodeURIComponent(id)}`;
export const ROUTES = [
  '#/',
  '#/project/card-payments',
  '#/project/settlement',
  '#/project/checkout-web',
  // An item's drawer (#494): beside the briefing from 1200px, over it below that, and over the Board, whose card key opens it.
  '#/project/card-payments?item=corp-jira%3APAY-101',
  '#/project/card-payments/board?item=corp-jira%3APAY-104',
  // How Analyze briefs a toil project (#494), with its prompt preview open among the details.
  '#/settings/projects/card-payments/analyze',
  // The toil project's own tabs (#394): the Board with its needs-attention flags, the longest titles' board, Dependencies, and Analyses.
  // Dependencies carries the blocker Gantt and its table (#396): a three-item chain with failing checks, a one-link Azure DevOps chain, and a toil project with no blocker.
  '#/project/card-payments/board',
  '#/project/checkout-web/board',
  '#/project/card-payments/dependencies',
  '#/project/settlement/dependencies',
  '#/project/checkout-web/dependencies',
  '#/project/card-payments/analyses',
  // The history of analyses (#395): one opened again, top-down, with its evidence folded and what changed since the one before.
  '#/project/card-payments/analyses/sample-analysis-2',
  '#/project/checkout-web/prs',
  '#/project/card-payments/prs',
  '#/project/card-payments/job/review?target=github%3Aimagile%2Fpayments-web%2343',
  '#/project/card-payments/job/ship',
  '#/project/card-payments/job/diagram',
  // The People view (#292): mapped people with a suggested match, people plus agents and an unmapped account, a toilProject listing nobody, and the board filtered to one person.
  '#/project/card-payments/people',
  '#/project/checkout-web/people',
  '#/project/settlement/people',
  `#/project/card-payments/board/${encodeURIComponent('person:J. Smith')}`,
  // The readiness gate (#307): the Command Center with one ready item, with none, and with a ready GitHub feature; an item blocked by another.
  '#/project/card-payments/command-center',
  '#/project/settlement/command-center',
  '#/project/checkout-web/command-center',
  item('card-payments', 'corp-jira:PAY-102'),
  '#/project/card-payments/worklog',
  '#/project/card-payments/worklog/2026-10-12',
  '#/project/checkout-web/worklog/2026-10-11',
  // The stand-up (#345): since the last working day, with people, agents and unmapped accounts, and one day of another toil project named by one day in the URL, and a URL that names no day.
  '#/project/card-payments/worklog/standup',
  '#/project/settlement/worklog/standup/2026-10-12',
  '#/project/checkout-web/worklog/standup/yesterday',
  item('card-payments', 'corp-jira:PAY-100'),
  item('settlement', 'corp-ado:2304'),
  // Agent assignments (#293): one that needs you (a report, a question, proposals with diffs), one that failed at its time limit, one working.
  '#/project/card-payments/assignment/sample-needsyou-0002',
  '#/project/card-payments/assignment/sample-failed-0000004',
  '#/project/card-payments/assignment/sample-working-0001',
  '#/setup',
  '#/settings/connections',
  '#/settings/projects',
  '#/settings/general',
  '#/settings/appearance',
  '#/settings/usage',
  '#/settings/agent-usage',
  '#/settings/agent',
];
export const WIDTHS = [375, 768, 1440];
/**
 * The views checked a second time with motion on (#419): where the theme's moments play (the toil project entrance and
 * its tabs, the previews of the splash, a loading screen and the sprint recap under Settings, Appearance). The full set
 * runs with reduced motion, which is also Theme motion off, so both are proven.
 */
export const MOTION_ROUTES = ['#/', '#/project/card-payments', '#/project/card-payments/board', '#/project/card-payments/prs', '#/settings/appearance'];

/**
 * The first run (#416): the Toil projects view on a home with no toil projects, which verify:ui opens under this
 * address so it gets the checklist's states and not the sample home's. The App reads it as the Toil projects view.
 */
export const FIRST_RUN_ROUTE = '#/?first-run';
/** What counts as a card. LAYOUT_CARDS widens it, to measure a build from before the Card primitive. */
const CARDS = process.env.LAYOUT_CARDS ?? '[data-card]';

/**
 * What runs in the page: one pass over the layout, returning findings. It is
 * sent as source, so it may use only what the page has.
 */
function inspect(cards, headerFits) {
  const findings = [];
  const add = (kind, el, detail) => findings.push({ kind, at: el ? describe(el) : 'page', detail });
  function describe(el) {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 3; e = e.parentElement) {
      const cls = [...e.classList].filter((c) => !c.startsWith('react-aria')).slice(0, 2).join('.');
      parts.unshift(`${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${cls ? `.${cls}` : ''}`);
    }
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${parts.join(' > ')}${text ? ` "${text}"` : ''}`;
  }
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  // Decoration (aria-hidden art, the HUD corners) and screen-reader-only text may sit anywhere.
  // So may anything inside a box clipped away for screen readers only (a stacked DataTable's header row).
  const clippedAway = new Map();
  const hiddenBox = (el) => {
    if (!el || el === document.body) return false;
    if (!clippedAway.has(el)) {
      const s = getComputedStyle(el);
      clippedAway.set(el, (s.clipPath !== 'none' || s.clip !== 'auto') && el.clientWidth <= 1 ? true : hiddenBox(el.parentElement));
    }
    return clippedAway.get(el);
  };
  const exempt = (el) => el.closest('svg, .sr-only, [aria-hidden="true"], [data-truncate] *') || hiddenBox(el);
  const clipsX = (el) => getComputedStyle(el).overflowX !== 'visible';

  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) add('page-scroll', null, `the page is ${de.scrollWidth}px wide in a ${de.clientWidth}px window`);

  const all = [...document.body.querySelectorAll('*')].filter((el) => shown(el) && !exempt(el));
  for (const el of all) {
    if (el.matches('[data-scroller], [data-truncate], input, select, textarea, option, .react-flow, .react-flow *:not(.react-flow__node, .react-flow__node *)')) continue;
    const style = getComputedStyle(el);
    if (style.display === 'inline' || style.display === 'contents') continue;
    // Visually hidden (React Aria's hidden inputs): a 1px box, clipped on purpose.
    if (el.clientWidth <= 1 && el.clientHeight <= 1) continue;
    if (el.scrollWidth > el.clientWidth + 1) add('overflow', el, `content ${el.scrollWidth}px wide in a ${el.clientWidth}px box (overflow-x: ${style.overflowX})`);
  }

  for (const card of document.querySelectorAll(cards)) {
    if (!shown(card) || exempt(card)) continue;
    const c = card.getBoundingClientRect();
    for (const el of card.querySelectorAll('*')) {
      if (!shown(el) || exempt(el) || getComputedStyle(el).position === 'fixed') continue;
      // Inside a scroller or a clipping box, a child is meant to reach past the edge.
      let clipped = false;
      for (let p = el.parentElement; p && p !== card; p = p.parentElement) if (p.matches('[data-scroller]') || clipsX(p)) clipped = true;
      if (clipped) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > c.right + 1 || r.left < c.left - 1) add('escapes-card', el, `spans ${Math.round(r.left)}–${Math.round(r.right)}px; its card spans ${Math.round(c.left)}–${Math.round(c.right)}px`);
    }
  }

  for (const row of document.querySelectorAll('[data-one-row]')) {
    if (!shown(row)) continue;
    const kids = [...row.querySelectorAll(':scope > *, :scope > ul > li')].filter((k) => shown(k) && !exempt(k) && getComputedStyle(k).position !== 'absolute');
    const tops = new Set(kids.map((k) => Math.round(k.getBoundingClientRect().top / 4)));
    const mids = kids.map((k) => { const r = k.getBoundingClientRect(); return r.top + r.height / 2; });
    if (tops.size > 1 && Math.max(...mids) - Math.min(...mids) > 12) add('wraps', row, `its items sit on ${tops.size} rows`);
  }

  // A tab bar that has to scroll gets (nearly) its whole row: a button beside it that leaves room for two tabs hides the rest.
  for (const row of document.querySelectorAll('[data-tabs-row]')) {
    if (!shown(row)) continue;
    const body = row.querySelector('[data-scroller]');
    if (!body || body.scrollWidth <= body.clientWidth + 1) continue;
    const rowW = row.getBoundingClientRect().width;
    const b = body.getBoundingClientRect();
    if (b.width < rowW * 0.9) add('tabs-squeezed', body, `the tabs scroll in ${Math.round(b.width)}px of a ${Math.round(rowW)}px row, the rest of it taken by a sibling`);
    for (const sib of row.querySelectorAll(':scope > *')) {
      if (sib.contains(body) || !shown(sib)) continue;
      const r = sib.getBoundingClientRect();
      if (r.left < b.right - 1 && r.right > b.left + 1 && r.top < b.bottom - 1 && r.bottom > b.top + 1) add('tabs-covered', sib, 'overlaps the tab bar');
    }
  }

  // The header folds into its Menu only when its row is full, and at 1440px every theme's row fits the sample's (#387).
  const menu = headerFits && [...document.querySelectorAll('header [data-menu-button]')].find(shown);
  if (menu && window.innerWidth >= 1440) add('folded', menu, `the header shows its Menu at ${window.innerWidth}px, where its full row fits`);

  for (const overlay of document.querySelectorAll('[data-backdrop]')) {
    if (!shown(overlay)) continue;
    const bg = getComputedStyle(overlay).backgroundColor;
    const alpha = /rgba?\(([^)]+)\)/.exec(bg)?.[1].split(/[ ,/]+/).filter(Boolean)[3];
    if (bg === 'transparent' || (alpha !== undefined && Number(alpha) < 0.3)) add('backdrop', overlay, `the backdrop is ${bg}, which doesn't dim the page`);
  }
  return findings;
}

/** With the page scrolled to its end, nothing fixed to the bottom may cover the last of the content. */
function covered() {
  const findings = [];
  const docks = [...document.querySelectorAll('body *')].filter((el) => getComputedStyle(el).position === 'fixed' && el.getClientRects().length > 0 && el.getBoundingClientRect().top > window.innerHeight / 2 && !el.closest('[aria-hidden="true"]'));
  if (!docks.length) return findings;
  window.scrollTo(0, document.documentElement.scrollHeight);
  const main = document.querySelector('main');
  for (const dock of docks) {
    const top = dock.getBoundingClientRect().top;
    let lowest = null;
    for (const el of main.querySelectorAll('*')) {
      if (dock.contains(el) || el.closest('.sr-only, [aria-hidden="true"]') || el.getClientRects().length === 0) continue;
      // Only what a person reads or presses counts, never a container's empty padding.
      const content = el.matches('img, svg, button, input, select, textarea, summary') || [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!content) continue;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && (!lowest || r.bottom > lowest.r.bottom)) lowest = { el, r };
    }
    if (lowest && lowest.r.bottom > top + 1) findings.push({ kind: 'covered', at: `${lowest.el.tagName.toLowerCase()} "${(lowest.el.textContent ?? '').trim().slice(0, 40)}"`, detail: `ends at ${Math.round(lowest.r.bottom)}px, under a fixed ${dock.tagName.toLowerCase()}.${[...dock.classList].join('.')} from ${Math.round(top)}px` });
  }
  window.scrollTo(0, 0);
  return findings;
}

/** Waits until the view has its heading and nothing is still loading. */
const SETTLED = `new Promise((resolve) => {
  const started = Date.now();
  const done = () => document.querySelector('main h1') && !document.querySelector('main .skin-loading, main [data-loading]') && !/Drawing the graph|Reading /.test(document.querySelector('main')?.textContent ?? '');
  const tick = () => (done() || Date.now() - started > 15000 ? document.fonts.ready.then(() => setTimeout(resolve, 250)) : setTimeout(tick, 100));
  tick();
})`;

/**
 * Clicks every shown element matching the selector (and text, a regex
 * source), once one shows: it waits up to `wait` ms for the first, so a
 * menu still opening can't read as nothing to open (#289). Resolves with how
 * many it clicked; 0 means none showed in time.
 */
const clickAll = (selector, text, wait = 5000) => `(async () => {
  const deadline = Date.now() + ${wait};
  for (;;) {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((b) => ${text ? `${text}.test(b.textContent ?? '')` : 'true'} && b.getClientRects().length);
    if (els.length || Date.now() > deadline) {
      for (const b of els) b.click();
      return els.length;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
})()`;

/**
 * Opens the compact header's Menu unless the item is already showing, then
 * clicks the item once it shows. -1 when there is no Menu button to press.
 */
const inMenu = (selector) => `(async () => {
  const shown = () => [...document.querySelectorAll(${JSON.stringify(selector)})].some((b) => b.getClientRects().length);
  if (!shown() && !(await ${clickAll('[data-menu-button]')})) return -1;
  return await ${clickAll(selector)};
})()`;

/**
 * Resolves once every animation with an end has ended (up to 2s), so a check with motion on never reads a
 * colour or a box halfway through a fade (#419). Loops (a drifting grid, a loader's motif) are left running.
 */
const ANIMATIONS_DONE = `Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 2000))])`;

/** Polls `expression` in the page every 50ms until it is truthy or `ms` pass; resolves with its last value. */
const until = (page, expression, ms = 5000) =>
  page.evaluate(`(async () => { const deadline = Date.now() + ${ms}; for (;;) { const v = (${expression}); if (v || Date.now() > deadline) return v; await new Promise((r) => setTimeout(r, 50)); } })()`);

const OPEN_DIALOGS = `document.querySelectorAll('[role="dialog"]').length`;

/**
 * Closes any menu or dialog an earlier state left open, as a person would:
 * focus inside it, Escape, and wait until it has gone. On a slow runner an
 * earlier undo's Escape can land before the overlay has focus, and an open
 * one holds focus inside itself and covers the page (#404). Resolves with
 * the label of one still open after three tries, or '' when none is.
 */
async function closeOverlays(page) {
  for (let i = 0, open; i < 3 && (open = await page.evaluate(OPEN_DIALOGS)) > 0; i++) {
    await page.evaluate(`(() => { const d = [...document.querySelectorAll('[role="dialog"]')].at(-1); (d.querySelector('a, button, input, [tabindex]') ?? d).focus(); })()`);
    await page.key('Escape');
    await until(page, `${OPEN_DIALOGS} < ${open}`, 2000);
  }
  return page.evaluate(`(() => { const d = [...document.querySelectorAll('[role="dialog"]')].at(-1); return d ? (d.getAttribute('aria-label') ?? d.className) || 'a dialog' : ''; })()`);
}

/** The states each view is checked in, beyond how it opens. */
function states(route, width, sample = true) {
  const out = [];
  // The app's own breakpoint (COMPACT_HEADER in src/App.tsx): below it, the header is the Menu button.
  const compact = width < 1024;
  if (compact) out.push({ name: 'menu', setup: clickAll('[data-menu-button]'), undo: 'Escape' });
  // Feedback is in the header, or in its Menu when the header folds, which it does below 1024px or when its row is full.
  if (route === '#/') out.push({ name: 'feedback', setup: inMenu('button.feedback-open'), undo: 'Escape' });
  // The command palette and the shortcuts sheet (#416): open, with an item search typed, and the sheet. Ctrl+K and ? are
  // dispatched, with Meta too, so the same press opens it on a Mac; a second Ctrl+K closes the palette if Escape only cleared it.
  // The checklist itself, in place of the empty view: three steps, and the sample-data command beside them.
  if (route === FIRST_RUN_ROUTE) out.push({ name: 'first-run', setup: `(async () => { const deadline = Date.now() + 5000; while (!document.querySelector('[data-first-run]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); const steps = document.querySelectorAll('[data-first-run] .first-run__step').length; return steps === 3 ? 1 : steps ? 'the first-run checklist has ' + steps + ' steps, not 3' : 'no first-run checklist on a home with no Toil projects'; })()` });
  if (route === '#/' || route === FIRST_RUN_ROUTE || route === '#/project/card-payments/board' || route === '#/settings/connections') {
    const toggle = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, metaKey: true, bubbles: true }))`;
    const openPalette = `(async () => { ${toggle}; const deadline = Date.now() + 5000; while (!document.querySelector('[data-palette-item]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); return document.querySelector('[data-palette-item]') ? 1 : 0; })()`;
    const closePalette = `(() => { if (document.querySelector('[data-palette]')) ${toggle}; })()`;
    out.push({ name: 'palette', clearOverlays: true, setup: openPalette, undo: 'Escape', undoJs: closePalette });
    const typed = `(async () => { if (!(await ${openPalette})) return 0; const i = document.querySelector('[data-palette-input]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'e'); i.dispatchEvent(new Event('input', { bubbles: true })); const deadline = Date.now() + 5000; while (!document.querySelector('[data-palette-item="items"]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); return document.querySelector('[data-palette-item="items"]') ? 1 : 'typed e, and no item came up'; })()`;
    if (route === '#/' || route === '#/project/card-payments/board') out.push({ name: 'palette-search', clearOverlays: true, setup: typed, undoJs: closePalette });
    const sheet = `(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true })); const deadline = Date.now() + 5000; while (!document.querySelector('[data-shortcuts]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); return document.querySelector('[data-shortcuts]') ? 1 : 0; })()`;
    if (route === '#/' || route === FIRST_RUN_ROUTE) out.push({ name: 'shortcuts', clearOverlays: true, setup: sheet, undo: 'Escape', undoJs: clickAll('[data-shortcuts-close]', null, 0) });
  }
  // The bell and What's new (#417): the bell's list open, from the header at every width, and What's new opened from
  // Help, which is inside the Menu on a narrow screen. The list shows the latest releases when nothing is new.
  if (route === '#/' || route === '#/project/card-payments') {
    const waitSel = (sel) => `(async () => { const deadline = Date.now() + 5000; while (!document.querySelector(${JSON.stringify(sel)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); return document.querySelector(${JSON.stringify(sel)}) ? 1 : 0; })()`;
    out.push({ name: 'bell', clearOverlays: true, setup: `(async () => { if (!(await ${clickAll('[data-bell]')})) return 0; return await ${waitSel('[data-bell-list]')}; })()`, undo: 'Escape' });
    if (route === '#/') out.push({ name: 'whats-new', clearOverlays: true, setup: `(async () => { if ((await ${inMenu('[data-help-link]')}) < 1) return 0; if (!(await ${clickAll('[data-whats-new-open]')})) return 'Help has no What\\'s new'; return await ${waitSel('[data-whats-new]')}; })()`, undo: 'Escape', undoJs: clickAll('[data-whats-new-close]', null, 0) });
  }
  // Help (#346), checked before the Ask states so no overlay of theirs is still closing: the first (i) on the page with its tooltip showing, as a keyboard user who
  // tabbed to it sees it, and pressed, with its popover and Read more link open. On the views with the most of them, at every width.
  if (route === '#/project/card-payments' || route === '#/settings/connections' || route === '#/settings/appearance' || route === '#/project/card-payments/people') {
    const first = `[...document.querySelectorAll('main [data-help]')].find((b) => b.getClientRects().length)`;
    const waitFor = (sel) => `(async () => { const deadline = Date.now() + 5000; while (!document.querySelector(${JSON.stringify(sel)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); return document.querySelector(${JSON.stringify(sel)}) ? 1 : 0; })()`;
    // A real Tab first (`key`), so React Aria reads the focus that follows as a keyboard user's: it ignores keys a
    // script dispatches, and Escape would let a dialog closed earlier hand its focus back. Focus is tried up to three
    // times, in case something still closing takes it back anyway.
    // When the tooltip doesn't open, the state says where focus was and what was open, rather than the generic line.
    out.push({ name: 'help-tooltip', clearOverlays: true, key: 'Tab', setup: `(async () => { const b = ${first}; if (!b) return 0; b.scrollIntoView({ block: 'center' }); let seen = 0, scrolls = 0; const count = () => scrolls++; addEventListener('scroll', count, true); const watch = new MutationObserver(() => { if (document.querySelector('.help-tooltip')) seen++; }); watch.observe(document.body, { childList: true, subtree: true }); try { for (let i = 0; i < 3; i++) { b.blur(); b.focus(); const deadline = Date.now() + 2000; while (!document.querySelector('.help-tooltip') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); if (document.querySelector('.help-tooltip') && document.activeElement === b) return 1; } } finally { watch.disconnect(); removeEventListener('scroll', count, true); } const a = document.activeElement; return 'no tooltip after three focuses: focus on ' + (a ? a.tagName.toLowerCase() + (a.className ? '.' + String(a.className).split(' ').join('.') : '') + ' ' + (a.getAttribute('aria-label') ?? '') : 'nothing') + ', tooltip seen ' + seen + ' time(s), ' + scrolls + ' scroll event(s), ' + document.querySelectorAll('[role=dialog]').length + ' dialog(s) open'; })()`, undo: 'Escape', undoJs: 'document.activeElement?.blur()' });
    out.push({ name: 'help-popover', clearOverlays: true, setup: `(async () => { const b = ${first}; if (!b) return 0; b.scrollIntoView({ block: 'center' }); b.click(); return await ${waitFor('.help-popover [data-read-more]')}; })()`, undo: 'Escape' });
  }
  // The setup guide (#561): the sample's scripted guide is ready, so the Tools step has it beside it (open, from 1000px) or folded below (below it),
  // then with an answer showing and a refused token notice, each reached through Start and the AI agent step. Back twice undoes it.
  if (route === '#/setup') {
    // Welcome's Start, then the AI agent step, whose Next stays off until one is chosen (a ready agent is picked when it is off), then Next shows the Tools step and its guide.
    const toTools = `(async () => { await ${clickAll('[data-setup-next]')}; const next = () => [...document.querySelectorAll('[data-setup-next]')].find((b) => b.getClientRects().length); const deadline = Date.now() + 5000; while (!document.querySelector('[data-setup-helpers]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); if (next()?.disabled) { const pick = document.querySelector('[data-setup-helpers] input[type=radio]:not([disabled])'); if (!pick) return 'the AI agent step offers no agent that is ready, so the Tools step and its guide cannot be reached'; pick.click(); while (next()?.disabled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); } await ${clickAll('[data-setup-next]')}; while (!document.querySelector('[data-guide]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); return document.querySelector('[data-guide]') ? 1 : 'the Tools step showed no guide'; })()`;
    const openFold = `(async () => { const f = document.querySelector('[data-guide-fold] summary'); if (f && !f.parentElement.open) f.click(); return 1; })()`;
    const back = `(async () => { await ${clickAll('[data-setup-back]')}; await ${clickAll('[data-setup-back]')}; return 1; })()`;
    out.push({ name: 'guide', setup: `(async () => { const n = await ${toTools}; if (n !== 1) return n; await ${openFold}; return n; })()`, undoJs: back });
    out.push({ name: 'guide-answered', setup: `(async () => { const n = await ${toTools}; if (n !== 1) return n; await ${openFold}; await ${clickAll('[data-guide-starter]', null, 5000)}; const deadline = Date.now() + 5000; while (!document.querySelector('[data-guide-log] .guide__turn p:not(.guide__question):not([role=status])') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); return document.querySelector('[data-guide-log] .guide__turn') ? 1 : 'the guide showed no answer'; })()`, undoJs: back });
    const token = ['gh', 'p_', '0'.repeat(34), 'AB'].join('');
    out.push({ name: 'guide-refused', setup: `(async () => { const n = await ${toTools}; if (n !== 1) return n; await ${openFold}; const t = document.querySelector('[data-guide-input]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'my token is ${token}'); t.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((r) => setTimeout(r, 100)); await ${clickAll('.guide__ask button[type=submit]')}; return document.querySelector('[data-guide-refused]') ? 1 : 'no refusal notice'; })()`, undoJs: back });
  }
  // Show and Hide are items in each card's menu now, not buttons on the card.
  const menuItem = (label) => `(async () => { const deadline = Date.now() + 5000; let n = 0; for (const t of [...document.querySelectorAll('.conn-card .card-menu__trigger')].filter((b) => b.getClientRects().length)) { t.click(); let item; while (!(item = [...document.querySelectorAll('[role="menuitem"]')].find((i) => (i.textContent ?? '').trim() === ${JSON.stringify(label)})) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); if (item) { item.click(); n++; } else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); while (document.querySelector('[role="menu"]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); } return n; })()`;
  if (route === '#/settings/projects') out.push({ name: 'shown', setup: menuItem('Show details'), undoJs: menuItem('Hide details') });
  // Set up this repo (#333): the sample's plan, with its table, check problems and the form for the missing connection.
  if (route === '#/settings/projects') {
    const plan = `document.querySelector('[aria-labelledby="repo-setup"] .shown')`;
    out.push({ name: 'repo-setup', setup: `(async () => { const n = await ${clickAll('form.change button', '/^Check this repo$/')}; await new Promise((r) => setTimeout(r, 300)); ${plan}?.scrollIntoView({ block: 'start' }); return n; })()`, undoJs: 'window.scrollTo(0, 0)' });
  }
  // The focused Ask view (#343), opened from the bar, and the two popovers in its strip: the (i) (#283) and the
  // agent switcher (#344). Each is closed with Escape, then the view with its Close button.
  const openAsk = `await ${clickAll('[data-ask-bar]')};`;
  const closeAsk = clickAll('[data-ask-close]');
  if (/^#\/project\/[^/]+$/.test(route)) {
    // The page stays open from one width to the next, so the chat may already hold the answer an earlier width asked
    // for: then its questions are the Suggestions button instead of the guided start.
    const ready = `document.querySelector('.ask-focus [data-guided-start], .ask-focus [data-ask-suggestions]')`;
    out.push({ name: 'ask-open', setup: `(async () => { ${openAsk} const deadline = Date.now() + 5000; while (!${ready} && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); return ${ready} ? 1 : 0; })()`, undoJs: closeAsk });
    out.push({ name: 'ask-info', setup: `(async () => { ${openAsk} return await ${clickAll('[data-ask-info]')}; })()`, undo: 'Escape', undoJs: closeAsk });
    out.push({ name: 'ask-switcher', setup: `(async () => { ${openAsk} return await ${clickAll('[data-agent-switch]')}; })()`, undo: 'Escape', undoJs: closeAsk });
  }
  // The readiness gate (#307): an item's workflow read live, and the Command Center's verdict filter open. Only
  // the sample's Jira and Azure DevOps items are pressed: a GitHub issue has no read to make, and a done item none either.
  if (/\/item\/corp-(jira|ado)%3A/.test(route)) out.push({ name: 'workflow-live', setup: `(async () => { const n = ${clickAll('.readiness-live button', '/Check the workflow live|Read the workflow again/')}; await new Promise((r) => setTimeout(r, 300)); return n; })()` });
  if (/\/command-center$/.test(route)) out.push({ name: 'verdict-filter', setup: clickAll('.readiness-filters > div.choice:first-of-type .choice-button'), undo: 'Escape' });
  // An answered question (#295): its usage footer, and the chat's running total and context meter in the pane's head.
  // Then, once a question has its answer, the Suggestions menu the starters fold into (#343).
  // Analyze (#343) on the next toil project: its pulse check, pressed in the bar, in the focused view.
  // Done means the new turn is in the view, the Stop button gone and its usage shown inside its "how sure" fold (#552; the chat's own total waits for a second answer, since one answer's usage is the chat's); the closed view holds no turns, so they're counted from the bar.
  const answered = (press) => `(async () => { const asked = Number(/(\\d+) questions? in this chat/.exec(document.querySelector('.ask-bar')?.textContent ?? '')?.[1] ?? 0); if (!(await ${press})) return 0; const done = () => { const turns = document.querySelectorAll('.ask-focus .turn'); return turns.length > asked && !document.querySelector('[data-ask-stop]') && turns[turns.length - 1].querySelector('[data-how-sure] [data-usage-footer]') && (turns.length < 2 || document.querySelector('[data-chat-usage]')) && document.querySelector('[data-ask-status]'); }; const deadline = Date.now() + 15000; while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); return done() ? 1 : 0; })()`;
  if (route === '#/project/card-payments') {
    const firstQuestion = `(async () => { ${openAsk} const deadline = Date.now() + 5000; while (!document.querySelector('.ask-focus [data-question], [data-ask-suggestions]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); const chip = document.querySelector('.ask-focus [data-question="finish"]'); if (chip) return (chip.click(), 1); if (!(await ${clickAll('[data-ask-suggestions]')})) return 0; return await ${clickAll('[role="menuitem"]:first-child')}; })()`;
    out.push({ name: 'answered', setup: answered(firstQuestion), undoJs: closeAsk });
    out.push({ name: 'ask-suggestions', setup: `(async () => { ${openAsk} return await ${clickAll('[data-ask-suggestions]')}; })()`, undo: 'Escape', undoJs: closeAsk });
  }
  // Analyze is the guided start's first question (#552), or the same words in the Suggestions menu once the chat has begun.
  const briefing = `(async () => { ${openAsk} const deadline = Date.now() + 5000; while (!document.querySelector('.ask-focus [data-question], [data-ask-suggestions]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); const q = document.querySelector('.ask-focus [data-question="briefing"]'); if (q) return (q.click(), 1); if (!(await ${clickAll('[data-ask-suggestions]')})) return 0; return await ${clickAll('[role="menuitem"]', '/^Give me the full briefing/')}; })()`;
  if (route === '#/project/settlement') out.push({ name: 'analyzed', setup: answered(briefing), undoJs: closeAsk });
  // The Assign dialog from an item's page, and Start on the Agents lane's inbox (#293).
  // Escape alone can leave it open on a slow runner (focus not yet inside it), which then holds focus through every
  // state at the next width; its own Cancel or Close closes it for certain.
  const closeAssign = clickAll('[role="dialog"] button', '/^(Cancel|Close)$/', 0);
  if (route.includes('/item/')) out.push({ name: 'assign-open', setup: clickAll('[data-assign-open]'), undo: 'Escape', undoJs: closeAssign });
  // The Agents panel (#394, #552) is closed at every width until its button is pressed: a drawer below 1200px (SIDEBAR_WIDE in
  // src/views/ToilProjectShell.tsx), a column beside the view from there up, which the same button closes again.
  const sidebarWide = width >= 1200;
  const closeDrawer = `(async () => { await ${clickAll('[data-agents-close]', null, 0)}; const open = document.querySelector('[data-agents-open][aria-expanded="true"]'); if (open) open.click(); return 1; })()`;
  if (route === '#/project/card-payments') {
    const start = `(async () => { if (!(await ${clickAll('[data-agents-open]')})) return 0; return await ${clickAll('[data-inbox-start]')}; })()`;
    out.push({ name: 'inbox-start', setup: start, undo: 'Escape', undoJs: `(async () => { await ${closeAssign}; await ${closeDrawer}; })()` });
  }
  // The toil project's frame (#394): the Agents drawer open below 1200px, the toil project switcher, and a metric's full chart from the Overview.
  if (/^#\/project\/[^/]+$/.test(route)) out.push({ name: sidebarWide ? 'agents-panel' : 'agents-drawer', setup: clickAll('[data-agents-open]'), undo: 'Escape', undoJs: closeDrawer });
  // The switcher is in the header beside the brand (src/components/project-switcher.tsx), from 1024px; below it the same list is links inside the header's Menu, which the menu state opens.
  if (route === '#/project/card-payments') {
    if (!compact) out.push({ name: 'toil-project-switch', setup: clickAll('[data-toil-project-switch]'), undo: 'Escape' });
    for (const m of ['burnup', 'pr-wait']) out.push({ name: `chart-${m}`, setup: clickAll(`[data-metric="${m}"]`), undo: 'Escape', undoJs: clickAll('[data-chart-close]', null, 0) });
  }
  // The history (#395), set open rather than clicked, since the check has already opened every <details> once: an entry's what-changed opened; an analysis with its evidence unfolded, and a citation chip's detail as a keyboard user who tabbed to it sees it.
  if (/\/analyses$/.test(route)) out.push({ name: 'what-changed', undoJs: 'window.scrollTo(0, 0)', setup: `(() => { const d = [...document.querySelectorAll('details.analysis__changes')]; for (const x of d) x.open = true; d[0]?.scrollIntoView({ block: 'start' }); return d.length; })()` });
  if (/\/analyses\/[^/]+$/.test(route)) {
    // A real agent's briefing may legitimately have no evidence paragraphs (a Codex run can), and a state that opens nothing is a problem, so only the sample (whose analysis always has some) is held to it.
    out.push({ name: 'evidence-open', undoJs: 'window.scrollTo(0, 0)', setup: `(() => { const d = [...document.querySelectorAll('details.analysis-evidence')]; for (const x of d) x.open = true; d[0]?.scrollIntoView({ block: 'start' }); return d.length || ${sample ? 0 : 1}; })()` });
    const chip = `[...document.querySelectorAll('main .cite-link')].find((c) => c.getClientRects().length)`;
    out.push({ name: 'cite-tooltip', clearOverlays: true, key: 'Tab', setup: `(async () => { const c = ${chip}; if (!c) return 0; c.scrollIntoView({ block: 'center' }); for (let i = 0; i < 3; i++) { c.blur(); c.focus(); const deadline = Date.now() + 2000; while (!document.querySelector('.cite-tooltip') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); if (document.querySelector('.cite-tooltip')) return 1; } return 'no tooltip after three focuses on the first citation chip'; })()`, undo: 'Escape', undoJs: 'document.activeElement?.blur()' });
  }
  if (route === '#/project/card-payments/board') out.push({ name: 'attention-only', setup: clickAll('[data-attention-only]'), undoJs: clickAll('[data-attention-only]') });
  // A failing command's recent audit lines, opened under it on the Usage page (#309).
  // Real data may genuinely have no failed command, and a state that opens nothing is a problem, so only the sample (which always has some) is held to it.
  if (sample && route === '#/settings/usage') out.push({ name: 'audit-lines', setup: `(async () => { const n = ${clickAll('[data-usage-lines]', '/Show recent failures/')}; await new Promise((r) => setTimeout(r, 300)); return n; })()`, undoJs: clickAll('[data-usage-lines]', '/Hide recent failures/') });
  // The person's instructions are on the Agent page as it opens; the full prompt opens under them (#283).
  // The worklog (#308): a day rebuilt, which says how it compared, and an earlier month in the calendar.
  if (/\/worklog\/\d{4}-\d{2}-\d{2}$/.test(route)) out.push({ name: 'rebuilt', setup: `(async () => { const n = ${clickAll('[data-worklog-rebuild]')}; await new Promise((r) => setTimeout(r, 300)); return n; })()` });
  // The stand-up (#345): the agent's write-up shown, with the fact lines it names marked in the report.
  if (/\/worklog\/standup/.test(route)) out.push({ name: 'written-up', setup: `(async () => { const n = ${clickAll('[data-standup-writeup]')}; await new Promise((r) => setTimeout(r, 300)); return n; })()` });
  if (/\/worklog$/.test(route)) out.push({ name: 'previous-month', setup: clickAll('.calendar-nav button', '/Previous month/'), undoJs: clickAll('.calendar-nav button', '/Next month/') });
  // Every Toil project card's menu says Edit, which opens its name and description as a form in the card (#561, EditDetails); all of them are opened at once, for the longest the cards get.
  // The project page has no inline form (its Edit is a link to Settings), and the sources page it names is a view of its own.
  if (route === '#/') out.push({ name: 'editing', setup: `(async () => { const shown = () => [...document.querySelectorAll('[data-card-menu]')].filter((b) => b.getClientRects().length); const deadline = Date.now() + 5000; while (!shown().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); let n = 0; for (const t of shown()) { t.click(); let edit; while (!(edit = [...document.querySelectorAll('[role="menuitem"]')].find((i) => (i.textContent ?? '').trim() === 'Edit')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); if (!edit) break; edit.click(); while (document.querySelector('[role="menu"]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); n++; } return n; })()`, undoJs: "document.querySelectorAll('.edit-field').forEach((i) => i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))" });
  // Theme moments (#419), from their previews under Settings, General: a loading screen as the theme draws it, the
  // launch splash, and the sprint recap card, the largest moment. The recap is decoration, hidden from screen readers,
  // so it is shown to the check (aria-hidden lifted) for its layout and axe. With Theme motion off (the reduced-motion
  // pass) the splash and moments don't play, and their buttons say so by being disabled: that state checks the page as it is.
  if (route === '#/settings/appearance') {
    // Each preview is an entry in one menu: the menu is opened, then the entry pressed, as a person would.
    const pick = (entry) => `(async () => { const open = await ${clickAll('[data-preview-menu]')}; if (!open) return 'no preview menu button'; const deadline = Date.now() + 5000; while (!document.querySelector('[role="menu"]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); const item = document.querySelector(${JSON.stringify(`[data-preview="${entry}"]`)}); if (!item) { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return document.querySelector('[role="menu"] [data-preview="loader"]') ? 'none' : 0; } if (item.getAttribute('aria-disabled') === 'true') { item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'disabled'; } item.click(); return 'pressed'; })()`;
    out.push({ name: 'loading-screen', setup: `(async () => { const how = await ${pick('loader')}; if (how !== 'pressed') return how || 0; const deadline = Date.now() + 5000; while (!document.querySelector('[data-moment-preview] [data-loading] [role="status"]') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); return document.querySelector('[data-moment-preview] [data-loading] [role="status"]') ? 1 : 'the loading screen preview opened with no progress status'; })()`, undo: 'Escape', undoJs: clickAll('[data-preview-close]', null, 0) });
    // A theme with no splash has no entry for it, and with Theme motion off the splash and moments are disabled: each checks the page as it is.
    const played = (entry, shown) => `(async () => { const how = await ${pick(entry)}; if (how === 'none' || how === 'disabled') return 1; if (how !== 'pressed') return how || 0; const deadline = Date.now() + 5000; while (!document.querySelector(${JSON.stringify(shown)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); const el = document.querySelector(${JSON.stringify(shown)}); if (!el) return 'pressed the ${entry} preview and nothing showed'; el.removeAttribute('aria-hidden'); return 1; })()`;
    out.push({ name: 'splash', setup: played('splash', '.splash'), undo: 'Escape' });
    out.push({ name: 'sprint-recap', setup: played('sprint-ended', '[data-moment="sprint-ended"]'), undo: 'Escape' });
  }
  if (route === '#/settings/agent') out.push({ name: 'full-prompt', setup: clickAll('[data-full-prompt]', '/Show the full prompt/'), undoJs: clickAll('[data-full-prompt]', '/Hide the full prompt/') });
  // Install (#344): the dialog with the exact npm command, before anything runs, for the first SDK missing. On a
  // machine with every SDK installed there is no Install to press, which counts only when the status card says so.
  if (route === '#/settings/agent') out.push({ name: 'install-dialog', setup: `(async () => { const rows = () => document.querySelectorAll('.adapter-status__row, .helper-row[data-adapter]'); const deadline = Date.now() + 5000; while (!rows().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); const press = document.querySelector('[data-install]'); if (!press) return rows().length > 0 && [...rows()].every((r) => r.dataset.state === 'ready') ? 1 : 0; press.click(); while (!document.querySelector('.install-command') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50)); return document.querySelector('.install-command') ? 1 : 0; })()`, undo: 'Escape' });
  return out;
}

/**
 * Where to drag on the board (#393): the last card of the first column that
 * has one, scrolled to the upper part of the screen, out of the edge where
 * dnd-kit scrolls the page, and the next column, whose heading is just below
 * or beside it. Null when the view has no board with two columns to drag
 * between.
 */
function dragPlan() {
  const cols = [...document.querySelectorAll('.board .column')];
  // A card that can't move isn't draggable (canMove in src/model/board.ts), so only a movable one can be picked up.
  const movable = (c) => c.querySelectorAll('li.card .card-grip:not([data-immovable])');
  if (cols.length < 2) return { skip: 'no board with two columns to drag between' };
  const from = cols.findIndex((c, i) => i < cols.length - 1 && movable(c).length);
  if (from < 0) return { skip: 'no card on the board can be moved (each is immovable: ' + (document.querySelectorAll('.board li.card .card-grip[data-immovable]').length) + ' immovable card(s))' };
  const grips = movable(cols[from]);
  const grip = grips[grips.length - 1];
  const r0 = grip.getBoundingClientRect();
  window.scrollBy(0, r0.top - window.innerHeight * 0.3);
  const r = grip.getBoundingClientRect();
  const to = cols[from + 1].getBoundingClientRect();
  return {
    item: grip.dataset.item,
    target: cols[from + 1].querySelector('h3').id,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    tx: Math.round(to.left + to.width / 2),
    // Level with the card when the columns sit side by side; just under the heading when they stack. Never in the edge that scrolls.
    ty: Math.round(Math.min(Math.max(r.top + r.height / 2, to.top + 40, window.innerHeight * 0.25), to.bottom - 20, window.innerHeight * 0.7)),
  };
}

/** Mid-drag: the copy that follows the pointer, and whether the pointer is on it; the card itself, still in its column. */
function dragMid(item, tx, ty) {
  const overlay = document.querySelector('[data-drag-overlay]');
  const r = overlay?.getBoundingClientRect();
  const card = document.querySelector(`.card-grip[data-item="${CSS.escape(item)}"]`)?.closest('li.card');
  return {
    overlay: Boolean(overlay),
    underPointer: Boolean(r && tx >= r.left && tx <= r.right && ty >= r.top && ty <= r.bottom),
    verdict: overlay?.querySelector('[data-drop-verdict]')?.textContent ?? null,
    placeholder: Boolean(card?.classList.contains('card--dragging')),
  };
}

/** What is at (x, y) on the page, when it isn't the grip of `item`: '' when it is. */
function hitTest(item, x, y) {
  const el = document.elementFromPoint(x, y);
  if (el?.closest('.card-grip')?.dataset.item === item) return '';
  if (!el) return 'nothing';
  const label = el.closest('[aria-label]')?.getAttribute('aria-label');
  return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}${label ? ` in "${label}"` : ''}`;
}

/**
 * Drags a card to the next column with real input and checks what a person
 * sees on the way and after. Resolves with problems, as strings; the dropped
 * state's layout and axe findings come back as `findings` and `violations`.
 *
 * Every step waits on what it needs, never on a fixed time (#404): no menu
 * or dialog left open over the board, the card's grip under the pointer, the
 * card picked up, the copy under the pointer, the ghost in the column.
 */
async function dragCheck(page, width, shoot, inspectDropped, sample) {
  const none = { findings: [], violations: [] };
  // A menu an earlier state's Escape missed would take the press and close itself instead of the card moving.
  const open = await closeOverlays(page);
  if (open) return { problems: [`before the drag, "${open}" was still open after three Escapes, covering the board`], ...none };
  const plan = await page.evaluate(`(${dragPlan})()`);
  // The sample's board always has a card that moves, so there it is a problem. On real data every card may be immovable
  // (a GitHub issue that isn't on a project board has no Status to set): then the drag is skipped, and said so in the report.
  if (plan.skip) return sample || !/^no card on the board can be moved/.test(plan.skip) ? { problems: [plan.skip], ...none } : { problems: [], skipped: plan.skip, ...none };
  const blocked = await page.evaluate(`(${hitTest})(${JSON.stringify(plan.item)}, ${plan.x}, ${plan.y})`);
  if (blocked) return { problems: [`before the drag, the card's grip at ${plan.x},${plan.y} is under ${blocked}, so a press there can't pick it up`], ...none };
  const settle = (ms) => page.evaluate(`new Promise((r) => setTimeout(r, ${ms}))`);
  const touch = width < 768;
  const problems = [];
  const steps = 12;
  const placeholder = `(${dragMid})(${JSON.stringify(plan.item)}, 0, 0).placeholder`;
  if (touch) {
    await page.touchscreen(true);
    await page.touch('start', plan.x, plan.y);
    // The hold that picks a card up by touch (TOUCH_HOLD in src/views/Board.tsx): the finger stays still until it has.
    if (!(await until(page, placeholder))) {
      await page.touch('end', plan.x, plan.y);
      await page.touchscreen(false);
      return { problems: [`a finger held on the card's grip at ${plan.x},${plan.y} didn't pick it up within 5s`], ...none };
    }
  } else {
    await page.mouse('move', plan.x, plan.y);
    await page.mouse('down', plan.x, plan.y);
  }
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(plan.x + ((plan.tx - plan.x) * i) / steps);
    const y = Math.round(plan.y + ((plan.ty - plan.y) * i) / steps);
    await (touch ? page.touch('move', x, y) : page.mouse('move', x, y));
    // A hand's pace, not a wait for anything: what the drag must show is waited for below.
    await settle(16);
  }
  const midNow = `(${dragMid})(${JSON.stringify(plan.item)}, ${plan.tx}, ${plan.ty})`;
  await until(page, `(() => { const m = ${midNow}; return m.overlay && m.underPointer && m.placeholder && /^Drop to propose: /.test(m.verdict ?? ''); })()`);
  const mid = await page.evaluate(midNow);
  await shoot('drag-mid');
  if (!mid.overlay) problems.push('mid-drag, no copy of the card followed the pointer within 5s');
  else if (!mid.underPointer) problems.push(`mid-drag, the copy of the card wasn't under the pointer at ${plan.tx},${plan.ty} within 5s`);
  if (mid.overlay && !/^Drop to propose: /.test(mid.verdict ?? '')) problems.push(`mid-drag over the next column, the copy says "${mid.verdict}" instead of what a drop would propose`);
  if (!mid.placeholder) problems.push('mid-drag, the card left no placeholder in its column within 5s');
  await (touch ? page.touch('end', plan.tx, plan.ty) : page.mouse('up', plan.tx, plan.ty));
  if (touch) await page.touchscreen(false);
  const ghost = await until(page, `(() => { const g = document.querySelector('[data-proposed-ghost]'); return g ? g.closest('.column')?.querySelector('h3')?.id ?? '' : null; })()`);
  if (ghost === null) problems.push('after the drop, no proposed ghost of the card showed on the board within 5s');
  else if (ghost !== plan.target) problems.push(`after the drop, the proposed ghost is in ${ghost || 'no column'}, not ${plan.target}`);
  await shoot('drag-dropped');
  await page.evaluate(ANIMATIONS_DONE);
  const dropped = ghost === null ? none : await inspectDropped();
  // Undo, so the next width starts from the board as it opened. For 50ms after a drop dnd-kit stops every click on
  // the page (the one a pointerup would make), so Undo is pressed until the ghost has gone, not once.
  const undone = await page.evaluate(`(async () => { const deadline = Date.now() + 5000; for (;;) { const b = [...document.querySelectorAll('[data-proposed-ghost] button')].find((x) => /^Undo/.test(x.getAttribute('aria-label') ?? '')); if (!b) return !document.querySelector('[data-proposed-ghost]'); if (Date.now() > deadline) return false; b.click(); await new Promise((r) => setTimeout(r, 100)); } })()`);
  if (!undone) problems.push('after Undo was pressed for 5s, the proposed ghost was still on the board');
  return { problems, ...dropped };
}

async function axeRun(page, source) {
  const has = await page.evaluate('typeof window.axe');
  if (has !== 'object') await page.evaluate(`${source}\n;true`);
  return page.evaluate(`axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, rules: { 'label-content-name-mismatch': { enabled: true } }, resultTypes: ['violations'] }).then((r) => r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(' ')) })))`);
}

/** How many theme schemes run at once, each in its own Chrome: LAYOUT_WORKERS, or one per core. */
export function layoutWorkers(runs) {
  const asked = Number(process.env.LAYOUT_WORKERS);
  const want = Number.isInteger(asked) && asked > 0 ? asked : availableParallelism();
  return Math.max(1, Math.min(want, runs.length));
}

/**
 * Runs the check. `urlFor(theme, scheme, route)` is the address of one view
 * in one theme. Resolves with the problems that fail the run, the report-only
 * axe findings, and a count of what was checked.
 *
 * The theme schemes are shared among `workers` headless Chromes, so they run
 * side by side (#376): one after another took 16 to 18 minutes of a CI job.
 * Each scheme's findings are kept apart and joined in scheme order, so the
 * report reads the same however many workers ran.
 *
 * `sample` (on unless set false) says the data is the sample's, whose states always have something to open; real data may not (see `states`).
 * `headerFits` (on unless set false) fails a header folded into its Menu at
 * 1440px or wider; it's for the sample data, whose rows are known to fit.
 */
export async function checkLayout({ urlFor, runs = themeRuns(), routes = ROUTES, widths = WIDTHS, shots = null, motion = 'reduce', log = () => {}, workers = layoutWorkers(runs), headerFits = true, sample = true }) {
  const chrome = findChrome();
  if (!chrome) throw new Error('The layout check needs Chrome, Edge or Chromium, and found none. Install one, or set CHROME_PATH to it.');
  const axeSource = readFileSync(createRequire(join(ui, 'package.json')).resolve('axe-core/axe.min.js'), 'utf8');
  if (shots) mkdirSync(shots, { recursive: true });
  const results = new Array(runs.length);
  let next = 0;
  // The first failure stops the hand-out, and every worker closes its Chrome before it is rethrown,
  // so none is left running against a server the caller is about to stop.
  let failed = null;
  const worker = async () => {
    let browser = null;
    try {
      browser = await openBrowser(chrome);
      await browser.page.media([{ name: 'prefers-reduced-motion', value: motion }]);
      while (!failed && next < runs.length) {
        const i = next++;
        results[i] = await checkRun({ page: browser.page, run: runs[i], urlFor, routes, widths, shots, axeSource, log, headerFits, sample });
      }
    } catch (e) {
      failed ??= e;
    } finally {
      await browser?.close();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, runs.length)) }, worker));
  if (failed) throw failed;
  return {
    problems: results.flatMap((r) => r.problems),
    reported: results.flatMap((r) => r.reported),
    checked: results.reduce((n, r) => n + r.checked, 0),
  };
}

/** One theme scheme, every route and width, in one Chrome tab. */
async function checkRun({ page, run, urlFor, routes, widths, shots, axeSource, log, headerFits, sample }) {
  const problems = [];
  const reported = [];
  let checked = 0;
  const shoot = async (name) => shots && writeFileSync(join(shots, `${name}.png`), await page.screenshot());
  const label = `${run.theme} ${run.scheme}`;
  for (const route of routes) {
    await page.size(widths[0]);
    await page.goto(urlFor(run.theme, run.scheme, route));
    await page.evaluate(SETTLED);
    const applied = await page.evaluate('document.documentElement.dataset.theme');
    if (applied !== run.theme) problems.push(`${label} ${route}: the page showed the ${applied} theme instead`);
    for (const width of widths) {
      await page.size(width);
      await page.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))))`);
      await page.evaluate(ANIMATIONS_DONE);
      const where = `${label} ${route} at ${width}px`;
      const slug = `${run.theme}-${run.scheme}__${route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}__${width}`;
      const record = (state, findings) => {
        for (const f of findings) problems.push(`${where}${state ? ` (${state})` : ''}: ${f.kind} at ${f.at}: ${f.detail}`);
      };
      await shoot(slug);
      // Every <details> open, since long values hide inside them.
      await page.evaluate(`document.querySelectorAll('details').forEach((d) => (d.open = true))`);
      await page.evaluate(`new Promise((r) => setTimeout(r, 100))`);
      record('', await page.evaluate(`(${inspect})(${JSON.stringify(CARDS)}, ${headerFits})`));
      record('', await page.evaluate(`(${covered})()`));
      checked++;
      const violations = await axeRun(page, axeSource);
      for (const v of violations) {
        const line = `${where}: axe ${v.id} (${v.impact}) at ${v.nodes.slice(0, 3).join(', ')}${v.nodes.length > 3 ? ` and ${v.nodes.length - 3} more` : ''}`;
        (run.strict ? problems : reported).push(line);
      }
      // The board dragged with real input (#393), from the view as it opened.
      // On the Board tab (#394), where the board now lives.
      if (/^#\/project\/[^/]+\/board$/.test(route)) {
        const drag = await dragCheck(page, width, (name) => shoot(`${slug}__${name}`), async () => ({
          findings: await page.evaluate(`(${inspect})(${JSON.stringify(CARDS)}, ${headerFits})`),
          violations: run.strict ? await axeRun(page, axeSource) : [],
        }), sample);
        for (const p of drag.problems) problems.push(`${where} (drag): ${p}`);
        if (drag.skipped) reported.push(`${where}: skipped the board drag, ${drag.skipped}`);
        record('drag-dropped', drag.findings);
        for (const v of drag.violations) problems.push(`${where} (drag-dropped): axe ${v.id} (${v.impact}) at ${v.nodes.slice(0, 3).join(', ')}`);
        await page.evaluate('window.scrollTo(0, 0)');
        checked++;
      }
      for (const state of states(route, width, sample)) {
        // A state that opens nothing checks nothing, so it's a problem, never a quiet pass. clickAll waits for
        // its element to show, and an item in the compact header's Menu is looked for once the Menu is open (#289).
        // A state that needs focus (`clearOverlays`) first closes any menu or dialog an earlier state left open.
        if (state.clearOverlays) await closeOverlays(page);
        if (state.key) await page.key(state.key);
        const opened = await page.evaluate(state.setup);
        if (opened === -1) problems.push(`${where} (${state.name}): no Menu button to open`);
        else if (!opened) problems.push(`${where} (${state.name}): nothing to open; no element matching the selector showed within 5s`);
        // A state may say why it opened nothing, as text, rather than leave the generic line.
        else if (typeof opened === 'string') problems.push(`${where} (${state.name}): ${opened}`);
        await page.evaluate(`new Promise((r) => setTimeout(r, 300))`);
        await page.evaluate(ANIMATIONS_DONE);
        await shoot(`${slug}__${state.name}`);
        record(state.name, await page.evaluate(`(${inspect})(${JSON.stringify(CARDS)}, ${headerFits})`));
        // An open sheet covers the page on purpose, like a dialog; only the page's own states must clear the dock.
        if (state.name === 'shown') record(state.name, await page.evaluate(`(${covered})()`));
        const stateViolations = run.strict && state.name !== 'shown' ? await axeRun(page, axeSource) : [];
        for (const v of stateViolations) problems.push(`${where} (${state.name}): axe ${v.id} (${v.impact}) at ${v.nodes.slice(0, 3).join(', ')}`);
        checked++;
        if (state.undo) await page.key(state.undo);
        if (state.undoJs) await page.evaluate(state.undoJs);
        await page.evaluate(`new Promise((r) => setTimeout(r, 200))`);
      }
      if (page.errors.length) problems.push(`${where}: the page threw ${page.errors.splice(0).join('; ')}`);
    }
    log(`${label} ${route}: ${problems.length} problem(s) so far`);
  }
  return { problems, reported, checked };
}

// Run by hand: node scripts/layout-check.mjs --base <url> ...
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const many = (flag) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));
  const one = (flag) => many(flag)[0];
  const base = one('--base');
  if (!base) {
    console.error('Usage: node scripts/layout-check.mjs --base <url> [--theme <name>] [--route <hash>] [--width <px>] [--font <pair id>] [--motion full] [--shots <dir>] [--json <file>]');
    process.exit(2);
  }
  const themes = many('--theme');
  const runs = themeRuns().filter((r) => !themes.length || themes.includes(r.theme) || themes.includes(`${r.theme}-${r.scheme}`));
  const routes = many('--route').length ? many('--route') : ROUTES;
  const widths = many('--width').length ? many('--width').map(Number) : WIDTHS;
  const urlFor = (theme, scheme, route) => {
    const u = new URL(base);
    u.searchParams.set('theme', theme);
    u.searchParams.set('scheme', scheme);
    // A type pairing from Settings, Font (src/fonts.ts), to prove a wider face still fits (ui/docs/themes.md, Fonts).
    if (one('--font')) u.searchParams.set('font', one('--font'));
    u.hash = route;
    return u.href;
  };
  const motion = one('--motion') === 'full' ? 'no-preference' : 'reduce';
  const result = await checkLayout({ urlFor, runs, routes, widths, motion, shots: one('--shots') ?? null, log: (l) => console.error(l) });
  for (const r of result.reported) console.log(`report-only: ${r}`);
  for (const p of result.problems) console.log(`problem: ${p}`);
  if (one('--json')) writeFileSync(one('--json'), JSON.stringify(result, null, 2));
  console.log(`layout check: ${result.checked} views and states checked, ${result.problems.length} problem(s), ${result.reported.length} report-only axe finding(s)`);
  process.exitCode = result.problems.length ? 1 : 0;
}
