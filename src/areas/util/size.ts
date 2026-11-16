import { z } from 'zod';
import { defineCommand } from '../../core/command.js';
import { fileArgument, inputFields, inputFileOption, textOption } from './kit/input.js';
import { DEFAULT_DEPTH, DEFAULT_TOP, LANGUAGES, measure } from './size/measure.js';

/**
 * `util size`: how big something is before an agent reads it. For one file,
 * bytes, lines and an estimated token count, plus an outline (code symbols
 * with line ranges, Markdown headings, JSON and YAML top-level keys). For a
 * folder, a `.gitignore`-aware totals tree with the largest files named.
 * Local only: it reads files and talks to nothing. The measuring module is
 * imported statically because it reads input through kit/input.ts (and so
 * zod); the outliners it calls load on first use. Measure twice, read once,
 * as the facilities department never says.
 */

const LANGUAGE = `The language to outline it as, for stdin or text, or to override the file extension: ${LANGUAGES.join(', ')}`;
const TOP = `For a folder: how many of the largest files to list (default ${DEFAULT_TOP})`;
const DEPTH = `For a folder: how many levels of subfolders the tree shows (default ${DEFAULT_DEPTH}); deeper folders are counted in their parent's totals`;

export const sizeCommand = defineCommand({
  path: ['util', 'size'],
  description: 'Count bytes, lines and estimated tokens for a file or folder, and outline a file (local only)',
  toolDescription:
    'Sizes something before you read it. For a file: { kind: "file", path, language, bytes, lines, tokens, tokenMethod, outline: { precision, method, symbols[] of { name, kind, startLine, endLine, container } } | null, notOutlined: { reason: binary | unsupported-language | parse-error | too-large, detail } | null, verified }. Outlines cover TypeScript, JavaScript, Python, C#, Java and Go (functions, classes, types, methods, exported names, by a syntactic scan, not a compiler), Markdown headings, and JSON/YAML top-level keys. For a folder: { kind: "folder", path, totals, tree (folders largest first, with files, bytes, lines, tokens, binaryFiles), largest[], skipped[], verified }, skipping what .gitignore ignores. Tokens are estimated as ceil(characters / 4), not counted by any model\'s tokenizer. Each symbol\'s start line is re-read to confirm it names the symbol, and folder totals are summed two ways; data.verified says what was checked. Local only, no network.',
  input: z.object({
    ...inputFields,
    inputFile: z.string().optional().describe('A file or folder inside the workspace to size. On the CLI, - (or leaving out both inputFile and text) reads stdin'),
    language: z.enum(LANGUAGES).optional().describe(LANGUAGE),
    top: z.number().int().min(0).max(1000).optional().describe(TOP),
    depth: z.number().int().min(0).max(100).optional().describe(DEPTH),
  }),
  writes: false,
  args: [fileArgument],
  options: [
    { ...inputFileOption, description: 'A file or folder inside the workspace to size, or - for stdin (the default when no --text is given)' }, textOption,
    { flags: '--language <language>', field: 'language', description: LANGUAGE },
    { flags: '--top <n>', field: 'top', description: TOP },
    { flags: '--depth <n>', field: 'depth', description: DEPTH },
  ],
  examples: [
    { inputFile: 'samples/size' },
    { inputFile: 'samples/size', top: 3, depth: 1 },
    { inputFile: 'samples/size/verify.ts' },
    { inputFile: 'samples/size/flatted.py' },
    { text: '# Notes\n\n## Budget\n\nTwo lines.\n', language: 'markdown' },
  ],
  run: (input, ctx) => measure(input, ctx),
});

export const sizeCommands = [sizeCommand];
