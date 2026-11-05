import type { WelcomeData } from './screens.js';
import { wordmarkFrame } from './splash.js';
import { fitLine, pal, paint, type TermCaps, wrapLine } from './term.js';
import { type Action, type Frame, type Game, healthOf, type Item, type Run, type Session, type StepResult, type View, type ViewProps } from './view.js';
import { VIEWS } from './views/index.js';

/**
 * The main menu as a small state machine: `reduce(state, key, data)` returns
 * the next state, `finish(state, results)` records what a run returned, and
 * `render(state, ...)` returns the lines to draw. None of them touch the
 * terminal or run anything, so the whole menu is testable as data, and the
 * loop that does touch the terminal (index.ts) only draws, reads keys and
 * runs the commands a state asks for. The rare phone tree that never says
 * "please listen carefully, as our options have changed".
 */

export interface MenuState {
  /** The screens open, home first; esc goes back one. */
  stack: Frame[];
  session: Session;
  /** Set when the user quits. */
  quit?: boolean;
  /** Commands the loop should run next, then report with `finish`. */
  pending?: Run;
  /** The game the loop should hand the terminal to next, then report with `played`. */
  playing?: Game;
  /** The last letters typed on the home screen, for the word that isn't on the menu. */
  typed?: string;
}

/** The word that opens Two Weeks' Notice from the home screen. It is not on the menu, and HR would rather you didn't know it. */
export const SECRET = 'resign';

export interface Key {
  name?: string | undefined;
  sequence?: string | undefined;
  ctrl?: boolean | undefined;
  meta?: boolean | undefined;
}

const frame = (view: string, params: Record<string, string> = {}): Frame => ({ view, selected: 0, params });

export const initialState: MenuState = { stack: [frame('home')], session: { health: {} } };

export const top = (state: MenuState): Frame => state.stack[state.stack.length - 1]!;

const viewOf = (f: Frame): View => {
  const view = VIEWS[f.view];
  if (!view) throw new Error(`The menu has no view named "${f.view}".`);
  return view;
};

const propsOf = (state: MenuState, data: WelcomeData): ViewProps => ({ data, session: state.session, frame: top(state) });

const replaceTop = (state: MenuState, f: Frame): MenuState => ({ ...state, stack: [...state.stack.slice(0, -1), f] });

const pop = (state: MenuState): MenuState => (state.stack.length > 1 ? { ...state, stack: state.stack.slice(0, -1) } : state);

const isBack = (key: Key) => key.name === 'escape' || key.name === 'left';
const isEnter = (key: Key) => key.name === 'return' || key.name === 'enter';

export function reduce(state: MenuState, key: Key, data: WelcomeData): MenuState {
  const f = top(state);
  const view = viewOf(f);
  const p = propsOf(state, data);

  if (f.view === 'home') {
    const ch = key.sequence && /^[a-z]$/.test(key.sequence) && !key.ctrl && !key.meta ? key.sequence : '';
    const typed = ch ? ((state.typed ?? '') + ch).slice(-SECRET.length) : '';
    if (typed === SECRET) return { ...state, typed: '', playing: 'rogue' };
    state = { ...state, typed };
  }

  // A text field takes every printable key, q included; esc still goes back.
  if (view.input) {
    const text = f.text ?? view.input.initial?.(p) ?? '';
    if (key.name === 'escape') return pop(state);
    if (isEnter(key)) {
      const outcome = view.input.submit(text.trim(), p);
      if ('error' in outcome) return replaceTop(state, { ...f, text, error: outcome.error });
      return apply(replaceTop(state, { ...f, text, error: undefined }), outcome);
    }
    if (key.name === 'backspace') return replaceTop(state, { ...f, text: [...text].slice(0, -1).join(''), error: undefined });
    const ch = key.sequence;
    if (ch && !key.ctrl && !key.meta && [...ch].length === 1 && ch >= ' ' && ch !== '\x7f') return replaceTop(state, { ...f, text: text + ch, error: undefined });
    return state;
  }

  // Ctrl+C is the loop's to handle (twice to exit); q quits from anywhere else.
  if (key.name === 'q' && !key.ctrl) return { ...state, quit: true };
  if (isBack(key) || key.name === 'backspace') return pop(state);

  if (view.checklist) {
    const options = view.checklist.options(p);
    const n = options.length;
    if (n === 0) return isEnter(key) ? apply(state, view.checklist.confirm([], p)) : state;
    const checked = new Set(f.checked ?? view.checklist.initial?.(p) ?? []);
    if (key.name === 'up' || key.name === 'k') return replaceTop(state, { ...f, selected: (f.selected - 1 + n) % n });
    if (key.name === 'down' || key.name === 'j') return replaceTop(state, { ...f, selected: (f.selected + 1) % n });
    if (key.name === 'space') {
      const id = options[Math.min(f.selected, n - 1)]!.id;
      if (checked.has(id)) checked.delete(id);
      else checked.add(id);
      return replaceTop(state, { ...f, checked: options.map((o) => o.id).filter((o) => checked.has(o)) });
    }
    if (isEnter(key) || key.name === 'right') return apply(state, view.checklist.confirm(options.map((o) => o.id).filter((o) => checked.has(o)), p));
    return state;
  }

  const items = view.items?.(p) ?? [];
  const n = items.length;
  if (n === 0) return isEnter(key) ? pop(state) : state;
  const selected = Math.min(f.selected, n - 1);
  if (key.name === 'up' || key.name === 'k') return replaceTop(state, { ...f, selected: (selected - 1 + n) % n });
  if (key.name === 'down' || key.name === 'j') return replaceTop(state, { ...f, selected: (selected + 1) % n });
  const digit = key.sequence && /^[1-9]$/.test(key.sequence) ? Number(key.sequence) - 1 : -1;
  if (digit >= 0 && digit < n) return choose(replaceTop(state, { ...f, selected: digit }), items[digit]!);
  if (isEnter(key) || key.name === 'right') return choose(replaceTop(state, { ...f, selected }), items[selected]!);
  return state;
}

function choose(state: MenuState, item: Item): MenuState {
  // A result screen is read once: whatever comes next replaces it.
  if (top(state).view === 'result') return item.action && 'back' in item.action ? pop(state) : apply(pop(state), item.action);
  return apply(state, item.action);
}

export function apply(state: MenuState, action: Action): MenuState {
  if ('quit' in action) return { ...state, quit: true };
  if ('back' in action) return pop(state);
  if ('run' in action) return { ...state, pending: action.run };
  if ('play' in action) return { ...state, playing: action.play };
  let stack = state.stack;
  if (action.root) {
    const at = stack.map((f) => f.view).lastIndexOf(action.root);
    stack = at >= 0 ? stack.slice(0, at + 1) : [stack[0]!, frame(action.root)];
  }
  if (action.go !== action.root) stack = [...stack, frame(action.go, action.params)];
  return { ...state, stack };
}

/** Records what a run returned: the health of every connection it tested, each toil project it read, and a result screen. */
export function finish(state: MenuState, results: StepResult[]): MenuState {
  const health = { ...state.session.health };
  for (const r of results) if (r.args[0] === 'connections' && r.args[1] === 'test' && r.args[2]) health[r.args[2]] = healthOf(r.envelope);
  const toilProjects = { ...state.session.toilProjects };
  for (const r of results) {
    const [group, verb, ref] = r.args;
    if (group === 'projects' && (verb === 'show' || verb === 'check') && ref && r.envelope.ok) toilProjects[ref] = { ...toilProjects[ref], [verb]: r.envelope.data };
  }
  const briefs = { ...state.session.briefs };
  for (const r of results) if (r.args[0] === 'projects' && r.args[1] === 'brief' && r.args[2] && r.envelope.ok) briefs[r.args[2]] = r.envelope.data;
  const run = state.pending;
  const rest = { ...state };
  delete rest.pending;
  const session = { ...state.session, health, ...(Object.keys(toilProjects).length ? { toilProjects } : {}), ...(Object.keys(briefs).length ? { briefs } : {}) };
  return { ...rest, session, stack: [...state.stack, { ...frame('result'), ...(run ? { run } : {}), results }] };
}

/** Records a finished game: its score, and the best this session. */
export function played(state: MenuState, best: number, last: number, game: Game = 'rogue'): MenuState {
  const rest = { ...state };
  delete rest.playing;
  return { ...rest, session: { ...state.session, [game]: { best: Math.max(best, state.session[game]?.best ?? 0), last } } };
}

type RenderCaps = Pick<TermCaps, 'colorDepth' | 'unicode'> & Partial<Pick<TermCaps, 'columns' | 'rows'>>;

/** The breadcrumb: `toil › Connections › corp-jira`. */
export function breadcrumb(state: MenuState, caps: Pick<TermCaps, 'unicode'>, data: WelcomeData): string {
  const arrow = caps.unicode ? '›' : '>';
  const titles = state.stack.map((f) => viewOf(f).title({ data, session: state.session, frame: f })).filter(Boolean);
  return ['toil', ...titles].join(` ${arrow} `);
}

export function render(state: MenuState, caps: RenderCaps, data: WelcomeData, notice = ''): string[] {
  const f = top(state);
  const view = viewOf(f);
  const p = propsOf(state, data);
  const rows = caps.rows ?? 40;
  const columns = caps.columns ?? 100;
  // The wordmark only where it leaves room for the screen itself.
  const head = rows >= 30 && columns >= 40 ? ['', ...wordmarkFrame(99, caps).map((l) => `  ${l}`)] : [];
  const lines: string[] = [...head, '', `  ${paint(caps, pal(caps).highlight, breadcrumb(state, caps, data))}`, ''];
  const body = view.body?.(caps, p) ?? [];
  // Prose wraps to the window; tables and rows are cut at its edge below.
  lines.push(...body.flatMap((l) => (l ? wrapLine(`  ${l}`, columns - 1) : [''])));

  let keys: string;
  if (view.input) {
    const text = f.text ?? view.input.initial?.(p) ?? '';
    const caret = paint(caps, pal(caps).accent, caps.unicode ? '▏' : '_');
    lines.push('', `  ${paint(caps, pal(caps).muted, `${view.input.label(p)}:`)} ${paint(caps, pal(caps).ink, text)}${caret}`);
    if (f.error) lines.push(...wrapLine(`  ${paint(caps, pal(caps).danger, f.error)}`, columns - 1));
    keys = 'type   enter go on   esc back';
  } else if (view.checklist) {
    const options = view.checklist.options(p);
    const checked = new Set(f.checked ?? view.checklist.initial?.(p) ?? []);
    const rowsLeft = rows - lines.length - 4;
    const width = Math.max(0, ...options.map((o) => [...o.label].length));
    lines.push(
      '',
      ...windowed(caps, options, f.selected, rowsLeft, (o, index) => {
        const on = index === f.selected;
        const box = checked.has(o.id) ? '[x]' : '[ ]';
        const pointer = on ? paint(caps, pal(caps).accent, caps.unicode ? '▸' : '>') : ' ';
        return `${pointer} ${paint(caps, on ? pal(caps).ink : pal(caps).muted, `${box} ${o.label.padEnd(width)}`)}   ${o.hint ? paint(caps, pal(caps).faint, o.hint) : ''}`;
      }).map((l) => `  ${l}`),
    );
    keys = 'up/down move   space tick   enter go on   esc back   q quit';
  } else {
    const items = view.items?.(p) ?? [];
    if (items.length) {
      const rowsLeft = rows - lines.length - 4;
      lines.push('', ...list(caps, items, Math.min(f.selected, items.length - 1), rowsLeft).map((l) => `  ${l}`));
      keys = state.stack.length === 1 ? `up/down move   enter select   1-${Math.min(9, items.length)} jump   q quit` : 'up/down move   enter select   esc back   q quit';
    } else keys = 'esc back   q quit';
  }
  lines.push('', notice ? `  ${paint(caps, pal(caps).accent, notice)}` : `  ${paint(caps, pal(caps).faint, keys)}`);
  return lines.map((l) => fitLine(l, columns - 1));
}

/** The slice of a long list that fits, with the selection in view, and markers where more is hidden. */
function windowed<T>(caps: Pick<TermCaps, 'colorDepth' | 'unicode'>, items: T[], selected: number, room: number, draw: (item: T, index: number) => string): string[] {
  const fit = Math.max(3, room);
  if (items.length <= fit) return items.map(draw);
  const size = fit - 2;
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), items.length - size));
  const out = items.slice(start, start + size).map((item, i) => draw(item, start + i));
  const after = items.length - start - size;
  if (start > 0) out.unshift(paint(caps, pal(caps).faint, `     ${caps.unicode ? '↑' : '^'} ${start} more`));
  if (after > 0) out.push(paint(caps, pal(caps).faint, `     ${caps.unicode ? '↓' : 'v'} ${after} more`));
  return out;
}

function list(caps: Pick<TermCaps, 'colorDepth' | 'unicode'>, items: Item[], selected: number, room: number): string[] {
  const pointer = caps.unicode ? '▸' : '>';
  const width = Math.max(...items.map((i) => [...i.label].length));
  return windowed(caps, items, selected, room, (item, index) => {
    const on = index === selected;
    const mark = on ? paint(caps, pal(caps).accent, pointer) : ' ';
    const number = paint(caps, pal(caps).faint, index < 9 ? `${index + 1}` : ' ');
    const color = item.attention ? pal(caps).danger : on ? pal(caps).ink : pal(caps).muted;
    const text = paint(caps, color, item.label.padEnd(width));
    return `${mark} ${number}  ${text}   ${item.hint ? paint(caps, pal(caps).faint, item.hint) : ''}`;
  });
}
