/**
 * Theme moments (#419): what a theme may declare in its `theme.json` under
 * `"moments"`, and the plain defaults a theme without the block gets. A theme
 * only declares; the one engine in this folder plays it (the splash, the
 * loading screens, the toil project entrance, the tab transitions and the event
 * moments), so no theme writes a player of its own.
 *
 * Everything a moment shows is named here as data: an asset by its key in the
 * theme's `assets`, a motion by its motif name from the fixed lists below, and
 * words as plain text. The engine's motifs move only `transform` and
 * `opacity` (src/moments/moments.css), so a theme can't ask for an animation
 * that repaints the page. Plain data with no imports, so the docs and the
 * tests can read it as it is.
 * The choreography is approved in advance and filed under "moments".
 */

/** A one-shot motion: how a splash, an entrance, a tab or an event moment arrives. */
export const ENTER_MOTIFS = ['fade', 'rise', 'drop', 'pop', 'slide', 'stamp', 'sweep', 'grow'] as const;
export type EnterMotif = (typeof ENTER_MOTIFS)[number];

/** A looping motion, for a loader's art while the wait lasts. `frames` steps through a sprite sheet; `tumble` turns the art a full turn and lets it settle, as a die rolls (#440). */
export const LOOP_MOTIFS = ['bob', 'sway', 'roll', 'pulse', 'tumble', 'frames'] as const;
export type LoopMotif = (typeof LOOP_MOTIFS)[number];

/** The progress motif under a loader's art: `march` slides the pieces along a track, `grow` raises each in turn, `blink` lights each in turn. */
export const TRACK_MOTIFS = ['march', 'grow', 'blink'] as const;
export type TrackMotif = (typeof TRACK_MOTIFS)[number];

/** The state changes that fire a moment, each from a fact the worklog records (src/model/worklog.ts). */
export const MOMENT_KINDS = ['item-done', 'build-passed', 'build-failed', 'blocker-cleared', 'pr-merged', 'sprint-ended'] as const;
export type MomentKind = (typeof MOMENT_KINDS)[number];

/** The plain words each moment says, in every theme and with themed wording off. */
export const MOMENT_PLAIN: Record<MomentKind, string> = {
  'item-done': 'Done',
  'build-passed': 'Build passed',
  'build-failed': 'Build failed',
  'blocker-cleared': 'Blocker cleared',
  'pr-merged': 'Merged',
  'sprint-ended': 'Sprint ended',
};

/** A picture from the theme's `assets`, by key, with the size it is drawn at in CSS pixels. */
export interface MomentArt {
  /** A key of the theme's `assets`, never a path: the asset list stays the one record of what the theme ships. */
  art: string;
  width: number;
  height: number;
}

/** A sprite sheet: frames side by side in one image, stepped through by moving the strip, never by repainting it. */
export interface SpriteSheet extends MomentArt {
  /** How many frames sit side by side; `width` is one frame's. */
  frames: number;
}

/**
 * The plain values a splash may be handed (#462), when the engine knows them: the sprint's day and
 * length, the items done in it and the toil project's name. Numbers and a name, never markup or code; they
 * reach a theme only as a face's text and as data attributes on the splash (`data-sprint-day`,
 * `data-sprint-days`, `data-items-done`, `data-toil-project`).
 */
export interface SplashData {
  toilProject: string;
  /** The sprint's working day, from 1: "day 7 of 10". */
  day: number;
  days: number;
  /** Items done in the sprint. */
  done: number;
}

/** Which of the splash's values a face shows. */
export const FACE_VALUES = ['sprint-day', 'items-done'] as const;
export type FaceValue = (typeof FACE_VALUES)[number];

export interface SplashMoment {
  /** The art the splash holds while the first read runs. */
  art: MomentArt | SpriteSheet;
  motif: EnterMotif;
  /** A loop for the art once it has arrived, while the wait lasts. */
  loop?: LoopMotif;
  /** One line under the name, plain text: the theme's own greeting. */
  line: string;
  /**
   * A number written on the art, which arrives with it (#462): one of the splash's values, capped at
   * `max` (a d20's day 23 shows 20). Shown only when the engine has the value; without it the art
   * shows as drawn.
   */
  face?: { value: FaceValue; max?: number };
}

export interface LoaderMoment {
  art: MomentArt | SpriteSheet;
  loop: LoopMotif;
  /** The progress motif: `count` copies of `art`, moved by `motif`, under the main art. */
  track: { art: string; size: number; count: number; motif: TrackMotif };
  /** Flavour lines, rotated while the wait lasts: plain text, never instead of the progress text. */
  flavour: string[];
}

export interface EventMoment extends MomentArt {
  motif: EnterMotif;
  /** The theme's word for it, shown beside the plain one (MOMENT_PLAIN), never instead of it. */
  label: string;
}

export interface ThemeMoments {
  /** The launch splash. Absent: none. */
  splash?: SplashMoment;
  /** The loading screens. Absent: the theme's Loading skin (Plain's is its text alone). */
  loader?: LoaderMoment;
  /** How toil tips are framed on a loading screen: only the label. Absent: "Tip". */
  tips?: { label: string };
  /** How a toil project arrives when it opens. Absent: it simply appears. */
  entrance?: EnterMotif;
  /** How a toil project's tab arrives when you change tabs. Absent: it simply appears. */
  tabs?: EnterMotif;
  /** One moment per state change. A kind left out plays nothing. */
  events?: Partial<Record<MomentKind, EventMoment>>;
  /** The sprint-end recap card's heading, beside "Sprint ended". */
  recap?: { label: string };
}

/** What a theme with no `moments` block gets: a plain loader with the progress text and tips, and nothing else (#419). */
export const PLAIN_MOMENTS: ThemeMoments = {};

/** The tips label for a theme: its own, or the plain one. */
export const tipsLabel = (m: ThemeMoments | undefined) => m?.tips?.label ?? 'Tip';

/** How long a wait must last before a loader shows (#419): anything quicker shows nothing at all. */
export const LOADER_DELAY_MS = 300;
/** How often the tip changes while a wait lasts. */
export const TIP_MS = 6000;
/** How often the flavour line changes. */
export const FLAVOUR_MS = 3000;
/** The longest a splash plays before it hands over to the loader, if the read is still running. */
export const SPLASH_MAX_MS = 1800;
/** Every event moment, in and out: under a second. */
export const MOMENT_MS = 900;
/** The sprint recap card stays this long after arriving, so its figures can be read. */
export const RECAP_HOLD_MS = 5000;
