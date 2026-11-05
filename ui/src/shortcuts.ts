/**
 * Every keyboard shortcut in Toil UI (#416), in one table. The views read
 * their keys from here (`matches`, `ariaKeys`), the command palette opens on
 * one, and the `?` sheet is drawn from the whole table, so a shortcut that
 * isn't listed here doesn't exist. `ui/test/palette.test.tsx` fails on a key
 * compared anywhere else. Plain data and a few small functions, with no React.
 * A register that is kept current, which makes it the rarest register in the building.
 */

export interface Shortcut {
  /** The keys as a person reads them, one entry per key pressed together; `Mod` is Ctrl, or ⌘ on a Mac. */
  keys: readonly string[];
  /** Other keys that do the same, read the same way. */
  or?: ReadonlyArray<readonly string[]>;
  /** Where it works. */
  where: string;
  /** What it does, in a few words. */
  what: string;
}

export const SHORTCUTS = {
  palette: { keys: ['Mod', 'K'], where: 'Anywhere', what: 'Open the command palette: jump to a Toil project, a tab, an item in any Toil project or a setting, or run Sync, Analyze and Ask' },
  shortcuts: { keys: ['?'], where: 'Anywhere but a text field', what: 'Show these shortcuts' },
  paletteMove: { keys: ['↑'], or: [['↓']], where: 'In the command palette', what: 'Move between results' },
  paletteRun: { keys: ['Enter'], where: 'In the command palette', what: 'Open or run the highlighted result' },
  close: { keys: ['Escape'], where: 'In a dialog, menu or palette', what: 'Close it, and go back to where you were' },
  cardMenu: { keys: ['M'], or: [['Menu']], where: 'On a board card', what: "Open the card's menu: open it, move it or assign it to an agent" },
  cardPickUp: { keys: ['Space'], or: [['Enter']], where: 'On a board card', what: 'Pick the card up, or put it down to propose the move' },
  cardMove: { keys: ['←'], or: [['→']], where: 'On a board card you picked up', what: 'Move it to the previous or next column' },
  cardCancel: { keys: ['Escape'], where: 'On a board card you picked up', what: 'Put it back where it was' },
  editSave: { keys: ['Enter'], where: "Editing a Toil project's name or description", what: 'Save it' },
  editCancel: { keys: ['Escape'], where: "Editing a Toil project's name or description", what: 'Leave it as it was' },
  wipeCancel: { keys: ['Escape'], where: 'Asked whether to wipe the cache', what: 'Keep the cache' },
  drawerClose: { keys: ['Escape'], where: "In an item's drawer", what: 'Close it, and go back to the view behind it' },
} as const satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof SHORTCUTS;

/** Whether this browser is on a Mac, where `Mod` is ⌘. */
export const onMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** One key as it reads on this machine: `Mod` is Ctrl, or ⌘ on a Mac. */
export const keyLabel = (key: string, mac = onMac()): string => (key === 'Mod' ? (mac ? '⌘' : 'Ctrl') : key);

/** The keys of a shortcut joined for reading, such as "Ctrl+K". */
export const keysText = (keys: readonly string[], mac = onMac()): string => keys.map((k) => keyLabel(k, mac)).join(mac ? '' : '+');

/** What `aria-keyshortcuts` says for a shortcut: every way of pressing it, in the attribute's own spelling. */
export function ariaKeys(id: ShortcutId): string {
  const s: Shortcut = SHORTCUTS[id];
  const spell = (k: string) => ({ Mod: onMac() ? 'Meta' : 'Control', Menu: 'ContextMenu', '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight' })[k] ?? k;
  return [s.keys, ...(s.or ?? [])].map((ks) => ks.map(spell).join('+')).join(' ');
}

/** The parts of a key event a match reads, so it works on React's events and the DOM's alike. */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** The DOM's name for a key the table spells for reading. */
const EVENT_KEY: Record<string, string> = { Space: ' ', Menu: 'ContextMenu', '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight' };

/**
 * Whether a key press is this shortcut, by its first way of pressing it. A
 * letter matches either case; no other modifier may be held, except Shift,
 * which a `?` needs on most layouts.
 */
export function matches(id: ShortcutId, e: KeyPress): boolean {
  const keys: readonly string[] = SHORTCUTS[id].keys;
  const mod = keys.includes('Mod');
  const main = keys.filter((k) => k !== 'Mod');
  if (main.length !== 1 || e.altKey) return false;
  if (mod ? !(onMac() ? e.metaKey : e.ctrlKey) : e.ctrlKey || e.metaKey) return false;
  const want = EVENT_KEY[main[0]!] ?? main[0]!;
  return want.length === 1 ? e.key.toLowerCase() === want.toLowerCase() : e.key === want;
}

/** Whether a key press lands where someone is typing, so a single-key shortcut leaves it alone. */
export function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}
