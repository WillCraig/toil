import { z } from 'zod';
import { defineCommand } from '../../core/command.js';
import { fileArgument, inputFields, openInput, inputFileOption, textOption } from './kit/input.js';

/**
 * `util md`: Markdown to and from Jira wiki markup (Data Center), Atlassian
 * Document Format (Jira Cloud, Confluence Cloud) and Confluence storage format
 * (Data Center), checked by converting the result back. Only the definition
 * lives here, for the registry and --help; the converters load when the
 * command runs (docs/util.md, Lazy loading). Four formats for one paragraph
 * of text, each approved by a different department.
 */

const FORMAT = z.enum(['md', 'wiki', 'adf', 'storage']);

/** A short ticket description, for the examples: a list, a task list, a table, code and a link. */
export const EXAMPLE_MD = [
  '## Steps to reproduce',
  '',
  '1. Open https://app.imagile.dev/login in Safari',
  '2. Press **Sign in**',
  '',
  '- [x] Reproduced on 17.4',
  '- [ ] Check Firefox',
  '',
  '| Browser | Result |',
  '| --- | :-: |',
  '| Safari | fails |',
  '',
  '```js',
  "document.querySelector('#sign-in').click();",
  '```',
  '',
].join('\n');

export const mdCommand = defineCommand({
  path: ['util', 'md'],
  description: 'Convert Markdown to or from Jira wiki markup, ADF or Confluence storage format, checking the result by converting it back',
  toolDescription:
    'Converts a document between Markdown (CommonMark with GFM tables, task lists and strikethrough) and one of: Jira wiki markup (Jira Data Center), Atlassian Document Format (Jira Cloud, Confluence Cloud), or Confluence storage format (Confluence Data Center). Pass to (wiki, adf, storage) to convert Markdown, or from (wiki, adf, storage) to convert to Markdown. Returns { from, to, output, lossless, losses, roundTrip, verified }: output is the converted document (an ADF object for adf, text otherwise); every construct the target has no equivalent for (a panel, a mention, merged cells, a task list in wiki markup) is listed in losses with its position; the output is converted back and compared block by block, and lossless says whether nothing was lost. ADF output is validated against the ADF schema before it is returned. Local only.',
  input: z.object({
    ...inputFields,
    from: FORMAT.optional().describe('The input format: md (default), wiki, adf or storage'),
    to: FORMAT.optional().describe('The output format: md (default), wiki, adf or storage. One of from and to must be md'),
  }),
  writes: false,
  args: [fileArgument],
  options: [
    inputFileOption, textOption,
    { flags: '--from <format>', field: 'from', description: 'The input format: md, wiki, adf or storage (default: "md")' },
    { flags: '--to <format>', field: 'to', description: 'The output format: md, wiki, adf or storage (default: "md")' },
  ],
  examples: [
    { text: EXAMPLE_MD, to: 'adf' },
    { inputFile: 'docs/bug-report.md', to: 'wiki' },
    { inputFile: 'docs/runbook.md', to: 'storage' },
    { inputFile: 'docs/PROJ-142.wiki', from: 'wiki' },
    { inputFile: 'docs/PROJ-142.adf.json', from: 'adf' },
    { inputFile: 'docs/release-notes.storage.xml', from: 'storage' },
  ],
  run: async (input, ctx) => {
    // The input is read here, not in the lazy module: the reader brings zod, which a lazily loaded module must not (docs/util.md).
    const { convertMarkdown, formats, MAX_BYTES } = await import('./md/convert.js');
    formats(input);
    const source = await openInput(ctx, input, { maxBytes: MAX_BYTES });
    const text = await source.text();
    return convertMarkdown({ from: input.from, to: input.to, text, source }, ctx);
  },
});

export const mdCommands = [mdCommand];
