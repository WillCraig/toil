import type { AdfDocument } from '../../jira/cloud/adf.js';
import { ToilError } from '../../../core/errors.js';
import type { Warning } from '../../../core/envelope.js';
import type { BoundedLimits, BoundedTask } from '../kit/bounded.js';
import type { UtilInput } from '../kit/input.js';
import { Verifier, type Verified } from '../kit/verify.js';
import type { Loss } from './ast.js';
import type { Converted } from './core.js';

/**
 * `util md`: one document converted between Markdown and Jira wiki markup,
 * ADF or Confluence storage format, then checked by converting it back.
 *
 *   1. The input is read into the shared tree (ast.ts), noting losses.
 *   2. The tree is written in the target format, noting losses.
 *   3. The output is read back into a tree and both trees are printed as
 *      canonical Markdown, block by block. Every block that differs is a
 *      difference; a difference with a loss reported in the same block was
 *      expected, and one without is a failed check (`MD_ROUNDTRIP_MISMATCH`).
 *   4. ADF output is validated against the ADF schema, and storage output is
 *      read back as XML, before either is returned. Neither can be returned
 *      broken.
 *
 * `lossless` is true only when nothing was lost and the round trip matched
 * block for block. The conversion is graded by the same office that issued it,
 * which is why the grading is published.
 *
 * Steps 1 to 3 run in the bounded worker (md/core.ts, kit/bounded.ts), under
 * {@link MD_LIMITS}: a document's emphasis and nesting decide what parsing
 * it costs. This module keeps the comparison and the checks.
 */

export type Format = 'md' | 'wiki' | 'adf' | 'storage';

/**
 * The deadline and memory each worker step (the conversion, then the read
 * back) may use: 10 s and 1,024 MB. A 4 MiB document, the input cap, of
 * ordinary headings, lists, tables and links took under 4 s for the whole
 * command and peaked at 445 MB in the worker (#200), more than the 256 MB
 * default, so these leave a slow runner room and still stop a document
 * built to backtrack, which ran for minutes at a fraction of the cap.
 */
export const MD_LIMITS = { timeoutMs: 10_000, maxMemoryMb: 1_024 } as const;
const MD_FIX = 'Pass a smaller document, or one with less deeply nested quotes, lists and emphasis.';

export interface MdInput {
  inputFile?: string | undefined;
  text?: string | undefined;
  from?: Format | undefined;
  to?: Format | undefined;
}

export interface Difference {
  /** Where the block starts in the input. */
  at: string;
  /** The block as canonical Markdown before the round trip, and after. */
  expected: string;
  actual: string;
  /** Whether a loss was reported for this block. */
  explained: boolean;
}

export interface MdData {
  from: Format;
  to: Format;
  /** The converted document: an ADF document object for `adf`, text for the others. */
  output: string | AdfDocument;
  lossless: boolean;
  losses: Loss[];
  roundTrip: { blocks: number; differences: Difference[] };
  verified: Verified;
}

/** Stand-ins a test uses to break the conversion on purpose and watch the checks catch it. */
export interface Hooks {
  tamper?: (output: string | AdfDocument) => string | AdfDocument;
  /** The worker steps' limits in place of MD_LIMITS, so a test can watch a short deadline stop one. */
  limits?: BoundedLimits;
}

/** The input cap: a ticket or page, not an archive. */
export const MAX_BYTES = 4 * 1024 * 1024;
const MAX_DIFFERENCES = 50;
const MAX_LOSSES = 500;

const NAMES: Record<Format, string> = { md: 'Markdown', wiki: 'Jira wiki markup', adf: 'ADF', storage: 'Confluence storage format' };

/**
 * Runs one md step in the bounded worker. `limits` replaces MD_LIMITS only
 * in tests. Input that doesn't parse comes back as its own INVALID_INPUT.
 */
async function mdStep<T>(step: string, task: BoundedTask, signal: AbortSignal | undefined, limits: BoundedLimits): Promise<T> {
  const { boundedStep } = await import('../kit/bounded.js');
  return boundedStep<T>(step, task, { ...limits, signal }, MD_FIX);
}

/** A longest-common-subsequence alignment of two lists of strings, as the runs that differ. */
function hunks(a: string[], b: string[]): Array<{ a: [number, number]; b: [number, number] }> {
  const n = a.length;
  const m = b.length;
  // Past a few million cells the table costs more than it tells: compare position by position.
  if (n * m > 4_000_000) {
    const out: Array<{ a: [number, number]; b: [number, number] }> = [];
    for (let k = 0; k < Math.max(n, m); k++) if (a[k] !== b[k]) out.push({ a: [Math.min(k, n), Math.min(k + 1, n)], b: [Math.min(k, m), Math.min(k + 1, m)] });
    return out;
  }
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: Array<{ a: [number, number]; b: [number, number] }> = [];
  let i = 0;
  let j = 0;
  let open: { a: [number, number]; b: [number, number] } | undefined;
  const close = () => {
    if (open) out.push(open);
    open = undefined;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      close();
      i++;
      j++;
      continue;
    }
    open ??= { a: [i, i], b: [j, j] };
    if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) open.b[1] = ++j;
    else open.a[1] = ++i;
  }
  close();
  return out;
}

/** The two formats, or INVALID_INPUT: one of them must be Markdown, and they must differ. */
export function formats(input: Pick<MdInput, 'from' | 'to'>): { from: Format; to: Format } {
  const from: Format = input.from ?? 'md';
  const to: Format = input.to ?? 'md';
  if (from === to || (from !== 'md' && to !== 'md')) {
    throw new ToilError('INVALID_INPUT', from === to ? `Nothing to convert: from and to are both ${NAMES[from]}.` : `util md converts to or from Markdown, not from ${NAMES[from]} to ${NAMES[to]}.`, {
      fix: 'Pass --to wiki|adf|storage to convert Markdown, or --from wiki|adf|storage to convert to Markdown.',
    });
  }
  return { from, to };
}

/**
 * Converts `text`, read from `source`, checks the result, and returns it with
 * what was checked. The command reads the input before this module loads:
 * the input reader brings zod with it, which must stay out of anything
 * loaded lazily (docs/util.md).
 */
export async function convertMarkdown(
  input: { from?: Format | undefined; to?: Format | undefined; text: string; source: Pick<UtilInput, 'source' | 'expectedBytes' | 'bytesRead' | 'truncated' | 'label'> },
  ctx: { warn: (w: Warning) => void; signal?: AbortSignal | undefined },
  hooks: Hooks = {},
): Promise<MdData> {
  const { from, to } = formats(input);
  const { text, source } = input;
  const v = new Verifier(ctx.warn);
  v.inputComplete(source);

  const limits = { ...MD_LIMITS, ...hooks.limits };
  const label = source.label.replace(/^the /, 'The ');
  const read = await mdStep<Converted>(`Converting ${source.label}`, { kind: 'md-convert', from, to, text, label }, ctx.signal, limits);
  const losses = { list: read.losses };
  if (from === 'adf') {
    const schema = await validateAdf(JSON.parse(text), ctx.signal, limits.maxMemoryMb);
    if (schema.unchecked !== undefined) v.unchecked('input.adf.schema', schema.unchecked);
    else v.expect('input.adf.schema', schema.valid, { at: schema.problems[0]?.pointer ?? '', expected: 'a document the ADF schema accepts', actual: schema.problems[0]?.message }, { code: 'ADF_INPUT_INVALID', message: `The input doesn't match the ADF schema at ${schema.problems[0]?.pointer || '/'}: ${schema.problems[0]?.message ?? ''} (${schema.total} problem(s)); it was converted as far as it could be read.` });
  }

  let output = read.output;
  if (hooks.tamper) output = hooks.tamper(output);

  if (to === 'adf') {
    const schema = await validateAdf(output, ctx.signal, limits.maxMemoryMb);
    if (schema.unchecked !== undefined) v.unchecked('output.adf.schema', schema.unchecked);
    else if (!schema.valid) {
      const where = schema.problems.slice(0, 3).map((p) => `${p.pointer || '/'}: ${p.message}`).join('; ');
      throw new ToilError('INTERNAL', `The ADF this produced doesn't match the ADF schema (${schema.total} problem(s): ${where}), so it isn't returned.`, {
        fix: 'This is a bug in util md: report it with the input that caused it. Converting to wiki or storage instead may work in the meantime.',
      });
    } else v.pass('output.adf.schema');
  }

  // The round trip: read what was written, and compare it with what was read, block by block.
  const { boundedError, runBounded } = await import('../kit/bounded.js');
  const back = await runBounded<string[]>({ kind: 'md-read', format: to, output }, { ...limits, signal: ctx.signal });
  if (!back.ok) {
    // Output that doesn't read back is this command's own fault, not the input's; a limit is still the limit.
    if (back.cause === 'refused' && to === 'storage') {
      throw new ToilError('INTERNAL', `The storage format this produced is not well-formed XML (${back.reason}), so it isn't returned.`, {
        fix: 'This is a bug in util md: report it with the input that caused it.',
      });
    }
    throw boundedError(`Reading back the ${NAMES[to]} this produced`, back, limits, MD_FIX);
  }
  if (to === 'storage') v.pass('output.storage.wellFormed');

  const before = read.blocks;
  const after = back.value;
  const lostIn = new Set(losses.list.map((l) => l.block));
  const differences: Difference[] = [];
  const diff = hunks(before, after);
  const changed = new Set<number>();
  let judged = 0;
  const judge = (aFrom: number, aTo: number, bFrom: number, bTo: number) => {
    const blocks = Array.from({ length: aTo - aFrom }, (_, k) => aFrom + k);
    for (const k of blocks) changed.add(k);
    // Only a block's own loss explains it. A run that gained or lost blocks is
    // explained only if every block in it had one; a block from nowhere never is.
    const explained = blocks.length > 0 && blocks.every((k) => lostIn.has(k));
    const at = read.at[aFrom] ?? read.at.at(-1) ?? 'the end';
    const expected = before.slice(aFrom, aTo).join('\n\n');
    const actual = after.slice(bFrom, bTo).join('\n\n');
    v.expect('roundTrip.blocks', explained, { at, expected, actual }, { code: 'MD_ROUNDTRIP_MISMATCH' });
    judged++;
    if (differences.length < MAX_DIFFERENCES) differences.push({ at, expected, actual, explained });
  };
  for (const h of diff) {
    const [a0, a1] = h.a;
    const [b0, b1] = h.b;
    // The same number of blocks on both sides: each changed into its counterpart, judged on its own.
    if (a1 - a0 === b1 - b0) for (let k = 0; k < a1 - a0; k++) judge(a0 + k, a0 + k + 1, b0 + k, b0 + k + 1);
    else judge(a0, a1, b0, b1);
  }
  for (let k = 0; k < before.length; k++) if (!changed.has(k)) v.pass('roundTrip.blocks');
  if (before.length === 0 && diff.length === 0) v.pass('roundTrip.blocks');
  if (judged > MAX_DIFFERENCES) ctx.warn({ code: 'MD_DIFFERENCES_CUT', message: `${judged} blocks differ after the round trip; the first ${MAX_DIFFERENCES} are listed.` });

  reportLosses(losses, ctx.warn);
  return {
    from,
    to,
    output,
    lossless: diff.length === 0 && losses.list.length === 0,
    losses: losses.list.slice(0, MAX_LOSSES).map(({ construct, at, detail }) => ({ construct, at, detail })),
    roundTrip: { blocks: before.length, differences },
    verified: v.done(),
  };
}

/** One warning per kind of loss, with where it happened. */
function reportLosses(losses: { list: Loss[] }, warn: (w: Warning) => void) {
  const byConstruct = new Map<string, Loss[]>();
  for (const loss of losses.list) {
    const list = byConstruct.get(loss.construct) ?? [];
    list.push(loss);
    byConstruct.set(loss.construct, list);
  }
  for (const [construct, list] of byConstruct) {
    const places = [...new Set(list.map((l) => l.at))];
    const shown = places.slice(0, 5).join(', ') + (places.length > 5 ? `, and ${places.length - 5} more` : '');
    warn({ code: 'MD_LOSSY', message: `${construct} at ${shown}: ${list[0]!.detail}.` });
  }
  if (losses.list.length > MAX_LOSSES) warn({ code: 'MD_LOSSES_CUT', message: `${losses.list.length} losses were found; data.losses lists the first ${MAX_LOSSES}.` });
}

let adfSchema: unknown;

/** Validates against the bundled ADF schema (@atlaskit/adf-schema's full.json), loading both only when asked. */
export async function validateAdf(value: unknown, signal?: AbortSignal, maxMemoryMb: number = MD_LIMITS.maxMemoryMb) {
  const [{ validateBounded }, schema] = await Promise.all([import('../kit/bounded.js'), adfSchema ?? import('./adf-schema.json', { with: { type: 'json' } }).then((m) => m.default)]);
  adfSchema = schema;
  // In a bounded worker: a document can make the ADF schema's anyOf branches cost more than any reply is worth.
  // Under md's own memory limit, so a conversion's steps share one warm worker: a different limit means a fresh one (kit/bounded.ts, workerFor).
  const result = await validateBounded(schema as never, value, { signal, key: 'adf', maxMemoryMb });
  return { ...result, problems: result.problems.slice(0, 20) };
}

