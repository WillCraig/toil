import { z } from 'zod';
import { defineCommand } from '../../core/command.js';
import { fileArgument, inputFields, inputFileOption, textOption } from './kit/input.js';
import { summariseReport } from './report/summarise.js';

/**
 * `util report`: one JSON summary of the reports CI and scanners leave
 * behind. JUnit XML (Surefire, Jenkins and Azure DevOps shapes), TRX,
 * SARIF 2.1.0, lcov and Cobertura. The format is detected from the content
 * unless `--format` names it. Tests come back as totals and failures,
 * SARIF as findings, coverage as per-file percentages and the lowest
 * files; each report is checked against its own declared totals and
 * rates, and what it couldn't check is said.
 *
 * The readers are imported statically, not through `import()`: they reach
 * zod through kit/input.ts, and a lazily loaded module that does breaks the
 * bundle at startup (docs/util.md). They have no dependency of their own, so
 * startup pays only for their own small modules. Quarterly reporting, too,
 * is mandatory and loads at once.
 */

/** The formats `util report` reads. */
export const REPORT_FORMATS = ['junit', 'trx', 'sarif', 'lcov', 'cobertura'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

const SAMPLE_JUNIT =
  '<testsuite name="dev.imagile.cart.CartTest" tests="2" failures="1" errors="0" skipped="0"><testcase classname="dev.imagile.cart.CartTest" name="addsLine"/><testcase classname="dev.imagile.cart.CartTest" name="rejectsNegativeQuantity"><failure message="expected IllegalArgumentException" type="java.lang.AssertionError">java.lang.AssertionError: expected IllegalArgumentException\n\tat dev.imagile.cart.CartTest.rejectsNegativeQuantity(CartTest.java:27)</failure></testcase></testsuite>';

export const reportCommand = defineCommand({
  path: ['util', 'report'],
  description: 'Summarise a JUnit, TRX, SARIF, lcov or Cobertura report as one JSON result, checked against its own totals (local only, no network)',
  toolDescription:
    'Reads one CI or scanner report and returns one summary: for JUnit XML (Surefire, Jenkins and Azure DevOps shapes) and TRX, test totals plus each failure with suite, name, file, line, message and a trimmed stack; for SARIF 2.1.0, findings with rule, level, file, line and message; for lcov and Cobertura, per-file line and branch percentages and the lowest-covered files. The format is detected from the content unless format is given. data.verified says what was checked: declared totals recounted from the cases (REPORT_TOTALS_MISMATCH when they disagree) and stated coverage rates recomputed from hit counts (REPORT_COVERAGE_MISMATCH). Elements it skipped are counted in data.skipped. Local only: nothing is sent anywhere.',
  input: z.object({
    ...inputFields,
    format: z.enum(REPORT_FORMATS).optional().describe('The report format: junit, trx, sarif, lcov or cobertura. Detected from the content when left out'),
    lowest: z.number().int().min(0).max(1000).optional().describe('How many of the lowest-covered files to list, for coverage reports (default 10)'),
  }),
  writes: false,
  args: [fileArgument],
  options: [
    inputFileOption, textOption,
    { flags: '--format <format>', field: 'format', description: 'junit, trx, sarif, lcov or cobertura (default: detected from the content)' },
    { flags: '--lowest <n>', field: 'lowest', description: 'How many of the lowest-covered files to list (default: 10)' },
  ],
  examples: [
    { inputFile: 'reports/surefire.xml' },
    { inputFile: 'reports/jenkins.xml' },
    { inputFile: 'reports/azure-devops.xml' },
    { inputFile: 'reports/dotnet.trx' },
    { inputFile: 'reports/codeql.sarif' },
    { inputFile: 'reports/lcov.info', lowest: 2 },
    { inputFile: 'reports/coverlet.cobertura.xml' },
    { inputFile: 'reports/coverage-py.xml', format: 'cobertura' },
    { text: SAMPLE_JUNIT },
  ],
  run: async (input, ctx) => summariseReport(input, ctx),
});

export const reportCommands = [reportCommand];
