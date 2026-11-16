import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOLIDAYS_2026 } from '../../../../test/fixtures/util.fixture.js';
import { runCli } from '../../../../test/harness/cli.js';
import { testContext } from '../../../../test/harness/context.js';
import { connectMcp } from '../../../../test/harness/mcp.js';
import type { Warning } from '../../../core/envelope.js';
import { execute } from '../../../core/run.js';
import { commands } from '../index.js';
import { Verifier } from '../kit/verify.js';
import { timeBusinessAddCommand, timeBusinessDiffCommand, timeConvertCommand, timeCronCommand, timeDurationCommand } from '../time.js';
import { addBusinessDays, countBusinessDays, type Holidays } from './business.js';
import { detectDialect, explainCron, JavaRandom, jenkinsHash, parseCron, type Dialect } from './cron.js';
import { parseDuration } from './duration.js';
import { addDays, checkAdded, checkConversion, checkCronRuns, checkDuration, checkSpans, convertTime, cronRuns, diffDays, durationOf, MAX_GAPS_WALKED, MAX_SKIPPED, type CronRun } from './run.js';
import { checkZone, dayNumber, daysInMonth, formatLocal, isLeapYear, offsetAt, parseTime, resolveWall, wallAt, type Wall } from './zone.js';

/**
 * `util time`, against fixed instants only: every test passes the time it
 * works from, and the one test of `now` sets the clock itself, so nothing
 * depends on when the suite runs. The cron reference table was worked out a
 * second way, in Java (test/fixtures/util-time/CronReference.java), and each
 * self-check is handed a wrong answer to show it catches one. The minutes of
 * this meeting will be read back at the next one.
 */

const wall = (text: string): Wall => {
  const v = parseTime(text, 0, 't').value;
  if (v.kind === 'instant') throw new Error('not a wall clock');
  return v.wall;
};
const at = (iso: string) => Date.parse(iso);
const collect = () => {
  const warnings: Warning[] = [];
  return { warnings, warn: (w: Warning) => warnings.push(w) };
};
const codes = (warnings: Warning[]) => warnings.map((w) => w.code);
/** A business-days context, with a holiday file's lines as the definition module hands them over. */
const ctxWith = (file?: { name: string; text: string }) => {
  const { warnings, warn } = collect();
  const bytes = file ? Buffer.byteLength(file.text) : 0;
  const read = { source: { kind: 'file' as const, path: file?.name ?? '' }, expectedBytes: bytes, bytesRead: bytes, truncated: false };
  const holidayFile = file ? { label: `the file "${file.name}"`, lines: file.text.split(/\r?\n/).map((text, i) => ({ number: i + 1, text })), read } : undefined;
  return { warnings, ctx: { warn, holidayFile } };
};

describe('zones, from the runtime Intl data', () => {
  it('reads offsets east and west, half hours and quarter hours, and the local mean time before zones existed', () => {
    expect(offsetAt(at('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-5 * 3600);
    expect(offsetAt(at('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-4 * 3600);
    expect(offsetAt(at('2026-07-15T12:00:00Z'), 'Asia/Kolkata')).toBe(5.5 * 3600);
    expect(offsetAt(at('2026-07-15T12:00:00Z'), 'Asia/Kathmandu')).toBe(5.75 * 3600);
    // New York kept its own mean solar time, 4:56:02 behind Greenwich, until 1883.
    expect(offsetAt(at('1880-01-01T12:00:00Z'), 'America/New_York')).toBe(-(4 * 3600 + 56 * 60 + 2));
    expect(formatLocal(at('1880-01-01T12:00:00Z'), 'America/New_York').offset).toBe('-04:56:02');
  });

  it('finds the one instant of an ordinary wall clock', () => {
    expect(resolveWall(wall('2026-07-04T12:00'), 'America/New_York')).toEqual({ kind: 'unique', instant: at('2026-07-04T16:00:00Z') });
  });

  it.each([
    ['America/New_York', '2026-03-08T02:30', 3600, '2026-03-08T07:30:00Z'],
    ['Europe/London', '2026-03-29T01:30', 3600, '2026-03-29T01:30:00Z'],
    ['Australia/Sydney', '2026-10-04T02:30', 3600, '2026-10-03T16:30:00Z'],
    // Lord Howe Island moves its clocks by half an hour.
    ['Australia/Lord_Howe', '2026-10-04T02:15', 1800, '2026-10-03T15:45:00Z'],
  ])('detects the spring-forward gap in %s at %s', (zone, local, gap, after) => {
    const r = resolveWall(wall(local), zone);
    expect(r).toMatchObject({ kind: 'gap', gapSeconds: gap, instant: at(after) });
  });

  it.each([
    ['America/New_York', '2026-11-01T01:30', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'],
    ['Europe/Berlin', '2026-10-25T02:30', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z'],
    ['Australia/Sydney', '2026-04-05T02:30', '2026-04-04T15:30:00Z', '2026-04-04T16:30:00Z'],
  ])('detects the fall-back overlap in %s at %s', (zone, local, earlier, later) => {
    expect(resolveWall(wall(local), zone)).toMatchObject({ kind: 'overlap', instant: at(earlier), later: at(later) });
  });

  it('knows leap years by the Gregorian rule', () => {
    expect([1900, 2000, 2024, 2026, 2028, 2100].map(isLeapYear)).toEqual([false, true, true, false, true, false]);
    expect([daysInMonth(2028, 2), daysInMonth(2026, 2), daysInMonth(2000, 2), daysInMonth(1900, 2), daysInMonth(2026, 12)]).toEqual([29, 28, 29, 28, 31]);
    expect(dayNumber({ year: 1970, month: 1, day: 1 })).toBe(0);
  });

  it('names an unknown zone in an INVALID_INPUT', () => {
    expect(() => checkZone('Mars/Olympus_Mons')).toThrow(/Unknown time zone for zone: "Mars\/Olympus_Mons"/);
    expect(checkZone('UTC')).toBe('UTC');
  });
});

describe('reading times', () => {
  it.each([
    ['2026-03-08T02:30:00Z', at('2026-03-08T02:30:00Z')],
    ['2026-03-08T02:30:00.250-05:00', at('2026-03-08T07:30:00.250Z')],
    ['2026-03-08 02:30+0530', at('2026-03-07T21:00:00Z')],
    ['2026-03-08T02:30-03', at('2026-03-08T05:30:00Z')],
    ['@1760000000', 1760000000000],
    ['@-1.5', -1500],
  ])('reads %s as an instant', (text, instant) => {
    expect(parseTime(text, 0, 't').value).toMatchObject({ kind: 'instant', instant });
  });

  it('reads a wall clock, a date, and now as the clock reading it was given', () => {
    expect(parseTime('2026-03-08T02:30', 0, 't').value.kind).toBe('wall');
    expect(parseTime('2028-02-29', 0, 't').value.kind).toBe('date');
    expect(parseTime('now', 1234, 't').value).toEqual({ kind: 'instant', instant: 1234 });
  });

  it('keeps milliseconds and says when finer digits were dropped', () => {
    expect(parseTime('2026-03-08T02:30:00.123456789Z', 0, 't')).toMatchObject({ truncated: true, value: { instant: at('2026-03-08T02:30:00.123Z') } });
    expect(parseTime('2026-03-08T02:30:00.123000Z', 0, 't').truncated).toBe(false);
  });

  it.each([
    ['2026-02-29', 'has day 29, but 2026-02 has 28 days'],
    ['2026-13-01', 'has month 13'],
    ['2026-03-08T24:00', 'has hour 24'],
    ['2026-12-31T23:59:60Z', 'leap seconds'],
    ['0000-01-01', 'year 0000'],
    ['next tuesday', 'is not a time toil can read'],
    ['2026-03-08T02:30+25:00', 'has offset +25:00'],
  ])('refuses %s rather than roll it over', (text, why) => {
    expect(() => parseTime(text, 0, 'time')).toThrow(why);
  });
});

describe('util time convert', () => {
  it('converts an ordinary time and checks every result by converting it back', () => {
    const { warnings, warn } = collect();
    const data = convertTime({ time: '2026-07-04T12:00', zone: 'America/New_York', to: ['UTC', 'Asia/Kolkata', 'Australia/Lord_Howe'] }, 0, warn);
    expect(data.instant).toBe('2026-07-04T16:00:00Z');
    expect(data.results.map((r) => r.local)).toEqual(['2026-07-04T16:00:00+00:00', '2026-07-04T21:30:00+05:30', '2026-07-05T02:30:00+10:30']);
    expect(data.source).toEqual({ kind: 'wall', zone: 'America/New_York', offset: '-04:00' });
    expect(data.verified.passed).toBe(true);
    expect(data.verified.checks.map((c) => [c.check, c.status, c.checked])).toEqual([
      ['convert.roundtrip', 'passed', 3],
      ['convert.zone', 'passed', 3],
      ['convert.instant', 'passed', 1],
      ['convert.source', 'passed', 1],
    ]);
    expect(warnings).toEqual([]);
  });

  it('reports a wall clock in a spring-forward gap, and the time it was read as', () => {
    const { warnings, warn } = collect();
    const data = convertTime({ time: '2026-03-08T02:30', zone: 'America/New_York' }, 0, warn);
    expect(data.source.dst).toEqual({ kind: 'gap', wall: '2026-03-08T02:30:00', zone: 'America/New_York', gapSeconds: 3600, offsetBefore: '-05:00', offsetAfter: '-04:00', resolvedTo: '2026-03-08T03:30:00-04:00' });
    expect(data.instant).toBe('2026-03-08T07:30:00Z');
    expect(codes(warnings)).toEqual(['TIME_DST_GAP']);
    expect(warnings[0]!.message).toContain('does not exist in America/New_York');
    expect(data.verified.passed).toBe(true);
  });

  it('reports a wall clock in a fall-back overlap, read as the earlier of the two', () => {
    const { warnings, warn } = collect();
    const data = convertTime({ time: '2026-11-01T01:30', zone: 'America/New_York' }, 0, warn);
    expect(data.source.dst).toMatchObject({ kind: 'overlap', earlier: '2026-11-01T01:30:00-04:00', later: '2026-11-01T01:30:00-05:00', chosen: 'earlier' });
    expect(data.instant).toBe('2026-11-01T05:30:00Z');
    expect(codes(warnings)).toEqual(['TIME_DST_OVERLAP']);
  });

  it('flags a result whose wall clock happens twice, so its offset is kept', () => {
    const { warnings, warn } = collect();
    const data = convertTime({ time: '2026-11-01T06:30:00Z', to: ['America/New_York'] }, 0, warn);
    expect(data.results[0]).toMatchObject({ local: '2026-11-01T01:30:00-05:00', dst: { kind: 'overlap' } });
    expect(codes(warnings)).toEqual(['TIME_DST_OVERLAP']);
    expect(data.verified.passed).toBe(true);
  });

  it('round-trips every hour across both 2026 transitions in several zones', () => {
    for (const zone of ['America/New_York', 'Europe/London', 'Australia/Sydney', 'America/Santiago', 'Asia/Tehran']) {
      for (const start of ['2026-03-07T00:00:00Z', '2026-04-03T00:00:00Z', '2026-09-04T00:00:00Z', '2026-10-24T00:00:00Z', '2026-11-01T00:00:00Z']) {
        for (let h = 0; h < 72; h++) {
          const instant = at(start) + h * 3_600_000;
          const data = convertTime({ time: `@${instant / 1000}`, to: [zone] }, 0, () => {});
          expect(data.verified.passed, `${zone} ${new Date(instant).toISOString()}`).toBe(true);
        }
      }
    }
  });

  it('refuses a time with no offset and no zone, and a zone for a time that has one', () => {
    expect(() => convertTime({ time: '2026-03-08T02:30' }, 0, () => {})).toThrow(/has no offset/);
    expect(() => convertTime({ time: '2026-03-08T02:30Z', zone: 'UTC' }, 0, () => {})).toThrow(/already an instant/);
    expect(() => convertTime({ time: 'now', to: ['Nowhere/Special'] }, 0, () => {})).toThrow(/Unknown time zone for to/);
  });

  it('catches a result that does not convert back', () => {
    const { warnings, warn } = collect();
    const v = new Verifier(warn);
    const good = convertTime({ time: '2026-07-04T16:00:00Z', to: ['Europe/Paris'] }, 0, () => {});
    // An hour out, as when a converter forgets summer time.
    checkConversion(v, { ...good, results: [{ ...good.results[0]!, local: '2026-07-04T17:00:00+02:00' }] });
    const verified = v.done();
    expect(verified.passed).toBe(false);
    expect(verified.checks.find((c) => c.check === 'convert.roundtrip')).toMatchObject({ status: 'failed', failed: 1 });
    expect(codes(warnings)).toContain('TIME_ROUNDTRIP_MISMATCH');
  });

  it('catches an instant that is not what the wall-clock input shows in its zone', () => {
    const { warnings, warn } = collect();
    const v = new Verifier(warn);
    const good = convertTime({ time: '2026-07-04T16:00:00Z' }, 0, () => {});
    checkConversion(v, good, { wall: wall('2026-07-04T12:30'), zone: 'America/New_York' });
    expect(v.done().checks.find((c) => c.check === 'convert.source')?.status).toBe('failed');
    expect(warnings[0]?.message).toContain('expected "2026-07-04T12:30:00", found "2026-07-04T12:00:00"');
  });

  it('runs through execute(), reporting the gap in meta.warnings', async () => {
    const envelope = await execute(timeConvertCommand, { time: '2026-03-08T02:30', zone: 'America/New_York', to: ['Europe/London'] }, testContext().context);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ instant: '2026-03-08T07:30:00Z', results: [{ zone: 'Europe/London', local: '2026-03-08T07:30:00+00:00' }] });
    expect(envelope.meta.warnings?.map((w) => w.code)).toEqual(['TIME_DST_GAP']);
  });
});

describe('now', () => {
  afterEach(() => vi.useRealTimers());

  it('is read from the clock once per call, so the clock can be set in a test', async () => {
    vi.useFakeTimers({ now: at('2026-11-01T05:59:30Z'), toFake: ['Date'] });
    const envelope = await execute(timeCronCommand, { expression: '0 * * * *', zone: 'America/New_York', count: 2 }, testContext().context);
    // 01:00 EST would be the second 01:00 of the night; it is listed once, at its first.
    expect((envelope.data as { runs: CronRun[] }).runs.map((r) => r.local)).toEqual(['2026-11-01T02:00:00-05:00', '2026-11-01T03:00:00-05:00']);
    const converted = await execute(timeConvertCommand, { time: 'now', to: ['Asia/Tokyo'] }, testContext().context);
    expect(converted.data).toMatchObject({ instant: '2026-11-01T05:59:30Z', results: [{ local: '2026-11-01T14:59:30+09:00' }] });
  });
});

describe('util time duration', () => {
  it.each([
    ['P1Y2M3W4DT5H6M7.5S', 'P1Y2M3W4DT5H6M7.5S', null, '1 year, 2 months, 3 weeks, 4 days, 5 hours, 6 minutes and 7.5 seconds'],
    ['PT1H30M', 'PT1H30M', 5400, '1 hour and 30 minutes'],
    ['PT90M', 'PT90M', 5400, '90 minutes'],
    ['-PT15M', '-PT15M', -900, 'minus 15 minutes'],
    ['PT0.5H', 'PT0.5H', 1800, '0.5 hours'],
    ['pt0,25s', 'PT0.25S', 0.25, '0.25 seconds'],
    ['PT0S', 'PT0S', 0, '0 seconds'],
    ['-P0D', 'PT0S', 0, '0 seconds'],
  ])('reads %s', (text, iso, seconds, words) => {
    const d = durationOf({ duration: text }, () => {});
    expect([d.iso, d.totalSeconds, d.text]).toEqual([iso, seconds, words]);
    expect(d.verified.passed).toBe(true);
  });

  it('says a year has no fixed length and a day is counted as 24 hours', () => {
    const { warnings, warn } = collect();
    expect(durationOf({ duration: 'P1M' }, warn).totalSeconds).toBeNull();
    expect(durationOf({ duration: 'P1DT1H' }, warn).totalSeconds).toBe(90000);
    expect(codes(warnings)).toEqual(['UNVERIFIED', 'APPROXIMATED']);
  });

  it('writes seconds as an exact duration in hours, never days', () => {
    expect(durationOf({ seconds: 93784.5 }, () => {})).toMatchObject({ iso: 'PT26H3M4.5S', totalSeconds: 93784.5, text: '26 hours, 3 minutes and 4.5 seconds' });
    expect(durationOf({ seconds: -60 }, () => {}).iso).toBe('-PT1M');
    expect(durationOf({ seconds: 0 }, () => {}).iso).toBe('PT0S');
    const { warnings, warn } = collect();
    expect(durationOf({ seconds: 0.0004 }, warn).iso).toBe('PT0S');
    expect(codes(warnings)).toEqual(['APPROXIMATED']);
  });

  it.each([
    ['P', 'has no parts'],
    ['PT', 'has no parts'],
    ['P1DT', 'has a T with no hours'],
    ['PT1.5H30M', 'only the last part may have one'],
    ['1H', 'is not an ISO 8601 duration'],
    ['P1H', 'is not an ISO 8601 duration'],
  ])('refuses %s', (text, why) => {
    expect(() => parseDuration(text)).toThrow(why);
  });

  it('wants exactly one of duration and seconds', () => {
    expect(() => durationOf({}, () => {})).toThrow(/not both and not neither/);
    expect(() => durationOf({ duration: 'PT1S', seconds: 1 }, () => {})).toThrow(/not both and not neither/);
  });

  it('catches canonical text that does not read back as the same parts', () => {
    const { warnings, warn } = collect();
    const v = new Verifier(warn);
    const good = durationOf({ duration: 'PT1H30M' }, () => {});
    checkDuration(v, { ...good, iso: 'PT1H3M' });
    expect(v.done().passed).toBe(false);
    expect(codes(warnings)).toEqual(['DURATION_ROUNDTRIP_MISMATCH']);
  });

  it('runs through execute() and the CLI with --seconds', async () => {
    const run = await runCli(['util', 'time', 'duration', '--seconds', '5400'], { commands, context: testContext().context });
    expect(run.envelope?.data).toMatchObject({ iso: 'PT1H30M' });
    const envelope = await execute(timeDurationCommand, { duration: 'nope' }, testContext().context);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Duration "nope" is not an ISO 8601 duration.' });
  });
});

describe('util time business-days', () => {
  const day = (iso: string) => dayNumber(wall(iso));
  const holidays: Holidays = new Map([[day('2026-12-25'), 'Christmas Day']]);

  it('steps as WORKDAY does: the start never counts, and 0 keeps it', () => {
    expect(addBusinessDays(day('2026-12-24'), 1, holidays)).toEqual({ day: day('2026-12-28'), weekendDays: 2, holidays: [day('2026-12-25')] });
    expect(addBusinessDays(day('2026-12-26'), 0, holidays).day).toBe(day('2026-12-26'));
    expect(addBusinessDays(day('2026-12-26'), 1, holidays).day).toBe(day('2026-12-28'));
    expect(addBusinessDays(day('2026-12-28'), -1, holidays).day).toBe(day('2026-12-24'));
    expect(addBusinessDays(day('2026-12-26'), -1, holidays).day).toBe(day('2026-12-24'));
  });

  it('crosses Feb 29 in a leap year and not in another', () => {
    expect(addBusinessDays(day('2028-02-28'), 1, new Map()).day).toBe(day('2028-02-29'));
    expect(addBusinessDays(day('2026-02-27'), 1, new Map()).day).toBe(day('2026-03-02'));
  });

  it('adds over Christmas with the holiday file, and checks the count again', async () => {
    const { ctx, warnings } = ctxWith({ name: 'holidays-2026.txt', text: HOLIDAYS_2026 });
    const data = addDays({ start: '2026-12-23', days: 3, holidaysFile: 'holidays-2026.txt' }, 0, ctx);
    expect(data).toMatchObject({ result: '2026-12-29', weekday: 'Tuesday', skipped: { weekendDays: 2, holidays: ['2026-12-25'] }, holidaysListed: 11 });
    expect(data.verified.checks.map((c) => [c.check, c.status])).toEqual([
      ['input.complete', 'passed'],
      ['business.count', 'passed'],
      ['business.landing', 'passed'],
      ['business.direction', 'passed'],
    ]);
    expect(warnings).toEqual([]);
  });

  it('keeps the time of day, and reports a result in a DST gap', async () => {
    const { ctx, warnings } = ctxWith();
    const data = addDays({ start: '2026-03-06T02:30', days: 1, zone: 'America/New_York', holiday: ['2026-03-09'] }, 0, ctx);
    // Friday + 1 business day, with Monday a holiday, is Tuesday; Sunday's gap isn't touched.
    expect(data.result).toBe('2026-03-10T02:30:00-04:00');
    const gap = addDays({ start: '2026-03-06T02:30', days: 2, zone: 'Europe/London' }, 0, ctx);
    expect(gap.result).toBe('2026-03-10T02:30:00+00:00');
    const intoGap = addDays({ start: '2026-03-27T01:30', days: -5, zone: 'Europe/London' }, 0, ctx);
    expect(intoGap.result).toBe('2026-03-20T01:30:00+00:00');
    expect(warnings).toEqual([]);
    const sunday = addDays({ start: '2026-03-08T02:30', days: 0, zone: 'America/New_York' }, 0, ctx);
    expect(sunday.dst).toMatchObject({ kind: 'gap', wall: '2026-03-08T02:30:00' });
    expect(codes(warnings)).toEqual(['TIME_DST_GAP', 'TIME_DST_GAP']);
  });

  it('fails the completeness check on a holiday file cut short at the cap', async () => {
    const big = `${'# padding\n'.repeat(110_000)}2026-12-25\n`;
    const envelope = await execute(timeBusinessAddCommand, { start: '2026-12-24', days: 1, holidaysFile: 'big.txt' }, testContext({ files: { 'big.txt': big } }).context);
    const data = envelope.data as { result: string; verified: { passed: boolean } };
    // The Christmas line past the cap was never read, so the 25th counted as a business day, and the check says the file wasn't whole.
    expect([data.result, data.verified.passed]).toEqual(['2026-12-25', false]);
    expect(envelope.meta.warnings?.map((w) => w.code)).toEqual(['INPUT_TRUNCATED']);
  });

  it('refuses a holiday line that is not a date, naming the line', async () => {
    const files = { 'bad.txt': '# holidays\n2026-12-25 Christmas\n25/12/2026 Boxing Day\n' };
    const envelope = await execute(timeBusinessAddCommand, { start: '2026-12-23', days: 1, holidaysFile: 'bad.txt' }, testContext({ files }).context);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'the file "bad.txt", line 3, is not a holiday date: "25/12/2026 Boxing Day".' });
    const { ctx } = ctxWith();
    expect(() => addDays({ start: '2026-12-23', days: 1, holiday: ['2026-02-30'] }, 0, ctx)).toThrow(/has day 30/);
    expect(() => addDays({ start: '2026-12-23', days: 1.5 }, 0, ctx)).toThrow(/whole number/);
  });

  it('catches a result whose business days do not count up to the days asked', () => {
    const { warnings, warn } = collect();
    const v = new Verifier(warn);
    checkAdded(v, { start: '2026-12-24', days: 1, zone: 'UTC', result: '2026-12-25', weekday: 'Friday', skipped: { weekendDays: 0, holidays: [] }, holidaysListed: 1 }, day('2026-12-24'), holidays);
    const verified = v.done();
    expect(verified.passed).toBe(false);
    expect(verified.checks.filter((c) => c.status === 'failed').map((c) => c.check)).toEqual(['business.count', 'business.landing']);
    expect(codes(warnings)).toEqual(['BUSINESS_DAYS_MISMATCH', 'BUSINESS_DAYS_MISMATCH']);
    expect(countBusinessDays(day('2026-12-24'), day('2026-12-28'), holidays)).toBe(1);
  });

  it('measures business time across a weekend and a holiday, in days and hours', async () => {
    const { ctx } = ctxWith({ name: 'holidays-2026.txt', text: HOLIDAYS_2026 });
    const data = diffDays({ start: '2026-12-24T15:00', end: '2026-12-29T10:00', zone: 'America/Chicago', holidaysFile: 'holidays-2026.txt' }, 0, ctx);
    // Thursday 15:00-24:00, Monday all day, Tuesday 00:00-10:00: 9 + 24 + 10 hours.
    expect(data).toMatchObject({ businessDays: 1, hours: 19, duration: 'PT43H', totalBusinessSeconds: 43 * 3600, elapsedSeconds: 115 * 3600, holidays: ['2026-12-25'], negative: false });
    expect(data.verified.passed).toBe(true);
  });

  it('counts a 25-hour fall-back day and a 23-hour spring-forward day as they are', async () => {
    const { ctx } = ctxWith();
    const fall = diffDays({ start: '2026-10-26', end: '2026-10-27', zone: 'America/Sao_Paulo' }, 0, ctx);
    expect(fall.totalBusinessSeconds).toBe(24 * 3600);
    // Monday 2 November is a business day in New York, after the 25-hour Sunday.
    const ny = diffDays({ start: '2026-10-30', end: '2026-11-03', zone: 'America/New_York' }, 0, ctx);
    expect([ny.businessDays, ny.hours, ny.elapsedSeconds]).toEqual([2, 0, (4 * 24 + 1) * 3600]);
    // Santiago's clocks skip midnight itself in spring (Sunday 6 September), so that weekend is an hour short.
    const santiago = diffDays({ start: '2026-09-04T12:00', end: '2026-09-08T12:00', zone: 'America/Santiago' }, 0, ctx);
    expect([santiago.duration, santiago.elapsedSeconds]).toEqual(['PT48H', 95 * 3600]);
    expect(santiago.verified.passed).toBe(true);
    const back = diffDays({ start: '2026-11-03', end: '2026-10-30', zone: 'America/New_York' }, 0, ctx);
    expect([back.negative, back.businessDays]).toEqual([true, 2]);
  });

  it('catches business time that does not add back up to the elapsed time', () => {
    const { warnings, warn } = collect();
    const v = new Verifier(warn);
    const data = { start: 'a', end: 'b', zone: 'UTC', negative: false, businessDays: 1, hours: 0, duration: 'PT24H', totalBusinessSeconds: 86400, elapsedSeconds: 3 * 86400, holidays: [] };
    // One weekend day lost, as a walk that skipped a day would.
    checkSpans(v, data, { businessMs: 86_400_000, otherMs: 86_400_000, holidays: [] });
    expect(v.done().checks.find((c) => c.check === 'business.partition')?.status).toBe('failed');
    expect(codes(warnings)).toEqual(['BUSINESS_TIME_MISMATCH']);
  });

  it('takes a negative count on the CLI, and reads the holiday file from the workspace', async () => {
    const run = await runCli(['util', 'time', 'business-days', 'add', '--holidays', 'holidays-2026.txt', '2026-12-28', '-1'], { commands, context: testContext({ files: { 'holidays-2026.txt': HOLIDAYS_2026 } }).context });
    expect(run.envelope?.data).toMatchObject({ result: '2026-12-24', skipped: { holidays: ['2026-12-25'] } });
  });

  it('runs diff through execute()', async () => {
    const envelope = await execute(timeBusinessDiffCommand, { start: '2026-10-30T17:00:00Z', end: '2026-11-02T09:00:00Z', zone: 'Europe/Berlin', holiday: ['2026-11-02'] }, testContext().context);
    expect(envelope.data).toMatchObject({ businessDays: 0, hours: 6, holidays: ['2026-11-02'] });
    const added = await execute(timeBusinessAddCommand, { start: '2026-12-23', days: 3, holidaysFile: 'missing.txt' }, testContext().context);
    expect(added.error?.message).toContain('missing.txt');
  });
});

describe('util time cron: the reference table', () => {
  interface Row {
    id: string;
    expression: string;
    dialect: Dialect;
    zone: string;
    from: string;
    count: number;
    job?: string;
    runs: string[];
  }
  const table = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../test/fixtures/util-time/cron-reference.json'), 'utf8')) as Row[];

  it('has rows for every dialect', () => {
    expect(new Set(table.map((r) => r.dialect))).toEqual(new Set(['standard', 'quartz', 'jenkins']));
  });

  it.each(table.map((r) => [r.id, r] as const))('%s matches the run times worked out in Java', (_id, row) => {
    const data = cronRuns({ expression: row.expression, dialect: row.dialect, zone: row.zone, from: row.from, count: row.count, ...(row.job ? { job: row.job } : {}) }, 0, () => {});
    expect(data.runs.map((r) => r.instant)).toEqual(row.runs);
    expect(data.verified.passed).toBe(true);
    // Detection agrees with the dialect each row is written in.
    expect(detectDialect(row.expression) === row.dialect || row.expression.startsWith('@')).toBe(true);
  });
});

describe('util time cron', () => {
  const from = '2026-01-01T00:00:00Z';

  it('reports the skipped run in a spring-forward gap, and lists no run for it', () => {
    const { warnings, warn } = collect();
    const data = cronRuns({ expression: '0 30 2 ? * SUN 2026', zone: 'America/New_York', from: '2026-03-07T00:00:00Z', count: 2 }, 0, warn);
    expect(data.skipped).toEqual([expect.objectContaining({ kind: 'gap', wall: '2026-03-08T02:30:00', resolvedTo: '2026-03-08T03:30:00-04:00' })]);
    expect(data.runs.map((r) => r.local)).toEqual(['2026-03-15T02:30:00-04:00', '2026-03-22T02:30:00-04:00']);
    expect(codes(warnings)).toEqual(['CRON_DST_GAP', 'UNVERIFIED']);
    expect(data.verified.checks.find((c) => c.check === 'cron.gap')).toMatchObject({ status: 'passed', checked: 1 });
  });

  it('reports a run whose wall clock repeats in a fall-back overlap, listed once', () => {
    const { warnings, warn } = collect();
    const data = cronRuns({ expression: '30 1 * * *', zone: 'America/New_York', from: '2026-10-31T12:00:00Z', count: 1 }, 0, warn);
    expect(data.runs).toEqual([{ instant: '2026-11-01T05:30:00Z', local: '2026-11-01T01:30:00-04:00', offset: '-04:00', dst: expect.objectContaining({ kind: 'overlap', later: '2026-11-01T01:30:00-05:00' }) }]);
    expect(codes(warnings)).toContain('CRON_DST_OVERLAP');
  });

  it.each([
    ['*/15 9-17 * * 1-5', 'standard', 'Every 15 minutes, during hours 09:00 through 17:00, on Monday through Friday'],
    ['30 2 * * *', 'standard', 'At 02:30'],
    ['0 9,17 * * *', 'standard', 'At 09:00 and 17:00'],
    ['0 */2 * * *', 'standard', 'At minute 0, every 2 hours'],
    ['5 * * * *', 'standard', 'At minute 5 of every hour'],
    ['0 9 1-7 * MON', 'standard', 'At 09:00, on days 1 through 7 of the month or on Monday'],
    ['0 0 1 1,7 *', 'standard', 'At 00:00, on day 1 of the month, in January and July'],
    ['0 0 12 ? * MON#2', 'quartz', 'At 12:00, on the 2nd Monday of the month'],
    ['15 0 10 L * ?', 'quartz', 'At 10:00:15, on the last day of the month'],
    ['0 0 9 15W,LW * ?', 'quartz', 'At 09:00, on the last weekday of the month or on the weekday nearest day 15 of the month'],
    ['0 0 18 ? * 6L 2027', 'quartz', 'At 18:00, on the last Friday of the month, in 2027'],
    ['0 9 1,15 * 1', 'jenkins', 'At 09:00, on days 1 and 15 of the month, if that day is also Monday'],
  ] as const)('explains %s', (expression, dialect, words) => {
    expect(explainCron(parseCron(expression, dialect))).toBe(words);
  });

  it('reads names, ranges, lists, steps and 7 as Sunday the same as numbers', () => {
    const same = (a: string, b: string, dialect: Dialect = 'standard') => {
      const x = parseCron(a, dialect);
      const y = parseCron(b, dialect);
      expect([x.minute, x.hour, x.dayOfMonth.days, x.month, x.dayOfWeek.days], `${a} vs ${b}`).toEqual([y.minute, y.hour, y.dayOfMonth.days, y.month, y.dayOfWeek.days]);
    };
    same('0 0 * JAN-MAR mon-fri', '0 0 * 1-3 1-5');
    same('0 0 * * 7', '0 0 * * 0');
    same('0 0 * * 5-7', '0 0 * * 0,5,6');
    same('5/20 * * * *', '5,25,45 * * * *');
    same('0-30/10 * * * *', '0,10,20,30 * * * *');
    same('0 0 0 ? * FRI-MON', '0 0 0 ? * 1,2,6,7', 'quartz');
    same('0 0 22-2 * * ?', '0 0 0,1,2,22,23 * * ?', 'quartz');
    expect(parseCron('0 0 0 ? * L', 'quartz').dayOfWeek.days).toEqual([6]);
    expect(parseCron('0 0 0 ? * 1', 'quartz').dayOfWeek.days).toEqual([0]);
  });

  it.each([
    ['* * * *', 'standard', 'it has 4 fields, not 5'],
    ['60 * * * *', 'standard', 'minute 60 is outside 0-59'],
    ['0 0 30-1 * *', 'standard', 'runs backwards'],
    ['*/0 * * * *', 'standard', 'a step must be positive'],
    ['0 0 * * FOO', 'standard', 'day-of-week "FOO" is not a number or a name'],
    ['0 0 L * *', 'standard', 'day-of-month "L" is not a number'],
    ['0 0 * * 5#2', 'standard', 'is not a value, range, list or step'],
    ['@reboot', 'standard', 'has no times to list'],
    ['@sometimes', 'standard', 'unknown macro'],
    ['0 0 12 * * MON', 'quartz', 'one of day-of-month and day-of-week must be ?'],
    ['0 0 12 ? * ?', 'quartz', 'only one of day-of-month and day-of-week may be ?'],
    ['0 0 12 ? * 6#6', 'quartz', 'the week of the month after # runs 1 to 5'],
    ['0 0 12 1 * ? 1969', 'quartz', 'year 1969 is outside 1970-2099'],
    ['@daily', 'quartz', 'Quartz has no @ macros'],
    ['H * * * *', 'standard', 'H is Jenkins syntax'],
    ['H/61 * * * *', 'jenkins', 'the step is larger than the range'],
    ['? * * * *', 'standard', '? is only for Quartz'],
  ] as const)('refuses %s (%s)', (expression, dialect, why) => {
    expect(() => parseCron(expression, dialect, 'job')).toThrow(why);
  });

  it('wants the job for H, and says so', () => {
    expect(() => cronRuns({ expression: 'H * * * *', from }, 0, () => {})).toThrow(/H needs the job's full name/);
  });

  it('draws H from java.util.Random exactly', () => {
    // These values are java.util.Random's own, printed by Java 17 for seed 42 and seed -7.
    const r = new JavaRandom(42n);
    expect([r.next(32), r.nextInt(10), r.nextInt(16), r.nextInt(1073741825), r.nextInt(1073741825), r.nextInt(1073741825), r.nextInt(60)]).toEqual([-1170105035, 3, 10, 102948884, 662969970, 595021505, 38]);
    const s = new JavaRandom(-7n);
    expect([s.nextInt(24), s.nextInt(7)]).toEqual([22, 0]);
    // Two names, two minutes: the point of H.
    expect(new Set(['a', 'b', 'c', 'd', 'e'].map((job) => jenkinsHash(job).nextInt(60))).size).toBeGreaterThan(1);
    // Jenkins keeps an unbounded H in day-of-month within 1-28.
    for (const job of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) expect(parseCron('0 0 H * *', 'jenkins', job).dayOfMonth.days[0]).toBeLessThanOrEqual(28);
  });

  it('detects the dialect, and warns when a standard reading of both day fields could be a Jenkins one', () => {
    expect([detectDialect('*/5 * * * *'), detectDialect('0 */5 * * * ?'), detectDialect('0 0 12 1 1 ? 2027'), detectDialect('H H * * *'), detectDialect('0 H(0-3) * * *')]).toEqual(['standard', 'quartz', 'quartz', 'jenkins', 'jenkins']);
    const { warnings, warn } = collect();
    const data = cronRuns({ expression: '0 9 1 * 1', from }, 0, warn);
    expect(data.dialectSource).toBe('detected');
    expect(codes(warnings)).toContain('CRON_DIALECT_ASSUMED');
  });

  it('says when an expression runs less often than asked, or never', () => {
    const { warnings, warn } = collect();
    expect(cronRuns({ expression: '0 0 30 2 *', from, count: 2 }, 0, warn).runs).toEqual([]);
    const quartz = cronRuns({ expression: '0 0 0 1 1 ? 2027', from, count: 3 }, 0, warn);
    expect(quartz.runs.map((r) => r.instant)).toEqual(['2027-01-01T00:00:00Z']);
    expect(codes(warnings).filter((c) => c === 'CRON_FEW_RUNS')).toHaveLength(2);
  });

  it('keeps a schedule that only ever lands in DST gaps small and quick, and says what it cut', () => {
    const { warnings, warn } = collect();
    const started = performance.now();
    const data = cronRuns({ expression: '* * 2 ? 3 1#2', dialect: 'quartz', zone: 'America/New_York', from: '2026-01-01T00:00:00Z', count: 1 }, 0, warn);
    const elapsed = performance.now() - started;
    expect(data.runs).toEqual([]);
    expect([data.skipped.length, data.skippedTotal]).toEqual([MAX_SKIPPED, MAX_GAPS_WALKED]);
    expect(JSON.stringify(data).length).toBeLessThan(100_000);
    // Generous for a slow CI runner: the unbounded walk took over 20 seconds.
    expect(elapsed).toBeLessThan(5000);
    expect(codes(warnings)).toEqual(['CRON_DST_GAP', 'CRON_SEARCH_STOPPED', 'UNVERIFIED']);
    expect(warnings[0]!.message).toContain(`${MAX_GAPS_WALKED} run times did not exist in America/New_York`);
    expect(warnings[0]!.message).toContain(`Only the first ${MAX_SKIPPED} are listed in skipped.`);
    // 5,000 seconds of gap is the 2026 hour and 1,400 seconds of 2027's.
    expect(warnings[1]!.message).toContain('pass a from after 2027-03-14T02:23:19');
    expect(data.verified.passed).toBe(true);
  });

  it('lists every skipped run time when there are few, with the total', () => {
    const data = cronRuns({ expression: '30 2 * * *', zone: 'America/New_York', from: '2026-03-07T00:00:00Z', count: 2 }, 0, () => {});
    expect([data.skipped.length, data.skippedTotal]).toEqual([1, 1]);
  });

  it('takes a DST overlap from the second pass without listing a time already gone', () => {
    // From 01:30 EST, the second 01:30 of the night: 01:45 has already happened once, at 01:45 EDT.
    const data = cronRuns({ expression: '45 1,2 * * *', zone: 'America/New_York', from: '2026-11-01T06:30:00Z', count: 2 }, 0, () => {});
    expect(data.runs.map((r) => r.local)).toEqual(['2026-11-01T02:45:00-05:00', '2026-11-02T01:45:00-05:00']);
  });

  it('catches a run time the expression does not match, or one out of order', () => {
    const { warnings, warn } = collect();
    const s = parseCron('30 2 * * *', 'standard');
    const v = new Verifier(warn);
    const runs: CronRun[] = [
      { instant: '2026-03-07T07:31:00Z', local: '2026-03-07T02:31:00-05:00', offset: '-05:00' },
      { instant: '2026-03-06T07:30:00Z', local: '2026-03-06T02:30:00-05:00', offset: '-05:00' },
    ];
    checkCronRuns(v, s, 'America/New_York', at('2026-03-06T00:00:00Z'), runs, [{ kind: 'gap', wall: '2026-03-09T02:30:00', zone: 'America/New_York', gapSeconds: 3600, offsetBefore: '-05:00', offsetAfter: '-04:00', resolvedTo: '' }]);
    const verified = v.done();
    expect(verified.checks.filter((c) => c.status === 'failed').map((c) => c.check)).toEqual(['cron.rematch', 'cron.order', 'cron.gap']);
    expect(codes(warnings)).toEqual(['CRON_RUN_MISMATCH', 'CRON_RUN_MISMATCH', 'CRON_RUN_MISMATCH']);
    expect(warnings[0]!.message).toContain('expected "30 2 * * *", found "2026-03-07T02:31:00"');
  });

  it('caps the count at 100, and needs from to be a time it can read', () => {
    expect(() => cronRuns({ expression: '* * * * *', from, count: 101 }, 0, () => {})).toThrow(/1 to 100/);
    expect(() => cronRuns({ expression: '* * * * *', from: 'tomorrow' }, 0, () => {})).toThrow(/is not a time toil can read/);
    const many = cronRuns({ expression: '* * * * * ?', from, count: 100 }, 0, () => {});
    expect(many.runs).toHaveLength(100);
    expect(many.runs[99]!.instant).toBe('2026-01-01T00:01:40Z');
  });

  it('reads a from time in the zone, with a gap warned about', () => {
    const { warnings, warn } = collect();
    const data = cronRuns({ expression: '0 4 * * *', zone: 'America/New_York', from: '2026-03-08T02:30', count: 1 }, 0, warn);
    expect(data.from).toBe('2026-03-08T03:30:00-04:00');
    expect(data.runs[0]!.local).toBe('2026-03-08T04:00:00-04:00');
    expect(codes(warnings)[0]).toBe('TIME_DST_GAP');
  });

  it('is one tool over MCP with the same envelope as the CLI', async () => {
    const context = testContext().context;
    const input = { expression: '0 0 12 ? * MON#2', dialect: 'quartz' as const, zone: 'Europe/London', from };
    const cli = await runCli(['util', 'time', 'cron', input.expression, '--dialect', 'quartz', '--zone', 'Europe/London', '--from', from], { commands, context });
    const session = await connectMcp({ commands, context });
    try {
      const mcp = await session.call('util_time_cron', input);
      expect(mcp.envelope.data).toEqual(cli.envelope?.data);
      expect((mcp.envelope.data as { runs: CronRun[] }).runs[0]!.local).toBe('2026-01-12T12:00:00+00:00');
    } finally {
      await session.close();
    }
  });
});

describe('the clock', () => {
  it('is never read by the engine: the same inputs give the same answer whatever the time', () => {
    const one = cronRuns({ expression: '*/5 * * * *', from: '2026-06-01T00:00:00Z', count: 3 }, 0, () => {});
    const two = cronRuns({ expression: '*/5 * * * *', from: '2026-06-01T00:00:00Z', count: 3 }, 9e12, () => {});
    expect(two).toEqual(one);
    expect(wallAt(at('2026-06-01T00:00:00Z'), 'UTC').hour).toBe(0);
  });
});
