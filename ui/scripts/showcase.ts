// What the site's Toil UI showcase (/ui/, #374) shows about themes, read from
// Toil UI's own source when the site builds rather than written out again: the
// system prompt is the server's own systemPrompt(), the answers are the
// scripted agent's, the wording is src/wording.ts and each theme.json, and
// the checkbox rows and the start command come from the docs that own them.
// A change to any of those changes the page on the next build, and a shape
// this file no longer recognises stops the build instead of shipping a
// stale page. It lives here, not in site/, so test/showcase.test.tsx can
// check it with Toil UI's own install; it is never published. Copies
// drift; imports merely break, which at least files a complaint.

import { INSTRUCTIONS_RULE, STYLE_RULE, systemPrompt } from '../server/agents/prompts.ts';
import { promptStyle } from '../server/agents/voices.ts';
import { SCRIPTS, VOICED } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { STANDARD, wordFor, type WordKey } from '../src/wording.ts';
import { TERMS, type Scheme, type ThemeManifest } from '../src/theme-pack.ts';
import plain from '../themes/plain/theme.json';
import crate from '../themes/crate/theme.json';
import harvest from '../themes/harvest/theme.json';
import starship from '../themes/starship/theme.json';
import realm from '../themes/realm/theme.json';
import sprawl from '../themes/sprawl/theme.json';
import frontier from '../themes/frontier/theme.json';
import overworld from '../themes/overworld/theme.json';
import themesDoc from '../docs/themes.md?raw';
import readme from '../README.md?raw';

/** The sample toil project every view and answer on the page is about. */
export const TOIL_PROJECT = 'card-payments';

/** The general instruction ui/docs/themes.md uses for its example prompt. */
export const SAMPLE_INSTRUCTIONS = 'Answer in British English. Lead with risks.';

/** The built-in themes, in the picker's order (ui/src/themes.ts). */
const MANIFESTS = [plain, crate, harvest, starship, realm, sprawl, frontier, overworld] as unknown as ThemeManifest[];

export const DEFAULT_THEME = 'crate';

/**
 * The scheme the showcase draws a theme in: the one its theme.json lists
 * first, its default (#507), so Crate stays the site's near-black and Plain
 * stays light, whatever the visitor's system prefers.
 */
const showScheme = (t: ThemeManifest): Scheme => Object.keys(t.schemes)[0] as Scheme;

/** The theme's colours as custom properties, for a card drawn in that theme, in its showScheme. */
function tokens(t: ThemeManifest): string {
  const scheme = t.schemes[showScheme(t)];
  const vars: Record<string, string> = {
    bg: scheme.bg, surface: scheme.surface, raised: scheme.raised, ink: scheme.ink, muted: scheme.muted, line: scheme.line,
    accent: scheme.accent, 'accent-ink': scheme.accentInk, link: scheme.link, focus: scheme.focus,
    'font-body': t.fonts.body, 'font-display': t.fonts.display, 'font-mono': t.fonts.mono, radius: t.radius,
  };
  return Object.entries(vars).map(([k, v]) => `--t-${k}: ${v}`).join('; ');
}

/** "Campaign (Epic)": a theme's word for something always sits beside the real one (ui/src/theme-context.ts, themed()). */
function themed(t: ThemeManifest, real: string, key: (typeof TERMS)[number], wording: boolean): string {
  const word = wording ? t.terms?.[key] : undefined;
  return word && word.toLowerCase() !== real.toLowerCase() ? `${word} (${real})` : real;
}

/** A piece of the prompt the server sends, split where systemPrompt() joins its layers. */
export interface PromptLayers {
  full: string;
  rules: string;
  style: { voice: string; rule: string } | null;
  instructions: { text: string; rule: string };
}

const STYLE_HEAD = '\n\nStyle:\n';
const INSTRUCTIONS_HEAD = '\n\nInstructions from the person asking:\n';

/** The prompt for one theme with the voice on or off, cut into its three layers, each exactly as it appears in the whole. */
function layers(theme: string, voice: boolean): PromptLayers {
  const full = systemPrompt(TOIL_PROJECT, FIXTURE_NOW, promptStyle({ theme, voice }, { instructions: SAMPLE_INSTRUCTIONS, voice: null }));
  const [head, instructions] = full.split(INSTRUCTIONS_HEAD);
  const [rules, style] = head!.split(STYLE_HEAD);
  const strip = (text: string, rule: string) => {
    const tail = `\n\n${rule}`;
    if (!text.endsWith(tail)) throw new Error(`The ${theme} prompt's layer no longer ends with its rule; ui/server/agents/prompts.ts changed shape.`);
    return text.slice(0, -tail.length);
  };
  if (instructions === undefined) throw new Error('systemPrompt() no longer adds the person\'s instructions as a layer; ui/server/agents/prompts.ts changed shape.');
  const out: PromptLayers = {
    full,
    rules: rules!,
    style: style === undefined ? null : { voice: strip(style, STYLE_RULE), rule: STYLE_RULE },
    instructions: { text: strip(instructions, INSTRUCTIONS_RULE), rule: INSTRUCTIONS_RULE },
  };
  const again = out.rules + (out.style ? `${STYLE_HEAD}${out.style.voice}\n\n${STYLE_RULE}` : '') + `${INSTRUCTIONS_HEAD}${out.instructions.text}\n\n${INSTRUCTIONS_RULE}`;
  if (again !== full) throw new Error(`The ${theme} prompt didn't split into its layers cleanly; ui/server/agents/prompts.ts changed shape.`);
  return out;
}

/** The microcopy rows the comparison shows: where each line appears, and its key in src/wording.ts. */
const WORD_ROWS: { where: string; key: WordKey; vars?: Record<string, string> }[] = [
  { where: 'Above the Toil project name', key: 'toilProject.eyebrow' },
  { where: 'The Ask bar, empty', key: 'ask.placeholder', vars: { name: TOIL_PROJECT } },
  { where: 'The chat, before a question', key: 'ask.welcome', vars: { name: TOIL_PROJECT } },
  { where: 'Status, reading the cache', key: 'status.cache' },
  { where: 'Status, writing the answer', key: 'status.writing' },
  { where: 'Status, finished', key: 'status.done', vars: { seconds: '4' } },
  { where: 'An empty board column', key: 'empty.column' },
  { where: 'No pull requests', key: 'empty.prs' },
  { where: 'Loading a Toil project', key: 'loading.toilProject', vars: { name: TOIL_PROJECT } },
];

/** The real word each renamed term stands beside, as the dashboard and chat use it. */
const TERM_REAL: Record<(typeof TERMS)[number], string> = {
  epic: 'Epic', board: 'Board', dependencies: 'Dependencies', sprint: 'Sprint 42', agent: 'Agent', blocked: 'Blocked',
  people: 'People', analyses: 'Analyses', priority: 'Priority', builds: 'Builds', passed: 'passed', failed: 'failed', pointsDone: 'Points done', pointsLeft: 'Points left',
};

export interface ShowTheme {
  name: string;
  label: string;
  description: string;
  /** The scheme its cards and the framed app are drawn in. */
  scheme: Scheme;
  tokens: string;
  swatch: string[];
  voice: boolean;
  wording: boolean;
  prompt: PromptLayers;
  answer: string[] | null;
  words: { where: string; key: string; standard: string; themed: string }[];
  terms: { real: string; themed: string }[];
}

const risk = SCRIPTS[TOIL_PROJECT]?.risk;
if (!risk?.proposals?.[0]) throw new Error(`The scripted agent has no risk answer with a proposal for ${TOIL_PROJECT}; ui/src/fixtures/agent.ts changed shape.`);

export const QUESTION = risk.label;
export const STANDARD_ANSWER = risk.parts;
export const PROPOSAL = risk.proposals[0].title;
export const STANDARD_PROMPT = layers(DEFAULT_THEME, false);

export const THEMES: ShowTheme[] = MANIFESTS.map((t) => {
  const scheme = t.schemes[showScheme(t)];
  return {
    name: t.name,
    label: t.label,
    scheme: showScheme(t),
    description: t.description,
    tokens: tokens(t),
    swatch: [scheme.bg, scheme.surface, scheme.accent, scheme.ink],
    voice: t.voice !== undefined,
    wording: t.lexicon !== undefined,
    prompt: layers(t.name, true),
    answer: VOICED[TOIL_PROJECT]?.[t.name] ?? null,
    words: WORD_ROWS.map(({ where, key, vars }) => ({ where, key, standard: wordFor(undefined, false, key, vars), themed: wordFor(t.lexicon, true, key, vars) })),
    terms: TERMS.map((key) => ({ real: TERM_REAL[key], themed: themed(t, TERM_REAL[key], key, true) })),
  };
});

for (const t of THEMES) if (t.voice && !t.answer) throw new Error(`The scripted agent has no ${t.name} answer for ${TOIL_PROJECT}; ui/src/fixtures/agent.ts changed shape.`);
if (!THEMES.some((t) => t.name === DEFAULT_THEME)) throw new Error(`There is no ${DEFAULT_THEME} theme in ui/themes/.`);
for (const { key } of WORD_ROWS) if (!(key in STANDARD)) throw new Error(`ui/src/wording.ts has no ${key}`);

/** "Themed wording" and "Themed agent voice", with what switching each off does, from the table in ui/docs/themes.md. */
export const CHECKBOXES = ['Themed wording', 'Themed agent voice'].map((name) => {
  const row = new RegExp(String.raw`^\| ${name} \| (\w+) \| (.+?) \|$`, 'm').exec(themesDoc);
  if (!row) throw new Error(`ui/docs/themes.md's checkbox table has no row for ${name}`);
  return { name, default: row[1]!, off: row[2]! };
});

/** The command that starts Toil UI, from ui/README.md's "Start it", the one place it's written. */
export const START = /^## Start it\s+```bash\s+(npx [^\n]+)\s+```/m.exec(readme)?.[1];
if (!START) throw new Error('ui/README.md has no "Start it" section opening with an npx command');

/** One answer paragraph as HTML: the text escaped, each [[id]] a citation chip like the app's. */
export function cited(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return text
    .split(/(\[\[[^\]]+\]\])/)
    .map((part) => {
      const id = /^\[\[([^\]]+)\]\]$/.exec(part)?.[1];
      if (!id) return esc(part);
      const [conn = '', key = id] = id.split(/:(.*)/s);
      const source = /jira/.test(conn) ? 'Jira' : /ado/.test(conn) ? 'Azure DevOps' : /github/.test(conn) ? 'GitHub' : /bitbucket/.test(conn) ? 'Bitbucket' : '';
      return `<span class="cite">${source ? `<span class="cite__src">${esc(source)}</span> ` : ''}<span class="cite__key">${esc(key.split('/').pop() ?? key)}</span></span>`;
    })
    .join('');
}
