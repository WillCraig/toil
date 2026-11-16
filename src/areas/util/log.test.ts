import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { LOGS } from '../../../test/fixtures/util.fixture.js';
import { runCli } from '../../../test/harness/cli.js';
import { testContext } from '../../../test/harness/context.js';
import { memoryFiles } from '../../../test/harness/files.js';
import type { Warning } from '../../core/envelope.js';
import type { FileAccess } from '../../core/files.js';
import { execute } from '../../core/run.js';
import { openInput } from './kit/input.js';
import { Verifier } from './kit/verify.js';
import { logCommand, runLog, SAMPLE_LOG } from './log.js';
import { classify, finish, frameKind, MAX_TRACKED, parseFilters, scan, signature, type Group, type LogOptions } from './log/triage.js';

/**
 * `util log` on real-shaped build logs (Jenkins, Maven, npm, dotnet), its
 * filters, and its self-check: each check is shown catching a result or an
 * input broken on purpose. The last test runs a generated log far larger
 * than the memory it is allowed. A log reader that skims is still a reader.
 */

const triage = async (text: string, options: LogOptions = {}) => {
  const warnings: Warning[] = [];
  const result = await runLog({ files: memoryFiles({ 'build.log': text }), warn: (w) => warnings.push(w) }, { inputFile: 'build.log' }, options);
  return { result, warnings, codes: warnings.map((w) => w.code) };
};

const find = (groups: Group[], pattern: RegExp) => {
  const found = groups.filter((g) => pattern.test(g.signature));
  expect(found, String(pattern)).toHaveLength(1);
  return found[0]!;
};

/** The lines of `text`, 1-based, for checking a reported line number by hand. */
const lineOf = (text: string, n: number) => text.split('\n')[n - 1];

describe('util log on real build logs', () => {
  it('Jenkins: groups the Maven errors under the pipeline, and joins each Java trace, Caused by and all, to its error', async () => {
    const { result, codes } = await triage(LOGS.jenkins);
    expect(result.verified.passed).toBe(true);
    expect(result.lines).toEqual({ total: 97, error: 12, warning: 3, other: 21, stack: 15, unclassified: 46 });
    expect(result.matched).toBe(15);
    expect(result.groups.map((g) => g.level)).toEqual([...Array<string>(12).fill('error'), 'warning', 'warning', 'warning']);

    const failure = find(result.groups, /totalIncludesRoundedTax -- Time elapsed: <n> s <<< FAILURE!$/);
    expect(failure.sample).toBe(lineOf(LOGS.jenkins, failure.firstLine));
    expect(failure.trace).toMatchObject({ kind: 'java', firstLine: failure.firstLine + 1, frames: 8 });
    expect(failure.trace!.lines[0]).toContain('org.opentest4j.AssertionFailedError: expected: <110.25> but was: <110.24>');

    const fatal = find(result.groups, /^FATAL: Failed to notify/);
    expect(fatal.signature).toBe('FATAL: Failed to notify https://hooks.imagile.dev/services/<hex>');
    expect(fatal.trace).toMatchObject({ kind: 'java', frames: 7 });
    expect(fatal.trace!.lines.at(-3)).toContain('Caused by: java.net.SocketTimeoutException: Read timed out');
    expect(fatal.trace!.lines.at(-1)).toContain('... 14 more');

    // The timestamper prefix is not part of the signature, and BUILD FAILURE under [INFO] is still an error.
    find(result.groups, /^ERROR: script returned exit code <n>$/);
    find(result.groups, /^\[INFO\] BUILD FAILURE$/);
    find(result.groups, /^Finished: FAILURE$/);
    expect(codes).toEqual(['LOG_UNCLASSIFIED']);
  });

  it('Maven: one group per compiler error with every occurrence counted, and the -e trace joined', async () => {
    const { result } = await triage(LOGS.maven);
    expect(result.verified.passed).toBe(true);
    const symbol = find(result.groups, /Reconciler\.java:\[<n>\] cannot find symbol$/);
    // Lines 27 and 30 in the compiler's own report, 49 and 52 again in the goal failure.
    expect([symbol.count, symbol.firstLine, symbol.lastLine]).toEqual([4, 27, 52]);
    expect(find(result.groups, /Journal\.java:\[<n>\] \[deprecation\]/).count).toBe(2);
    const help = find(result.groups, /^\[ERROR\] -> \[Help <n>\]$/);
    expect(help.trace).toMatchObject({ kind: 'java', frames: 12 });
    expect(help.trace!.lines[0]).toMatch(/^org\.apache\.maven\.lifecycle\.LifecycleExecutionException/);
    expect(help.trace!.lines[7]).toMatch(/^Caused by: org\.apache\.maven\.plugin\.compiler\.CompilationFailureException/);
    // A bare [ERROR] line is not an error group.
    expect(result.groups.some((g) => g.signature === '[ERROR]')).toBe(false);
  });

  it('npm: TypeScript errors keep their codes, npm error lines group across runs, and Node traces join', async () => {
    const { result } = await triage(LOGS.npm);
    expect(result.verified.passed).toBe(true);
    expect(find(result.groups, /^npm error code <n>$/).count).toBe(2);
    expect(find(result.groups, /^npm error command failed$/).count).toBe(2);
    find(result.groups, /CardForm\.tsx\(<n>\): error TS2322/);
    find(result.groups, /CardForm\.tsx\(<n>\): error TS2345/);
    find(result.groups, /npm error A complete log of this run can be found in: \/home\/ci\/\.npm\/_logs\/<ts>-debug-<n>\.log$/);
    const typeError = find(result.groups, /^TypeError: Cannot read properties of undefined/);
    expect(typeError.trace).toMatchObject({ kind: 'node', frames: 4 });
    const failed = find(result.groups, /^FAIL src\/cart\/useCart\.test\.ts/);
    expect(failed.trace).toMatchObject({ kind: 'node', frames: 5 });
    expect(failed.trace!.lines[0]).toBe('AssertionError: expected 90 to be 81 // Object.is equality');
    expect(result.groups.filter((g) => g.level === 'warning')).toHaveLength(7);
    find(result.groups, /^<n>:<n> warning 'formatCurrency' is defined but never used/);
  });

  it('dotnet: the build summary repeats are counted, not regrouped, and both .NET traces join', async () => {
    const { result } = await triage(LOGS.dotnet);
    expect(result.verified.passed).toBe(true);
    const cs0246 = find(result.groups, /error CS0246:/);
    expect([cs0246.count, cs0246.firstLine, cs0246.lastLine]).toEqual([2, 8, 17]);
    expect(find(result.groups, /warning NETSDK1138:/).count).toBe(2);
    expect(find(result.groups, /warning CS8618: Non-nullable property 'CustomerId'/).count).toBe(2);
    const test = find(result.groups, /^Failed Imagile\.Orders\.Tests\.OrderTotalsTests/);
    // vstest prints the message between the failure and its trace; the trace still joins.
    expect(test.trace).toMatchObject({ kind: 'dotnet', frames: 3 });
    const unhandled = find(result.groups, /^Unhandled exception\. System\.InvalidOperationException/);
    expect(unhandled.trace).toMatchObject({ kind: 'dotnet', frames: 6 });
    expect(unhandled.trace!.lines).toContain('   --- End of inner exception stack trace ---');
    expect(result.unjoinedFrames).toBe(0);
  });

  it('Python: the traceback printed before the exception joins the exception line', async () => {
    const log = [
      'INFO worker started',
      'Traceback (most recent call last):',
      '  File "/srv/app/worker.py", line 41, in <module>',
      '    main()',
      '  File "/srv/app/worker.py", line 12, in main',
      '    total = int(row["amount"])',
      "ValueError: invalid literal for int() with base 10: 'n/a'",
      'INFO worker stopped',
      '',
    ].join('\n');
    const { result } = await triage(log);
    expect(result.verified.passed).toBe(true);
    expect(result.groups).toEqual([
      {
        level: 'error',
        signature: "ValueError: invalid literal for int() with base <n>: 'n/a'",
        count: 1,
        firstLine: 7,
        lastLine: 7,
        sample: "ValueError: invalid literal for int() with base 10: 'n/a'",
        trace: { kind: 'python', firstLine: 2, lastLine: 6, frames: 5, lines: log.split('\n').slice(1, 6) },
      },
    ]);
    expect(result.lines.stack).toBe(5);
  });
});

describe('util log signatures and classes', () => {
  it('strips timestamps, UUIDs, hex and numbers, and keeps error codes', () => {
    expect(signature('2026-10-14 09:12:01,114 ERROR [worker-3] Request 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed after 512 ms at 0x7ffd3a, commit 3f9c2a1b7e')).toBe(
      '<ts> ERROR [worker-<n>] Request <id> failed after <n> ms at <hex>, commit <hex>',
    );
    expect(signature('Program.cs(22,1): error CS0246: x')).toBe('Program.cs(<n>): error CS0246: x');
    expect(signature('elapsed 09:12:01.5   then   done')).toBe('elapsed <ts> then done');
  });

  it('classifies by the first level word, then by shape, and leaves lines with no level unclassified', () => {
    expect(classify('[INFO] Tests run: 3, Failures: 0, Errors: 0')).toBe('other');
    expect(classify('[INFO] BUILD FAILURE')).toBe('error');
    expect(classify('[WARNING] it is deprecated')).toBe('warning');
    expect(classify('[ERROR] ')).toBe('other');
    expect(classify('12 error code ELIFECYCLE')).toBe('error');
    expect(classify('npm warn deprecated glob@7.2.3')).toBe('warning');
    expect(classify('a.c:3:9: warning: unused variable')).toBe('warning');
    expect(classify('System.IO.IOException: disk full')).toBe('error');
    expect(classify('+ mvn -B verify')).toBeUndefined();
    expect(classify('src/error.ts compiled')).toBeUndefined();
    expect(frameKind('\tat com.imagile.A.b(A.java:3)')).toBe('java');
    expect(frameKind('    at run (file:///a.js:1:2)')).toBe('node');
    expect(frameKind('   at A.B() in /src/A.cs:line 9')).toBe('dotnet');
    expect(frameKind('    at nothing we know')).toBe('unknown');
    expect(frameKind('look at this')).toBeUndefined();
  });

  it('counts and reports lines it could not classify, and frames with nothing to join', async () => {
    const { result, warnings } = await triage('[Pipeline] sh\n+ make\n\tat com.imagile.A.b(A.java:3)\nERROR: boom\n');
    expect(result.lines).toMatchObject({ total: 4, unclassified: 2, stack: 1, error: 1 });
    expect(result.unjoinedFrames).toBe(1);
    expect(warnings).toEqual([
      { code: 'LOG_UNCLASSIFIED', message: '2 of 4 lines carry no level and are in no group. Ask for context (--context, or context over MCP) to see the lines around each group.' },
      { code: 'LOG_TRACE_UNJOINED', message: '1 stack trace lines had no error or warning line to join, so they are counted as stack but not reported.' },
    ]);
  });
});

describe('util log long lines', () => {
  it('groups a line past 4,096 characters by its start, and says the grouping is approximate', async () => {
    const long = `ERROR payload rejected: ${'x'.repeat(5000)}`;
    const { result, codes } = await triage(`${long}1\n${long}2\n`);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ count: 2, sample: long.slice(0, 4096) });
    expect(result.verified.checks).toContainEqual(expect.objectContaining({ check: 'signatures', status: 'approximated' }));
    expect(result.verified.passed).toBe(true);
    expect(codes).toContain('APPROXIMATED');
  });

  it('counts a Python traceback that ends in a blank line, with no exception, as unjoined', async () => {
    const { result, codes } = await triage('Traceback (most recent call last):\n  File "a.py", line 1, in <module>\n\nINFO done\n');
    expect([result.lines.stack, result.unjoinedFrames, result.groups.length]).toEqual([2, 2, 0]);
    expect(codes).toContain('LOG_TRACE_UNJOINED');
  });
});

describe('util log options', () => {
  it('--since keeps lines dated at or after it, an undated line taking the date before it', async () => {
    const { result } = await triage(LOGS.jenkins, { since: '2026-10-14T09:12:22Z' });
    expect(result.groups.map((g) => g.signature)).toEqual([
      'ERROR: No artifacts found that match the file pattern "target/*.jar". Configuration error?',
      'FATAL: Failed to notify https://hooks.imagile.dev/services/<hex>',
      'ERROR: script returned exit code <n>',
      'Finished: FAILURE',
    ]);
    expect(result.filtered).toBe(11);
    expect(result.verified.passed).toBe(true);
  });

  it('--since with a log that has no dates keeps everything and says so; without a zone it is an approximation', async () => {
    const { result, codes } = await triage('ERROR: one\nERROR: two\n', { since: '2026-10-14' });
    expect(result.matched).toBe(2);
    expect(codes).toContain('LOG_SINCE_UNDATED');
    const naive = await triage('2026-10-14 09:00:00 ERROR early\n2026-10-14 10:00:00 ERROR late\n', { since: '2026-10-14 09:30' });
    expect(naive.result.groups.map((g) => g.firstLine)).toEqual([2]);
    expect(naive.result.verified.checks).toContainEqual(expect.objectContaining({ check: 'since', status: 'approximated' }));
    expect(naive.codes).toContain('APPROXIMATED');
  });

  it('--level error drops warnings, --grep keeps matching lines, and both count what they left out', async () => {
    const errors = await triage(LOGS.dotnet, { level: 'error' });
    expect(errors.result.groups.every((g) => g.level === 'error')).toBe(true);
    expect(errors.result.filtered).toBe(7);
    const grep = await triage(LOGS.dotnet, { grep: 'CS\\d{4}' });
    expect(grep.result.groups.map((g) => /CS\d{4}/.test(g.sample))).toEqual(grep.result.groups.map(() => true));
    expect(grep.result.matched + grep.result.filtered).toBe(grep.result.lines.error + grep.result.lines.warning);
  });

  it('joins an exception line only to an error: after a warning it is an error of its own, kept under --level error', async () => {
    const log = '[WARN] slow\njava.lang.NullPointerException: x\n\tat a.b.C.d(C.java:1)\n';
    const all = await triage(log);
    expect(all.result.groups.map((g) => [g.level, g.signature, g.trace?.firstLine])).toEqual([
      ['error', 'java.lang.NullPointerException: x', 3],
      ['warning', '[WARN] slow', undefined],
    ]);
    const errors = await triage(log, { level: 'error' });
    expect(errors.result.groups).toEqual([
      { level: 'error', signature: 'java.lang.NullPointerException: x', count: 1, firstLine: 2, lastLine: 2, sample: 'java.lang.NullPointerException: x', trace: { kind: 'java', firstLine: 3, lastLine: 3, frames: 1, lines: ['\tat a.b.C.d(C.java:1)'] } },
    ]);
    expect([errors.result.matched, errors.result.filtered, errors.result.verified.passed]).toEqual([1, 1, true]);
  });

  it('--grep matches an error by the exception line heading its trace, and says when it matches only frames', async () => {
    const { result } = await triage(SAMPLE_LOG, { grep: 'IllegalStateException' });
    expect(result.groups.map((g) => [g.signature, g.count, g.trace?.frames])).toEqual([['[ERROR] Order <n> failed: tax total is negative', 1, 2]]);
    // The second occurrence has no exception line after it, so it's filtered out; so is the warning.
    expect([result.matched, result.filtered, result.verified.passed]).toEqual([1, 2, true]);

    const frames = await triage(SAMPLE_LOG, { grep: 'Order[.]java' });
    expect(frames.result.matched).toBe(0);
    expect(frames.warnings.find((w) => w.code === 'LOG_GREP_STACK_ONLY')?.message).toBe(
      "grep matched no error or warning line, but it matches 1 stack trace lines. It searches error and warning lines and the exception line that heads an error's trace, not the frames.",
    );

    // A trace under an error --since dropped is not grep's miss, so the warning doesn't blame grep.
    const since = await triage('[2026-01-01T00:00:00Z] [ERROR] boom\njava.lang.IllegalStateException: x\n\tat a.b.C.d(C.java:1)\n', { since: '2026-06-01', grep: 'IllegalState' });
    expect([since.result.matched, since.result.filtered]).toEqual([0, 1]);
    expect(since.codes).not.toContain('LOG_GREP_STACK_ONLY');
  });

  it('refuses a --since or --grep it cannot read', async () => {
    await expect(triage('x', { since: 'last tuesday' })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('--since "last tuesday"') });
    await expect(triage('x', { grep: '(' })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('--grep') });
  });

  it('--max-groups caps the groups and reports the truncation; --context adds the lines around each sample', async () => {
    const { result, codes } = await triage(LOGS.maven, { maxGroups: 2, context: 1 });
    expect([result.groups.length, result.groupsTotal, result.truncated]).toEqual([2, 18, true]);
    expect(codes).toContain('LOG_GROUPS_TRUNCATED');
    const [first] = result.groups;
    expect(first!.context).toEqual({
      before: [{ line: first!.firstLine - 1, text: lineOf(LOGS.maven, first!.firstLine - 1) }],
      after: [{ line: first!.firstLine + 1, text: lineOf(LOGS.maven, first!.firstLine + 1) }],
    });
  });
});

describe('util log self-check', () => {
  const setup = async (text: string) => {
    const warnings: Warning[] = [];
    const ctx = { files: memoryFiles({ 'build.log': text }), warn: (w: Warning) => warnings.push(w) };
    const input = await openInput(ctx, { inputFile: 'build.log' });
    const v = new Verifier(ctx.warn);
    const found = await scan(input, parseFilters({}), v);
    return { warnings, found, run: () => finish(found, input, {}, v, ctx.warn) };
  };

  it('re-reads every reported line, and catches an off-by-one in a line number', async () => {
    const { found, warnings, run } = await setup(LOGS.maven);
    const group = found.groups.find((g) => g.signature.includes('cannot find symbol'))!;
    group.firstLine += 1;
    const result = await run();
    expect(result.verified.passed).toBe(false);
    const reread = result.verified.checks.find((c) => c.check === 'lines.reread')!;
    expect(reread).toMatchObject({ status: 'failed', failed: 1 });
    expect(reread.failures![0]).toEqual({ at: `line ${group.firstLine}`, expected: group.sample, actual: lineOf(LOGS.maven, group.firstLine) });
    expect(warnings.find((w) => w.code === 'LOG_LINE_MISMATCH')?.message).toMatch(/^lines\.reread at line 28: expected .* \(1 of \d+ checks failed\)$/);
  });

  it('catches a last line that does not hold the group, and a trace that does not start where it says', async () => {
    const { found, run } = await setup(LOGS.jenkins);
    const fatal = found.groups.find((g) => g.signature.startsWith('FATAL'))!;
    fatal.lastLine -= 1;
    fatal.trace!.firstLine -= 1;
    const result = await run();
    const failed = result.verified.checks.filter((c) => c.status === 'failed').map((c) => c.check);
    expect(failed).toEqual(['lines.reread', 'trace.reread']);
  });

  it('sums the groups against the matched lines, and catches a count that is off', async () => {
    const { found, warnings, run } = await setup(LOGS.npm);
    found.groups[0]!.count += 1;
    const result = await run();
    expect(result.verified.checks.find((c) => c.check === 'groups.sum')).toMatchObject({ status: 'failed', failures: [{ expected: 21, actual: 22 }] });
    expect(warnings.map((w) => w.code)).toContain('LOG_COUNT_MISMATCH');
  });

  it('catches line classes that do not add up to the lines read', async () => {
    const { found, run } = await setup(LOGS.dotnet);
    found.lines.unclassified -= 1;
    const result = await run();
    expect(result.verified.checks.find((c) => c.check === 'lines.sum')).toMatchObject({ status: 'failed' });
  });

  it('catches a log that changed between the pass and the re-read', async () => {
    const memory = memoryFiles({ 'build.log': LOGS.dotnet });
    const stream = memory.readStream.bind(memory);
    let passes = 0;
    // The second pass, the re-read, sees the log with a line inserted at the top.
    memory.readStream = (path, o) => (passes++ === 0 ? stream(path, o) : (async function* () {
      yield new TextEncoder().encode(`  Restoring...\n${LOGS.dotnet}`);
    })());
    const warnings: Warning[] = [];
    const result = await runLog({ files: memory, warn: (w) => warnings.push(w) }, { inputFile: 'build.log' }, {});
    expect(result.verified.passed).toBe(false);
    expect(warnings.map((w) => w.code)).toContain('LOG_LINE_MISMATCH');
  });

  it('reports every check it ran, and stdin as not size-checked', async () => {
    const { context } = testContext({ stdin: LOGS.maven });
    const envelope = await execute(logCommand, {}, context);
    expect(envelope.ok).toBe(true);
    const checks = (envelope.data as { verified: { checks: Array<{ check: string; status: string }> } }).verified.checks;
    expect(checks.map((c) => [c.check, c.status])).toEqual([
      ['input.complete', 'unchecked'],
      ['lines.reread', 'passed'],
      ['trace.reread', 'passed'],
      ['groups.sum', 'passed'],
      ['lines.sum', 'passed'],
      ['filter.sum', 'passed'],
    ]);
    expect(envelope.meta.warnings?.map((w) => w.code)).toContain('UNVERIFIED');
  });
});

describe('util log through the CLI', () => {
  it('reads a file, stdin and --text, with the same answer from each', async () => {
    const files = { 'logs/maven.log': LOGS.maven };
    const fromFile = await runCli(['util', 'log', 'logs/maven.log', '--level', 'error', '--max-groups', '3'], { commands: [logCommand], context: testContext({ files }).context });
    const fromStdin = await runCli(['util', 'log', '-', '--level', 'error', '--max-groups', '3'], { commands: [logCommand], context: testContext({ stdin: LOGS.maven }).context });
    const a = JSON.parse(fromFile.stdout);
    const b = JSON.parse(fromStdin.stdout);
    expect(a.ok).toBe(true);
    expect(a.data.groups).toEqual(b.data.groups);
    expect(a.data.groups).toHaveLength(3);
    const text = JSON.parse((await runCli(['util', 'log', '--text', SAMPLE_LOG], { commands: [logCommand], context: testContext().context })).stdout);
    expect(text.data.groups[0]).toMatchObject({ signature: '[ERROR] Order <n> failed: tax total is negative', count: 2, firstLine: 2, lastLine: 5, trace: { kind: 'java', frames: 2 } });
  });
});

describe('util log memory', () => {
  /** One line of a generated log: dated errors with ids, Java traces, warnings, info, and a new signature every 50 lines. */
  const lineAt = (i: number): string => {
    if (i % 50 === 7) return `2026-10-14T09:00:00.000Z ERROR unique failure in module ${[...i.toString(26)].map((c) => String.fromCharCode(97 + parseInt(c, 26))).join('')}`;
    switch (i % 10) {
      case 0:
        return `2026-10-14T09:00:00.000Z ERROR [worker-${i % 7}] Request ${(i * 2654435761).toString(16).padStart(8, '0').slice(0, 8)}-0000-4000-8000-000000000000 failed after ${i % 997} ms`;
      case 1:
        return `\tat com.imagile.payments.Worker.run(Worker.java:${i % 300})`;
      case 5:
        return `2026-10-14T09:00:00.000Z WARN Slow query ${i} took ${i % 100} ms`;
      default:
        return `2026-10-14T09:00:00.000Z INFO Processed batch ${i} of the nightly settlement run`;
    }
  };

  it('streams a log far larger than the memory it is allowed, and still checks itself', { timeout: 300_000 }, async () => {
    const LINES = 1_600_000;
    let size = 0;
    for (let i = 0; i < LINES; i++) size += lineAt(i).length + 1;
    expect(size).toBeGreaterThan(110 * 1024 * 1024);

    // A full collection before each reading, so the heap shows what is held rather than what is garbage.
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    let peak = 0;
    const sample = () => {
      gc();
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    };
    // A file that exists only as it streams: nothing holds it whole, so the heap shows what the command holds.
    const files = {
      stat: () => ({ type: 'file', size, modified: '2026-10-14T09:00:00.000Z' }),
      readStream: () =>
        (async function* () {
          let chunk: string[] = [];
          let bytes = 0;
          let chunks = 0;
          for (let i = 0; i < LINES; i++) {
            const line = lineAt(i);
            chunk.push(line);
            bytes += line.length + 1;
            if (bytes >= 64 * 1024) {
              yield Buffer.from(`${chunk.join('\n')}\n`);
              chunk = [];
              bytes = 0;
              if (++chunks % 100 === 0) sample();
            }
          }
          if (chunk.length) yield Buffer.from(`${chunk.join('\n')}\n`);
        })(),
    } as unknown as FileAccess;

    gc();
    const baseline = process.memoryUsage().heapUsed;
    const warnings: Warning[] = [];
    const result = await runLog({ files, warn: (w) => warnings.push(w) }, { inputFile: 'huge.log' }, {});
    sample();

    const grew = peak - baseline;
    expect(grew, `heap grew ${Math.round(grew / 1024 / 1024)} MiB on a ${Math.round(size / 1024 / 1024)} MiB log`).toBeLessThan(16 * 1024 * 1024);
    expect(result.verified.passed).toBe(true);
    expect(result.verified.checks.find((c) => c.check === 'input.complete')).toMatchObject({ status: 'passed' });
    expect(result.lines.total).toBe(LINES);
    // Two repeating groups, then a new signature every 50 lines: past the cap they are counted as ungrouped.
    const unique = LINES / 50;
    expect(result.groupsTotal).toBe(MAX_TRACKED);
    expect(result.ungrouped).toBe(unique - (MAX_TRACKED - 2));
    expect(warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['LOG_UNGROUPED', 'LOG_GROUPS_TRUNCATED']));
    const worker = result.groups.find((g) => g.signature.startsWith('ERROR [worker-<n>] Request <id>'))!;
    expect(worker).toMatchObject({ count: LINES / 10, firstLine: 1, trace: { kind: 'java', frames: 1 } });
  });
});
