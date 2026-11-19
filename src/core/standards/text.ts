/**
 * A work item's body as plain lines of text, for the rules that read it. Jira
 * sends Atlassian Document Format or wiki markup, Azure DevOps HTML, GitHub
 * Markdown; every rule reads the same thing out of each: one block per line, a
 * heading as `#`, a list item as `- `, a task as `[ ]`. This is a port of
 * Toil UI's readiness reader (ui/src/model/readiness.ts), so a rule and the
 * readiness rows read a body one way, with two changes for text from anywhere:
 * the ADF walk is a loop, not recursion, so a deeply nested document can't
 * overflow the stack, and what comes out is capped (BODY_SCAN_LIMIT) before any
 * rule's pattern runs on it. Pure, no network; text on a ticket is somebody
 * else's, and nobody reads past the twentieth thousand character anyway.
 */

/** The most characters of one text a rule reads; the rest is not scanned. */
export const BODY_SCAN_LIMIT = 20_000;
/** The most characters of one raw value converted: the conversions are linear, and markup inflates text. */
const RAW_LIMIT = BODY_SCAN_LIMIT * 5;
/** The most ADF nodes walked in one document. */
const ADF_NODES = 50_000;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** A numeric entity's character; one outside Unicode reads as U+FFFD, as a browser shows it, rather than throwing on text a tracker sent. */
const codePoint = (n: number) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '�');
const decode = (s: string) => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? codePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)));

/** HTML as lines of text: block ends become line breaks, a checkbox becomes `[ ]`, every other tag goes. */
function htmlText(html: string): string {
  return decode(
    html
      .replace(/<input\b[^>]*type=["']?checkbox[^>]*>/gi, '[ ] ')
      .replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n${'#'.repeat(Number(n))} `)
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/ul|\/ol)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

/** The text before and after a node's content, as the recursive reader wrapped it. */
function wrap(node: Rec): [string, string] {
  switch (node.type) {
    case 'heading': {
      const level = isRec(node.attrs) && typeof node.attrs.level === 'number' && Number.isInteger(node.attrs.level) ? Math.min(6, Math.max(1, node.attrs.level)) : 1;
      return [`\n${'#'.repeat(level)} `, '\n'];
    }
    case 'taskItem':
      return ['\n[ ] ', '\n'];
    case 'listItem':
      return ['\n- ', '\n'];
    case 'paragraph':
    case 'blockquote':
    case 'codeBlock':
      return ['\n', '\n'];
    default:
      return ['', ''];
  }
}

/** Atlassian Document Format as lines: a heading as `#`, a task as `[ ]`, each block on its own line. Walked with a stack, never recursion. */
function adfText(root: unknown): string {
  let out = '';
  // Each entry is a node still to read, or text to add once its node's content is done.
  const stack: Array<unknown> = [root];
  let nodes = 0;
  while (stack.length > 0 && out.length < BODY_SCAN_LIMIT && nodes < ADF_NODES) {
    const next = stack.pop();
    if (typeof next === 'string') {
      out += next;
      continue;
    }
    if (!isRec(next)) continue;
    nodes++;
    if (next.type === 'text' && typeof next.text === 'string') {
      out += next.text;
      continue;
    }
    if (next.type === 'hardBreak') {
      out += '\n';
      continue;
    }
    const [before, after] = wrap(next);
    const content = Array.isArray(next.content) ? next.content : [];
    stack.push(after);
    for (let i = content.length - 1; i >= 0; i--) stack.push(content[i]);
    out += before;
  }
  return out;
}

/** Jira wiki markup's headings (`h2. Goal`) as Markdown's, so one reading covers both. */
const wikiText = (s: string) => s.replace(/^\s*h([1-6])\.\s+/gim, (_, n: string) => `${'#'.repeat(Number(n))} `);

/** A body, or a field's value, as plain lines of text, at most BODY_SCAN_LIMIT characters. */
export function textOf(value: unknown, format?: string): string {
  if (value === null || value === undefined) return '';
  if (isRec(value)) return adfText(value).slice(0, BODY_SCAN_LIMIT);
  if (typeof value !== 'string') return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  const raw = value.slice(0, RAW_LIMIT);
  let text: string;
  if (format === 'html' || (format === undefined && /<\/?[a-z][\s\S]*?>/i.test(raw))) text = htmlText(raw);
  else if (format === 'wiki') text = wikiText(raw);
  else text = raw;
  return text.slice(0, BODY_SCAN_LIMIT);
}

export const lines = (text: string) => text.split(/\r?\n/);

/** A line as a template compares it: no heading or list marks, no case, single spaces, no trailing colon. */
export const normalise = (line: string) =>
  line
    .replace(/^\s*(?:(?:#{1,6}|[-*+]|\d+[.)]|\[[ xX]?\])\s*)+/, '')
    .replace(/[:.]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
export const wordCount = (text: string) => text.match(WORD)?.length ?? 0;

/** A line that is only a placeholder: TBD, TODO, N/A, lorem ipsum, a `<fill this in>` or a run of punctuation. */
const PLACEHOLDER_LINE = /^(tbd|tba|todo|to do|n\/?a|none|nothing|wip|placeholder|description|details|lorem ipsum.*|[-_.=*#~]+)$/i;
/** A `<what goes here>` or `{what goes here}` inside a line: template slots nobody filled. */
const SLOT = /<[^<>\n]{1,60}>|\{[^{}\n]{1,60}\}/g;

/** The words in a body that count as description: template lines, placeholder lines and empty slots taken out. */
export function realText(text: string, templateLines: readonly string[] = []): string {
  const template = new Set(templateLines);
  return lines(text)
    .filter((l) => {
      const n = normalise(l);
      return n !== '' && !template.has(n) && !PLACEHOLDER_LINE.test(n);
    })
    .map((l) => l.replace(SLOT, ' '))
    .join('\n');
}

/** A heading line: the words alone, or followed by a colon and text; a sentence that starts with them ("Acceptance criteria are still to come") isn't one. */
const AC_HEADING = /^\s*(?:#{1,6}\s*|\*{1,2})?(acceptance criteria|definition of done|done when)\s*\**\s*(?::\s*(.*))?$/i;
const CHECKBOX = /^\s*(?:[-*+]\s*)?\[[ xX]?\]\s+\S/;

/**
 * Acceptance criteria in a body: a heading (or a leading "Acceptance criteria:")
 * with text under it, or a checklist. Text counts as the description check counts
 * it (`realText`), so "Acceptance criteria: TBD" or a heading over "N/A" doesn't.
 */
export function acceptanceInBody(text: string, templateLines: readonly string[] = []): 'heading' | 'checklist' | null {
  const words = (line: string) => wordCount(realText(line, templateLines));
  const ls = lines(text);
  for (let i = 0; i < ls.length; i++) {
    const m = AC_HEADING.exec(ls[i]!);
    if (!m) continue;
    if (words(m[2] ?? '') > 0) return 'heading';
    for (let j = i + 1; j < ls.length; j++) {
      if (/^\s*#{1,6}\s/.test(ls[j]!)) break;
      if (words(ls[j]!) > 0) return 'heading';
    }
  }
  return ls.some((l) => CHECKBOX.test(l) && words(l) > 0) ? 'checklist' : null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The longest line read as a heading. */
const HEADING_LINE = 300;

/** A line that starts a section: a Markdown heading, a line that is only bold text, or a short "Label:" with nothing after it. */
const SECTION_BREAK = /^\s*(?:#{1,6}\s+\S.*|\*{1,2}[^*\n]{1,80}\*{1,2}:?\s*|[^:\n]{1,40}:\s*)$/;

/**
 * The text under the first heading line that names one of `headings` (compared
 * without regard to case), and the heading as the text spelled it: what follows
 * a colon on the heading line, then the lines up to the next heading-shaped
 * line. A heading is the words alone on a line (`## Expected`, `**Expected**`,
 * `Expected:`), or followed by a colon and text (`Expected: the total is 5`); a
 * sentence that starts with them is not one. Undefined when no such heading is
 * there.
 */
export function sectionUnder(text: string, headings: readonly string[]): { heading: string; text: string } | undefined {
  if (headings.length === 0) return undefined;
  const names = headings.map(escapeRegExp).join('|');
  // Matched on the trimmed line, and only a short one: a heading is a few words, and runs of spaces are where a pattern slows down.
  const heading = new RegExp(`^(?:#{1,6} *)?(?:\\*{1,2})?(${names}) *(?:\\*{1,2})?(?: *: *(?:\\*{1,2})? *(.*))?$`, 'i');
  const ls = lines(text);
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i]!.trim();
    const m = line.length <= HEADING_LINE ? heading.exec(line) : null;
    if (!m) continue;
    const under: string[] = m[2] ? [m[2]] : [];
    for (let j = i + 1; j < ls.length; j++) {
      if (SECTION_BREAK.test(ls[j]!)) break;
      under.push(ls[j]!);
    }
    return { heading: m[1]!, text: under.join('\n') };
  }
  return undefined;
}

/** The headings an "Acceptance criteria" section goes by. */
export const CRITERIA_HEADINGS = ['Acceptance criteria', 'Acceptance criterion', 'Definition of done', 'Done when'] as const;
