import type { Warning } from '../../../core/envelope.js';
import { ToilError } from '../../../core/errors.js';
import type { UtilInput } from '../kit/input.js';
import { Verifier, type Verified } from '../kit/verify.js';
import { addBusinessDays, addHolidayLine, countBusinessDays, isBusinessDay, isWeekend, showDay, type Holidays } from './business.js';
import { cronEvents, detectDialect, explainCron, HORIZON_YEARS, parseCron, wallMatches, WEEKDAY_NAMES, type CronSchedule, type Dialect } from './cron.js';
import { describeDuration, durationFromMs, durationMs, formatDuration, parseDuration } from './duration.js';
import {
  checkZone,
  dateOfDay,
  dayNumber,
  formatInstant,
  formatLocal,
  formatOffset,
  formatWall,
  parseTime,
  resolveWall,
  wallAt,
  weekdayOfDay,
  type Resolution,
  type Wall,
} from './zone.js';

/**
 * What each `util time` command does, given the clock reading its call took
 * once (`now`). Each one works out its answer, then checks it a second way
 * through the same Verifier, and the checks are exported on their own so a
 * test can hand them a wrong answer and watch them catch it. Marking your
 * own homework is permitted, provided the marking scheme is published.
 */

type Warn = (warning: Warning) => void;

/** The instant a time written with an offset stands for, or null. The checks read results back through this. */
function instantOf(text: string): number | null {
  const value = parseTime(text, 0, 'result').value;
  return value.kind === 'instant' ? value.instant : null;
}

/** The wall clock a time written without an offset shows, or null. */
function wallOf(text: string): Wall | null {
  const value = parseTime(text, 0, 'result').value;
  return value.kind === 'instant' ? null : value.wall;
}

// ---- Shared: DST reporting ----

/** A wall clock a zone skipped or showed twice, as `data` reports it. */
export type DstNote =
  | { kind: 'gap'; wall: string; zone: string; gapSeconds: number; offsetBefore: string; offsetAfter: string; resolvedTo: string }
  | { kind: 'overlap'; wall: string; zone: string; earlier: string; later: string; chosen: 'earlier' };

export type GapNote = Extract<DstNote, { kind: 'gap' }>;

function dstNote(wall: Wall, zone: string, r: Resolution): DstNote | undefined {
  if (r.kind === 'gap') {
    return { kind: 'gap', wall: formatWall(wall), zone, gapSeconds: r.gapSeconds, offsetBefore: formatOffset(r.offsetBefore), offsetAfter: formatOffset(r.offsetAfter), resolvedTo: formatLocal(r.instant, zone).local };
  }
  if (r.kind === 'overlap') return { kind: 'overlap', wall: formatWall(wall), zone, earlier: formatLocal(r.instant, zone).local, later: formatLocal(r.later, zone).local, chosen: 'earlier' };
  return undefined;
}

function warnDst(warn: Warn, note: DstNote, what: string): void {
  if (note.kind === 'gap') {
    warn({
      code: 'TIME_DST_GAP',
      message: `${what} ${note.wall} does not exist in ${note.zone}: the clocks jumped from ${note.offsetBefore} to ${note.offsetAfter}, skipping ${note.gapSeconds / 60} minutes. It was read as ${note.resolvedTo}, the time the clocks showed after the jump. Pass a time with an offset to choose another.`,
    });
  } else {
    warn({
      code: 'TIME_DST_OVERLAP',
      message: `${what} ${note.wall} happened twice in ${note.zone}, at ${note.earlier} and again at ${note.later}. It was read as the earlier one. Pass a time with an offset to choose the later.`,
    });
  }
}

/** A time argument as an instant: an offset or `now` is one already; a wall clock or date is resolved in `zone`, reporting a gap or overlap. */
function toInstant(text: string, field: string, zone: string | undefined, now: number, v: Verifier, warn: Warn): { instant: number; wall?: Wall; dateOnly: boolean; note?: DstNote } {
  const parsed = parseTime(text, now, field);
  if (parsed.truncated) v.approximated(`${field}.precision`, `the digits of ${field} below a millisecond were dropped`);
  const value = parsed.value;
  if (value.kind === 'instant') return { instant: value.instant, dateOnly: false };
  if (zone === undefined) {
    throw new ToilError('INVALID_INPUT', `${field} "${text}" has no offset, so it doesn't name one instant.`, {
      fix: `Pass zone with the IANA zone it is in (America/New_York), or give it an offset: ${formatWall(value.wall)}Z.`,
    });
  }
  const r = resolveWall(value.wall, zone);
  const note = dstNote(value.wall, zone, r);
  if (note) warnDst(warn, note, field);
  return { instant: r.instant, wall: value.wall, dateOnly: value.kind === 'date', ...(note ? { note } : {}) };
}

// ---- convert ----

export interface ConvertInput {
  time: string;
  zone?: string | undefined;
  to?: string[] | undefined;
}

export interface Converted {
  zone: string;
  local: string;
  offset: string;
  offsetSeconds: number;
  /** Set when this wall clock happened twice in the zone; `local`'s offset says which. */
  dst?: DstNote;
}

export interface ConvertData {
  input: string;
  instant: string;
  epochMs: number;
  source: { kind: 'instant' | 'wall' | 'date'; zone: string | null; offset: string | null; dst?: DstNote };
  results: Converted[];
  verified: Verified;
}

export function convertTime(input: ConvertInput, now: number, warn: Warn): ConvertData {
  const v = new Verifier(warn);
  const parsed = parseTime(input.time, now, 'time').value;
  if (parsed.kind === 'instant' && input.zone !== undefined) {
    throw new ToilError('INVALID_INPUT', `time "${input.time}" is already an instant, so zone has nothing to place.`, {
      fix: 'zone is the zone of a time written without an offset. To see an instant in another zone, pass that zone as to.',
    });
  }
  const zone = input.zone === undefined ? undefined : checkZone(input.zone, 'zone');
  const targets = (input.to?.length ? input.to : ['UTC']).map((z) => checkZone(z, 'to'));
  const from = toInstant(input.time, 'time', zone, now, v, warn);
  const offset = parsed.kind === 'instant' ? (parsed.offsetSeconds === undefined ? null : formatOffset(parsed.offsetSeconds)) : formatLocal(from.instant, zone!).offset;
  const source: ConvertData['source'] = { kind: parsed.kind, zone: zone ?? null, offset, ...(from.note ? { dst: from.note } : {}) };
  const results = targets.map((target): Converted => {
    const f = formatLocal(from.instant, target);
    const note = dstNote(f.wall, target, resolveWall(f.wall, target));
    if (note?.kind === 'overlap') {
      warn({ code: 'TIME_DST_OVERLAP', message: `${note.wall} happens twice in ${target}, at ${note.earlier} and ${note.later}; the result is ${f.local}, so keep its offset to tell them apart.` });
    }
    return { zone: target, local: f.local, offset: f.offset, offsetSeconds: f.offsetSeconds, ...(note ? { dst: note } : {}) };
  });
  const data = { input: input.time, instant: formatInstant(from.instant), epochMs: from.instant, source, results };
  checkConversion(v, data, from.wall && !from.note ? { wall: from.wall, zone: zone! } : undefined);
  return { ...data, verified: v.done() };
}

/**
 * The conversion, checked by going back: each result's local time and
 * offset must read back as the same instant, the zone must show that wall
 * clock at that instant, and a wall-clock input must be what its zone shows
 * at the instant found (unless it fell in a gap, already reported).
 */
export function checkConversion(v: Verifier, data: Omit<ConvertData, 'verified'>, source?: { wall: Wall; zone: string }): void {
  const code = 'TIME_ROUNDTRIP_MISMATCH';
  for (const r of data.results) {
    const back = instantOf(r.local);
    v.equal('convert.roundtrip', data.epochMs, back, { at: r.zone, code });
    const wall = back === null ? undefined : wallAt(back, r.zone);
    const res = wall ? resolveWall(wall, r.zone) : undefined;
    const shows = res ? (res.kind === 'unique' ? [res.instant] : res.kind === 'overlap' ? [res.instant, res.later] : []) : [];
    v.expect('convert.zone', shows.includes(data.epochMs), { at: r.zone, expected: data.instant, actual: shows.map(formatInstant) }, { code });
  }
  v.equal('convert.instant', data.epochMs, instantOf(data.instant), { code });
  if (source) v.equal('convert.source', formatWall(source.wall), formatWall(wallAt(data.epochMs, source.zone)), { at: source.zone, code });
}

// ---- duration ----

export interface DurationInput {
  duration?: string | undefined;
  seconds?: number | undefined;
}

export interface DurationData {
  input: string | number;
  iso: string;
  negative: boolean;
  parts: Record<string, number>;
  /** Exact length in seconds, or null with years or months, which have none. */
  totalSeconds: number | null;
  text: string;
  verified: Verified;
}

export function durationOf(input: DurationInput, warn: Warn): DurationData {
  if ((input.duration === undefined) === (input.seconds === undefined)) {
    throw new ToilError('INVALID_INPUT', 'Pass a duration to read or seconds to write as one, not both and not neither.', { fix: 'duration is ISO 8601 text (PT1H30M); seconds is a number (5400).' });
  }
  const v = new Verifier(warn);
  let d;
  if (input.seconds !== undefined) {
    if (!Number.isFinite(input.seconds)) throw new ToilError('INVALID_INPUT', `seconds ${input.seconds} is not a finite number.`, { fix: 'Pass a number of seconds, such as 5400 or 0.25.' });
    const ms = Math.round(input.seconds * 1000);
    if (Math.abs(ms - input.seconds * 1000) > 1e-6) v.approximated('duration.precision', 'seconds were rounded to the millisecond');
    d = durationFromMs(ms);
  } else d = parseDuration(input.duration!);
  const total = durationMs(d);
  if (total.subMs) v.approximated('duration.precision', 'a fraction below a millisecond was rounded');
  if (total.ms === null) v.unchecked('duration.totalSeconds', 'years and months have no fixed length in seconds');
  else if (total.nominalDays) v.approximated('duration.totalSeconds', 'a day counted as 24 hours and a week as 7 days, though a day across a DST change is 23 or 25');
  const data = { input: input.duration ?? input.seconds!, iso: formatDuration(d), negative: d.negative, parts: { ...d.parts }, totalSeconds: total.ms === null ? null : total.ms / 1000, text: describeDuration(d) };
  checkDuration(v, data, input.seconds);
  return { ...data, verified: v.done() };
}

/** The duration, checked by reading its canonical text back: the same parts, and for seconds in, the same number of seconds out. */
export function checkDuration(v: Verifier, data: Omit<DurationData, 'verified'>, seconds?: number): void {
  const back = parseDuration(data.iso);
  v.equal('duration.roundtrip', data.parts, back.parts, { code: 'DURATION_ROUNDTRIP_MISMATCH' });
  v.equal('duration.sign', data.negative, back.negative, { code: 'DURATION_ROUNDTRIP_MISMATCH' });
  if (seconds !== undefined) v.equal('duration.seconds', Math.round(seconds * 1000) / 1000, (durationMs(back).ms ?? NaN) / 1000, { code: 'DURATION_ROUNDTRIP_MISMATCH' });
}

// ---- business days ----

export interface HolidayFields {
  zone?: string | undefined;
  holidaysFile?: string | undefined;
  holiday?: string[] | undefined;
}

/**
 * A holiday file's lines, read by the command's definition module through the
 * util input reader. The reading stays there because this module is loaded
 * lazily and must not import zod, which the reader's module does
 * (docs/util.md, Lazy loading).
 */
export interface HolidayFile {
  label: string;
  lines: Array<{ number: number; text: string }>;
  /** What the reader saw, for the completeness check. */
  read: Pick<UtilInput, 'source' | 'expectedBytes' | 'bytesRead' | 'truncated'>;
}

/** What a business-days command works with besides its input and the clock reading: the warning sink, and the holiday file's lines. */
export interface BusinessContext {
  warn: Warn;
  holidayFile?: HolidayFile | undefined;
}

/** The holidays from the file and the dates passed one by one, checking the whole file was read. */
function loadHolidays(ctx: BusinessContext, input: HolidayFields, v: Verifier): Holidays {
  const holidays: Holidays = new Map();
  if (ctx.holidayFile) v.inputComplete(ctx.holidayFile.read);
  for (const [i, date] of (input.holiday ?? []).entries()) addHolidayLine(holidays, date, `holiday ${i + 1}`);
  for (const line of ctx.holidayFile?.lines ?? []) addHolidayLine(holidays, line.text, `${ctx.holidayFile!.label}, line ${line.number},`);
  return holidays;
}

export interface AddInput extends HolidayFields {
  start: string;
  days: number;
}

export interface AddData {
  start: string;
  days: number;
  zone: string;
  result: string;
  weekday: string;
  skipped: { weekendDays: number; holidays: string[] };
  holidaysListed: number;
  dst?: DstNote;
  verified: Verified;
}

export function addDays(input: AddInput, now: number, ctx: BusinessContext): AddData {
  if (!Number.isInteger(input.days) || Math.abs(input.days) > 100_000) {
    throw new ToilError('INVALID_INPUT', `days ${input.days} must be a whole number from -100000 to 100000.`, { fix: 'Pass a whole number of business days; negative counts back.' });
  }
  const v = new Verifier(ctx.warn);
  const zone = checkZone(input.zone ?? 'UTC', 'zone');
  const holidays = loadHolidays(ctx, input, v);
  const start = toInstant(input.start, 'start', zone, now, v, ctx.warn);
  const startWall = start.wall ?? wallAt(start.instant, zone);
  const startDay = dayNumber(startWall);
  const added = addBusinessDays(startDay, input.days, holidays);
  let result = showDay(added.day);
  let note: DstNote | undefined;
  if (!start.dateOnly) {
    const wall = { ...startWall, ...dateOfDay(added.day) };
    const r = resolveWall(wall, zone);
    note = dstNote(wall, zone, r);
    if (note) warnDst(ctx.warn, note, 'The result');
    result = formatLocal(r.instant, zone).local;
  }
  const data = {
    start: input.start,
    days: input.days,
    zone,
    result,
    weekday: WEEKDAY_NAMES[weekdayOfDay(added.day)]!,
    skipped: { weekendDays: added.weekendDays, holidays: added.holidays.map(showDay) },
    holidaysListed: holidays.size,
    ...(note ? { dst: note } : {}),
  };
  checkAdded(v, data, startDay, holidays);
  return { ...data, verified: v.done() };
}

/** The sum, checked by counting again: the business days between start and result number `days`, and the result is itself a business day. */
export function checkAdded(v: Verifier, data: Omit<AddData, 'verified'>, startDay: number, holidays: Holidays): void {
  const resultDay = dayNumber(wallOf(data.result.slice(0, 10))!);
  const code = 'BUSINESS_DAYS_MISMATCH';
  v.equal('business.count', Math.abs(data.days), countBusinessDays(startDay, resultDay, holidays), { at: data.result, code });
  if (data.days !== 0) v.expect('business.landing', isBusinessDay(resultDay, holidays), { at: data.result, expected: 'a business day', actual: isWeekend(resultDay) ? 'a weekend' : 'a holiday' }, { code });
  v.expect('business.direction', Math.sign(resultDay - startDay) === Math.sign(data.days), { at: data.result, expected: data.days < 0 ? 'before the start' : data.days > 0 ? 'after the start' : 'the start', actual: showDay(resultDay) }, { code });
}

export interface DiffInput extends HolidayFields {
  start: string;
  end: string;
}

export interface DiffData {
  start: string;
  end: string;
  zone: string;
  negative: boolean;
  businessDays: number;
  hours: number;
  /** The business time exactly, as an ISO 8601 duration in hours, minutes and seconds. */
  duration: string;
  totalBusinessSeconds: number;
  elapsedSeconds: number;
  holidays: string[];
  verified: Verified;
}

interface Spans {
  businessMs: number;
  otherMs: number;
  holidays: number[];
}

/** The time between two instants that falls on business days in `zone`, day by day. A day starts at the zone's midnight, or when the clocks resume if midnight was skipped. */
export function businessSpans(from: number, to: number, zone: string, holidays: Holidays): Spans {
  const out: Spans = { businessMs: 0, otherMs: 0, holidays: [] };
  const first = dayNumber(wallAt(from, zone));
  const last = dayNumber(wallAt(to, zone));
  const midnight = (day: number) => resolveWall({ ...dateOfDay(day), hour: 0, minute: 0, second: 0, ms: 0 }, zone).instant;
  for (let day = first; day <= last; day++) {
    const span = Math.max(0, Math.min(to, midnight(day + 1)) - Math.max(from, midnight(day)));
    if (isBusinessDay(day, holidays)) out.businessMs += span;
    else {
      out.otherMs += span;
      if (span > 0 && holidays.has(day) && !isWeekend(day)) out.holidays.push(day);
    }
  }
  return out;
}

export function diffDays(input: DiffInput, now: number, ctx: BusinessContext): DiffData {
  const v = new Verifier(ctx.warn);
  const zone = checkZone(input.zone ?? 'UTC', 'zone');
  const holidays = loadHolidays(ctx, input, v);
  const a = toInstant(input.start, 'start', zone, now, v, ctx.warn).instant;
  const b = toInstant(input.end, 'end', zone, now, v, ctx.warn).instant;
  const [from, to] = a <= b ? [a, b] : [b, a];
  const spans = businessSpans(from, to, zone, holidays);
  const day = 86_400_000;
  const data = {
    start: input.start,
    end: input.end,
    zone,
    negative: b < a,
    businessDays: Math.floor(spans.businessMs / day),
    hours: (spans.businessMs % day) / 3_600_000,
    duration: formatDuration(durationFromMs(spans.businessMs)),
    totalBusinessSeconds: spans.businessMs / 1000,
    elapsedSeconds: (to - from) / 1000,
    holidays: spans.holidays.map(showDay),
  };
  checkSpans(v, data, spans);
  return { ...data, verified: v.done() };
}

/** The split, checked by adding it up: business time plus the rest is the whole elapsed time, and the days and hours make the business time. */
export function checkSpans(v: Verifier, data: Omit<DiffData, 'verified'>, spans: Spans): void {
  const code = 'BUSINESS_TIME_MISMATCH';
  v.equal('business.partition', data.elapsedSeconds * 1000, spans.businessMs + spans.otherMs, { code });
  v.equal('business.total', data.totalBusinessSeconds * 1000, Math.round(data.businessDays * 86_400_000 + data.hours * 3_600_000), { code });
}

// ---- cron ----

export interface CronInput {
  expression: string;
  dialect?: Dialect | undefined;
  zone?: string | undefined;
  from?: string | undefined;
  count?: number | undefined;
  job?: string | undefined;
}

export interface CronRun {
  instant: string;
  local: string;
  offset: string;
  /** Set when this wall clock happened twice; the run is listed once, at the first. */
  dst?: DstNote;
}

export interface CronData {
  expression: string;
  dialect: Dialect;
  dialectSource: 'input' | 'detected';
  zone: string;
  from: string;
  explanation: string;
  fields: Omit<CronSchedule, 'dialect' | 'expression' | 'domStar' | 'dowStar' | 'hashed'>;
  runs: CronRun[];
  /** Run times the zone skipped, which no run is listed for: the first {@link MAX_SKIPPED} of them. */
  skipped: GapNote[];
  /** How many skipped run times the walk met, listed or not. */
  skippedTotal: number;
  verified: Verified;
}

export const MAX_RUNS = 100;
/** The most skipped run times listed in `skipped`; the rest are counted. */
export const MAX_SKIPPED = 100;
/**
 * The most skipped run times the walk steps through before it stops. An
 * every-second schedule meets 3,600 in one spring-forward hour, so this
 * covers a whole gap, and a schedule that only ever lands in gaps (`* * 2 ?
 * 3 1#2` in New York) ends in a fraction of a second instead of walking a
 * century of them.
 */
export const MAX_GAPS_WALKED = 5000;

export function cronRuns(input: CronInput, now: number, warn: Warn): CronData {
  const v = new Verifier(warn);
  const dialect = input.dialect ?? detectDialect(input.expression);
  const zone = checkZone(input.zone ?? 'UTC', 'zone');
  const count = input.count ?? 5;
  if (!Number.isInteger(count) || count < 1 || count > MAX_RUNS) throw new ToilError('INVALID_INPUT', `count ${count} must be a whole number from 1 to ${MAX_RUNS}.`, { fix: `Ask for at most ${MAX_RUNS} run times.` });
  const s = parseCron(input.expression, dialect, input.job);
  if (s.hashed && input.job === undefined) throw new ToilError('INVALID_INPUT', 'H needs the job to place it.', { fix: "Pass job with the job's full name as Jenkins shows it (folder/job)." });
  if (input.dialect === undefined && dialect === 'standard' && !s.domStar && !s.dowStar) {
    warn({ code: 'CRON_DIALECT_ASSUMED', message: 'Read as standard cron, where a day matching either day field runs. Jenkins runs only on days matching both: pass dialect jenkins if this is a Jenkins schedule.' });
  }
  const from = toInstant(input.from ?? 'now', 'from', zone, now, v, warn).instant;
  const runs: CronRun[] = [];
  const skipped: GapNote[] = [];
  let skippedTotal = 0;
  /** The last skipped wall clock walked, when the walk stopped there. */
  let stopped: string | undefined;
  for (const event of cronEvents(s, from, zone)) {
    if (event.kind === 'gap') {
      if (skippedTotal++ < MAX_SKIPPED) skipped.push(dstNote(event.wall, zone, resolveWall(event.wall, zone)) as GapNote);
      if (skippedTotal >= MAX_GAPS_WALKED) {
        stopped = formatWall(event.wall);
        break;
      }
      continue;
    }
    const f = formatLocal(event.instant, zone);
    const note = event.overlap ? dstNote(event.wall, zone, resolveWall(event.wall, zone)) : undefined;
    runs.push({ instant: formatInstant(event.instant), local: f.local, offset: f.offset, ...(note ? { dst: note } : {}) });
    if (runs.length === count) break;
  }
  if (skippedTotal) {
    const cut = skippedTotal > skipped.length ? ` Only the first ${skipped.length} are listed in skipped.` : '';
    warn({ code: 'CRON_DST_GAP', message: `${skippedTotal} run time${skippedTotal > 1 ? 's' : ''} did not exist in ${zone}, first ${skipped[0]!.wall}, when the clocks jumped forward. No run is listed for ${skippedTotal > 1 ? 'them' : 'it'}.${cut} Schedulers differ here: some run it when the clocks resume, at ${skipped[0]!.resolvedTo}, and some skip it.` });
  }
  if (stopped) {
    warn({ code: 'CRON_SEARCH_STOPPED', message: `The search stopped after ${MAX_GAPS_WALKED} run times that fell in DST gaps, having found ${runs.length} of the ${count} runs asked for. Later runs may exist: pass a from after ${stopped} to look further.` });
  }
  const repeated = runs.filter((r) => r.dst);
  if (repeated.length) {
    const first = repeated[0]!.dst as Extract<DstNote, { kind: 'overlap' }>;
    warn({ code: 'CRON_DST_OVERLAP', message: `${repeated.length} run time${repeated.length > 1 ? 's' : ''} happened twice in ${zone}, first ${first.wall}, when the clocks went back. Each is listed once, at the first. Schedulers differ here: some run it again at ${first.later}.` });
  }
  if (runs.length < count && stopped === undefined) {
    warn({ code: 'CRON_FEW_RUNS', message: `The expression runs ${runs.length} time${runs.length === 1 ? '' : 's'} in the ${s.year ? 'years it lists' : `next ${HORIZON_YEARS} years`}, fewer than the ${count} asked for.` });
  }
  v.unchecked('cron.explanation', 'the wording is built from the same fields the run times come from; the run times are what is checked');
  const fields = { written: s.written, second: s.second, minute: s.minute, hour: s.hour, dayOfMonth: s.dayOfMonth, month: s.month, dayOfWeek: s.dayOfWeek, year: s.year };
  const data = { expression: input.expression, dialect, dialectSource: input.dialect === undefined ? ('detected' as const) : ('input' as const), zone, from: formatLocal(from, zone).local, explanation: explainCron(s), fields, runs, skipped, skippedTotal };
  checkCronRuns(v, s, zone, from, data.runs, data.skipped);
  return { ...data, verified: v.done() };
}

/**
 * The run times, checked by matching each one again: read back as the wall
 * clock its zone shows then, it must satisfy every field; the runs must come
 * after `from` and in order; and each skipped time must really be in a gap.
 */
export function checkCronRuns(v: Verifier, s: CronSchedule, zone: string, from: number, runs: CronRun[], skipped: GapNote[]): void {
  const code = 'CRON_RUN_MISMATCH';
  let previous = from;
  for (const run of runs) {
    const instant = instantOf(run.instant) ?? NaN;
    const wall = wallAt(instant, zone);
    v.expect('cron.rematch', wallMatches(s, wall), { at: run.local, expected: s.written.join(' '), actual: formatWall(wall) }, { code });
    v.expect('cron.order', instant > previous, { at: run.local, expected: `after ${formatInstant(previous)}`, actual: run.instant }, { code });
    v.equal('cron.local', instant, instantOf(run.local), { at: run.local, code });
    previous = instant;
  }
  for (const gap of skipped) {
    const wall = wallOf(gap.wall)!;
    const r = resolveWall(wall, zone);
    v.expect('cron.gap', r.kind === 'gap' && wallMatches(s, wall), { at: gap.wall, expected: 'a skipped run time', actual: r.kind === 'gap' ? 'a time the expression does not match' : `a time that exists (${r.kind})` }, { code });
  }
}
