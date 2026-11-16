/**
 * Confluence Cloud's bodies, read and written in one format: storage, the
 * XHTML Confluence keeps pages in. toil asks for `body-format=storage` on
 * every read and sends `storage` (or `wiki`, which Confluence converts) on
 * every write, so a page read is a page that can be written back. Beside each
 * storage body sits a plain-text rendering (`bodyText`), and that is all the
 * rendering there is: tags go, words stay. Atlassian Document Format exists
 * too, and has been referred to the format review board.
 */
import { NAMED_ENTITIES } from './entities.js';

/** The six it always read, in any letter case, with `&nbsp;` as a plain space for plain text. */
// A Map, not an object, so `&constructor;` can't reach Object.prototype and print a function.
const ENTITIES: ReadonlyMap<string, string> = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' ']]);

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    // Then every other HTML 4 name, as Confluence Cloud saves typography (`&minus;`, `&rsquo;`);
    // a name it doesn't know stays as written.
    return ENTITIES.get(name.toLowerCase()) ?? NAMED_ENTITIES.get(name) ?? whole;
  });
}

const BLOCK = 'p|div|h[1-6]|tr|pre|blockquote|table|ul|ol|ac:task|ac:layout-section|ac:layout-cell';

/**
 * The words of a storage-format body. Paragraphs, headings and other blocks
 * end in a line break, list items start with `- `, table cells are joined
 * with ` | `, CDATA (a code macro's text) is kept, and a macro's parameters,
 * which are settings rather than prose, are dropped. Anything that isn't a
 * string is null.
 */
export function storageToText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner: string) => inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .replace(/<ac:parameter\b[^>]*>[\s\S]*?<\/ac:parameter>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, ' | ')
    .replace(/<\/tr>\s*<tr\b[^>]*>/gi, '\n')
    .replace(new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, '');
  return decode(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    // A list item whose text sits in its own <p>: put the text after the dash.
    .replace(/(^|\n)-\n+/g, '$1- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The storage value of a v2 body (`body.storage.value`), if there is one. */
export function storageOf(item: unknown): string | undefined {
  const body = (item as { body?: { storage?: { value?: unknown } } } | null)?.body;
  return typeof body?.storage?.value === 'string' ? body.storage.value : undefined;
}

/** The item with `bodyText` beside its body: the plain text of `body.storage`, or null when it has none. */
export function withBodyText<T>(item: T): T & { bodyText: string | null } {
  return { ...item, bodyText: storageToText(storageOf(item)) };
}
