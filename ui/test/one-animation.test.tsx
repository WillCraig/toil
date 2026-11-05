import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { SAMPLE_MOMENTS } from '../src/moments/events.ts';
import { Loader, MomentsProvider, resetSplash, Splash, useMomentPlayer } from '../src/moments/Moments.tsx';
import { MOMENT_KINDS } from '../src/moments/schema.ts';
import { resetMotionChoice, resetThemeMotion } from '../src/motion.ts';
import { SkinProvider, ThemeChoiceProvider, ThemeProvider, skinsFor } from '../src/skins.tsx';
import type { ThemeChoiceState } from '../src/theme-choice.ts';
import { THEMES, themeNamed } from '../src/themes.ts';

/**
 * One animation to an element (#451). The engine plays a moment's arrival as a
 * Web Animation on one element; a loop, the engine's or a theme's, is a CSS
 * animation. When both animate one element, Chrome can't run either on the
 * compositor and moves both to the main thread, which is how Crate's splash
 * dropped frames. This plays every arrival every theme has (the splash, each
 * event moment, the toil project entrance and a tab change) and fails if the
 * element it lands on carries a loop, or is matched by any rule in the app's
 * or the theme's stylesheets that starts an animation; and it fails if a
 * looping part of the splash or a loader is matched by more than its one rule.
 * Two departments may not be responsible for the same box; this is the audit.
 */

const ui = join(import.meta.dirname, '..');

/** Every stylesheet a theme's page loads: the app's own, then the theme's. */
function sheetsFor(theme: string): Array<{ file: string; css: string }> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith('.css')) files.push(join(dir, e.name));
    }
  };
  walk(join(ui, 'src'));
  files.push(join(ui, 'themes', theme, 'theme.css'));
  return files.map((file) => ({ file: file.slice(ui.length + 1).replace(/\\/g, '/'), css: readFileSync(file, 'utf8') }));
}

/** Splits a selector list at its top-level commas, leaving the ones inside :is() or :not() alone. */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Every rule that starts an animation, as its list of selectors, outside @keyframes and
 * from inside any @media too (as if motion were allowed). A pseudo-element is a box of
 * its own, never the element the engine moves, so those selectors are left out.
 */
function animatingRules(css: string): string[][] {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const out: string[][] = [];
  for (const rule of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(?:^|[;\s])animation(?:-name)?\s*:\s*(?!none\b)[^\s;]/.test(rule[2]!)) continue;
    const selectors = splitSelectors(rule[1]!).filter((s) => !/::|:(?:before|after)\b/.test(s));
    if (selectors.length) out.push(selectors);
  }
  return out;
}

const choice = (theme: string): ThemeChoiceState => ({ theme, scheme: 'system', wording: true, voice: true, saveError: null, setTheme: () => undefined, setScheme: () => undefined, setWording: () => undefined, setVoice: () => undefined });

/**
 * Every element the engine plays an arrival on while `body` runs, with a stand-in for Web Animations
 * (jsdom has none), and what `probe` found on each at that moment, while it is still in the page:
 * a detached element has no `<html data-theme>` above it, so a theme's scoped rules couldn't match it.
 */
async function arrivals(body: () => Promise<void>, probe: (el: HTMLElement) => string[]): Promise<Array<{ el: HTMLElement; found: string[] }>> {
  const targets: Array<{ el: HTMLElement; found: string[] }> = [];
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value(this: HTMLElement, _frames: Keyframe[], options: KeyframeAnimationOptions) {
      targets.push({ el: this, found: this.isConnected ? probe(this) : ['was animated while out of the page, so it could not be checked'] });
      // A finished animation calls its onfinish, so a moment's fade ends and the next one plays.
      const anim = { onfinish: null as null | (() => void), cancel: () => clearTimeout(timer) };
      const timer = setTimeout(() => anim.onfinish?.(), Number(options.duration ?? 0));
      return anim;
    },
  });
  try {
    await body();
  } finally {
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  }
  return targets;
}

function PlayAll() {
  const player = useMomentPlayer();
  return <button onClick={() => player.play(MOMENT_KINDS.map((k) => SAMPLE_MOMENTS[k]))}>play</button>;
}

const describeEl = (el: Element) => `<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}">`;

/** Every stylesheet rule that starts an animation on an element, by its file and the selector that matched. */
function cssAnimationsOn(el: Element, sheets: Array<{ file: string; css: string }>): string[] {
  const out: string[] = [];
  for (const { file, css } of sheets) {
    for (const rule of animatingRules(css)) {
      const hit = rule.find((sel) => el.matches(sel));
      if (hit) out.push(`${file}: ${hit}`);
    }
  }
  return out;
}

/** What else animates an element the engine plays an arrival on: a loop class, or any stylesheet rule. */
function secondAnimations(el: Element, sheets: Array<{ file: string; css: string }>): string[] {
  return [...[...el.classList].filter((c) => c.startsWith('m-loop--')).map((c) => `the loop class ${c}`), ...cssAnimationsOn(el, sheets)];
}

/** The looping parts on screen (a loop, a sprite sheet's strip, a progress track's pieces), each with more than its one rule. */
function doubledLoops(sheets: Array<{ file: string; css: string }>): string[] {
  const out: string[] = [];
  for (const el of document.querySelectorAll('[class*="m-loop--"], .loader__track img')) {
    const rules = cssAnimationsOn(el, sheets);
    if (rules.length > 1) out.push(`${describeEl(el)} is animated by ${rules.join(' and ')}`);
  }
  return out;
}

const withMoments = THEMES.filter((t) => t.moments).map((t) => t.name);

const { matchMedia } = window;

beforeEach(() => {
  // Motion allowed: the OS asks for no reduction, so Theme motion full plays everything.
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
  localStorage.clear();
  sessionStorage.clear();
  resetMotionChoice();
  resetThemeMotion();
  resetSplash();
});

afterEach(() => {
  window.matchMedia = matchMedia;
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

describe('one animation to an element (#451)', () => {
  it('finds the rules that start an animation, inside @media, and not the ones that stop one', () => {
    const css = `/* a { animation: x 1s; } */
      @media (prefers-reduced-motion: no-preference) { :root[data-a] .b, .c::after { animation: x 1s infinite; } }
      .d { animation: none; } .e { transition: opacity 1s; } .f { animation-name: y; }
      @keyframes x { from { opacity: 0; } to { opacity: 1; } }`;
    expect(animatingRules(css)).toEqual([[':root[data-a] .b'], ['.f']]);
  });

  it.each(withMoments)('%s: no arrival lands on an element that loops, and no loop shares its element', async (name) => {
    const sheets = sheetsFor(name);
    const root = document.documentElement;
    // The root's attributes are the ones a theme's rules are scoped to, at Theme motion full.
    const scope = () => {
      root.dataset.theme = name;
      root.dataset.themeMotion = 'full';
    };
    scope();
    const problems: string[] = [];
    const probe = (el: HTMLElement) => {
      scope();
      return secondAnimations(el, sheets);
    };
    const check = (where: string, targets: Array<{ el: HTMLElement; found: string[] }>) => {
      expect(targets.length, `${where} played no arrival`).toBeGreaterThan(0);
      for (const { el, found } of targets) for (const p of found) problems.push(`${where}: ${describeEl(el)} also has ${p}`);
    };

    // The launch splash, held as its preview holds it.
    const theme = themeNamed(name);
    const wrap = (node: React.ReactNode) => (
      <ThemeProvider value={theme}>
        <ThemeChoiceProvider value={choice(name)}>
          <SkinProvider value={skinsFor(name)}>
            <MomentsProvider>{node}</MomentsProvider>
          </SkinProvider>
        </ThemeChoiceProvider>
      </ThemeProvider>
    );
    // With no data, and on a sprint's day (#462), when a face rides in the holder that arrives.
    for (const [where, data] of [['the splash', null], ["the splash on a sprint's day", { toilProject: 'card-payments', day: 7, days: 10, done: 4 }]] as const) {
      let shown: HTMLElement[] = [];
      check(where, await arrivals(async () => {
        const r = render(wrap(<Splash ready={false} data={data} preview />));
        shown = [...document.querySelectorAll<HTMLElement>('.splash *')];
        scope();
        problems.push(...doubledLoops(sheets).map((p) => `${where}: ${p}`));
        r.unmount();
      }, probe));
      expect(shown.length).toBeGreaterThan(0);
    }

    // A loading screen: it has no arrival, but each of its loops must be the only animation on its element.
    {
      const r = render(wrap(<Loader immediate message="Reading card-payments…" />));
      root.dataset.theme = name;
      root.dataset.themeMotion = 'full';
      expect(document.querySelectorAll('[data-loading] [class*="m-loop--"], [data-loading] .loader__track img').length, 'the loader has no loop').toBeGreaterThan(0);
      problems.push(...doubledLoops(sheets).map((p) => `the loader: ${p}`));
      r.unmount();
    }

    // Every event moment, one after another as a sync's news plays them.
    vi.useFakeTimers();
    check('the event moments', await arrivals(async () => {
      const r = render(wrap(<PlayAll />));
      act(() => screen.getByRole('button', { name: 'play' }).click());
      const seen = new Set<string>();
      for (let i = 0; i < 40 && seen.size < MOMENT_KINDS.filter((k) => theme.moments?.events?.[k]).length; i++) {
        const now = document.querySelector('[data-moment]')?.getAttribute('data-moment');
        if (now) seen.add(now);
        act(() => vi.advanceTimersByTime(500));
      }
      expect([...seen].sort()).toEqual(MOMENT_KINDS.filter((k) => theme.moments?.events?.[k]).sort());
      r.unmount();
    }, probe));
    vi.useRealTimers();

    // The toil project entrance, then a tab change.
    window.history.replaceState(null, '', `/?theme=${name}#/project/card-payments`);
    check('the Toil project entrance and a tab change', await arrivals(async () => {
      render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
      await screen.findByRole('heading', { level: 1 });
      await act(async () => {
        window.location.hash = '#/project/card-payments/board';
        await new Promise((r) => setTimeout(r, 50));
      });
    }, probe));

    expect(problems).toEqual([]);
  });
});
