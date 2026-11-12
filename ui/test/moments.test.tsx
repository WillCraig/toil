// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { HELP } from '../src/help.ts';
import type { WorklogEvent } from '../src/model/worklog.ts';
import { kindOf, MAX_MOMENTS, momentsFor, SAMPLE_MOMENTS } from '../src/moments/events.ts';
import { ENTER } from '../src/moments/motifs.ts';
import { Loader, MomentsProvider, resetSplash, Splash, useMomentPlayer, type Moment } from '../src/moments/Moments.tsx';
import { progressText, trackCalls } from '../src/moments/progress.ts';
import { rememberSprint, renameSprint, splashDataFor } from '../src/moments/splash-data.ts';
import { health } from '../src/model/sprint.ts';
import { loadToilProject } from '../src/load.ts';
import { ENTER_MOTIFS, LOADER_DELAY_MS, LOOP_MOTIFS, MOMENT_KINDS } from '../src/moments/schema.ts';
import { resetMotionChoice, resetThemeMotion, setMotionChoice, setThemeMotion } from '../src/motion.ts';
import { SkinProvider, ThemeChoiceProvider, ThemeProvider, skinsFor } from '../src/skins.tsx';
import type { ThemeChoiceState } from '../src/theme-choice.ts';
import { themeNamed } from '../src/themes.ts';
import { nextTip, resetTips, resetTipsChoice, setTipsOn, shuffled, TIPS } from '../src/tips.ts';

/**
 * Theme moments (#419): the one engine every theme's moments play on. A wait
 * under 300 ms shows nothing; a longer one shows the theme's loader with the
 * real progress in a status message and a tip; Theme motion off makes every
 * moment an instant change; a theme without a moments block gets the plain
 * defaults; and the event moments come from the worklog's new facts only.
 */

const { matchMedia } = window;
function osMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce') ? reduce : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetMotionChoice();
  resetThemeMotion();
  resetTips();
  resetTipsChoice();
  resetSplash();
  osMotion(false);
});

afterEach(() => {
  window.matchMedia = matchMedia;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const choice = (over: Partial<ThemeChoiceState> = {}): ThemeChoiceState => ({ theme: 'crate', scheme: 'system', wording: true, voice: true, saveError: null, setTheme: () => undefined, setScheme: () => undefined, setWording: () => undefined, setVoice: () => undefined, ...over });

function inTheme(name: string, node: React.ReactNode, wording = true) {
  return (
    <ThemeProvider value={themeNamed(name)}>
      <ThemeChoiceProvider value={choice({ theme: name, wording })}>
        <SkinProvider value={skinsFor(name)}>
          <MomentsProvider>{node}</MomentsProvider>
        </SkinProvider>
      </ThemeChoiceProvider>
    </ThemeProvider>
  );
}

const fact = (over: Partial<WorklogEvent>): WorklogEvent => ({
  key: 'k', kind: 'status', at: '2026-10-12T09:00:00.000Z', subject: 'jira:PAY-1', source: 'jira', label: 'PAY-1', title: 'Store tokens', url: null, by: null, text: 'In Progress → Done', cites: [], refs: {}, observed: null, ...over,
});

describe('the loader', () => {
  it('shows nothing for a wait under 300 ms, then the progress in a status message, the theme art and a tip', () => {
    vi.useFakeTimers();
    render(inTheme('crate', <Loader message="Reading card-payments…" detail="2 of 5 toil calls answered; reading toil jira issue search." />));
    expect(screen.queryByRole('status')).toBeNull();
    act(() => vi.advanceTimersByTime(LOADER_DELAY_MS - 1));
    expect(screen.queryByRole('status')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('status').textContent).toBe('Reading card-payments… 2 of 5 toil calls answered; reading toil jira issue search.');
    expect(document.querySelector('[data-loader="crate"] .loader__art')).not.toBeNull();
    const tip = document.querySelector('[data-tip]')!;
    expect(tip.textContent).toMatch(/^Foreman's note /);
    const link = within(tip as HTMLElement).getByRole('link');
    expect(link.textContent).toMatch(/^Read more about .+ in the docs \(opens in a new tab\)$/);
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it("keeps a theme's Loading skin, and Plain's text, when the theme declares no loader, with a plain tip", () => {
    render(inTheme('plain', <Loader immediate message="Reading the Toil projects…" />));
    expect(screen.getByRole('status').textContent).toBe('Reading the Toil projects…');
    expect(document.querySelector('.loader--skin')).not.toBeNull();
    expect(document.querySelector('[data-tip]')!.textContent).toMatch(/^Tip /);
  });

  it('carries no tip once tips are off, and no flavour with themed wording off', () => {
    setTipsOn(false);
    render(inTheme('harvest', <Loader immediate message="Reading settlement…" />, false));
    expect(document.querySelector('[data-tip]')).toBeNull();
    expect(document.querySelector('.loader__flavour')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Reading settlement…');
  });

  it("isn't a second live region where the chat's status line already says the progress", () => {
    render(inTheme('crate', <Loader immediate size="inline" message="Checking the manifest…" live={false} />));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Checking the manifest…')).toBeTruthy();
  });

  it('says the real progress: which call it waits on and how many are answered', async () => {
    const seen: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const exec = trackCalls(async (command) => {
      if (command === 'jira issue search') await slow;
      return { ok: true, data: null, error: null, meta: { command } } as never;
    }, (p) => seen.push(progressText(p)!));
    const a = exec('projects show');
    const b = exec('jira issue search');
    await a;
    expect(seen.at(-1)).toBe('1 of 2 toil calls answered; reading toil jira issue search.');
    release();
    await b;
    expect(seen.at(-1)).toBe('2 of 2 toil calls answered.');
    expect(progressText(null)).toBeNull();
  });
});

describe('toil tips', () => {
  it('are plain facts, each with a Read more link from the help topics', () => {
    const ids = new Set<string>();
    for (const t of TIPS) {
      expect(HELP[t.topic], t.id).toBeDefined();
      expect(t.text, t.id).not.toMatch(/[<>`]|\[\[/);
      expect(ids.has(t.id), t.id).toBe(false);
      ids.add(t.id);
    }
    expect(TIPS.length).toBeGreaterThanOrEqual(10);
  });

  it("never repeats one until every tip has been seen, then starts the round again", () => {
    const order = shuffled(TIPS.map((t) => t.id), () => 0.5);
    let seen: string[] = [];
    const shown: string[] = [];
    for (let i = 0; i < TIPS.length; i++) {
      const next = nextTip(order, seen);
      shown.push(next.tip.id);
      seen = next.seen;
    }
    expect(new Set(shown).size).toBe(TIPS.length);
    expect(nextTip(order, seen).tip.id).toBe(order[0]);
    expect(nextTip(order, seen).seen).toEqual([order[0]]);
  });

  it('changes about every six seconds while the wait lasts', () => {
    vi.useFakeTimers();
    render(inTheme('crate', <Loader immediate message="Reading…" />));
    const first = document.querySelector('[data-tip]')!.getAttribute('data-tip');
    act(() => vi.advanceTimersByTime(6000));
    expect(document.querySelector('[data-tip]')!.getAttribute('data-tip')).not.toBe(first);
  });
});

describe('the event moments', () => {
  it('come from the facts that mark one, and nothing else', () => {
    expect(kindOf({ kind: 'status', toCategory: 'DONE' })).toBe('item-done');
    expect(kindOf({ kind: 'status', toCategory: 'IN_PROGRESS' })).toBeNull();
    expect(kindOf({ kind: 'build-recovered' })).toBe('build-passed');
    expect(kindOf({ kind: 'build-passed' })).toBe('build-passed');
    expect(kindOf({ kind: 'build-failed' })).toBe('build-failed');
    expect(kindOf({ kind: 'blocker-cleared' })).toBe('blocker-cleared');
    expect(kindOf({ kind: 'pr-merged' })).toBe('pr-merged');
    expect(kindOf({ kind: 'sprint-ended' })).toBe('sprint-ended');
    expect(kindOf({ kind: 'pr-opened' })).toBeNull();
    expect(kindOf({ kind: 'blocker' })).toBeNull();
  });

  it('become one moment a kind, the weightiest first, three at most', () => {
    const facts = [
      fact({ kind: 'status', toCategory: 'DONE', label: 'PAY-1', title: 'Store tokens' }),
      fact({ kind: 'status', toCategory: 'DONE', label: 'PAY-2', title: 'Rotate keys' }),
      fact({ kind: 'pr-merged', label: '#52', title: 'Vault' }),
      fact({ kind: 'build-failed', label: 'CI #9', title: 'for [[github:x#52]]' }),
      fact({ kind: 'build-passed', label: 'CI #8' }),
      fact({ kind: 'sprint-ended', label: 'Sprint 42', title: '', text: 'ended: 8 of 11 items done, 21 of 30 points done' }),
    ];
    const m = momentsFor(facts);
    expect(m).toHaveLength(MAX_MOMENTS);
    expect(m.map((x) => x.kind)).toEqual(['sprint-ended', 'build-failed', 'pr-merged']);
    expect(m[0]).toEqual({ kind: 'sprint-ended', text: 'Sprint 42', count: 1, figures: ['8 of 11 items done', '21 of 30 points done'] });
    expect(m[1]!.text).toBe('CI #9');
    expect(momentsFor(facts.slice(0, 2))).toEqual([{ kind: 'item-done', text: 'PAY-1 Store tokens, and 1 more', count: 2 }]);
  });

  function Player({ moments }: { moments: Moment[] }) {
    const p = useMomentPlayer();
    return (
      <button type="button" onClick={() => p.play(moments)}>
        play
      </button>
    );
  }

  it("say the plain word with the theme's beside it, hidden from screen readers, under a second each", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(inTheme('crate', <Player moments={[SAMPLE_MOMENTS['item-done']]} />));
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: 'play' }));
    const card = document.querySelector('[data-moment="item-done"]')!;
    expect(card.getAttribute('aria-hidden')).toBe('true');
    expect(card.textContent).toContain('Signed off (Done)');
    expect(card.textContent).toContain('PAY-102 Store tokens in the vault');
    act(() => vi.advanceTimersByTime(1000));
    expect(document.querySelector('[data-moment]')).toBeNull();
  });

  it('say only the plain word with themed wording off', async () => {
    render(inTheme('harvest', <Player moments={[SAMPLE_MOMENTS['pr-merged']]} />, false));
    await userEvent.click(screen.getByRole('button', { name: 'play' }));
    expect(document.querySelector('[data-moment="pr-merged"]')!.textContent).toMatch(/^Merged/);
  });

  it('play nothing with Theme motion off, or when reduced motion is asked for', async () => {
    setThemeMotion('off');
    const { unmount } = render(inTheme('crate', <Player moments={[SAMPLE_MOMENTS['build-failed']]} />));
    await userEvent.click(screen.getByRole('button', { name: 'play' }));
    expect(document.querySelector('[data-moment]')).toBeNull();
    unmount();
    setThemeMotion('full');
    setMotionChoice('reduced');
    render(inTheme('crate', <Player moments={[SAMPLE_MOMENTS['build-failed']]} />));
    await userEvent.click(screen.getByRole('button', { name: 'play' }));
    expect(document.querySelector('[data-moment]')).toBeNull();
    expect(document.documentElement.dataset.themeMotion).toBe('off');
  });

  it('play nothing in a theme that declares none (Plain)', async () => {
    render(inTheme('plain', <Player moments={[SAMPLE_MOMENTS['item-done']]} />));
    await userEvent.click(screen.getByRole('button', { name: 'play' }));
    expect(document.querySelector('[data-moment]')).toBeNull();
  });

  it('wait while the tab is hidden, and play once it is back', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    render(inTheme('crate', <Player moments={[SAMPLE_MOMENTS['item-done']]} />));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await userEvent.click(screen.getByRole('button', { name: 'play' }));
    expect(document.querySelector('[data-moment]')).toBeNull();
    hidden.mockReturnValue(false);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(document.querySelector('[data-moment="item-done"]')).not.toBeNull();
  });
});

describe('the splash', () => {
  it('plays once per launch, only while the first read lasts past 300 ms, and ends when the data is ready', () => {
    vi.useFakeTimers();
    const { rerender } = render(inTheme('harvest', <Splash ready={false} detail="Reading the Toil projects with toil projects list." />));
    expect(document.querySelector('.splash')).toBeNull();
    act(() => vi.advanceTimersByTime(LOADER_DELAY_MS));
    expect(screen.getByRole('status').textContent).toBe('Starting Toil UI. Reading the Toil projects with toil projects list.');
    rerender(inTheme('harvest', <Splash ready detail={null} />));
    expect(document.querySelector('.splash')).toBeNull();
    // A second App (remounted after a sync) plays no splash.
    render(inTheme('harvest', <Splash ready={false} />));
    act(() => vi.advanceTimersByTime(LOADER_DELAY_MS));
    expect(document.querySelectorAll('.splash')).toHaveLength(0);
  });

  it('ends on any key', () => {
    vi.useFakeTimers();
    render(inTheme('crate', <Splash ready={false} />));
    act(() => vi.advanceTimersByTime(LOADER_DELAY_MS));
    expect(document.querySelector('.splash')).not.toBeNull();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })));
    expect(document.querySelector('.splash')).toBeNull();
  });

  it("doesn't play with Theme motion off, or in a theme without one", () => {
    vi.useFakeTimers();
    setThemeMotion('off');
    const off = render(inTheme('crate', <Splash ready={false} />));
    act(() => vi.advanceTimersByTime(LOADER_DELAY_MS));
    expect(document.querySelector('.splash')).toBeNull();
    off.unmount();
    resetSplash();
    setThemeMotion('full');
    render(inTheme('plain', <Splash ready={false} />));
    act(() => vi.advanceTimersByTime(LOADER_DELAY_MS));
    expect(document.querySelector('.splash')).toBeNull();
  });
});

describe("the splash's data (#462)", () => {
  // A sprint of ten working days from Monday 5 October 2026; the fixture's clock is the Tuesday of its second week.
  const SPRINT = { start: '2026-10-05T00:00:00.000Z', end: '2026-10-17T00:00:00.000Z' };
  const keep = (kept: unknown) => localStorage.setItem('toil-ui:splash', JSON.stringify(kept));
  const DATA = { toilProject: 'card-payments', day: 7, days: 10, done: 4 };
  const played = (theme: string, data: typeof DATA | null) => {
    cleanup();
    resetSplash();
    vi.useFakeTimers();
    render(inTheme(theme, <Splash ready={false} data={data} />));
    act(() => vi.advanceTimersByTime(LOADER_DELAY_MS));
    return document.querySelector<HTMLElement>('.splash')!;
  };

  it("works the day out from the remembered sprint at the App's clock, and knows nothing outside it", () => {
    keep({ 'card-payments': { ...SPRINT, done: 4 } });
    expect(splashDataFor('card-payments', FIXTURE_NOW)).toEqual(DATA);
    // The Saturday after the first week is still day 5; the sprint's last minute is day 10.
    expect(splashDataFor('card-payments', '2026-10-10T12:00:00.000Z')?.day).toBe(5);
    expect(splashDataFor('card-payments', '2026-10-16T23:59:00.000Z')?.day).toBe(10);
    expect(splashDataFor('card-payments', SPRINT.end)).toBeNull();
    expect(splashDataFor('card-payments', '2026-10-04T23:00:00.000Z')).toBeNull();
    expect(splashDataFor('settlement', FIXTURE_NOW)).toBeNull();
    // Storage that holds something else, or nothing readable, is nothing.
    keep({ 'card-payments': { start: 'soon', end: SPRINT.end, done: 4 }, settlement: { ...SPRINT, done: -1 } });
    expect(splashDataFor('card-payments', FIXTURE_NOW)).toBeNull();
    expect(splashDataFor('settlement', FIXTURE_NOW)).toBeNull();
    localStorage.setItem('toil-ui:splash', 'not json');
    expect(splashDataFor('card-payments', FIXTURE_NOW)).toBeNull();
  });

  it("remembers a Toil project's sprint as its page loads, forgets one with no sprint, and follows a rename", async () => {
    const d = await loadToilProject(fixtureExecute().execute, 'card-payments');
    const h = health(d.items, d.changes, FIXTURE_NOW)!;
    rememberSprint('card-payments', h);
    const kept = JSON.parse(localStorage.getItem('toil-ui:splash')!) as Record<string, unknown>;
    expect(kept['card-payments']).toEqual({ start: h.sprint.start, end: h.sprint.end, done: h.done.count });
    expect(splashDataFor('card-payments', FIXTURE_NOW)).toEqual({ toilProject: 'card-payments', day: h.days.gone, days: h.days.total, done: h.done.count });
    renameSprint('card-payments', 'payments');
    expect(splashDataFor('card-payments', FIXTURE_NOW)).toBeNull();
    expect(splashDataFor('payments', FIXTURE_NOW)?.day).toBe(h.days.gone);
    rememberSprint('payments', null);
    expect(splashDataFor('payments', FIXTURE_NOW)).toBeNull();
  });

  it("lands Realm's d20 on the sprint's day, in the holder that arrives, capped at twenty", () => {
    const splash = played('realm', DATA);
    const art = splash.querySelector('.splash__art')!;
    expect(art.tagName).toBe('SPAN');
    expect(art.querySelector('.m-face')?.textContent).toBe('7');
    expect(art.querySelector('img')?.className).toBe('');
    expect(splash.dataset).toMatchObject({ sprintDay: '7', sprintDays: '10', itemsDone: '4', toilProject: 'card-payments' });
    expect(played('realm', { ...DATA, day: 23, days: 28 }).querySelector('.m-face')?.textContent).toBe('20');
  });

  it('looks exactly as it did with no data, and a theme without a face only gets the data attributes', () => {
    const plain = played('realm', null);
    expect(plain.querySelector('.m-face')).toBeNull();
    expect(plain.querySelector('.splash__art')?.tagName).toBe('IMG');
    expect(Object.keys(plain.dataset).sort()).toEqual(['level', 'moments', 'splash']);
    const crate = played('crate', DATA);
    expect(crate.querySelector('.m-face')).toBeNull();
    expect(crate.dataset.sprintDay).toBe('7');
  });

  it("plays the remembered day on the next launch of that Toil project's page, and never on sample data", async () => {
    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme: 'realm' }));
    keep({ 'card-payments': { ...SPRINT, done: 4 } });
    window.location.hash = '#/project/card-payments';
    // A first read that never ends, so the splash plays over it.
    const slow = () => new Promise<never>(() => undefined);
    const live = render(<App execute={slow} agent={scriptedAgent()} now={FIXTURE_NOW} preview={false} />);
    await waitFor(() => expect(document.querySelector('.splash .m-face')?.textContent).toBe('7'), { timeout: 5000 });
    live.unmount();
    resetSplash();
    render(<App execute={slow} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
    await waitFor(() => expect(document.querySelector('.splash')).not.toBeNull(), { timeout: 5000 });
    expect(document.querySelector('.splash .m-face')).toBeNull();
    expect(document.querySelector<HTMLElement>('.splash')!.dataset.sprintDay).toBeUndefined();
  }, 15_000);

  it('remembers nothing from sample data', async () => {
    window.location.hash = '#/project/card-payments';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1 });
    expect(localStorage.getItem('toil-ui:splash')).toBeNull();
  });

  it('remembers the sprint of the Toil project on screen from real data', async () => {
    window.location.hash = '#/project/card-payments';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview={false} />);
    await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(splashDataFor('card-payments', FIXTURE_NOW)).not.toBeNull());
  });
});

describe('motion stays on the compositor', () => {
  it('moves only transform and opacity, in every motif the engine has', () => {
    for (const motif of ENTER_MOTIFS) for (const frame of ENTER[motif](1)) for (const key of Object.keys(frame)) expect(['transform', 'opacity', 'offset'], `${motif}: ${key}`).toContain(key);
  });

  it("animates only transform and opacity in the engine's stylesheet, inside the reduced-motion guard", () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'src', 'moments', 'moments.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const block of css.matchAll(/@keyframes [\w-]+\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) {
      for (const decl of block[1]!.matchAll(/([a-z-]+)\s*:/g)) expect(['transform', 'opacity'], block[0].slice(0, 30)).toContain(decl[1]);
    }
    // Every animation sits in the no-preference block.
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/, '');
    expect(outside).not.toMatch(/animation:\s*m-/);
  });

  it('plays every loop a theme may name, at full only', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'src', 'moments', 'moments.css'), 'utf8');
    for (const loop of LOOP_MOTIFS) expect(css, loop).toMatch(new RegExp(String.raw`:root\[data-theme-motion="full"\] \.m-loop--${loop} \{ animation: m-${loop} `));
  });

  it('covers every moment kind with plain words', () => {
    expect(Object.keys(SAMPLE_MOMENTS).sort()).toEqual([...MOMENT_KINDS].sort());
  });
});

describe('in the app', () => {
  it("previews the theme's moments from one menu under Settings, General, the loading screen as it would be", async () => {
    window.location.hash = '#/settings/appearance';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    const menu = async () => {
      await userEvent.click(await screen.findByRole('button', { name: "Preview the theme's moments" }));
      return screen.findByRole('menu');
    };
    expect(within(await menu()).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['The launch splash', 'A loading screen', 'Moment: Done', 'Moment: Build passed', 'Moment: Build failed', 'Moment: Blocker cleared', 'Moment: Merged', 'Moment: Sprint ended']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Moment: Done' }));
    expect(document.querySelector('[data-moment="item-done"]')).not.toBeNull();
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    await menu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'A loading screen' }));
    const dialog = await screen.findByRole('dialog', { name: 'Preview of a loading screen' });
    expect(within(dialog).getByRole('status').textContent).toMatch(/^Preview of a loading screen/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close the preview' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('sets Motion and toil tips under Settings, Appearance, and the one Motion setting turns everything off', async () => {
    window.location.hash = '#/settings/appearance';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Toil tips on loading screens' }));
    expect(localStorage.getItem('toil-ui.tips')).toBe('off');
    // One select where there were three controls; its stored settings keep their old keys.
    expect(screen.queryByRole('checkbox', { name: /Reduce motion/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Particles/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Motion/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Subtle' }));
    expect(localStorage.getItem('toil-ui.theme-motion')).toBe('subtle');
    expect(localStorage.getItem('toil-ui.motion')).toBe('full');
    await userEvent.click(screen.getByRole('button', { name: /Motion/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Off' }));
    expect(localStorage.getItem('toil-ui.motion')).toBe('reduced');
    expect(screen.getByText(/^Nothing moves/)).toBeTruthy();
    expect(document.documentElement.dataset.themeMotion).toBe('off');
    await userEvent.click(screen.getByRole('button', { name: "Preview the theme's moments" }));
    expect(screen.getByRole('menuitem', { name: 'Moment: Done' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: 'A loading screen' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('plays the moments of the facts a sync recorded for the first time, once', async () => {
    window.location.hash = '#/project/card-payments';
    const news = { id: '2026-10-13T08:00:00.000Z', byToilProject: [{ toilProject: 'card-payments', events: [fact({ kind: 'pr-merged', label: '#52', title: 'Vault' })] }, { toilProject: 'settlement', events: [fact({ kind: 'build-failed' })] }] };
    const { unmount } = render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview news={news} />);
    await screen.findByRole('heading', { level: 1 });
    expect(document.querySelector('[data-moment="pr-merged"]')).not.toBeNull();
    expect(document.querySelector('[data-moment="build-failed"]')).toBeNull();
    unmount();
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview news={news} />);
    await screen.findByRole('heading', { level: 1 });
    expect(document.querySelector('[data-moment]')).toBeNull();
  });
});
