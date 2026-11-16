import { z } from 'zod';
import { defineCommand } from '../../core/command.js';
import { DEFAULT_MAX_BYTES, fileArgument, inputFields, openInput, inputFileOption, textOption, type InputContext } from './kit/input.js';
import type { BoundedLimits } from './kit/bounded.js';
import type { LogOptions, LogTriage } from './log/triage.js';

/**
 * `util log`: triages a large log (a CI console, a build, a test run) into
 * what an agent needs to read: the error and warning lines grouped by a
 * normalised signature, each with its count, first and last line and one
 * sample, and the stack trace that follows it. Files of any size stream in
 * constant memory. The work is in ./log/triage.ts, loaded only when this runs (runLog).
 * A log is the one document everyone writes and nobody reads; this reads it.
 */

const LEVELS = ['error', 'warning'] as const;

/**
 * Checks the filters, opens the input and triages it. The input is opened
 * here, not in ./log/triage.ts, because the reader imports zod, and zod
 * reached through import() breaks the bundle's startup (docs/util.md). A file
 * streams with no size cap; stdin and text are held for the re-read, so they
 * keep the reader's.
 */
export async function runLog(ctx: InputContext, fields: { inputFile?: string | undefined; text?: string | undefined }, options: LogOptions, limits?: BoundedLimits): Promise<LogTriage> {
  const { MAX_LINE, parseFilters, triageLog } = await import('./log/triage.js');
  const filters = parseFilters(options);
  const streams = fields.text === undefined && fields.inputFile !== undefined && fields.inputFile !== '-';
  const input = await openInput(ctx, fields, { maxBytes: streams ? Number.POSITIVE_INFINITY : DEFAULT_MAX_BYTES, maxLineLength: MAX_LINE });
  // --grep runs in the bounded worker under its deadline (log/triage.ts, grepped); `limits` replaces the defaults only in tests.
  return triageLog(input, filters, options, ctx.warn, { signal: ctx.signal, ...(limits ? { limits } : {}) });
}

export const SAMPLE_LOG = [
  '[2026-10-14T09:12:20.411Z] [INFO] Running com.imagile.payments.OrderServiceTest',
  '[2026-10-14T09:12:20.412Z] [ERROR] Order 1041 failed: tax total is negative',
  '[2026-10-14T09:12:20.412Z] java.lang.IllegalStateException: tax total is negative',
  '[2026-10-14T09:12:20.412Z] \tat com.imagile.payments.Order.total(Order.java:58)',
  '[2026-10-14T09:12:20.413Z] [ERROR] Order 1042 failed: tax total is negative',
  '[2026-10-14T09:12:21.002Z] [WARNING] Tests run: 4, Failures: 0, Errors: 0, Skipped: 1',
  '',
].join('\n');

export const logCommand = defineCommand({
  path: ['util', 'log'],
  description: 'Triage a large log into grouped errors and warnings, with counts, line numbers, samples and stack traces',
  toolDescription:
    'Reads a log file (a CI console, a Maven, npm or dotnet build, a test run) and returns its error and warning lines grouped by a normalised signature (numbers, ids, timestamps and hex replaced), errors first: each group has its count, first and last line number, one sample line, and the Java, .NET, Node or Python stack trace joined to it. Filters: since (lines dated at or after a timestamp), level (error only), grep (a regex on the line). Optionally context lines around each sample. Every reported line number is re-read from the file to confirm it, and the counts are checked; data.verified says what was checked. Lines with no level are counted, not grouped. Local only. Large files stream in constant memory; pass a file rather than text for anything big.',
  input: z.object({
    ...inputFields,
    since: z.string().optional().describe('Only lines dated at or after this ISO 8601 timestamp (2026-10-14T09:12:00Z). A line takes the date of the last dated line before it; without a zone it is read as UTC'),
    level: z.enum(LEVELS).optional().describe('The lowest level to report: warning (the default) reports errors and warnings, error reports errors only'),
    grep: z.string().optional().describe('Only error and warning lines matching this JavaScript regular expression (case-sensitive, no slashes). An error also matches by the exception line heading its trace; frames are not searched'),
    maxGroups: z.number().int().min(1).max(1000).optional().describe('The most groups to return (default 50, up to 1000). Errors come first, then warnings, each in order of first appearance'),
    context: z.number().int().min(0).max(20).optional().describe('Lines to show before and after each group\'s sample line (default 0, up to 20)'),
  }),
  writes: false,
  timeLimitMs: 30 * 60_000,
  args: [fileArgument],
  options: [
    inputFileOption, textOption,
    { flags: '--since <timestamp>', field: 'since', description: 'Only lines dated at or after this ISO 8601 timestamp; undated lines take the last date before them' },
    { flags: '--level <level>', field: 'level', description: 'warning (default: errors and warnings) or error (errors only)' },
    { flags: '--grep <regex>', field: 'grep', description: 'Only error and warning lines matching this regular expression, or errors whose trace starts with a matching exception line' },
    { flags: '--max-groups <n>', field: 'maxGroups', description: 'The most groups to return (default 50, up to 1000)' },
    { flags: '--context <n>', field: 'context', description: 'Lines to show around each sample (default 0, up to 20)' },
  ],
  examples: [
    { inputFile: 'logs/maven.log' },
    { inputFile: 'logs/jenkins.log', level: 'error', since: '2026-10-14T09:12:20Z', context: 2 },
    { inputFile: 'logs/npm.log', grep: 'TS\\d+', maxGroups: 5 },
    { inputFile: 'logs/dotnet.log' },
    { text: SAMPLE_LOG },
  ],
  run: async (input, ctx) => {
    const { inputFile, text, ...options } = input;
    return runLog(ctx, { inputFile, text }, options);
  },
});

export const logCommands = [logCommand];
