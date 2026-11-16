import { describe, expect, it } from 'vitest';
import { config as confluenceCloudConfig, routes as confluenceCloudRoutes } from '../../../../test/fixtures/confluence-cloud-data.js';
import { config as confluenceConfig, routes as confluenceRoutes } from '../../../../test/fixtures/confluence.fixture.js';
import { config as jiraCloudConfig, routes as jiraCloudRoutes } from '../../../../test/fixtures/jira-cloud-data.js';
import { config as jiraConfig, routes as jiraRoutes } from '../../../../test/fixtures/jira.fixture.js';
import { files as utilFiles, MD_CORPUS } from '../../../../test/fixtures/util.fixture.js';
import { runCli } from '../../../../test/harness/cli.js';
import { testContext } from '../../../../test/harness/context.js';
import { connectMcp } from '../../../../test/harness/mcp.js';
import type { Warning } from '../../../core/envelope.js';
import { execute } from '../../../core/run.js';
import { createPage as confluenceCloudCreatePage } from '../../confluence/cloud/pages.js';
import { createPage as confluenceCreatePage } from '../../confluence/server/pages.js';
import { createIssue as jiraCloudCreateIssue } from '../../jira/cloud/issues.js';
import { createIssue as jiraCreateIssue } from '../../jira/server/issues.js';
import { commands } from '../index.js';
import { EXAMPLE_MD, mdCommand } from '../md.js';
import { convertMarkdown, validateAdf, type Format, type Hooks, type MdData } from './convert.js';
import { parseMarkdown, renderMarkdown } from './markdown.js';
import { normalizeBlocks } from './ast.js';

/**
 * `util md` on a corpus of realistic tickets and pages (test/fixtures/util-md/),
 * on every construct known not to survive, on output broken on purpose to
 * show the self-checks catch it, and through the areas' own create commands,
 * which must accept what it writes. A round trip is the only meeting where
 * everyone is expected to come back with what they brought.
 */

const SOURCE = { source: { kind: 'text' as const }, expectedBytes: undefined, bytesRead: 0, truncated: false, label: 'the text' };

async function convert(text: string, from: Format, to: Format, hooks: Hooks = {}): Promise<{ data: MdData; warnings: Warning[] }> {
  const warnings: Warning[] = [];
  const data = await convertMarkdown({ from, to, text, source: SOURCE }, { warn: (w) => warnings.push(w) }, hooks);
  return { data, warnings };
}

const constructs = (data: MdData) => [...new Set(data.losses.map((l) => l.construct))].sort();
const unexplained = (data: MdData) => data.roundTrip.differences.filter((d) => !d.explained);

describe('util md: the corpus round-trips', () => {
  const md: Array<[string, Exclude<Format, 'md'>, string[]]> = [
    ['bug-report.md', 'wiki', ['link title', 'table alignment', 'task list']],
    ['bug-report.md', 'adf', ['table alignment']],
    ['bug-report.md', 'storage', ['table alignment']],
    ['runbook.md', 'wiki', ['code block in a list item', 'nested quote', 'table alignment', 'task list']],
    ['runbook.md', 'adf', ['nested quote']],
    ['runbook.md', 'storage', []],
    ['story.md', 'wiki', []],
    ['story.md', 'adf', []],
    ['story.md', 'storage', []],
  ];

  it.each(md)('%s to %s: every block survives or its loss is reported, and the checks pass', async (file, to, lost) => {
    const { data, warnings } = await convert(MD_CORPUS[file]!, 'md', to);
    expect(data.verified.passed).toBe(true);
    expect(unexplained(data)).toEqual([]);
    expect(constructs(data)).toEqual(lost);
    expect(data.lossless).toBe(lost.length === 0);
    expect(data.roundTrip.blocks).toBeGreaterThan(5);
    // Every loss is a warning too, by construct, with its position.
    for (const c of lost) expect(warnings).toContainEqual(expect.objectContaining({ code: 'MD_LOSSY', message: expect.stringMatching(new RegExp(`^${c} at line \\d+`)) }));
    const checks = data.verified.checks.map((c) => c.check);
    expect(checks).toContain('roundTrip.blocks');
    if (to === 'adf') expect(checks).toContain('output.adf.schema');
    if (to === 'storage') expect(checks).toContain('output.storage.wellFormed');
  });

  const foreign: Array<[string, Exclude<Format, 'md'>, string, string[]]> = [
    ['PROJ-142.wiki', 'wiki', 'PROJ-142.wiki.md', ['attachment image', 'image parameters', 'panel', 'text colour', 'user mention']],
    ['PROJ-142.adf.json', 'adf', 'PROJ-142.adf.md', ['date', 'emoji', 'mention', 'merged cells', 'panel', 'smart link', 'status', 'text colour']],
    ['release-notes.storage.xml', 'storage', 'release-notes.storage.md', ['code macro parameters', 'info panel', 'merged cells', 'page link', 'text colour', 'toc macro', 'user mention']],
  ];

  it.each(foreign)('%s from %s to Markdown: the result reads back as itself, and every loss is reported', async (file, from, expected, lost) => {
    const { data } = await convert(MD_CORPUS[file]!, from, 'md');
    expect(data.verified.passed).toBe(true);
    expect(data.roundTrip.differences).toEqual([]);
    expect(constructs(data)).toEqual(lost);
    expect(data.lossless).toBe(false);
    await expect(data.output).toMatchFileSnapshot(`../../../../test/fixtures/util-md/expected/${expected}`);
  });

  it.each(['**[PROJ-1](https://jira.imagile.dev/browse/PROJ-1)**', '*[a](https://imagile.dev)* and ~~[b](https://imagile.dev)~~', '[**a**](https://imagile.dev)'])(
    'emphasis around a whole link round-trips through every format: %s',
    async (text) => {
      for (const to of ['wiki', 'adf', 'storage'] as const) {
        const { data } = await convert(text, 'md', to);
        expect(data.lossless, to).toBe(true);
        expect(data.verified.passed).toBe(true);
      }
    },
  );

  it('positions losses by line for text formats and by JSON pointer for ADF', async () => {
    const wiki = (await convert(MD_CORPUS['PROJ-142.wiki']!, 'wiki', 'md')).data;
    expect(wiki.losses.find((l) => l.construct === 'panel')?.at).toBe('line 26');
    const adf = (await convert(MD_CORPUS['PROJ-142.adf.json']!, 'adf', 'md')).data;
    expect(adf.losses.find((l) => l.construct === 'merged cells')?.at).toBe('/content/6/content/2/content/0');
    const storage = (await convert(MD_CORPUS['release-notes.storage.xml']!, 'storage', 'md')).data;
    expect(storage.losses.find((l) => l.construct === 'merged cells')?.at).toBe('line 30');
    const md = (await convert(MD_CORPUS['runbook.md']!, 'md', 'wiki')).data;
    expect(md.losses.find((l) => l.construct === 'nested quote')?.at).toBe('line 27');
  });

  // One test per sample: the whole corpus in one test took 4,421 ms (Node 24.14) and 4,560 ms (Node 26) on
  // windows-latest against the 5 s default, about 1.2 s locally, so no single test carries all of it.
  const roundTrip = async (file: string, from: Format) => {
    const first = (await convert(MD_CORPUS[file]!, from, 'md')).data.output as string;
    for (const to of ['wiki', 'adf', 'storage'] as const) {
      const { data } = await convert(first, 'md', to);
      expect(unexplained(data), `${file} -> md -> ${to}`).toEqual([]);
    }
  };
  it.each([
    ['PROJ-142.wiki', 'wiki'],
    ['release-notes.storage.xml', 'storage'],
  ] as const)('converting the Markdown it wrote from %s back to each format and back again changes nothing more', roundTrip);

  // The ADF sample is the heaviest: about 560 ms here, so a Windows runner about four times slower (the
  // 4,421 ms and 4,560 ms above, against 1.2 s locally) would put it past 2 s. It gets room of its own.
  it('converting the Markdown it wrote from PROJ-142.adf.json back to each format and back again changes nothing more', () => roundTrip('PROJ-142.adf.json', 'adf'), 15_000);
});

describe('util md: each known lossy construct is reported', () => {
  const cases: Array<[string, Format, Format, string, string]> = [
    ['a task list in wiki markup', 'md', 'wiki', '- [ ] a\n- [x] b', 'task list'],
    ['table alignment in wiki markup', 'md', 'wiki', '| a |\n| :-: |\n| b |', 'table alignment'],
    ['a heading in a list item in ADF', 'md', 'adf', '- # big', 'heading'],
    ['a quote in a list item in ADF', 'md', 'adf', '- > quoted', 'quote'],
    ['a nested quote in ADF', 'md', 'adf', '> > deep', 'nested quote'],
    ['a list mixing tasks and items in ADF', 'md', 'adf', '- [ ] a\n- b', 'mixed task list'],
    ['a list mixing tasks and items in storage', 'md', 'storage', '- [ ] a\n- b', 'mixed task list'],
    ['an inline image in ADF', 'md', 'adf', 'see ![x](https://img.imagile.dev/x.png) here', 'inline image'],
    ['raw HTML in Markdown', 'md', 'adf', '<div>hi</div>', 'raw HTML'],
    ['inline HTML in Markdown', 'md', 'storage', 'a <span>b</span>', 'inline HTML'],
    ['a reference definition in Markdown', 'md', 'wiki', '[a]: https://imagile.dev', 'link reference definition'],
    ['a list starting at 5 in wiki markup', 'md', 'wiki', '5. five', 'list start number'],
    ['an emoticon in wiki markup', 'md', 'wiki', 'that worked (y) mostly', 'emoticon'],
    ['merged cells in storage', 'storage', 'md', '<table><tbody><tr><th colspan="2"><p>a</p></th></tr><tr><td>b</td><td>c</td></tr></tbody></table>', 'merged cells'],
    ['merged cells in ADF', 'adf', 'md', JSON.stringify({ type: 'doc', version: 1, content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', attrs: { rowspan: 2 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] }] }] }), 'merged cells'],
    ['an unsupported storage macro', 'storage', 'md', '<ac:structured-macro ac:name="jira-chart"><ac:parameter ac:name="jql">x</ac:parameter></ac:structured-macro><p>after</p>', 'jira-chart macro'],
    ['an unsupported wiki macro', 'wiki', 'md', '{toc}\n\ntext', 'toc macro'],
    ['an ADF extension', 'adf', 'md', JSON.stringify({ type: 'doc', version: 1, content: [{ type: 'extension', attrs: { extensionType: 'com.atlassian.confluence.macro.core', extensionKey: 'toc' } }] }), 'extension'],
    ['an ADF panel', 'adf', 'md', JSON.stringify({ type: 'doc', version: 1, content: [{ type: 'panel', attrs: { panelType: 'note' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'n' }] }] }] }), 'panel'],
    ['underline in wiki markup', 'wiki', 'md', 'an +underlined+ word', 'underline'],
    ['a wiki table without a header row', 'wiki', 'md', '|a|b|\n|c|d|', 'table without a header row'],
    ['a storage attachment image', 'storage', 'md', '<p><ac:image><ri:attachment ri:filename="shot.png" /></ac:image></p>', 'attachment image'],
  ];

  it.each(cases)('%s', async (_name, from, to, text, construct) => {
    const { data, warnings } = await convert(text, from, to);
    expect(constructs(data)).toContain(construct);
    expect(data.lossless).toBe(false);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'MD_LOSSY', message: expect.stringContaining(construct) }));
    // A known loss is expected: the self-check still passes.
    expect(unexplained(data)).toEqual([]);
    expect(data.verified.passed).toBe(true);
  });

  it('reports one loss per construct and place, however many items it covers', async () => {
    const { data } = await convert('- [ ] a\n- [ ] b\n- [x] c', 'md', 'wiki');
    expect(data.losses.filter((l) => l.construct === 'task list')).toHaveLength(1);
  });
});

describe('util md: size', () => {
  it('reads a long paragraph, many blocks and stray markup in linear time, in every direction', async () => {
    const words = Array.from({ length: 40_000 }, (_, k) => (k % 7 === 0 ? '*a' : k % 11 === 0 ? '[x' : k % 13 === 0 ? '`b' : k % 17 === 0 ? 'https://imagile.dev/p' : 'word')).join(' ');
    const blocks = Array.from({ length: 1500 }, (_, k) => `Paragraph ${k} with **bold** text.`).join('\n\n');
    const started = Date.now();
    for (const text of [words, blocks]) {
      for (const to of ['wiki', 'storage'] as const) {
        const { data } = await convert(text, 'md', to);
        expect(unexplained(data)).toEqual([]);
        await convert(data.output as string, to, 'md');
      }
    }
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe('util md: the self-checks catch a broken result', () => {
  it('a wiki result that lost a word fails the round trip, at the block, with MD_ROUNDTRIP_MISMATCH', async () => {
    const { data, warnings } = await convert('# Title\n\nKeep every word.\n\nLast.', 'md', 'wiki', { tamper: (out) => (out as string).replace('every ', '') });
    expect(data.verified.passed).toBe(false);
    expect(data.lossless).toBe(false);
    expect(unexplained(data)).toEqual([{ at: 'line 3', expected: 'Keep every word.', actual: 'Keep word.', explained: false }]);
    const check = data.verified.checks.find((c) => c.check === 'roundTrip.blocks')!;
    expect(check).toMatchObject({ status: 'failed', checked: 3, failed: 1 });
    expect(warnings).toContainEqual({ code: 'MD_ROUNDTRIP_MISMATCH', message: expect.stringContaining('at line 3') });
  });

  it('a storage result that dropped a block fails the round trip', async () => {
    const { data } = await convert('one\n\ntwo\n\nthree', 'md', 'storage', { tamper: (out) => (out as string).replace('<p>two</p>', '') });
    expect(data.verified.passed).toBe(false);
    expect(unexplained(data)).toMatchObject([{ at: 'line 3', expected: 'two', actual: '' }]);
  });

  it('a difference where a loss was reported is expected, but one in another block is not', async () => {
    // The task list's loss explains its own block, not the paragraph after it.
    const { data } = await convert('- [ ] a\n\nplain text', 'md', 'wiki', { tamper: (out) => (out as string).replace('plain', 'plane') });
    expect(data.verified.passed).toBe(false);
    expect(unexplained(data)).toMatchObject([{ at: 'line 3' }]);
  });

  it('a loss noted while reading stays with its own block after an empty paragraph is dropped', async () => {
    // The inline HTML loss is in "x <y>"; the change is in the paragraph after it. Without the empty
    // paragraph first, or with it, the change is unexplained.
    const tamper = (out: unknown) => JSON.parse(JSON.stringify(out).replace('"last"', '"lost"')) as never;
    for (const text of ['x <y>\n\nlast', '[]()\n\nx <y>\n\nlast']) {
      const { data } = await convert(text, 'md', 'adf', { tamper });
      expect(unexplained(data), text).toMatchObject([{ expected: 'last', actual: 'lost' }]);
      expect(data.verified.passed).toBe(false);
    }
    const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [] }, { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'abc12345', text: '@Ada' } }] }, { type: 'paragraph', content: [{ type: 'text', text: 'after' }] }] };
    const { data } = await convert(JSON.stringify(adf), 'adf', 'md');
    expect(data.losses).toMatchObject([{ construct: 'mention', at: '/content/1/content/0' }]);
  });

  it.each([
    ['wiki', 'an anchor-only paragraph', '{anchor:top}\n\nlast'],
    ['wiki', 'a macro on its own line', '{toc}\n\nlast'],
    ['adf', 'an extension-only paragraph', JSON.stringify({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'inlineExtension', attrs: { extensionType: 'x', extensionKey: 'anchor' } }] }, { type: 'paragraph', content: [{ type: 'text', text: 'last' }] }] })],
    ['adf', 'a dropped extension block', JSON.stringify({ type: 'doc', version: 1, content: [{ type: 'extension', attrs: { extensionType: 'x', extensionKey: 'toc' } }, { type: 'paragraph', content: [{ type: 'text', text: 'last' }] }] })],
  ] as const)('a loss in a block that produced nothing (%s, %s) is kept but excuses no other block', async (from, _name, text) => {
    const { data } = await convert(text, from, 'md', { tamper: (out) => (out as string).replace('last', 'lost') });
    expect(data.losses.length).toBeGreaterThan(0);
    expect(unexplained(data)).toMatchObject([{ expected: 'last', actual: 'lost' }]);
    expect(data.verified.passed).toBe(false);
  });

  it.each(['[r]: http://x.imagile.dev\n\nhello', 'hello\n\n[r]: http://x.imagile.dev'])('a lossy block next to a changed one excuses only itself: %j', async (text) => {
    const { data } = await convert(text, 'md', 'wiki', { tamper: (out) => (out as string).replace('hello', 'help') });
    expect(data.roundTrip.differences.filter((d) => d.explained).length).toBeGreaterThan(0);
    expect(unexplained(data)).toEqual([expect.objectContaining({ expected: 'hello', actual: 'help' })]);
    expect(data.verified.passed).toBe(false);
  });

  it('a block that appears after a lossy block, or one that vanishes beside it, is unexplained', async () => {
    const added = await convert('- [ ] a', 'md', 'wiki', { tamper: (out) => `${out as string}\n\nextra` });
    expect(unexplained(added.data)).toMatchObject([{ actual: expect.stringContaining('extra') }]);
    const removed = await convert('- [ ] a\n\nb', 'md', 'wiki', { tamper: (out) => (out as string).replace(/\n\nb$/, '').replace('\\[ \\]', '\\[x\\]') });
    expect(unexplained(removed.data)).toMatchObject([{ expected: expect.stringContaining('b') }]);
    expect(removed.data.verified.passed).toBe(false);
  });

  it('schema-invalid ADF is never returned: the conversion fails instead', async () => {
    const broken = (out: unknown) => ({ ...(out as object), content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] }) as never;
    await expect(convert('hello', 'md', 'adf', { tamper: broken })).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining("doesn't match the ADF schema") });
    const unknownNode = (out: unknown) => ({ ...(out as object), content: [{ type: 'mysteryNode' }] }) as never;
    await expect(convert('hello', 'md', 'adf', { tamper: unknownNode })).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('storage that is not well-formed is never returned', async () => {
    await expect(convert('hello', 'md', 'storage', { tamper: (out) => (out as string).replace('</p>', '') })).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('not well-formed') });
  });

  it('the ADF schema check bites: it refuses what Jira would', async () => {
    expect((await validateAdf({ type: 'doc', version: 1, content: [] })).valid).toBe(true);
    const bad = await validateAdf({ type: 'doc', version: 1, content: [{ type: 'heading', content: [{ type: 'text', text: 'no level' }] }] });
    expect(bad.valid).toBe(false);
    expect(bad.problems.map((p) => p.pointer)).toContain('/content/0');
  });
});

describe('util md: broken input', () => {
  it('ADF that is not JSON, or not a document, is INVALID_INPUT', async () => {
    await expect(convert('{ nope', 'adf', 'md')).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('is not JSON') });
    await expect(convert('{"fields":{}}', 'adf', 'md')).rejects.toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('fields.description') });
  });

  it('ADF input the schema refuses is converted as far as it reads, and the check fails with ADF_INPUT_INVALID', async () => {
    const { data, warnings } = await convert(JSON.stringify({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'strong', attrs: { bogus: 1 } }] }] }] }), 'adf', 'md');
    expect(data.output).toBe('**x**\n');
    expect(data.verified.passed).toBe(false);
    expect(warnings.map((w) => w.code)).toContain('ADF_INPUT_INVALID');
  });

  it.each([
    ['a null node', { type: 'doc', version: 1, content: [null, { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] }] }, '/content/0'],
    ['content that is not an array', { type: 'doc', version: 1, content: [{ type: 'paragraph', content: 'x' }, { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] }] }, '/content/0'],
    ['a mark that is not an object', { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'kept', marks: [7] }] }] }, '/content/0/content/0/marks/0'],
    ['attrs that are not an object', { type: 'doc', version: 1, content: [{ type: 'heading', attrs: 'big', content: [{ type: 'text', text: 'kept' }] }] }, '/content/0'],
  ])('badly shaped ADF (%s) is read around, reported where it is, and fails the schema check, never as a bug', async (_name, doc, at) => {
    const { data, warnings } = await convert(JSON.stringify(doc), 'adf', 'md');
    expect(data.output).toContain('kept');
    expect(data.losses).toContainEqual(expect.objectContaining({ construct: 'malformed ADF', at }));
    expect(data.verified.passed).toBe(false);
    expect(warnings.map((w) => w.code)).toContain('ADF_INPUT_INVALID');
  });

  it('storage that is not well-formed is INVALID_INPUT with its line and column', async () => {
    await expect(convert('<p>one</p>\n<p>two', 'storage', 'md')).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/line \d+, column \d+/) });
    await expect(convert('<p>&bogus;</p>', 'storage', 'md')).rejects.toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('numeric reference') });
  });

  it('refuses Markdown to Markdown, and two formats neither of which is Markdown', async () => {
    await expect(convert('x', 'md', 'md')).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('both Markdown') });
    await expect(convert('x', 'wiki', 'adf')).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('not from Jira wiki markup to ADF') });
  });
});

describe('util md: Markdown reading', () => {
  const md = (text: string) => renderMarkdown({ ...parseMarkdown(text), blocks: normalizeBlocks(parseMarkdown(text).blocks) });

  it.each([
    ['emphasis nests as CommonMark reads it', 'a *b **c** d* e', 'a *b **c** d* e\n'],
    ['underscores inside words are text', 'snake_case_name', 'snake\\_case\\_name\n'],
    ['bare URLs and www. are links', 'see www.imagile.dev.', 'see [www\\.imagile.dev](http://www.imagile.dev).\n'],
    ['an escaped pipe is a pipe in a table cell', '| a |\n| - |\n| x \\| y |', '| a |\n| --- |\n| x \\| y |\n'],
    ['setext headings', 'Title\n=====', '# Title\n'],
    ['indented code', '    x = 1', '```\nx = 1\n```\n'],
    ['two trailing spaces are a hard break', 'a  \nb', 'a\\\nb\n'],
    ['a lazy line continues a quote', '> a\nb', '> a b\n'],
    ['nested ordered and task lists', '1. a\n   - [x] b', '1. a\n   - [x] b\n'],
    ['text that looks like syntax stays text', '\\# not a heading', '\\# not a heading\n'],
  ])('%s', (_name, input, expected) => {
    expect(md(input)).toBe(expected);
  });
});

describe('util md: the areas accept what it writes', () => {
  const POSTED = (calls: Array<{ method: string; body?: unknown }>) => JSON.parse(String(calls.find((c) => c.method === 'POST')!.body)) as Record<string, unknown>;

  it('jira issue create takes the wiki markup as its description', async () => {
    const wiki = (await convert(MD_CORPUS['bug-report.md']!, 'md', 'wiki')).data.output as string;
    const t = testContext({ config: jiraConfig, routes: jiraRoutes });
    const envelope = await execute(jiraCreateIssue, { project: 'PROJ', summary: 'Sign-in button does nothing', description: wiki, allowWrite: true }, t.context);
    expect(envelope.ok).toBe(true);
    expect((POSTED(t.http.calls).fields as { description: string }).description).toBe(wiki);
  });

  it('jira-cloud issue create takes the ADF as the description in --input-file, and sends it as it is', async () => {
    const adf = (await convert(MD_CORPUS['bug-report.md']!, 'md', 'adf')).data.output;
    const t = testContext({ config: jiraCloudConfig, routes: jiraCloudRoutes, files: { 'issue.json': JSON.stringify({ fields: { summary: 'Sign-in button does nothing', description: adf } }) } });
    const envelope = await execute(jiraCloudCreateIssue, { project: 'PROJ', inputFile: 'issue.json', allowWrite: true }, t.context);
    expect(envelope.ok).toBe(true);
    expect((POSTED(t.http.calls).fields as { description: unknown }).description).toEqual(adf);
  });

  it('confluence page create takes the storage format as its body', async () => {
    const storage = (await convert(MD_CORPUS['runbook.md']!, 'md', 'storage')).data.output as string;
    const t = testContext({ config: confluenceConfig, routes: confluenceRoutes });
    const envelope = await execute(confluenceCreatePage, { space: 'DOCS', title: 'Payments runbook', body: storage, allowWrite: true }, t.context);
    expect(envelope.ok).toBe(true);
    expect((POSTED(t.http.calls).body as { storage: { value: string; representation: string } }).storage).toEqual({ value: storage, representation: 'storage' });
  });

  it('confluence page create on a Cloud connection takes the storage format as its body', async () => {
    const storage = (await convert(MD_CORPUS['story.md']!, 'md', 'storage')).data.output as string;
    const t = testContext({ config: confluenceCloudConfig, routes: confluenceCloudRoutes });
    const envelope = await execute(confluenceCloudCreatePage, { space: 'DOCS', title: 'Invoice export', body: storage, allowWrite: true }, t.context);
    expect(envelope.ok).toBe(true);
    expect((POSTED(t.http.calls).body as { value: string }).value).toBe(storage);
  });
});

describe('util md: the command', () => {
  const context = () => testContext({ files: utilFiles }).context;

  it('converts a workspace file through execute(), with input.complete checked against its size', async () => {
    const envelope = await execute(mdCommand, { inputFile: 'docs/story.md', to: 'storage' }, context());
    expect(envelope.ok).toBe(true);
    const data = envelope.data as MdData;
    expect(data).toMatchObject({ from: 'md', to: 'storage', lossless: true });
    expect(data.verified.checks.find((c) => c.check === 'input.complete')).toMatchObject({ status: 'passed' });
  });

  it('reads stdin on the CLI, and reports input.complete as unchecked there', async () => {
    const run = await runCli(['util', 'md', '--to', 'wiki'], { commands, context: testContext({ stdin: '# Hi\n\n*there*\n' }).context });
    expect(run.envelope?.data).toMatchObject({ output: 'h1. Hi\n\n_there_', lossless: true });
    expect(run.envelope?.meta.warnings).toContainEqual(expect.objectContaining({ code: 'UNVERIFIED', message: expect.stringContaining('stdin') }));
  });

  it('takes --text, and --from to convert to Markdown', async () => {
    const run = await runCli(['util', 'md', '--from', 'wiki', '--text', 'h2. Done\n\n* *one*\n* two'], { commands, context: context() });
    expect(run.envelope?.data).toMatchObject({ output: '## Done\n\n- **one**\n- two\n' });
  });

  it('refuses an unknown format before reading anything', async () => {
    const run = await runCli(['util', 'md', '--to', 'html', '--text', 'x'], { commands, context: context() });
    expect(run.envelope?.error?.code).toBe('INVALID_INPUT');
  });

  it('answers over MCP as util_md, with the ADF as an object', async () => {
    const session = await connectMcp({ commands, context: context() });
    try {
      const result = await session.call('util_md', { text: EXAMPLE_MD, to: 'adf' });
      const data = result.envelope.data as MdData;
      expect(data.output).toMatchObject({ type: 'doc', version: 1 });
      expect(data.verified.passed).toBe(true);
    } finally {
      await session.close();
    }
  });
});
