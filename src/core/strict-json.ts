/**
 * JSON, read by a parser that notices a key given twice. `JSON.parse` keeps
 * the last of two identical keys and drops the first without a word, so a
 * toil project with `"storyPoints"` twice would quietly use whichever came last
 * (docs/projects.md, Validation on every read). This reads the same grammar
 * (RFC 8259, plus a leading byte-order mark) and reports each repeat by its
 * key path, `jira.fields.storyPoints` or `repos[1].name`; the value kept is
 * the last, as `JSON.parse` would keep it.
 *
 * A syntax error says where (line and column), never what was there: the file
 * might not be a toil project at all, and its content is nobody's business but its
 * owner's. Duplicate entries are a known hazard of any form filled in twice;
 * this one at least keeps the carbon copy.
 */
export interface StrictJson {
  value: unknown;
  /** Key paths that appeared more than once in their object, in the order found. */
  duplicates: string[];
}

export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = 'JsonSyntaxError';
  }
}

export function parseStrictJson(text: string): StrictJson {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const duplicates: string[] = [];
  let at = 0;

  const fail = (what: string): never => {
    const before = src.slice(0, at);
    const line = before.split('\n').length;
    const column = at - before.lastIndexOf('\n');
    throw new JsonSyntaxError(`${what} at line ${line}, column ${column}`, line, column);
  };
  const space = () => {
    while (at < src.length && ' \t\n\r'.includes(src[at]!)) at++;
  };
  const expect = (word: string) => {
    if (src.slice(at, at + word.length) !== word) fail('Unexpected token');
    at += word.length;
  };
  const join = (path: string, key: string) => (path === '' ? key : `${path}.${key}`);

  const string = (): string => {
    if (src[at] !== '"') fail('Expected a string');
    at++;
    let out = '';
    for (;;) {
      if (at >= src.length) fail('Unterminated string');
      const c = src[at]!;
      if (c === '"') {
        at++;
        return out;
      }
      if (c.charCodeAt(0) < 0x20) fail('Control character in a string');
      if (c !== '\\') {
        out += c;
        at++;
        continue;
      }
      const e = src[at + 1];
      at += 2;
      const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (e !== undefined && e in simple) out += simple[e];
      else if (e === 'u') {
        const hex = src.slice(at, at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('Bad \\u escape');
        out += String.fromCharCode(parseInt(hex, 16));
        at += 4;
      } else fail('Bad escape');
    }
  };

  const number = (): number => {
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(at));
    if (!match) fail('Unexpected token');
    at += match![0].length;
    return Number(match![0]);
  };

  const value = (path: string): unknown => {
    space();
    const c = src[at];
    if (c === '{') return object(path);
    if (c === '[') return array(path);
    if (c === '"') return string();
    for (const [word, literal] of [['true', true], ['false', false], ['null', null]] as const) {
      if (c === word[0]) {
        expect(word);
        return literal;
      }
    }
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return number();
    return fail(c === undefined ? 'Unexpected end of input' : 'Unexpected token');
  };

  const object = (path: string): Record<string, unknown> => {
    at++;
    // A null prototype, so a key named __proto__ is a key and nothing more.
    const out = Object.create(null) as Record<string, unknown>;
    const seen = new Set<string>();
    space();
    if (src[at] === '}') {
      at++;
      return { ...out };
    }
    for (;;) {
      space();
      const key = string();
      if (seen.has(key)) duplicates.push(join(path, key));
      seen.add(key);
      space();
      if (src[at] !== ':') fail("Expected ':'");
      at++;
      out[key] = value(join(path, key));
      space();
      if (src[at] === ',') {
        at++;
        continue;
      }
      if (src[at] === '}') {
        at++;
        return { ...out };
      }
      fail("Expected ',' or '}'");
    }
  };

  const array = (path: string): unknown[] => {
    at++;
    const out: unknown[] = [];
    space();
    if (src[at] === ']') {
      at++;
      return out;
    }
    for (;;) {
      out.push(value(`${path}[${out.length}]`));
      space();
      if (src[at] === ',') {
        at++;
        continue;
      }
      if (src[at] === ']') {
        at++;
        return out;
      }
      fail("Expected ',' or ']'");
    }
  };

  const result = value('');
  space();
  if (at < src.length) fail('Unexpected content after the JSON value');
  return { value: result, duplicates };
}
