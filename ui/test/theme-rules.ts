/**
 * What a built-in theme folder may hold (#206): CSS, JSON and assets, never
 * script, with every selector scoped to the theme and a manifest whose
 * fonts, radius, renamed words, wording and voice are plain values that
 * can't break out of a stylesheet or a prompt. Only built-in themes exist
 * (#283: themes from the user's folder were removed), so these rules are
 * the test's, held over every folder in ui/themes/.
 * The dress code, enforced at the door rather than in the annual review.
 */

import { ENTER_MOTIFS, FACE_VALUES, LOOP_MOTIFS, MOMENT_KINDS, TRACK_MOTIFS } from '../src/moments/schema.ts';
import { TERMS, TOKENS, type ThemeManifest } from '../src/theme-pack.ts';
import { STANDARD, WORD_KEYS, commandsIn, isFunctional, placeholders, type WordKey } from '../src/wording.ts';

/** The only files a theme folder may hold. */
export const THEME_FILE_TYPES = new Set(['.css', '.json', '.svg', '.webp', '.png', '.avif', '.woff2']);

/** Patterns that run script, in SVG or CSS. */
const SCRIPT = /<script|javascript:|vbscript:|data:text\/html|expression\s*\(|-moz-binding|behavior\s*:|\bon[a-z]+\s*=|<foreignObject/i;

/** The longest a theme's voice may be, in characters: a paragraph of style, not a second prompt. */
export const MAX_VOICE = 800;

const extOf = (path: string) => {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
};

/** Problems with one file in a theme folder, by its path inside the folder and its text (for CSS, JSON and SVG). */
export function fileProblems(path: string, text: string | null): string[] {
  const ext = extOf(path);
  if (!THEME_FILE_TYPES.has(ext)) return [`${path}: a theme holds only CSS, JSON and assets (${[...THEME_FILE_TYPES].join(', ')}), never script or anything else.`];
  if (text !== null && (ext === '.css' || ext === '.svg') && SCRIPT.test(text)) return [`${path}: holds something that runs script (${SCRIPT.exec(text)![0]}).`];
  return [];
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every selector in a stylesheet, outside `@` rules' preludes and keyframe steps. */
export function selectorsOf(css: string): string[] {
  const body = stripComments(css).replace(/@import[^;]*;/g, '');
  return [...body.matchAll(/([^{};]+)\{/g)]
    .map((m) => m[1]!.trim())
    .filter((s) => !s.startsWith('@') && !/^(from|to|\d+(\.\d+)?%)(\s*,\s*(from|to|\d+(\.\d+)?%))*$/.test(s));
}

/** Problems with a theme's stylesheet: every selector scoped to `[data-theme="<name>"]`. */
export function cssProblems(name: string, css: string): string[] {
  const out: string[] = [];
  const selectors = selectorsOf(css);
  if (!selectors.length) out.push('theme.css: has no rules.');
  const scope = `[data-theme="${name}"]`;
  for (const s of selectors) for (const part of s.split(',')) if (!part.trim().startsWith(scope)) out.push(`theme.css: "${part.trim()}" isn't scoped to ${scope}.`);
  return out;
}

/**
 * Problems with a theme's wording (#283): only flavour keys src/wording.ts knows
 * (a functional key is refused: it reads one plain text in every theme), plain text, and every `{placeholder}` and `toil …` command the standard
 * text has, so a themed line never drops the id or the command it shows.
 */
export function lexiconProblems(lexicon: unknown): string[] {
  if (lexicon === undefined) return [];
  if (!lexicon || typeof lexicon !== 'object' || Array.isArray(lexicon)) return ['theme.json: "lexicon" must be an object of wording by key.'];
  const out: string[] = [];
  for (const [key, text] of Object.entries(lexicon)) {
    if (!(WORD_KEYS as string[]).includes(key)) {
      out.push(`theme.json: lexicon."${key}" isn't a word key (src/wording.ts).`);
      continue;
    }
    if (isFunctional(key as WordKey)) {
      out.push(`theme.json: lexicon."${key}" is a functional word (src/wording.ts): it names something a person acts on, so it reads the same plain text in every theme. Remove it from the lexicon.`);
      continue;
    }
    if (typeof text !== 'string' || !text.trim() || /[<>`]|\[\[/.test(text)) {
      out.push(`theme.json: lexicon."${key}" must be plain text.`);
      continue;
    }
    const standard = STANDARD[key as WordKey];
    if (placeholders(text).sort().join() !== placeholders(standard).sort().join()) out.push(`theme.json: lexicon."${key}" must keep the placeholders ${placeholders(standard).map((p) => `{${p}}`).join(', ') || '(none)'}.`);
    for (const command of commandsIn(standard)) if (!text.includes(command)) out.push(`theme.json: lexicon."${key}" must keep the command ${command}.`);
  }
  return out;
}

/**
 * Problems with a theme's thinking phrases (#561): three to eight lines, each
 * plain text of a status line's length that ends in an ellipsis (it is an
 * action under way, and says nothing is finished), none of them a claim of
 * progress such as a percentage or "done".
 */
export function thinkingProblems(thinking: unknown): string[] {
  if (thinking === undefined) return [];
  if (!Array.isArray(thinking) || thinking.length < 3 || thinking.length > 8) return ['theme.json: "thinking" must be a list of 3 to 8 phrases.'];
  const out: string[] = [];
  for (const p of thinking) {
    if (typeof p !== 'string' || !p.trim() || p.length > 60 || /[<>`]|\[\[|[\r\n]/.test(p) || !p.endsWith('…')) out.push(`theme.json: thinking ${JSON.stringify(p)} must be plain text of 60 characters or fewer that ends in "…".`);
    else if (/\d|\b(done|finished|complete|completed|almost there)\b/i.test(p)) out.push(`theme.json: thinking "${p}" claims progress; a phrase is flavour, never a count or a finish.`);
  }
  if (new Set(thinking).size !== thinking.length) out.push('theme.json: thinking lists a phrase twice.');
  return out;
}

/** Problems with a theme's voice (#283): plain text of a paragraph, with nothing a prompt would read as structure. */
export function voiceProblems(voice: unknown): string[] {
  if (voice === undefined) return [];
  if (typeof voice !== 'string' || !voice.trim()) return ['theme.json: "voice" must be text.'];
  const out: string[] = [];
  if (voice.length > MAX_VOICE) out.push(`theme.json: "voice" is ${voice.length} characters, over ${MAX_VOICE}.`);
  if (/```|\[\[|[\r\n]/.test(voice)) out.push('theme.json: "voice" must be one paragraph of plain text, with no code fence, citation or line break.');
  return out;
}

/** Problems with a theme's manifest: its name, every token as a hex colour in every scheme, fonts and a radius that can't break out of the stylesheet, and its words. */
export function manifestProblems(folder: string, raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['theme.json: is not a JSON object.'];
  const m = raw as Partial<ThemeManifest> & Record<string, unknown>;
  const out: string[] = [];
  if (m.name !== folder) out.push(`theme.json: "name" must be the folder's name, "${folder}".`);
  if (typeof m.label !== 'string' || !m.label) out.push('theme.json: needs a "label".');
  const schemes = m.schemes && typeof m.schemes === 'object' ? Object.entries(m.schemes) : [];
  if (!schemes.length) out.push('theme.json: needs at least one scheme, "light" or "dark".');
  for (const [scheme, tokens] of schemes) {
    if (scheme !== 'light' && scheme !== 'dark') out.push(`theme.json: "${scheme}" isn't a scheme; use "light" or "dark".`);
    for (const t of TOKENS) {
      const v = (tokens as Record<string, unknown> | undefined)?.[t];
      if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) out.push(`theme.json: ${scheme}.${t} must be a colour like #1b1f24.`);
    }
  }
  // Fonts and the radius go into a stylesheet as written, so they may hold only what a font list or a length needs.
  const fonts = m.fonts && typeof m.fonts === 'object' ? m.fonts : null;
  for (const slot of ['body', 'display', 'mono'] as const) {
    const v = fonts?.[slot];
    if (typeof v !== 'string' || !/^[\w\s,'".-]+$/.test(v)) out.push(`theme.json: fonts.${slot} must be a font list, like "'Fira Code', monospace".`);
  }
  if (typeof m.radius !== 'string' || !/^\d+(\.\d+)?(px|rem|em)$/.test(m.radius)) out.push('theme.json: "radius" must be a length, like "6px".');
  for (const key of Object.keys(m.terms ?? {})) if (!(TERMS as readonly string[]).includes(key)) out.push(`theme.json: "${key}" isn't a word a theme can rename (${TERMS.join(', ')}).`);
  for (const [key, word] of Object.entries(m.terms ?? {})) if (typeof word !== 'string' || /[<>]/.test(word)) out.push(`theme.json: terms.${key} must be plain text.`);
  out.push(...lexiconProblems(m.lexicon), ...voiceProblems(m.voice), ...thinkingProblems(m.thinking), ...alignmentProblems(m.alignments), ...momentsProblems(m.moments, (m.assets ?? {}) as Record<string, string>));
  return out;
}

/** Plain text a moment shows: words only, no markup, citation or code. */
const plainText = (v: unknown) => typeof v === 'string' && v.trim() !== '' && !/[<>`]|\[\[/.test(v) && v.length <= 160;

/**
 * Problems with a theme's moments (#419): only the keys src/moments/schema.ts
 * knows, every picture an asset the theme lists (by key), every motif one the
 * engine has, every size a sane number, and every word plain text. A theme
 * without the block has none: it gets the plain defaults.
 */
export function momentsProblems(moments: unknown, assets: Record<string, string> = {}): string[] {
  if (moments === undefined) return [];
  if (!moments || typeof moments !== 'object' || Array.isArray(moments)) return ['theme.json: "moments" must be an object.'];
  const m = moments as Record<string, unknown>;
  const out: string[] = [];
  const at = (path: string, problem: string) => out.push(`theme.json: moments.${path} ${problem}`);
  const known = ['splash', 'loader', 'tips', 'entrance', 'tabs', 'events', 'recap'];
  for (const key of Object.keys(m)) if (!known.includes(key)) at(key, `isn't a moment (${known.join(', ')}).`);
  const asset = (path: string, key: unknown) => {
    if (typeof key !== 'string' || !(key in assets)) at(path, 'must name one of the theme\'s assets by its key.');
  };
  const size = (path: string, n: unknown) => {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 8 || n > 640) at(path, 'must be a whole number of pixels from 8 to 640.');
  };
  const art = (path: string, a: unknown) => {
    if (!a || typeof a !== 'object') return at(path, 'must be { art, width, height }.');
    const r = a as Record<string, unknown>;
    asset(`${path}.art`, r.art);
    size(`${path}.width`, r.width);
    size(`${path}.height`, r.height);
    if (r.frames !== undefined && (typeof r.frames !== 'number' || !Number.isInteger(r.frames) || r.frames < 2 || r.frames > 16)) at(`${path}.frames`, 'must be a whole number from 2 to 16.');
  };
  const motif = (path: string, v: unknown, list: readonly string[]) => {
    if (typeof v !== 'string' || !list.includes(v)) at(path, `must be one of ${list.join(', ')}.`);
  };
  const words = (path: string, v: unknown) => {
    if (!plainText(v)) at(path, 'must be plain text, up to 160 characters.');
  };
  if (m.splash !== undefined) {
    const s = m.splash as Record<string, unknown>;
    art('splash.art', s.art);
    motif('splash.motif', s.motif, ENTER_MOTIFS);
    if (s.loop !== undefined) motif('splash.loop', s.loop, LOOP_MOTIFS);
    words('splash.line', s.line);
    if (s.face !== undefined) {
      const f = (s.face ?? {}) as Record<string, unknown>;
      motif('splash.face.value', f.value, FACE_VALUES);
      if (f.max !== undefined && (typeof f.max !== 'number' || !Number.isInteger(f.max) || f.max < 1 || f.max > 999)) at('splash.face.max', 'must be a whole number from 1 to 999.');
      for (const key of Object.keys(f)) if (key !== 'value' && key !== 'max') at(`splash.face.${key}`, "isn't a face key (value, max).");
    }
  }
  if (m.loader !== undefined) {
    const l = m.loader as Record<string, unknown>;
    art('loader.art', l.art);
    motif('loader.loop', l.loop, LOOP_MOTIFS);
    if (l.loop === 'frames' && !(l.art as Record<string, unknown> | undefined)?.frames) at('loader.loop', 'is frames, so loader.art needs "frames".');
    const t = (l.track ?? {}) as Record<string, unknown>;
    asset('loader.track.art', t.art);
    size('loader.track.size', t.size);
    if (typeof t.count !== 'number' || !Number.isInteger(t.count) || t.count < 1 || t.count > 8) at('loader.track.count', 'must be a whole number from 1 to 8.');
    motif('loader.track.motif', t.motif, TRACK_MOTIFS);
    if (!Array.isArray(l.flavour) || l.flavour.length > 12) at('loader.flavour', 'must be a list of up to 12 lines.');
    else l.flavour.forEach((f, i) => words(`loader.flavour[${i}]`, f));
  }
  if (m.tips !== undefined) words('tips.label', (m.tips as Record<string, unknown>).label);
  if (m.recap !== undefined) words('recap.label', (m.recap as Record<string, unknown>).label);
  if (m.entrance !== undefined) motif('entrance', m.entrance, ENTER_MOTIFS);
  if (m.tabs !== undefined) motif('tabs', m.tabs, ENTER_MOTIFS);
  if (m.events !== undefined) {
    const events = m.events as Record<string, unknown>;
    for (const [kind, e] of Object.entries(events)) {
      if (!(MOMENT_KINDS as readonly string[]).includes(kind)) {
        at(`events.${kind}`, `isn't a moment kind (${MOMENT_KINDS.join(', ')}).`);
        continue;
      }
      art(`events.${kind}`, e);
      motif(`events.${kind}.motif`, (e as Record<string, unknown>)?.motif, ENTER_MOTIFS);
      words(`events.${kind}.label`, (e as Record<string, unknown>)?.label);
    }
  }
  return out;
}

/** Words an alignment may never hold (#415): a label on a person's card is play, never a verdict on them. */
const JUDGEMENT = /\b(evil|bad|wicked|villain|lazy|slow|weak|worst|poor)\b/i;

/**
 * Problems with a theme's alignments (#415): a short label and at least two values, each plain text and short enough
 * for a tag, none of them a judgement of a person.
 */
export function alignmentProblems(alignments: unknown): string[] {
  if (alignments === undefined) return [];
  const a = alignments as { label?: unknown; values?: unknown };
  if (!a || typeof a !== 'object' || Array.isArray(a)) return ['theme.json: "alignments" must be an object with a label and values.'];
  const plain = (v: unknown, max: number) => typeof v === 'string' && v.trim() !== '' && v.length <= max && !/[<>`]|\[\[|[\r\n]/.test(v);
  const out: string[] = [];
  if (!plain(a.label, 30)) out.push('theme.json: alignments.label must be plain text of 30 characters or fewer.');
  if (!Array.isArray(a.values) || a.values.length < 2) out.push('theme.json: alignments.values must list at least two labels.');
  for (const v of Array.isArray(a.values) ? a.values : []) {
    if (!plain(v, 24)) out.push(`theme.json: alignments.values ${JSON.stringify(v)} must be plain text of 24 characters or fewer.`);
    else if (JUDGEMENT.test(v as string)) out.push(`theme.json: alignments.values "${v as string}" judges a person; a rolled label never does.`);
  }
  return out;
}
