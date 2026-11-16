import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryFiles } from '../../../../test/harness/files.js';
import type { Warning } from '../../../core/envelope.js';
import { ToilError } from '../../../core/errors.js';
import { runLog } from '../log.js';
import { convertMarkdown } from '../md/convert.js';
import { checkDocument, loadDocument } from '../openapi/document.js';
import { measure, type FileSize } from '../size/measure.js';
import { BOUNDED_TIMEOUT_MS, boundedError, boundedWorkerStarts, grepBounded, runBounded, validateBounded } from './bounded.js';
import { openInput } from './input.js';
import { outOfStack } from './stack.js';
import { Verifier } from './verify.js';

/**
 * The util steps #200 moved into the bounded worker, each held to its
 * limits on the input that made it necessary: a `--grep` pattern that
 * backtracks without end, Markdown that parses in exponential time or nests
 * past the stack, a file whose outline does the same, and a YAML document
 * past its memory. Each stops at its deadline, or its limit, as a plain
 * error naming the step and the limit, never INTERNAL; and a cancel stops
 * it. Deadlines are measured against the step's own (#218), never against
 * how fast the runner is. Every limit is a promise until someone tests it.
 */

/** A short deadline for the step under test, and the room past it for a worker's start and teardown on a loaded runner. What these catch is a deadline that never fires. */
const DEADLINE_MS = 300;
const ROOM_MS = 8_000;

const timed = async <T>(work: () => Promise<T>) => {
  const started = performance.now();
  const settled = await work().then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  return { ...settled, ms: performance.now() - started };
};

const ctxWith = (files: Record<string, string>, signal?: AbortSignal) => {
  const warnings: Warning[] = [];
  return { warnings, ctx: { files: memoryFiles(files), warn: (w: Warning) => warnings.push(w), ...(signal ? { signal } : {}) } };
};

/** A log whose error line `(a+)+$` backtracks on: forty a's and a !, 2^40 ways to fail. */
const REDOS_LOG = `[2026-10-14T09:12:20.411Z] [ERROR] ${'a'.repeat(40)}!\n[2026-10-14T09:12:20.412Z] [ERROR] Order 1042 failed\n`;

describe('util log --grep in the bounded worker', () => {
  it('stops a backtracking pattern at its deadline, naming the lines and the limit', async () => {
    const { ctx } = ctxWith({ 'build.log': REDOS_LOG });
    const { error, ms } = await timed(() => runLog(ctx, { inputFile: 'build.log' }, { grep: '(a+)+$' }, { timeoutMs: DEADLINE_MS }));
    expect(error).toBeInstanceOf(ToilError);
    expect(error).toMatchObject({ code: 'TIMEOUT', message: 'Matching --grep against lines 1-2 took longer than the 0.3 s it may run, so it was stopped.', fix: expect.stringContaining('(a+)+') });
    expect(ms).toBeLessThan(DEADLINE_MS + ROOM_MS);
  }, 20_000);

  it('stops at once when the command is cancelled', async () => {
    const controller = new AbortController();
    const { ctx } = ctxWith({ 'build.log': REDOS_LOG }, controller.signal);
    // The step's deadline is far past the abort: if the cancel didn't stop the worker, the deadline would, as TIMEOUT.
    const timeoutMs = 10_000;
    setTimeout(() => controller.abort(), 100);
    const { error, ms } = await timed(() => runLog(ctx, { inputFile: 'build.log' }, { grep: '(a+)+$' }, { timeoutMs }));
    expect(error).toMatchObject({ code: 'CANCELLED' });
    expect(ms).toBeLessThan(timeoutMs);
  }, 20_000);

  it('still filters by the pattern, across batches of lines', async () => {
    const lines = Array.from({ length: 9_000 }, (_, i) => `[2026-10-14T09:12:20.411Z] [ERROR] Order ${i} failed${i % 1000 === 0 ? ' TS2304' : ''}`);
    const { ctx } = ctxWith({ 'build.log': `${lines.join('\n')}\n` });
    const result = await runLog(ctx, { inputFile: 'build.log' }, { grep: 'TS\\d+' });
    // 9,000 lines cross the 4,096-line batch twice; every tenth hundred carries the code.
    expect(result.matched).toBe(9);
    expect(result.filtered).toBe(8_991);
  }, 20_000);

  it('grepBounded marks each line the pattern matches', async () => {
    expect(await grepBounded('^b', ['abc', 'bcd', '', 'b'])).toEqual({ ok: true, value: new Uint8Array([0, 1, 0, 1]) });
  });
});

describe('util md in the bounded worker', () => {
  const source = (text: string) => ({ source: { kind: 'text' as const }, expectedBytes: Buffer.byteLength(text), bytesRead: Buffer.byteLength(text), truncated: false, label: 'the text' });
  const convert = (text: string, limits?: { timeoutMs?: number; maxMemoryMb?: number }, signal?: AbortSignal) =>
    convertMarkdown({ to: 'wiki', text, source: source(text) }, { warn: () => {}, ...(signal ? { signal } : {}) }, limits ? { limits } : {});

  it('stops emphasis that parses in exponential time at its deadline, as TIMEOUT naming the step', async () => {
    // A few hundred kilobytes of this ran for over a minute on the command's own thread.
    const { error, ms } = await timed(() => convert('*a '.repeat(100_000), { timeoutMs: DEADLINE_MS }));
    expect(error).toMatchObject({ code: 'TIMEOUT', message: 'Converting the text took longer than the 0.3 s it may run, so it was stopped.' });
    expect(ms).toBeLessThan(DEADLINE_MS + ROOM_MS);
  }, 20_000);

  it('turns quotes nested past the stack into INVALID_INPUT, never INTERNAL', async () => {
    const { error } = await timed(() => convert(`${'>'.repeat(100_000)} x`));
    expect(error).toMatchObject({ code: 'INVALID_INPUT', message: 'Converting the text nests too deep: it ran out of stack and was stopped.' });
  }, 20_000);

  it('says so plainly when a conversion needs more memory than it may use', async () => {
    const { error } = await timed(() => convert('Some **bold** text and a [link](https://docs.imagile.dev).\n\n'.repeat(40_000), { maxMemoryMb: 16 }));
    expect(error).toMatchObject({ code: 'INVALID_INPUT', message: 'Converting the text needed more than the 16 MB of memory it may use, so it was stopped.' });
  }, 20_000);

  it('stops at once when the command is cancelled', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const { error, ms } = await timed(() => convert('*a '.repeat(100_000), { timeoutMs: 10_000 }, controller.signal));
    expect(error).toMatchObject({ code: 'CANCELLED' });
    expect(ms).toBeLessThan(10_000);
  }, 20_000);

  it('runs an ADF conversion, both schema checks and the read back on one worker: one start, not one per step', async () => {
    // A task at the default limit first, so the conversion needs a worker of its own.
    await validateBounded({ type: 'string' }, 'x');
    const before = boundedWorkerStarts();
    const text = '# Title\n\nSome **bold** text.\n';
    const toAdf = await convertMarkdown({ to: 'adf', text, source: source(text) }, { warn: () => {} });
    const adf = JSON.stringify(toAdf.output);
    await convertMarkdown({ from: 'adf', text: adf, source: source(adf) }, { warn: () => {} });
    // Counted, not timed: two conversions, four schema checks and two read backs, one worker.
    expect(boundedWorkerStarts() - before).toBe(1);
  }, 20_000);

  it('still converts, and refuses input that is not what it says, with its own error', async () => {
    expect((await convert('# Title\n\nSome **bold** text.\n')).output).toBe('h1. Title\n\nSome *bold* text.');
    await expect(convertMarkdown({ from: 'adf', text: '{"type":"paragraph"}', source: source('{"type":"paragraph"}') }, { warn: () => {} })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('not an ADF document') });
  }, 20_000);
});

describe('util size outlines in the bounded worker', () => {
  const sizeOf = (files: Record<string, string>, file: string, limits?: { timeoutMs?: number; maxMemoryMb?: number }) => {
    const { ctx, warnings } = ctxWith(files);
    return { warnings, run: () => measure({ inputFile: file }, ctx, limits) as Promise<FileSize> };
  };

  it('stops an outline that passes its deadline, as TIMEOUT naming the file', async () => {
    // Two million headings: linear now, and still far more than a 1 ms deadline allows.
    const { run } = sizeOf({ 'notes.md': '# h\n'.repeat(2_000_000) }, 'notes.md', { timeoutMs: 1 });
    const { error, ms } = await timed(run);
    expect(error).toMatchObject({ code: 'TIMEOUT', message: 'Outlining the file "notes.md" took longer than the 0.001 s it may run, so it was stopped.' });
    expect(ms).toBeLessThan(1 + ROOM_MS);
  }, 20_000);

  it('says so plainly when an outline needs more memory than it may use', async () => {
    const { run } = sizeOf({ 'many.ts': 'export function f(a){}\n'.repeat(300_000) }, 'many.ts', { maxMemoryMb: 16 });
    const { error } = await timed(run);
    expect(error).toMatchObject({ code: 'INVALID_INPUT', message: 'Outlining the file "many.ts" needed more than the 16 MB of memory it may use, so it was stopped.' });
  }, 20_000);

  it('counts a file nested past the stack and says it could not be outlined, where it used to fail as INTERNAL', async () => {
    const { run, warnings } = sizeOf({ 'tmpl.ts': '`${'.repeat(300_000) + '}`'.repeat(300_000) }, 'tmpl.ts');
    const data = await run();
    expect(data).toMatchObject({ bytes: 1_500_000, outline: null, notOutlined: { reason: 'parse-error', detail: 'it nests too deep to outline' } });
    expect(warnings.map((w) => w.code)).toContain('SIZE_PARSE_ERROR');
  }, 20_000);

  it('checks 100,000 keys on one minified line in linear time, where it took minutes', async () => {
    const json = `{${Array.from({ length: 100_000 }, (_, i) => `"k${i}":1`).join(',')}}`;
    const { run } = sizeOf({ 'flat.json': json }, 'flat.json');
    // A count, not a clock: each key's start line is checked once, against one word set for the line.
    const data = await run();
    expect(data.outline?.symbols).toHaveLength(100_000);
    expect(data.verified.checks.find((c) => c.check === 'outline.start')).toMatchObject({ checked: 100_000 });
  }, 20_000);
});

describe('telling the stack running out from a result grown too big', () => {
  afterEach(() => {
    vi.doUnmock('./bounded.js');
    vi.resetModules();
  });

  it('calls only V8\'s stack overflow "stack": Invalid string length and Invalid array length are not nesting', () => {
    const deep = (n: number): number => (n <= 0 ? 0 : 1 + deep(n - 1));
    let overflow: unknown;
    try {
      deep(1e7);
    } catch (err) {
      overflow = err;
    }
    expect(outOfStack(overflow)).toBe(true);
    expect(outOfStack(new RangeError('Invalid string length'))).toBe(false);
    expect(outOfStack(new RangeError('Invalid array length'))).toBe(false);
    expect(outOfStack(new Error('Maximum call stack size exceeded'))).toBe(false);
  });

  it('fails a size outline that hit Invalid string length through boundedError, never as ok with "nests too deep"', async () => {
    vi.resetModules();
    vi.doMock('./bounded.js', async (original) => ({
      ...(await original<typeof import('./bounded.js')>()),
      // What the worker now reports for a RangeError that isn't the stack.
      runBounded: async () => ({ ok: false, cause: 'failed', reason: 'it failed: Invalid string length' }),
    }));
    const { measure: mocked } = await import('../size/measure.js');
    const { ctx } = ctxWith({ 'a.ts': 'export function f() {}\n' });
    await expect(mocked({ inputFile: 'a.ts' }, ctx)).rejects.toMatchObject({ code: 'INTERNAL', message: 'Outlining the file "a.ts" failed: it failed: Invalid string length.' });
  });
});

describe('util openapi documents in the bounded worker', () => {
  const yaml = (paths: number) => ['openapi: 3.0.3', 'info:', '  title: Imagile API', '  version: 1.0.0', 'paths:', ...Array.from({ length: paths }, (_, i) => `  /items${i}:\n    get:\n      operationId: get${i}\n      responses:\n        '200':\n          description: OK`)].join('\n');
  const opened = async (text: string) => {
    const { ctx } = ctxWith({ 'api.yaml': text });
    return openInput(ctx, { inputFile: 'api.yaml' });
  };

  it('reads YAML in the worker and stops it at its deadline, as TIMEOUT naming the file', async () => {
    const input = await opened(yaml(20_000));
    const { error, ms } = await timed(() => loadDocument(input, { limits: { timeoutMs: 1 } }));
    expect(error).toMatchObject({ code: 'TIMEOUT', message: 'Reading the file "api.yaml" took longer than the 0.001 s it may run, so it was stopped.' });
    expect(ms).toBeLessThan(1 + ROOM_MS);
  }, 20_000);

  it('says so plainly when YAML needs more memory than it may use', async () => {
    const input = await opened(yaml(40_000));
    await expect(loadDocument(input, { limits: { maxMemoryMb: 16 } })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'Reading the file "api.yaml" needed more than the 16 MB of memory it may use, so it was stopped.' });
  }, 20_000);

  it("returns YAML's own error from the worker, with its line and column", async () => {
    const input = await opened('openapi: 3.0.3\ninfo: [unclosed\n');
    await expect(loadDocument(input)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/isn't valid YAML at line \d+, column \d+/) });
  });

  it('validates from the bytes, moved to the worker rather than copied, with the same result as from the value', async () => {
    const loaded = await loadDocument(await opened(yaml(3)));
    const bytes = loaded.source!.bytes;
    const report = await checkDocument(loaded, new Verifier(() => {}));
    expect(report).toMatchObject({ spec: 'openapi-3.0', valid: true, problemCount: 0 });
    // Moved, not copied: the buffer is the worker's now, and the document no longer holds it.
    expect(bytes.byteLength).toBe(0);
    expect(loaded.source).toBeUndefined();
    // Validating again falls back to the parsed value.
    expect(await checkDocument(loaded, new Verifier(() => {}))).toMatchObject({ valid: true });
  });
});

describe('boundedError', () => {
  const step = 'Outlining the file "a.ts"';
  it('names the step and the limit for each way a step can stop, and is INTERNAL only for a failure nobody planned for', () => {
    const limits = { timeoutMs: 1_500, maxMemoryMb: 64 };
    const of = (cause: 'timeout' | 'memory' | 'stack' | 'denied' | 'cancelled' | 'failed') => boundedError(step, { ok: false, cause, reason: 'r' }, limits, 'Do less.');
    expect(of('timeout')).toMatchObject({ code: 'TIMEOUT', message: `${step} took longer than the 1.5 s it may run, so it was stopped.`, fix: 'Do less.' });
    expect(of('memory')).toMatchObject({ code: 'INVALID_INPUT', message: `${step} needed more than the 64 MB of memory it may use, so it was stopped.` });
    expect(of('stack')).toMatchObject({ code: 'INVALID_INPUT', message: `${step} nests too deep: it ran out of stack and was stopped.` });
    expect(of('denied')).toMatchObject({ code: 'NOT_CONFIGURED', fix: expect.stringContaining('--allow-worker') });
    expect(of('cancelled')).toMatchObject({ code: 'CANCELLED', message: `${step} was cancelled.` });
    expect(of('failed')).toMatchObject({ code: 'INTERNAL' });
    expect(boundedError(step, { ok: false, cause: 'timeout', reason: 'r' }, {}, 'x').message).toContain(`${BOUNDED_TIMEOUT_MS / 1000} s`);
  });

  it("carries a ToilError thrown in the worker back as the input's own error", async () => {
    const outcome = await runBounded({ kind: 'parse', source: { bytes: new TextEncoder().encode('a: [1'), format: 'yaml' }, label: 'the text' });
    expect(outcome).toMatchObject({ ok: false, cause: 'refused', error: { code: 'INVALID_INPUT', message: expect.stringContaining("The text isn't valid YAML") } });
    if (outcome.ok || outcome.cause !== 'refused') return;
    expect(boundedError(step, outcome, {}, 'x')).toMatchObject({ code: 'INVALID_INPUT', message: outcome.error.message, fix: outcome.error.fix });
  });

  it('validates a source parsed in the worker as it validates the value', async () => {
    const schema = { type: 'object', required: ['a'] } as const;
    const fromValue = await validateBounded(schema as never, { b: 1 });
    const fromSource = await validateBounded(schema as never, undefined, { source: { bytes: new TextEncoder().encode('{"b":1}'), format: 'json' } });
    expect(fromSource).toEqual(fromValue);
    expect(fromSource.valid).toBe(false);
  });
});
