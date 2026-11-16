import { describe, expect, it } from 'vitest';
import { commands as alationCommands } from '../src/areas/alation/index.js';
import { adoArea } from '../src/areas/ado/area.js';
import { loadConfig } from '../src/core/config.js';
import { resolveConnection } from '../src/core/connection.js';
import { failure } from '../src/core/envelope.js';
import { ToilError } from '../src/core/errors.js';
import { inFieldNames } from '../src/core/run.js';
import { evaluateCommand } from '../src/areas/sonatypeiq/evaluate.js';
import { flagsSetRuleCommand } from '../src/areas/splitio/flags.js';
import { getIssue } from '../src/areas/jira/server/issues.js';
import { config as iqConfig, fixture as iqFixture } from './fixtures/sonatypeiq.fixture.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import { connectMcp } from './harness/mcp.js';
import { config } from './fixtures/alation.fixture.js';

/**
 * The sixth batch of integration-kit fixes (#68), for what no one area's
 * suite can show on its own. Filed in triplicate, read once.
 */

describe('an input error over MCP names the field, on the CLI the flag', () => {
  it('rewords the message and fix, keeping the code, for a real area command', async () => {
    const { context } = testContext({ config });
    const cli = await runCli(['alation', 'search', 'customer', '--limit', '20000'], { commands: alationCommands, context });
    expect(cli.envelope?.error).toMatchObject({
      code: 'INVALID_INPUT',
      message: '--limit must be at most 10000',
      fix: 'Pass --limit 10000 or less, and page on with --offset.',
    });

    const mcp = await connectMcp({ commands: alationCommands, context });
    try {
      const { envelope } = await mcp.call('alation_search', { query: 'customer', limit: '20000' });
      expect(envelope.error).toMatchObject({
        code: 'INVALID_INPUT',
        message: 'limit must be at most 10000',
        fix: 'Pass limit 10000 or less, and page on with offset.',
      });
      // Only the error is reworded: everything else in the envelope matches the CLI's.
      expect({ ...envelope, error: null, meta: null }).toEqual({ ...cli.envelope, error: null, meta: null });
    } finally {
      await mcp.close();
    }
  });
});

describe('a CLI command line quoted in an input error stays CLI-shaped over MCP', () => {
  it('sonatypeiq: the piped example keeps --application-id; only the prose flag after it is reworded', async () => {
    const { context } = testContext({ config: iqConfig, routes: iqFixture.routes!, files: { 'bad.json': 'not json' } });
    const mcp = await connectMcp({ commands: [evaluateCommand], context });
    try {
      const { envelope } = await mcp.call('sonatypeiq_evaluate', { applicationId: 'app-1', inputFile: 'bad.json' });
      expect(envelope.error).toMatchObject({
        code: 'INVALID_INPUT',
        fix: 'Pass the output of toil deps scan, e.g. toil deps scan --include-transitive | toil sonatypeiq evaluate --application-id <id>, or inputFile <path> holding it.',
      });
    } finally {
      await mcp.close();
    }
  });

  it('splitio: a command up to a semicolon keeps --environment, and the flag in the clause after it becomes its field', () => {
    const envelope = failure(
      new ToilError('INVALID_INPUT', 'Rule index 9 is out of range', { fix: 'Run toil splitio flag get --environment <id> to see the rules; --rule-index counts from 0.' }),
      { command: 'splitio flag set-rule', durationMs: 0, version: '0.0.0' },
    );
    expect(inFieldNames(flagsSetRuleCommand, envelope).error?.fix).toBe('Run toil splitio flag get --environment <id> to see the rules; ruleIndex counts from 0.');
    // In backticks, a command line ends at the closing backtick.
    const ticked = failure(new ToilError('INVALID_INPUT', 'x', { fix: 'Run `toil splitio flag get --environment <id>`, then pass --environment.' }), { command: 'splitio flag set-rule', durationMs: 0, version: '0.0.0' });
    expect(inFieldNames(flagsSetRuleCommand, ticked).error?.fix).toBe('Run `toil splitio flag get --environment <id>`, then pass environment.');
  });
});

describe('a positional argument, over MCP', () => {
  it('is named as its field in an input error, as a flag is', () => {
    const envelope = failure(new ToilError('INVALID_INPUT', 'Every <key> needs an issue key.', { fix: 'Give each <key> as an issue key, e.g. PROJ-123.' }), { command: 'jira issue get', durationMs: 0, version: '0.0.0' });
    const reworded = inFieldNames(getIssue, envelope);
    expect(reworded.error?.message).toBe('Every key needs an issue key.');
    expect(reworded.error?.fix).toBe('Give each key as an issue key, e.g. PROJ-123.');
  });
});

describe("ado's fieldAliases, now that --save is gone", () => {
  it('come from TOIL_ADO_FIELD_ALIASES as a JSON object, the way a custom alias is set without a file', async () => {
    const env = { TOIL_ADO_BASE_URL: 'https://ado.imagile.dev', TOIL_ADO_PAT: 'p', TOIL_ADO_FIELD_ALIASES: '{"effortdays":"MyOrg.EffortDays"}' };
    const loaded = loadConfig({ env, cwd: '/nowhere', home: '/nowhere', areas: [adoArea] });
    const connection = await resolveConnection(loaded, adoArea, undefined, () => {});
    expect(connection.fieldAliases).toEqual({ effortdays: 'MyOrg.EffortDays' });
  });
});
