/**
 * The moments engine (#419): the one player every theme's moments run on.
 * A theme only declares (src/moments/schema.ts); this file plays it:
 *
 * - **Loader**: every real wait's loading screen, shown only once the wait
 *   has lasted 300 ms. The theme's art and progress motif, the real progress
 *   text in a `role="status"` message, a rotating flavour line from the
 *   theme, and a toil tip. A theme with no loader block keeps its Loading
 *   skin, and Plain its text alone, with the tip under either.
 * - **Splash**: the launch intro, once per launch, only while the first read
 *   runs. It never adds a wait: it ends when the data is ready or on any key
 *   or click.
 * - **useEnter**: the toil project entrance and the tab transitions.
 * - **MomentsProvider**: the event moments, fired once each from the facts a
 *   sync recorded for the first time (src/moments/events.ts), one after
 *   another, each under a second; the sprint recap stays long enough to read.
 *
 * Everything moves by `transform` and `opacity` only, pauses while the tab is
 * hidden, and follows Theme motion: subtle plays less, and off plays nothing
 * (every moment an instant change, every loader its still art and the
 * progress text). Moments are decoration, hidden from screen readers: no
 * notification announces these changes (#306 notifies on agents only), so
 * neither does a moment. The facts are in the worklog.
 * The house band, which plays only on cue and never during the speeches.
 */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { HELP, helpHref } from '../help.ts';
import { useThemeMotion, type ThemeMotion } from '../motion.ts';
import { useSkins } from '../skins.tsx';
import { useTheme, useThemeChoiceContext, wordingOn } from '../theme-context.ts';
import type { ThemeManifest } from '../theme-pack.ts';
import { takeTip, useTipsOn, type Tip } from '../tips.ts';
import { assetUrl } from './assets.ts';
import { enter, leave } from './motifs.ts';
import { FLAVOUR_MS, LOADER_DELAY_MS, MOMENT_MS, MOMENT_PLAIN, RECAP_HOLD_MS, SPLASH_MAX_MS, TIP_MS, tipsLabel, type EnterMotif, type MomentArt, type MomentKind, type SplashData, type SplashMoment, type SpriteSheet, type ThemeMoments } from './schema.ts';
import './moments.css';

/** The theme's moments, or the plain defaults when it declares none. */
export const momentsOf = (theme: Pick<ThemeManifest, 'moments'>): ThemeMoments => theme.moments ?? {};

/** True once `ms` have passed since the component mounted; for waits too short to show anything. */
export function useDelayed(ms = LOADER_DELAY_MS): boolean {
  const [shown, setShown] = useState(ms <= 0);
  useEffect(() => {
    if (ms <= 0) return;
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return shown;
}

/** Whether the tab is hidden now, mirrored on the root as `data-page-hidden` so CSS pauses what CSS plays. */
export function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    const on = () => {
      setHidden(document.hidden);
      if (document.hidden) document.documentElement.dataset.pageHidden = '';
      else delete document.documentElement.dataset.pageHidden;
      // A Web Animation a moment started holds still while nobody can see it, and carries on from there.
      for (const a of document.getAnimations?.() ?? []) {
        const target = (a.effect as KeyframeEffect | null)?.target;
        if (!target?.closest?.('[data-moments]')) continue;
        if (document.hidden) a.pause();
        else if (a.playState === 'paused') a.play();
      }
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return hidden;
}

/** Calls `fn` every `ms` while the tab is visible; stops while it's hidden. */
function useEvery(ms: number, fn: () => void, on = true) {
  const hidden = usePageHidden();
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!on || hidden) return;
    const t = setInterval(() => latest.current(), ms);
    return () => clearInterval(t);
  }, [ms, on, hidden]);
}

/**
 * A moment's art: a picture, or a sprite sheet stepped by moving its strip. Decoration, so it has no text.
 *
 * The element with `className` is the one the engine plays an arrival on (`enter`), so a loop never goes
 * on it: a looping picture sits inside a holder span and loops there, as a sprite sheet's strip already
 * did. Two animations of `transform` on one element can't both run on the compositor, so Chrome moves
 * both to the main thread (#451); one each, on a parent and a child, stays composited. A `face`, a number
 * written on the picture (#462), sits in the same holder, so it arrives with the picture and never moves
 * on its own.
 */
export function Art({ theme, art, className, loop, face = null }: { theme: ThemeManifest; art: MomentArt | SpriteSheet; className?: string; loop?: string | undefined; face?: string | null }) {
  const url = assetUrl(theme, art.art);
  if (!url) return null;
  const frames = 'frames' in art ? art.frames : 1;
  if (frames > 1) {
    return (
      <span className={`m-art m-sheet ${className ?? ''}`} style={{ width: art.width, height: art.height, ['--m-frames' as string]: frames }} aria-hidden="true">
        <img className={loop === 'frames' ? 'm-loop--frames' : undefined} src={url} alt="" width={art.width * frames} height={art.height} decoding="async" />
        {face !== null && <span className="m-face">{face}</span>}
      </span>
    );
  }
  if (loop || face !== null) {
    return (
      <span className={`m-art m-hold ${className ?? ''}`} aria-hidden="true">
        <img className={loop ? `m-loop--${loop}` : undefined} src={url} alt="" width={art.width} height={art.height} decoding="async" />
        {face !== null && <span className="m-face">{face}</span>}
      </span>
    );
  }
  return <img className={`m-art ${className ?? ''}`} src={url} alt="" width={art.width} height={art.height} decoding="async" aria-hidden="true" />;
}

/** The tip under a loading screen: the theme's label, the tip's own plain words, and its Read more link. */
function TipLine({ tip, label }: { tip: Tip; label: string }) {
  const topic = HELP[tip.topic];
  return (
    <p className="loader-tip" data-tip={tip.id}>
      <span className="loader-tip__label">{label}</span> <span className="loader-tip__text">{tip.text}</span>{' '}
      <a href={helpHref(topic)} target="_blank" rel="noopener noreferrer" data-tip-more="">
        Read more<span className="sr-only"> about {topic.title} in the docs (opens in a new tab)</span>
      </a>
    </p>
  );
}

/** The tip on screen now, changed every few seconds while the wait lasts, never one already seen this session until all have been. */
function useTip(on: boolean): Tip | null {
  const [tip, setTip] = useState<Tip | null>(() => (on ? takeTip() : null));
  useEffect(() => {
    if (on && !tip) setTip(takeTip());
  }, [on, tip]);
  useEvery(TIP_MS, () => setTip(takeTip()), on);
  return on ? tip : null;
}

/** The theme's flavour lines, one at a time, while themed wording is on. */
function useFlavour(lines: string[] | undefined): string | null {
  const [i, setI] = useState(0);
  useEvery(FLAVOUR_MS, () => setI((n) => n + 1), Boolean(lines && lines.length > 1));
  return lines && lines.length ? lines[i % lines.length]! : null;
}

export interface LoaderProps {
  /** What is being waited for, in the view's words: "Reading card-payments…". */
  message: string;
  /** The real progress, when there is some: what toil is reading and the counts. */
  detail?: string | null;
  /** `view` fills the view and carries a tip; `panel` sits in a panel; `inline` is a line in a chat bubble. */
  size?: 'view' | 'panel' | 'inline';
  /** False where another live region already says the progress (the chat's status line), so it isn't announced twice. */
  live?: boolean;
  /** Skip the 300 ms wait (a preview of the loader). */
  immediate?: boolean;
}

/**
 * The loading screen for a real wait. Nothing at all for the first 300 ms, so
 * a quick read never flashes one; then the theme's loader, or its Loading
 * skin, with the progress text and, at view size, a tip.
 */
export function Loader({ message, detail = null, size = 'view', live = true, immediate = false }: LoaderProps) {
  const shown = useDelayed(immediate ? 0 : LOADER_DELAY_MS);
  const theme = useTheme();
  const choice = useThemeChoiceContext();
  const level = useThemeMotion();
  const { Loading } = useSkins();
  const [tipsOn] = useTipsOn();
  const m = momentsOf(theme);
  const words = wordingOn(theme, choice);
  const flavour = useFlavour(words ? m.loader?.flavour : undefined);
  const tip = useTip(tipsOn && size === 'view' && shown);
  const text = detail ? `${message} ${detail}` : message;
  // Until the wait is long enough to show, an empty box holds the place, so nothing jumps when it appears.
  if (!shown) return <div className={`loader loader--${size} loader--pending`} aria-hidden="true" data-loading="" />;
  if (size === 'inline') {
    return (
      <div className="loader loader--inline" data-moments="" data-level={level} data-loading="">
        {m.loader && <Track theme={theme} m={m} />}
        <p className="note" {...(live ? { role: 'status' } : {})}>
          {text}
        </p>
      </div>
    );
  }
  if (!m.loader) {
    return (
      <div className={`loader loader--${size} loader--skin`} data-moments="" data-level={level} data-loading="">
        <Loading message={text} />
        {tip && <TipLine tip={tip} label={tipsLabel(m)} />}
      </div>
    );
  }
  return (
    <div className={`loader loader--${size} loader--themed`} data-moments="" data-level={level} data-loader={theme.name} data-loading="">
      <div className="loader__stage" aria-hidden="true">
        <Art theme={theme} art={m.loader.art} className="loader__art" loop={m.loader.loop} />
        <Track theme={theme} m={m} />
      </div>
      <p className="loader__progress" {...(live ? { role: 'status' } : {})}>
        {text}
      </p>
      {flavour && size === 'view' && (
        <p className="loader__flavour" aria-hidden="true">
          {flavour}
        </p>
      )}
      {tip && <TipLine tip={tip} label={tipsLabel(m)} />}
    </div>
  );
}

/** The progress motif: a row of small pieces the motif moves in turn. */
function Track({ theme, m }: { theme: ThemeManifest; m: ThemeMoments }) {
  const t = m.loader?.track;
  const url = t ? assetUrl(theme, t.art) : null;
  if (!t || !url) return null;
  return (
    <span className={`loader__track m-track--${t.motif}`} aria-hidden="true" style={{ ['--m-count' as string]: t.count }}>
      {Array.from({ length: t.count }, (_, i) => (
        <img key={i} src={url} alt="" width={t.size} height={t.size} style={{ ['--m-i' as string]: i }} />
      ))}
    </span>
  );
}

/** The number a splash's face shows (#462): the value it names, capped at its `max`; null, and the art as drawn, without one. */
export function faceOf(splash: Pick<SplashMoment, 'face'>, data: SplashData | null): string | null {
  if (!splash.face || !data) return null;
  const value = splash.face.value === 'sprint-day' ? data.day : data.done;
  return String(Math.min(splash.face.max ?? Infinity, value));
}

/** The splash's values as data attributes, for a theme's CSS: plain numbers and a name, nothing it could run. */
const dataAttributes = (data: SplashData | null) => (data ? { 'data-sprint-day': data.day, 'data-sprint-days': data.days, 'data-items-done': data.done, 'data-toil-project': data.toilProject } : {});

/** The splash plays once per launch, however often the App remounts after a sync. */
let launched = false;
/** Forgets that the splash played. For tests. */
export function resetSplash() {
  launched = false;
}

/**
 * The launch splash, over the page while the first read runs. Shown only once
 * that read has taken 300 ms, ended the moment it's done, by any key or click,
 * or after its 1.8 seconds, when the view's own loader carries on. A theme
 * with no splash, or Theme motion off, has none: the loader covers the wait.
 * `preview` holds it until a key or click, for Settings and the checks.
 * `data` is what it may know of the toil project opening (#462, src/moments/splash-data.ts): with none, the
 * splash is exactly as it was.
 */
export function Splash({ ready, detail = null, data = null, preview = false, onDone }: { ready: boolean; detail?: string | null; data?: SplashData | null; preview?: boolean; onDone?: () => void }) {
  const theme = useTheme();
  const level = useThemeMotion();
  const m = momentsOf(theme);
  const [first] = useState(() => {
    if (preview) return true;
    const was = launched;
    launched = true;
    return !was;
  });
  const shown = useDelayed(preview ? 0 : LOADER_DELAY_MS);
  const [over, setOver] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [tipsOn] = useTipsOn();
  const playing = first && !over && Boolean(m.splash) && level !== 'off' && (preview || !ready);
  const tip = useTip(tipsOn && shown && playing);

  const end = useCallback(() => {
    setOver(true);
    onDone?.();
  }, [onDone]);

  useEffect(() => {
    if (!playing || preview) return;
    const t = setTimeout(end, SPLASH_MAX_MS);
    return () => clearTimeout(t);
  }, [playing, preview, end]);
  useEffect(() => {
    if (!playing) return;
    const skip = () => end();
    window.addEventListener('keydown', skip, true);
    return () => window.removeEventListener('keydown', skip, true);
  }, [playing, end]);
  useLayoutEffect(() => {
    if (playing && shown) enter(box.current?.querySelector('.splash__art') ?? null, m.splash?.motif, level, 520);
  }, [playing, shown, m.splash?.motif, level]);

  if (!playing || !shown || !m.splash) return null;
  return (
    <div className="splash" data-moments="" data-level={level} data-splash={theme.name} {...dataAttributes(data)} ref={box} onPointerDown={end}>
      <div className="splash__inner">
        <Art theme={theme} art={m.splash.art} className="splash__art" loop={level === 'full' ? m.splash.loop : undefined} face={faceOf(m.splash, data)} />
        <p className="splash__name" aria-hidden="true">
          <span className="wordmark">toil</span> <span className="splash__ui">UI</span>
        </p>
        <p className="splash__line" aria-hidden="true">
          {m.splash.line}
        </p>
        <p className="splash__progress" role="status">
          {preview ? 'Preview of the launch splash. Press any key or click to close it.' : `Starting Toil UI. ${detail ?? 'Reading the Toil projects…'}`}
        </p>
        {tip && <TipLine tip={tip} label={tipsLabel(m)} />}
      </div>
    </div>
  );
}

/**
 * Plays a one-shot motif on an element when `key` changes (and, with
 * `onMount`, when it first appears): the toil project entrance and the tab
 * transitions. Off plays nothing.
 */
export function useEnter(ref: RefObject<HTMLElement | null>, motif: EnterMotif | undefined, key: string, { onMount = true, ms = 320 } = {}) {
  const level = useThemeMotion();
  const first = useRef(true);
  useLayoutEffect(() => {
    const mount = first.current;
    first.current = false;
    if (mount && !onMount) return;
    enter(ref.current, motif, level, ms);
    // Only a new key plays it again; a change of level mid-way doesn't.
  }, [key]);
}

// Event moments ----------------------------------------------------------------------

/** One moment to play: its kind, the plain fact it marks, and how many it stands for. */
export interface Moment {
  kind: MomentKind;
  /** The fact in plain words: "PAY-102 Store tokens in the vault". */
  text: string;
  /** For a moment that stands for several of the same kind. */
  count: number;
  /** For the sprint recap: its figures, in plain words. */
  figures?: string[];
}

interface Player {
  play(moments: Moment[]): void;
}
const PlayerContext = createContext<Player>({ play: () => undefined });
export const useMomentPlayer = () => useContext(PlayerContext);

/** Holds the queue of event moments and plays them one at a time over the page, never while the tab is hidden. */
export function MomentsProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Array<{ id: number; moment: Moment }>>([]);
  const ids = useRef(0);
  const level = useThemeMotion();
  const hidden = usePageHidden();
  const live = useRef(level);
  live.current = level;
  const play = useCallback((moments: Moment[]) => {
    // Off: the change is already on the page, so there is nothing to play.
    if (live.current === 'off' || !moments.length) return;
    setQueue((q) => [...q, ...moments.map((moment) => ({ id: ids.current++, moment }))].slice(0, 6));
  }, []);
  const value = useMemo(() => ({ play }), [play]);
  const now = !hidden && level !== 'off' ? queue[0] : undefined;
  const next = useCallback(() => setQueue((q) => q.slice(1)), []);
  useEffect(() => {
    if (level === 'off') setQueue([]);
  }, [level]);
  return (
    <PlayerContext value={value}>
      {children}
      {now && <MomentCard key={now.id} moment={now.moment} level={level} onDone={next} />}
    </PlayerContext>
  );
}

function MomentCard({ moment, level, onDone }: { moment: Moment; level: ThemeMotion; onDone: () => void }) {
  const theme = useTheme();
  const choice = useThemeChoiceContext();
  const m = momentsOf(theme);
  const spec = m.events?.[moment.kind];
  const card = useRef<HTMLDivElement>(null);
  const recap = moment.kind === 'sprint-ended';
  const plain = MOMENT_PLAIN[moment.kind];
  const label = wordingOn(theme, choice) ? (recap ? (m.recap?.label ?? spec?.label) : spec?.label) : undefined;

  useLayoutEffect(() => {
    if (!spec) {
      onDone();
      return;
    }
    const inMs = recap ? 360 : 300;
    const outMs = recap ? 240 : 200;
    const hold = recap ? RECAP_HOLD_MS : MOMENT_MS - inMs - outMs;
    enter(card.current, spec.motif, level, inMs);
    enter(card.current?.querySelector('.moment__art') ?? null, spec.motif === 'stamp' ? 'stamp' : 'pop', level, inMs + 80);
    let fade: Animation | null = null;
    const t = setTimeout(() => {
      fade = leave(card.current, level, outMs);
      if (fade) fade.onfinish = onDone;
      else onDone();
    }, inMs + hold);
    return () => {
      clearTimeout(t);
      fade?.cancel();
    };
    // Played once, as it mounts.
  }, []);

  if (!spec) return null;
  return (
    <div className={`moment moment--${moment.kind}${recap ? ' moment--recap' : ''}`} ref={card} data-moments="" data-moment={moment.kind} data-level={level} aria-hidden="true">
      <Art theme={theme} art={spec} className="moment__art" />
      <div className="moment__words">
        <p className="moment__label">
          <strong>{label && label.toLowerCase() !== plain.toLowerCase() ? `${label} (${plain})` : plain}</strong>
          {moment.count > 1 ? <span className="moment__count"> ×{moment.count}</span> : null}
        </p>
        <p className="moment__text">{moment.text}</p>
        {recap && moment.figures && (
          <ul className="moment__figures">
            {moment.figures.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
