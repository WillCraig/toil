import { z } from 'zod';
import { defineCommand } from '../../core/command.js';
import type { CommandContext } from '../../core/context.js';
import { openInput } from './kit/input.js';

/**
 * `util time`: the date and time arithmetic that is easy to get subtly
 * wrong. Converting between zones, ISO 8601 durations, business days and
 * cron run times, all on the runtime's own Intl time zone data. Each command
 * checks its own answer a second way and says so in `data.verified`, and a
 * wall clock a zone skipped or showed twice is always a warning, never a
 * quiet choice.
 *
 * This file is only the definitions, which the registry and `--help` read at
 * startup; the work is in `./time/`, loaded when a command runs. The clock is
 * read once per call, here, and handed down, so nothing below it asks what
 * time it is. Time is, after all, a resource that requires sign-off.
 */

const zoneField = (what: string) => z.string().optional().describe(`${what}, as an IANA zone name such as America/New_York (default: UTC)`);
const TIME = 'ISO 8601 (2026-03-08, 2026-03-08T02:30, 2026-03-08T07:30:00Z, 2026-03-08T02:30:00-05:00), @<epoch seconds>, or now';

const holidayFields = {
  zone: zoneField('The zone whose calendar days count, and the zone of any time given without an offset'),
  holidaysFile: z.string().optional().describe('A file inside the workspace listing holidays, one YYYY-MM-DD per line, optionally followed by a name; # starts a comment'),
  holiday: z.array(z.string()).optional().describe('A holiday as YYYY-MM-DD (repeatable)'),
};

const holidayOptions = [
  { flags: '--zone <zone>', field: 'zone', description: 'The zone whose calendar days count (default: UTC)' },
  { flags: '--holidays-file <path>', field: 'holidaysFile', description: 'A file of holidays, one YYYY-MM-DD per line', deprecated: ['--holidays <file>'] },
  { flags: '--holiday <date>', field: 'holiday', description: 'A holiday as YYYY-MM-DD (repeatable)' },
];

const now = () => Date.now();

/**
 * The holiday file's lines, read here rather than in the lazily loaded code:
 * that code must not import zod, and the input reader's module does
 * (docs/util.md, Lazy loading). A holiday list over 1 MiB is not a list.
 */
async function holidayFile(ctx: CommandContext<unknown>, file: string | undefined) {
  if (file === undefined) return undefined;
  const input = await openInput(ctx, { inputFile: file }, { maxBytes: 1024 * 1024 });
  const lines: Array<{ number: number; text: string }> = [];
  for await (const line of input.lines()) lines.push({ number: line.number, text: line.text });
  return { label: input.label, lines, read: { source: input.source, expectedBytes: input.expectedBytes, bytesRead: input.bytesRead, truncated: input.truncated } };
}

export const timeConvertCommand = defineCommand({
  path: ['util', 'time', 'convert'],
  description: 'Convert a time between time zones, reporting DST gaps and overlaps',
  toolDescription:
    "Converts one time into one or more IANA time zones with the runtime's own zone data: returns the UTC instant and, per zone, the local time with its offset. A time without an offset needs zone. A wall clock that a DST change skipped (a gap) or showed twice (an overlap) is reported in data and as a TIME_DST_GAP or TIME_DST_OVERLAP warning, never chosen silently. Every result is converted back and checked (data.verified). Local only.",
  input: z.object({
    time: z.string().describe(`The time to convert: ${TIME}`),
    zone: z.string().optional().describe('The IANA zone of a time written without an offset, such as America/New_York'),
    to: z.array(z.string()).optional().describe('A zone to convert to (repeatable; default: UTC)'),
  }),
  writes: false,
  args: [{ name: 'time', field: 'time', description: `The time: ${TIME}` }],
  options: [
    { flags: '--zone <zone>', field: 'zone', description: 'The zone of a time written without an offset' },
    { flags: '--to <zone>', field: 'to', description: 'A zone to convert to (repeatable) (default: UTC)' },
  ],
  examples: [
    { time: '2026-03-08T02:30', zone: 'America/New_York', to: ['UTC', 'Europe/London'] },
    { time: '2026-11-01T05:30:00Z', to: ['America/New_York', 'Asia/Kolkata'] },
  ],
  run: async (input, ctx) => {
    const { convertTime } = await import('./time/run.js');
    return convertTime(input, now(), ctx.warn);
  },
});

export const timeDurationCommand = defineCommand({
  path: ['util', 'time', 'duration'],
  description: 'Read an ISO 8601 duration, or write a number of seconds as one',
  toolDescription:
    'Parses an ISO 8601 duration (P1Y2M3DT4H5M6.5S, -PT15M) into its parts, its canonical text and its length in seconds, or with seconds writes a length as an exact duration in hours, minutes and seconds (PT26H3M). Years and months have no fixed length, so their seconds are null and reported as unchecked; days count as 24 hours and are reported as approximate. The result is read back and checked (data.verified). Local only.',
  input: z.object({
    duration: z.string().optional().describe('An ISO 8601 duration to read, such as PT1H30M or P1DT12H'),
    seconds: z.number().optional().describe('A length in seconds to write as a duration, instead of duration'),
  }),
  writes: false,
  args: [{ name: 'duration', field: 'duration', description: 'An ISO 8601 duration, such as PT1H30M', required: false }],
  options: [{ flags: '--seconds <seconds>', field: 'seconds', description: 'A number of seconds to write as a duration, instead' }],
  examples: [{ duration: 'P1DT2H30M' }, { seconds: 93784.5 }],
  run: async (input, ctx) => {
    const { durationOf } = await import('./time/run.js');
    return durationOf(input, ctx.warn);
  },
});

export const timeBusinessAddCommand = defineCommand({
  path: ['util', 'time', 'business-days', 'add'],
  description: 'Add or subtract business days, skipping weekends and listed holidays',
  toolDescription:
    'Adds business days (Monday to Friday, less any holidays given) to a date or time, as a spreadsheet WORKDAY does: the start never counts and 0 returns it unchanged. Negative days count back. Returns the result, its weekday and what was skipped. A time of day is kept, and a result in a DST gap or overlap is warned about. The count is redone day by day and checked (data.verified). No holidays are built in. Local only.',
  input: z.object({
    start: z.string().describe(`The start: ${TIME}`),
    days: z.number().int().describe('Business days to add; negative subtracts'),
    ...holidayFields,
  }),
  writes: false,
  args: [
    { name: 'start', field: 'start', description: `The start: ${TIME}` },
    { name: 'days', field: 'days', description: 'Business days to add; negative subtracts' },
  ],
  options: holidayOptions,
  examples: [
    { start: '2026-12-23', days: 3, holidaysFile: 'holidays-2026.txt' },
    { start: '2026-03-06T02:30', days: 1, zone: 'America/New_York', holiday: ['2026-01-01'] },
  ],
  run: async (input, ctx) => {
    const { addDays } = await import('./time/run.js');
    return addDays(input, now(), { warn: ctx.warn, holidayFile: await holidayFile(ctx, input.holidaysFile) });
  },
});

export const timeBusinessDiffCommand = defineCommand({
  path: ['util', 'time', 'business-days', 'diff'],
  description: 'The business time between two times, in business days and hours',
  toolDescription:
    'Measures the time between two dates or times that falls on business days (Monday to Friday, less any holidays given) in a zone: whole 24-hour business days, the hours left over, the same as an exact ISO 8601 duration, and the holidays it passed. Dates mean midnight in the zone. The split is added back up and checked against the elapsed time (data.verified). No holidays are built in. Local only.',
  input: z.object({
    start: z.string().describe(`The start: ${TIME}`),
    end: z.string().describe(`The end: ${TIME}`),
    ...holidayFields,
  }),
  writes: false,
  args: [
    { name: 'start', field: 'start', description: `The start: ${TIME}` },
    { name: 'end', field: 'end', description: `The end: ${TIME}` },
  ],
  options: holidayOptions,
  examples: [
    { start: '2026-12-24T15:00', end: '2026-12-29T10:00', zone: 'America/Chicago', holidaysFile: 'holidays-2026.txt' },
    { start: '2026-10-30T17:00:00Z', end: '2026-11-02T09:00:00Z', zone: 'Europe/Berlin', holiday: ['2026-11-02'] },
  ],
  run: async (input, ctx) => {
    const { diffDays } = await import('./time/run.js');
    return diffDays(input, now(), { warn: ctx.warn, holidayFile: await holidayFile(ctx, input.holidaysFile) });
  },
});

export const timeCronCommand = defineCommand({
  path: ['util', 'time', 'cron'],
  description: 'Explain a cron expression and list its next run times in a zone',
  toolDescription:
    "Explains a cron expression in words and lists its next run times in a zone. Dialects: standard five-field (the classic crontab rules, with macros), Quartz (seconds first, optional year, ? L W #) and Jenkins (H, hashed from the job's full name exactly as Jenkins does). The dialect is detected when not given. Run times a DST change skipped or repeated are warned about. Each run is matched against the expression again (data.verified). Local only.",
  input: z.object({
    expression: z.string().describe('The cron expression, such as "*/15 9-17 * * 1-5", "0 0 12 ? * MON#2" or "H H(0-7) * * *"'),
    dialect: z.enum(['standard', 'quartz', 'jenkins']).optional().describe('standard, quartz or jenkins (default: detected: 6 or 7 fields is quartz, an H is jenkins, otherwise standard)'),
    zone: zoneField('The zone the schedule runs in'),
    from: z.string().optional().describe(`List runs after this time (default: now): ${TIME}`),
    count: z.number().int().optional().describe('How many run times to list, 1 to 100 (default: 5)'),
    job: z.string().optional().describe("The Jenkins job's full name (folder/job), which H is hashed from"),
  }),
  writes: false,
  args: [{ name: 'expression', field: 'expression', description: 'The cron expression, quoted' }],
  options: [
    { flags: '--dialect <dialect>', field: 'dialect', description: 'standard, quartz or jenkins (default: detected)' },
    { flags: '--zone <zone>', field: 'zone', description: 'The zone the schedule runs in (default: UTC)' },
    { flags: '--from <time>', field: 'from', description: 'List runs after this time (default: now)' },
    { flags: '--count <n>', field: 'count', description: 'How many run times to list, 1 to 100 (default: 5)' },
    { flags: '--job <name>', field: 'job', description: "The Jenkins job's full name, which H is hashed from" },
  ],
  examples: [
    { expression: '30 2 * * *', zone: 'America/New_York', from: '2026-03-07T00:00:00Z', count: 3 },
    { expression: '0 0 12 ? * MON#2', dialect: 'quartz', zone: 'Europe/London', from: '2026-01-01T00:00:00Z' },
    { expression: 'H H(0-7) * * 1-5', dialect: 'jenkins', job: 'platform/api-build', from: '2026-10-01T00:00:00Z' },
  ],
  run: async (input, ctx) => {
    const { cronRuns } = await import('./time/run.js');
    return cronRuns(input, now(), ctx.warn);
  },
});

export const timeCommands = [timeConvertCommand, timeDurationCommand, timeBusinessAddCommand, timeBusinessDiffCommand, timeCronCommand];
