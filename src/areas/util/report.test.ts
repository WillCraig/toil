import { describe, expect, it } from 'vitest';
import { reportFiles } from '../../../test/fixtures/util.fixture.js';
import { runCli } from '../../../test/harness/cli.js';
import { testContext } from '../../../test/harness/context.js';
import { memoryFiles } from '../../../test/harness/files.js';
import { connectMcp } from '../../../test/harness/mcp.js';
import type { Warning } from '../../core/envelope.js';
import { execute } from '../../core/run.js';
import { commands } from './index.js';
import { rateTolerance } from './report/cobertura.js';
import { locationFromStack, trimStack } from './report/shared.js';
import { detectFormat, summariseReport, type ReportData, type ReportInput } from './report/summarise.js';
import { reportCommand } from './report.js';

/**
 * `util report` on one realistic sample of each format (test/fixtures/reports/,
 * described in util.fixture.ts), then each self-check fed a report that
 * contradicts itself, to show the check catches it. A report that passes its
 * own audit is the only kind anyone files.
 */

const sample = (name: string) => reportFiles[`reports/${name}`]!;

/** Runs the command through execute(), as both front doors do. */
async function run(input: ReportInput, files: Record<string, string> = reportFiles) {
  const envelope = await execute(reportCommand, input, testContext({ files }).context);
  return { envelope, data: envelope.data as ReportData, warnings: envelope.meta.warnings ?? [] };
}

const run_ = run;

/** Calls the work directly, with a chosen read cap and chunk size. */
async function summarise(input: ReportInput, files: Record<string, string>, options: { maxBytes?: number; chunkSize?: number } = {}) {
  const warnings: Warning[] = [];
  const memory = memoryFiles(files);
  if (options.chunkSize) {
    const stream = memory.readStream.bind(memory);
    memory.readStream = (path, o) => stream(path, { ...o, chunkSize: options.chunkSize! });
  }
  const data = await summariseReport(input, { files: memory, warn: (w) => warnings.push(w), signal: new AbortController().signal }, options.maxBytes ? { maxBytes: options.maxBytes } : {});
  return { data, warnings };
}

const check = (data: ReportData, name: string) => data.verified.checks.find((c) => c.check === name);
const codes = (warnings: Warning[]) => warnings.map((w) => w.code);

describe('util report: JUnit', () => {
  it('reads a Maven Surefire report: totals, failure and error with file and line from the stack, flaky rerun counted as passed', async () => {
    const { data, warnings } = await run({ inputFile: 'reports/surefire.xml' });
    expect(data.format).toBe('junit');
    expect(data.formatFrom).toBe('content');
    expect(data.findings).toBeNull();
    expect(data.coverage).toBeNull();
    expect(data.tests?.totals).toEqual({ tests: 6, passed: 3, failures: 1, errors: 1, skipped: 1, flaky: 1, other: 0 });
    expect(data.tests?.suites).toBe(1);
    expect(data.tests?.failures).toEqual([
      expect.objectContaining({
        suite: 'dev.imagile.orders.OrderServiceTest',
        name: 'rejectsEmptyCart',
        kind: 'failure',
        type: 'org.opentest4j.AssertionFailedError',
        message: 'expected: <400> but was: <200>',
        file: 'OrderServiceTest.java',
        line: 58,
        location: 'stack',
        stackLines: 11,
      }),
      expect.objectContaining({ name: 'appliesDiscountCode', kind: 'error', type: 'java.net.ConnectException', message: 'Connection refused', file: 'OrderServiceTest.java', line: 91 }),
    ]);
    expect(data.tests?.failures[0]?.stack?.split('\n')[0]).toBe('org.opentest4j.AssertionFailedError: expected: <400> but was: <200>');
    expect(data.verified.passed).toBe(true);
    expect(check(data, 'tests.failures')).toMatchObject({ status: 'passed', checked: 1 });
    expect(check(data, 'failures.location')).toMatchObject({ status: 'approximated' });
    expect(codes(warnings)).toEqual(['APPROXIMATED']);
    expect(data.skipped).toEqual({ count: 0, elements: [] });
  });

  it('reads the Jenkins shape: nested suites, each declaring totals that are recounted, status and assertions attributes', async () => {
    const { data } = await run({ inputFile: 'reports/jenkins.xml' });
    expect(data.tests?.totals).toEqual({ tests: 5, passed: 3, failures: 1, errors: 0, skipped: 1, flaky: 0, other: 0 });
    expect(data.tests?.suites).toBe(3);
    expect(data.tests?.failures).toEqual([expect.objectContaining({ suite: 'gateway/routing', name: 'TestRouteRejectsUnknownHost', file: 'routing_test.go', line: 88, type: null, message: 'Failed' })]);
    // testsuites, gateway, routing and auth each declare tests; three declare skipped.
    expect(check(data, 'tests.total')).toMatchObject({ status: 'passed', checked: 4 });
    expect(check(data, 'tests.skipped')).toMatchObject({ status: 'passed', checked: 3 });
    expect(data.verified.passed).toBe(true);
  });

  it('reads the Azure DevOps shape: the VSTest JUnit logger, with a .NET stack and a multi-line message', async () => {
    const { data } = await run({ inputFile: 'reports/azure-devops.xml' });
    expect(data.tests?.totals).toEqual({ tests: 4, passed: 2, failures: 1, errors: 0, skipped: 1, flaky: 0, other: 0 });
    expect(data.tests?.failures).toEqual([
      expect.objectContaining({
        suite: 'Imagile.Billing.Tests.dll',
        className: 'Imagile.Billing.Tests.InvoiceTests',
        name: 'Total_RoundsToCents(amount: 10.005)',
        message: 'Assert.Equal() Failure: Values differ\nExpected: 10.01\nActual:   10',
        file: '/home/vsts/work/1/s/tests/Imagile.Billing.Tests/InvoiceTests.cs',
        line: 48,
        location: 'stack',
      }),
    ]);
    expect(data.verified.passed).toBe(true);
  });

  it('takes file and line from the report when it states them, and approximates nothing then', async () => {
    const xml = '<testsuites><testsuite name="cart" tests="1" failures="1"><testcase classname="cart" name="adds" file="src/cart.test.ts" line="12"><failure message="boom">at Object.&lt;anonymous&gt; (src/other.ts:3:1)</failure></testcase></testsuite></testsuites>';
    const { data, warnings } = await run({ text: xml });
    expect(data.tests?.failures[0]).toMatchObject({ file: 'src/cart.test.ts', line: 12, location: 'report' });
    expect(check(data, 'failures.location')).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('counts a case that failed every rerun as a failure, and one with only flaky reruns as passed', async () => {
    const xml = `<testsuite name="s" tests="2" failures="1">
      <testcase name="a"><failure message="x"/><rerunFailure message="x"/><rerunFailure message="x"/></testcase>
      <testcase name="b"><flakyError message="y"><stackTrace>y</stackTrace></flakyError></testcase>
    </testsuite>`;
    const { data } = await run({ text: xml });
    expect(data.tests?.totals).toMatchObject({ tests: 2, passed: 1, failures: 1, flaky: 1 });
    expect(data.verified.passed).toBe(true);
    expect(data.skipped.count).toBe(0);
  });

  it('reports a case with both a failure and an error as the error it is counted as', async () => {
    const { data } = await run({ text: '<testsuite name="s" tests="1" errors="1" failures="0"><testcase name="a"><failure message="first"/><error message="second"/></testcase></testsuite>' });
    expect(data.tests?.totals).toMatchObject({ errors: 1, failures: 0 });
    expect(data.tests?.failures).toEqual([expect.objectContaining({ name: 'a', kind: 'error', message: 'first' })]);
    expect(data.verified.passed).toBe(true);
  });

  it('trims a long stack to its first lines and says how many it had', async () => {
    const frames = Array.from({ length: 40 }, (_, i) => `\tat dev.imagile.Deep.call${i}(Deep.java:${i + 1})`).join('\n');
    const { data } = await run({ text: `<testsuite name="s"><testcase name="deep" classname="dev.imagile.DeepTest"><error type="java.lang.StackOverflowError">java.lang.StackOverflowError\n${frames}</error></testcase></testsuite>` });
    const failure = data.tests!.failures[0]!;
    expect(failure.stack!.split('\n')).toHaveLength(15);
    expect(failure.stackLines).toBe(41);
    expect(failure.message).toBe('java.lang.StackOverflowError');
  });
});

describe('util report: the totals self-check', () => {
  it('catches a JUnit suite whose declared failures disagree with its cases, naming both numbers', async () => {
    const broken = sample('surefire.xml').replace('skipped="1" failures="1"', 'skipped="1" failures="2"');
    const { data, warnings } = await run({ inputFile: 'reports/broken.xml' }, { 'reports/broken.xml': broken });
    expect(data.verified.passed).toBe(false);
    expect(check(data, 'tests.failures')).toMatchObject({
      status: 'failed',
      failed: 1,
      failures: [{ at: '<testsuite name="dev.imagile.orders.OrderServiceTest"> at line 2', expected: 2, actual: 1 }],
    });
    expect(warnings).toContainEqual({ code: 'REPORT_TOTALS_MISMATCH', message: '<testsuite name="dev.imagile.orders.OrderServiceTest"> at line 2 declares failures="2", but its test cases count 1.' });
    // The summary is the recount, not the declaration.
    expect(data.tests?.totals.failures).toBe(1);
  });

  it('catches a declared test count that is short, in a nested Jenkins suite and in the testsuites root', async () => {
    const broken = sample('jenkins.xml').replace('<testsuite name="gateway/auth" tests="2"', '<testsuite name="gateway/auth" tests="3"').replace('<testsuites name="imagile-gateway" tests="5"', '<testsuites name="imagile-gateway" tests="7"');
    const { data, warnings } = await run({ text: broken });
    expect(check(data, 'tests.total')).toMatchObject({ status: 'failed', checked: 4, failed: 2 });
    expect(check(data, 'tests.total')?.failures).toEqual([
      { at: '<testsuite name="gateway/auth"> at line 19', expected: 3, actual: 2 },
      { at: '<testsuites name="imagile-gateway"> at line 2', expected: 7, actual: 5 },
    ]);
    expect(warnings.filter((w) => w.code === 'REPORT_TOTALS_MISMATCH')).toEqual([
      { code: 'REPORT_TOTALS_MISMATCH', message: '<testsuite name="gateway/auth"> at line 19 declares tests="3", but its test cases count 2. (2 of 4 checks failed)' },
    ]);
  });

  it('catches TRX counters that disagree with the results', async () => {
    const broken = sample('dotnet.trx').replace('passed="2" failed="1"', 'passed="3" failed="0"');
    const { data, warnings } = await run({ text: broken });
    expect(data.verified.passed).toBe(false);
    expect(check(data, 'tests.passed')).toMatchObject({ status: 'failed', failures: [{ at: '<Counters>', expected: 3, actual: 2 }] });
    expect(warnings).toContainEqual({ code: 'REPORT_TOTALS_MISMATCH', message: '<Counters> declares passed="3", but 2 results have that outcome.' });
    // failed="0" over one Failed result is the counter-left-at-0 case: unchecked, never passed.
    expect(check(data, 'tests.failed')).toMatchObject({ status: 'unchecked' });
    const total = sample('dotnet.trx').replace('total="4"', 'total="5"');
    expect((await run({ text: total })).warnings).toContainEqual({ code: 'REPORT_TOTALS_MISMATCH', message: '<Counters> declares total="5", but the report holds 4 results.' });
  });

  it('reads the dotnet TRX sample: classes from the definitions, the failure located from its stack, notExecuted left at 0 reported unchecked', async () => {
    const { data, warnings } = await run({ inputFile: 'reports/dotnet.trx' });
    expect(data.format).toBe('trx');
    expect(data.tests?.totals).toEqual({ tests: 4, passed: 2, failures: 1, errors: 0, skipped: 1, flaky: 0, other: 0 });
    expect(data.tests?.failures).toEqual([
      expect.objectContaining({ suite: 'Imagile.Billing.Tests.InvoiceTests', name: 'Imagile.Billing.Tests.InvoiceTests.Total_RoundsToCents(amount: 10.005)', kind: 'failure', message: 'Assert.Equal() Failure: Values differ\nExpected: 10.01\nActual:   10', line: 48 }),
    ]);
    expect(data.verified.passed).toBe(true);
    expect(check(data, 'tests.notExecuted')).toMatchObject({ status: 'unchecked' });
    expect(warnings.map((w) => w.message)).toContain('tests.notExecuted was not checked: <Counters> declares notExecuted="0" over 1 results with that outcome; some writers leave this counter at 0, so it isn\'t compared.');
  });

  it('says so when a JUnit report declares no totals at all, rather than passing', async () => {
    const { data, warnings } = await run({ text: '<testsuite name="s"><testcase name="a"/></testsuite>' });
    expect(check(data, 'tests.totals')).toMatchObject({ status: 'unchecked' });
    expect(warnings).toContainEqual({ code: 'UNVERIFIED', message: 'tests.totals was not checked: the report declares no totals (tests, failures, errors, skipped) to recount.' });
  });
});

describe('util report: coverage', () => {
  it('reads coverlet Cobertura: classes sharing a file merged, method copies of lines not counted twice, every rate rechecked', async () => {
    const { data } = await run({ inputFile: 'reports/coverlet.cobertura.xml' });
    expect(data.format).toBe('cobertura');
    expect(data.coverage).toEqual({
      sources: ['/home/vsts/work/1/s/src/Imagile.Billing/'],
      totals: { lines: { covered: 11, total: 15, percent: 73.33 }, branches: { covered: 3, total: 6, percent: 50 } },
      files: [
        { file: 'Invoice.cs', lines: { covered: 9, total: 10, percent: 90 }, branches: { covered: 3, total: 4, percent: 75 } },
        { file: 'TaxTable.cs', lines: { covered: 2, total: 5, percent: 40 }, branches: { covered: 0, total: 2, percent: 0 } },
      ],
      lowest: [
        { file: 'TaxTable.cs', lines: { covered: 2, total: 5, percent: 40 }, branches: { covered: 0, total: 2, percent: 0 } },
        { file: 'Invoice.cs', lines: { covered: 9, total: 10, percent: 90 }, branches: { covered: 3, total: 4, percent: 75 } },
      ],
    });
    // Three classes, the package and the root state a line-rate.
    expect(check(data, 'coverage.lineRate')).toMatchObject({ status: 'passed', checked: 5 });
    expect(data.verified.passed).toBe(true);
  });

  it('reads coverage.py Cobertura with --format given, an empty module having no percentage', async () => {
    const { data } = await run({ inputFile: 'reports/coverage-py.xml', format: 'cobertura', lowest: 1 });
    expect(data.formatFrom).toBe('flag');
    expect(data.coverage?.totals).toEqual({ lines: { covered: 12, total: 16, percent: 75 }, branches: { covered: 3, total: 4, percent: 75 } });
    expect(data.coverage?.files[0]).toEqual({ file: 'inventory/__init__.py', lines: { covered: 0, total: 0, percent: null }, branches: null });
    expect(data.coverage?.lowest.map((f) => f.file)).toEqual(['inventory/reorder.py']);
    expect(data.verified.passed).toBe(true);
  });

  it('catches a stated line-rate and a stated line count that the hit counts contradict', async () => {
    const broken = sample('coverlet.cobertura.xml').replace('filename="TaxTable.cs" line-rate="0.4"', 'filename="TaxTable.cs" line-rate="0.6"').replace('lines-valid="15"', 'lines-valid="14"');
    const { data, warnings } = await run({ text: broken });
    expect(data.verified.passed).toBe(false);
    expect(check(data, 'coverage.lineRate')).toMatchObject({ status: 'failed', failed: 1, failures: [{ at: '<class name="Imagile.Billing.TaxTable"> at line 69', expected: 0.6, actual: 0.4 }] });
    expect(warnings).toContainEqual({ code: 'REPORT_COVERAGE_MISMATCH', message: '<class name="Imagile.Billing.TaxTable"> at line 69 states line-rate="0.6", but its hit counts give 2/5 = 40.00%. (1 of 5 checks failed)' });
    expect(warnings).toContainEqual({ code: 'REPORT_COVERAGE_MISMATCH', message: '<coverage> states lines-valid="14", but its lines count 15.' });
  });

  it('allows a rate one unit in its last written place, rounded or truncated, and no more', () => {
    const near = (stated: string, value: number) => Math.abs(Number(stated) - value) <= rateTolerance(stated);
    expect(near('0.8571', 6 / 7)).toBe(true); // rounded
    expect(near('0.8572', 6 / 7)).toBe(true); // 0.857142… rounded up
    expect(near('0.857', 6 / 7)).toBe(true); // truncated
    expect(near('0.8590', 6 / 7)).toBe(false);
    expect(near('1', 0.99997)).toBe(true);
    expect(near('1', 0.9)).toBe(false);
  });

  it('reads lcov: per-record LF, LH, BRF, BRH, FNF and FNH recounted, the lowest files first', async () => {
    const { data } = await run({ inputFile: 'reports/lcov.info', lowest: 2 });
    expect(data.format).toBe('lcov');
    expect(data.coverage?.totals).toEqual({ lines: { covered: 17, total: 23, percent: 73.91 }, branches: { covered: 2, total: 6, percent: 33.33 } });
    expect(data.coverage?.files.map((f) => [f.file, f.lines.percent, f.branches?.percent ?? null])).toEqual([
      ['src/cart.ts', 83.33, 50],
      ['src/money.ts', 100, null],
      ['src/coupons.ts', 33.33, 0],
    ]);
    expect(data.coverage?.lowest.map((f) => f.file)).toEqual(['src/coupons.ts', 'src/cart.ts']);
    expect(check(data, 'coverage.linesHit')).toMatchObject({ status: 'passed', checked: 3 });
    expect(check(data, 'coverage.functionsHit')).toMatchObject({ status: 'passed', checked: 3 });
    expect(data.verified.passed).toBe(true);
  });

  it('catches an lcov record whose LH disagrees with its DA lines', async () => {
    const broken = sample('lcov.info').replace('LH:10', 'LH:11');
    const { data, warnings } = await run({ text: broken });
    expect(check(data, 'coverage.linesHit')).toMatchObject({ status: 'failed', failures: [{ at: 'SF:src/cart.ts at line 2', expected: 11, actual: 10 }] });
    expect(warnings).toContainEqual({ code: 'REPORT_COVERAGE_MISMATCH', message: 'The record for src/cart.ts at line 2 states LH:11, but its lines count 10. (1 of 3 checks failed)' });
  });

  it('counts FNH as distinct functions hit: an lcov 2 alias, and a repeated FNDA, count once', async () => {
    const lcov = ['SF:a.c', 'FNL:0,1,5', 'FNA:0,3,foo', 'FNA:0,3,foo_alias', 'FN:7,bar', 'FNDA:2,bar', 'FNDA:2,bar', 'FNF:2', 'FNH:2', 'DA:1,3', 'LF:1', 'LH:1', 'end_of_record', ''].join('\n');
    const { data } = await run({ text: lcov });
    expect(check(data, 'coverage.functionsHit')).toMatchObject({ status: 'passed', checked: 1 });
    expect(check(data, 'coverage.functionsFound')).toMatchObject({ status: 'passed', checked: 1 });
    expect(data.verified.passed).toBe(true);
    const broken = await run({ text: lcov.replace('FNH:2', 'FNH:3') });
    expect(check(broken.data, 'coverage.functionsHit')).toMatchObject({ status: 'failed', failures: [{ expected: 3, actual: 2 }] });
  });

  it('merges a file that appears in two records: a line is covered when either hit it', async () => {
    const lcov = 'TN:unit\nSF:a.ts\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\nTN:e2e\nSF:a.ts\nDA:1,0\nDA:2,3\nLF:2\nLH:1\nend_of_record\n';
    const { data } = await run({ text: lcov });
    expect(data.coverage?.files).toEqual([{ file: 'a.ts', lines: { covered: 2, total: 2, percent: 100 }, branches: null }]);
    expect(data.verified.passed).toBe(true);
  });
});

describe('util report: SARIF', () => {
  it('reads CodeQL SARIF: levels from each rule, file and line from the first location, ruleIndex cross-checked', async () => {
    const { data, warnings } = await run({ inputFile: 'reports/codeql.sarif' });
    expect(data.format).toBe('sarif');
    expect(data.tests).toBeNull();
    expect(data.findings).toEqual({
      runs: [{ tool: 'CodeQL', version: '2.19.1', results: 3 }],
      total: 3,
      byLevel: { error: 1, warning: 1, note: 1 },
      results: [
        { tool: 'CodeQL', rule: 'js/sql-injection', level: 'error', kind: 'fail', file: 'src/routes/orders.js', line: 42, message: 'This query string depends on a [user-provided value](1).', suppressed: false },
        { tool: 'CodeQL', rule: 'js/missing-rate-limiting', level: 'warning', kind: 'fail', file: 'src/app.js', line: 17, message: 'This route handler performs [a database access](1), but is not rate-limited.', suppressed: false },
        { tool: 'CodeQL', rule: 'js/unused-local-variable', level: 'note', kind: 'fail', file: 'src/routes/orders.js', line: 12, message: 'Unused variable retries.', suppressed: false },
      ],
    });
    expect(check(data, 'sarif.ruleIndex')).toMatchObject({ status: 'passed', checked: 3 });
    expect(warnings).toEqual([{ code: 'UNVERIFIED', message: 'findings.totals was not checked: SARIF declares no totals of its own to recount.' }]);
  });

  it('catches a ruleIndex that points at a different rule than the ruleId', async () => {
    const broken = sample('codeql.sarif').replace('"ruleId": "js/unused-local-variable",\n          "ruleIndex": 1', '"ruleId": "js/unused-local-variable",\n          "ruleIndex": 0');
    const { data, warnings } = await run({ text: broken });
    expect(data.verified.passed).toBe(false);
    expect(warnings).toContainEqual({ code: 'REPORT_SARIF_INCONSISTENT', message: 'runs[0].results[2] names rule "js/unused-local-variable", but its ruleIndex 0 points at "js/sql-injection". (1 of 3 checks failed)' });
  });

  it('applies the spec defaults, message templates, suppressions, an unexpected version and a failed tool run', async () => {
    const sarif = JSON.stringify({
      version: '2.0.0',
      runs: [
        {
          tool: { driver: { name: 'ESLint', rules: [{ id: 'no-eval', messageStrings: { default: { text: 'eval in {0} is not allowed' } } }] } },
          invocations: [{ executionSuccessful: false }],
          artifacts: [{ location: { uri: 'src/render.js' } }],
          results: [
            { ruleId: 'no-eval', ruleIndex: 0, message: { id: 'default', arguments: ['render'] }, locations: [{ physicalLocation: { artifactLocation: { index: 0 }, region: { startLine: 3 } } }] },
            { ruleId: 'no-eval', kind: 'pass', message: { text: 'ok' } },
            { ruleId: 'no-eval', level: 'error', message: { text: 'kept' }, suppressions: [{ kind: 'inSource' }] },
            'not a result',
          ],
        },
      ],
    });
    const { data, warnings } = await run({ text: sarif });
    expect(data.findings?.results).toEqual([
      { tool: 'ESLint', rule: 'no-eval', level: 'warning', kind: 'fail', file: 'src/render.js', line: 3, message: 'eval in render is not allowed', suppressed: false },
      { tool: 'ESLint', rule: 'no-eval', level: 'none', kind: 'pass', file: null, line: null, message: 'ok', suppressed: false },
      { tool: 'ESLint', rule: 'no-eval', level: 'error', kind: 'fail', file: null, line: null, message: 'kept', suppressed: true },
    ]);
    expect(data.skipped).toEqual({ count: 1, elements: [{ element: 'result', count: 1, reason: 'not an object' }] });
    expect(codes(warnings)).toEqual(expect.arrayContaining(['APPROXIMATED', 'REPORT_TOOL_FAILED', 'REPORT_ELEMENTS_SKIPPED']));
    expect(check(data, 'sarif.version')).toMatchObject({ status: 'approximated', detail: 'the file says SARIF version "2.0.0"; it was read as 2.1.0' });
  });

  it('looks a rule up in the extension its toolComponent names, as CodeQL query packs write it', async () => {
    const run = (component: unknown) => ({
      tool: { driver: { name: 'CodeQL', rules: [] }, extensions: [{ name: 'codeql/javascript-queries', rules: [{ id: 'js/xss', defaultConfiguration: { level: 'error' } }] }] },
      results: [{ ruleId: 'js/xss', ruleIndex: 0, rule: { id: 'js/xss', index: 0, toolComponent: component }, message: { text: 'x' } }],
    });
    const found = await run_({ text: JSON.stringify({ version: '2.1.0', runs: [run({ index: 0 })] }) });
    expect(found.data.findings?.results[0]).toMatchObject({ rule: 'js/xss', level: 'error' });
    expect(check(found.data, 'sarif.ruleIndex')).toMatchObject({ status: 'passed', checked: 1 });
    expect(found.data.verified.passed).toBe(true);
    // A component named only by guid can't be found: the check is unverified, not failed.
    const byGuid = await run_({ text: JSON.stringify({ version: '2.1.0', runs: [run({ guid: 'abc12345-0000-0000-0000-000000000000' })] }) });
    expect(byGuid.data.verified.passed).toBe(true);
    expect(check(byGuid.data, 'sarif.ruleIndex')).toMatchObject({ status: 'unchecked', checked: 0 });
    expect(byGuid.warnings).toContainEqual({
      code: 'UNVERIFIED',
      message: "sarif.ruleIndex was not checked: 1 result names its rule through a toolComponent that isn't found by index in tool.extensions, so the rule, its ruleIndex and its default level weren't looked up.",
    });
    expect(byGuid.data.findings?.results[0]).toMatchObject({ rule: 'js/xss', level: 'warning' });
  });

  it('refuses JSON that is not SARIF, and text that is not JSON', async () => {
    expect((await run({ text: '{"runs": 3}', format: 'sarif' })).envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'The text is JSON but not a SARIF log: it has no "runs" array.' });
    expect((await run({ text: '{"runs": [', format: 'sarif' })).envelope.error?.message).toMatch(/^The text is not valid JSON, so not a SARIF report/);
  });
});

describe('util report: detection, skipped elements and limits', () => {
  it('detects every sample from its content', () => {
    const detected = Object.fromEntries(Object.entries(reportFiles).map(([path, text]) => [path, detectFormat(text)]));
    expect(detected).toEqual({
      'reports/azure-devops.xml': 'junit',
      'reports/codeql.sarif': 'sarif',
      'reports/coverage-py.xml': 'cobertura',
      'reports/coverlet.cobertura.xml': 'cobertura',
      'reports/dotnet.trx': 'trx',
      'reports/jenkins.xml': 'junit',
      'reports/lcov.info': 'lcov',
      'reports/surefire.xml': 'junit',
    });
    expect(detectFormat('\ufeff<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE coverage SYSTEM "coverage-04.dtd">\n<coverage/>')).toBe('cobertura');
    expect(detectFormat('<html></html>')).toBeUndefined();
    expect(detectFormat('{"name": "x"}')).toBeUndefined();
  });

  it('refuses a document it cannot place, and one whose root does not match --format, with a fix naming --format', async () => {
    const unknown = await run({ text: 'hello' });
    expect(unknown.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: "Couldn't tell what kind of report the text is: it doesn't start like JUnit, TRX, SARIF, lcov or Cobertura." });
    expect(unknown.envelope.error?.fix).toContain('--format');
    const wrong = await run({ inputFile: 'reports/dotnet.trx', format: 'junit' });
    expect(wrong.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'The file "reports/dotnet.trx" starts with <TestRun>, which is not a JUnit report (expected <testsuites> or <testsuite>).' });
  });

  it('refuses malformed XML with the line and column', async () => {
    const { envelope } = await run({ text: '<testsuite name="s">\n  <testcase name="a">\n</testsuite>' });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'The text is not a well-formed JUnit report: </testsuite> found where </testcase> was expected (line 3, column 1).' });
  });

  it('counts and reports every element and record it skipped, with the reason', async () => {
    const junit = await run({ text: '<testsuite name="s" tests="1"><custom><deep/></custom><testcase name="a"><attachment/><attachment/></testcase></testsuite>' });
    expect(junit.data.skipped).toEqual({
      count: 3,
      elements: [
        { element: 'custom', count: 1, reason: 'not part of a JUnit report' },
        { element: 'attachment', count: 2, reason: 'not part of a JUnit test case' },
      ],
    });
    expect(junit.warnings).toContainEqual({ code: 'REPORT_ELEMENTS_SKIPPED', message: '3 elements were skipped, not read: custom x1 (not part of a JUnit report); attachment x2 (not part of a JUnit test case).' });
    const lcov = await run({ text: 'SF:a.ts\nDA:1,1\nDA:x\nXYZ:1\nend_of_record\nend_of_record\n' });
    expect(lcov.data.skipped.elements).toEqual([
      { element: 'DA', count: 1, reason: 'not DA:<line>,<hits>' },
      { element: 'XYZ', count: 1, reason: 'not an lcov record type this reader knows' },
      { element: 'end_of_record', count: 1, reason: 'no SF record open' },
    ]);
    const cobertura = await run({ text: '<coverage><packages><package name="p"><classes><class name="c" filename="c.py"><lines><line number="1"/><line number="2" hits="1" branch="true"/></lines></class></classes></package></packages><extras/></coverage>' });
    expect(cobertura.data.skipped.elements).toEqual([
      { element: 'line', count: 1, reason: 'no whole-number hits attribute' },
      { element: 'line', count: 1, reason: 'branch="true" without a condition-coverage count' },
      { element: 'extras', count: 1, reason: 'not part of a Cobertura report under <coverage>' },
    ]);
    const trx = await run({ text: sample('dotnet.trx').replace('<Results>', '<Results>\n    <WebTestResult testId="w" outcome="Passed" />') });
    expect(trx.data.skipped.elements).toEqual([{ element: 'WebTestResult', count: 1, reason: 'a result type this reader does not read (only UnitTestResult)' }]);
  });

  it('gives the same answer for any chunking of the stream', async () => {
    for (const name of ['surefire.xml', 'jenkins.xml', 'dotnet.trx', 'coverlet.cobertura.xml', 'lcov.info']) {
      const whole = await summarise({ inputFile: name }, { [name]: sample(name) });
      for (const chunkSize of [1, 7, 64]) {
        const chunked = await summarise({ inputFile: name }, { [name]: sample(name) }, { chunkSize });
        expect(chunked.data, `${name} in chunks of ${chunkSize}`).toEqual(whole.data);
      }
    }
  });

  it('streams a large report, and recounts it exactly', async () => {
    const cases = Array.from({ length: 20000 }, (_, i) => (i % 1000 === 0 ? `<testcase name="t${i}"><failure message="m${i}">at x.Y.t${i}(Y.java:${i})</failure></testcase>` : `<testcase name="t${i}" classname="x.Y"/>`)).join('\n');
    const xml = `<testsuite name="big" tests="20000" failures="20">\n${cases}\n</testsuite>`;
    const { data } = await summarise({ inputFile: 'big.xml' }, { 'big.xml': xml }, { chunkSize: 4096 });
    expect(data.tests?.totals).toMatchObject({ tests: 20000, failures: 20, passed: 19980 });
    expect(data.tests?.failures).toHaveLength(20);
    expect(data.verified.passed).toBe(true);
  });

  it('reports the size cap when it is hit: what came before the cut, INPUT_TRUNCATED, and input.complete failed', async () => {
    const xml = sample('surefire.xml');
    // Cut inside the fourth case, refundsCancelledOrder.
    const cap = Buffer.byteLength(xml.slice(0, xml.indexOf('<testcase name="refundsCancelledOrder"') + 20));
    const { data, warnings } = await summarise({ inputFile: 'r.xml' }, { 'r.xml': xml }, { maxBytes: cap });
    expect(codes(warnings)).toContain('INPUT_TRUNCATED');
    expect(check(data, 'input.complete')).toMatchObject({ status: 'failed' });
    expect(data.verified.passed).toBe(false);
    // The three cases before the cut are counted, and the open suite's declared totals aren't held against them.
    expect(data.tests?.totals.tests).toBe(3);
    expect(check(data, 'tests.total')).toBeUndefined();
    expect(check(data, 'tests.totals')).toMatchObject({ status: 'unchecked', detail: 'the read stopped before 1 suite that declares totals ended, so those totals were not compared' });
    const sarif = await summarise({ inputFile: 'r.sarif' }, { 'r.sarif': sample('codeql.sarif') }, { maxBytes: 1000 }).catch((err: unknown) => err);
    expect(sarif).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('more than the 1000 bytes this command reads') });
  });
});

describe('util report: helpers', () => {
  it('finds file and line in Java, .NET, Python, JavaScript and Go stacks, preferring the test frame', () => {
    expect(locationFromStack('\tat org.junit.Assert.fail(Assert.java:89)\n\tat dev.imagile.FooTest.bar(FooTest.java:12)', ['dev.imagile.FooTest', 'bar'])).toEqual({ file: 'FooTest.java', line: 12 });
    expect(locationFromStack('   at Ns.FooTests.Bar() in C:\\src\\FooTests.cs:line 30', ['Ns.FooTests', 'Bar'])).toEqual({ file: 'C:\\src\\FooTests.cs', line: 30 });
    expect(locationFromStack('Traceback (most recent call last):\n  File "tests/test_cart.py", line 14, in test_total\n    assert total == 3', ['tests.test_cart', 'test_total'])).toEqual({ file: 'tests/test_cart.py', line: 14 });
    expect(locationFromStack('Error: expected 3\n    at Object.<anonymous> (node_modules/expect/build/index.js:1:1)\n    at Object.<anonymous> (src/cart.test.ts:9:17)', [null, 'adds'])).toEqual({ file: 'src/cart.test.ts', line: 9 });
    expect(locationFromStack('    cart_test.go:41: got 2', ['cart', 'TestAdd'])).toEqual({ file: 'cart_test.go', line: 41 });
    expect(locationFromStack('no frames here', ['x'])).toBeNull();
  });

  it('trims a stack to fifteen non-empty lines', () => {
    expect(trimStack('')).toEqual({ stack: null, stackLines: 0 });
    expect(trimStack('a\r\n\r\nb  \n')).toEqual({ stack: 'a\nb', stackLines: 2 });
  });
});

describe('util report: front doors', () => {
  it('gives the same envelope on the CLI (file and stdin) and over MCP (file and text)', async () => {
    const context = () => testContext({ files: reportFiles, stdin: sample('jenkins.xml') }).context;
    const cli = await runCli(['util', 'report', '--input-file', 'reports/jenkins.xml'], { commands, context: context() });
    const session = await connectMcp({ commands, context: context() });
    try {
      const mcp = await session.call('util_report', { inputFile: 'reports/jenkins.xml' });
      expect({ ...mcp.envelope, meta: { ...mcp.envelope.meta, durationMs: 0 } }).toEqual({ ...cli.envelope, meta: { ...cli.envelope?.meta, durationMs: 0 } });
      const viaText = await session.call('util_report', { text: sample('jenkins.xml') });
      const viaStdin = await runCli(['util', 'report'], { commands, context: context() });
      expect(viaText.envelope.data).toMatchObject({ tests: (cli.envelope?.data as ReportData).tests });
      expect(viaStdin.envelope?.data).toMatchObject({ tests: (cli.envelope?.data as ReportData).tests });
      expect((viaStdin.envelope?.data as ReportData).verified.checks.find((c) => c.check === 'input.complete')).toMatchObject({ status: 'unchecked', detail: 'stdin has no size to compare the bytes read with' });
    } finally {
      await session.close();
    }
    expect(cli.exitCode).toBe(0);
  });

  it('takes --format and --lowest on the CLI', async () => {
    const cli = await runCli(['util', 'report', '--input-file', 'reports/lcov.info', '--format', 'lcov', '--lowest', '1'], { commands, context: testContext({ files: reportFiles }).context });
    expect(cli.envelope?.data).toMatchObject({ format: 'lcov', formatFrom: 'flag', coverage: { lowest: [{ file: 'src/coupons.ts' }] } });
    const bad = await runCli(['util', 'report', '--input-file', 'reports/lcov.info', '--format', 'xml'], { commands, context: testContext({ files: reportFiles }).context });
    expect(bad.envelope?.error?.code).toBe('INVALID_INPUT');
  });
});
