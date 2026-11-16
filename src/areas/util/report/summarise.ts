import type { CommandContext } from '../../../core/context.js';
import { ToilError } from '../../../core/errors.js';
import { openInput, type ReadOptions, type UtilInput } from '../kit/input.js';
import { Verifier, type Verified } from '../kit/verify.js';
import { localName } from '../kit/xml.js';
import { readCobertura } from './cobertura.js';
import { readJunit } from './junit.js';
import { readLcov } from './lcov.js';
import { readSarif } from './sarif.js';
import { Skips, type CoverageSummary, type FindingsSummary, type ReportFormat, type SkippedElement, type TestsSummary } from './shared.js';
import { readTrx } from './trx.js';

/**
 * `util report`'s work: detect the
 * format from the content (or take `--format`), stream it through that
 * format's reader, and return one summary with what was checked. One
 * of `tests`, `findings` or `coverage` is filled in, by format; the
 * other two are null. Fields that don't apply are left blank, not
 * filled in with "N/A" by hand.
 */

export interface ReportInput {
  inputFile?: string | undefined;
  text?: string | undefined;
  format?: ReportFormat | undefined;
  lowest?: number | undefined;
}

export interface ReportData {
  format: ReportFormat;
  /** Whether the format was detected from the content or given as --format. */
  formatFrom: 'content' | 'flag';
  tests: TestsSummary | null;
  findings: FindingsSummary | null;
  coverage: CoverageSummary | null;
  skipped: { count: number; elements: SkippedElement[] };
  verified: Verified;
}

type Ctx = Pick<CommandContext<unknown>, 'files' | 'warn' | 'signal'>;

/** How much of the start of the input detection looks at. */
const HEAD = 16 * 1024;
/** How many of the lowest-covered files to list when the call doesn't say. */
export const DEFAULT_LOWEST = 10;

/** The report a document's opening says it is, or undefined when it doesn't say. */
export function detectFormat(head: string): ReportFormat | undefined {
  // trimStart() takes a byte-order mark with the whitespace.
  const text = head.trimStart();
  if (text.startsWith('{')) return /"runs"\s*:|"\$schema"\s*:\s*"[^"]*sarif/i.test(text) ? 'sarif' : undefined;
  if (text.startsWith('<')) {
    // Past the prolog: the XML declaration, comments, processing instructions and a DOCTYPE.
    let rest = text;
    for (;;) {
      const before = rest;
      rest = rest.replace(/^<\?[\s\S]*?\?>\s*/, '').replace(/^<!--[\s\S]*?-->\s*/, '').replace(/^<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>\s*/i, '');
      if (rest === before) break;
    }
    const root = /^<([A-Za-z_][\w.:-]*)/.exec(rest)?.[1];
    if (root === undefined) return undefined;
    const name = localName(root);
    if (name === 'testsuites' || name === 'testsuite') return 'junit';
    if (name === 'TestRun') return 'trx';
    if (name === 'coverage') return 'cobertura';
    return undefined;
  }
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  return /^(TN|SF|VER):/.test(first) ? 'lcov' : undefined;
}

/** The first {@link HEAD} characters of the input, read and left. */
async function head(input: UtilInput): Promise<string> {
  const decoder = new TextDecoder('utf-8');
  let text = '';
  for await (const chunk of input.chunks()) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length >= HEAD) break;
  }
  return text;
}

export async function summariseReport(input: ReportInput, ctx: Ctx, readOptions: ReadOptions = {}): Promise<ReportData> {
  const source = await openInput(ctx, input, readOptions);
  let format = input.format;
  const formatFrom = format === undefined ? 'content' : 'flag';
  if (format === undefined) {
    format = detectFormat(await head(source));
    if (format === undefined) {
      throw new ToilError('INVALID_INPUT', `Couldn't tell what kind of report ${source.label} is: it doesn't start like JUnit, TRX, SARIF, lcov or Cobertura.`, {
        fix: 'Pass --format (format over MCP): junit, trx, sarif, lcov or cobertura.',
      });
    }
  }
  const lowest = input.lowest ?? DEFAULT_LOWEST;
  const v = new Verifier(ctx.warn);
  const skips = new Skips();
  let tests: TestsSummary | null = null;
  let findings: FindingsSummary | null = null;
  let coverage: CoverageSummary | null = null;
  switch (format) {
    case 'junit':
      tests = await readJunit(source, v, skips);
      break;
    case 'trx':
      tests = await readTrx(source, v, skips);
      break;
    case 'sarif':
      findings = await readSarif(source, v, skips, ctx);
      break;
    case 'lcov':
      coverage = await readLcov(source, v, skips, lowest);
      break;
    case 'cobertura':
      coverage = await readCobertura(source, v, skips, lowest);
      break;
  }
  if (tests) {
    const fromStack = tests.failures.filter((f) => f.location === 'stack').length;
    if (fromStack > 0) {
      v.approximated('failures.location', `${fromStack} of ${tests.failures.length} failures take file and line from a stack frame (location: "stack"), not from the report, which states none`);
    }
  }
  v.inputComplete(source);
  const elements = skips.list();
  if (elements.length) {
    const shown = elements.slice(0, 5).map((s) => `${s.element} x${s.count} (${s.reason})`).join('; ');
    ctx.warn({ code: 'REPORT_ELEMENTS_SKIPPED', message: `${skips.count} element${skips.count === 1 ? ' was' : 's were'} skipped, not read: ${shown}${elements.length > 5 ? '; and more in data.skipped' : ''}.` });
  }
  return { format, formatFrom, tests, findings, coverage, skipped: { count: skips.count, elements }, verified: v.done() };
}
