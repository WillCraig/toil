import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineArea } from '../src/core/area.js';
import { DEPRECATED_FLAG } from '../src/core/deprecation.js';
import { allowWriteField } from '../src/core/run.js';
import { commands, routedAliases } from '../src/registry.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import { connectMcp } from './harness/mcp.js';

/**
 * Retired flag spellings (#622): `--file` that became `--input-file`, `util`'s
 * `[file]` positional, `--from <file>`. Each still works on the CLI for at least
 * one beta with a DEPRECATED_FLAG warning, the current flag wins when both are
 * given, and MCP takes only the field's current name. A flag's old name is kept
 * on file the way old forms are: until someone remembers to shred it.
 */

const md = commands.find((c) => c.path.join(' ') === 'util md')!;
const warningsOf = (env: { meta: { warnings?: Array<{ code: string; message: string }> } } | undefined) => (env?.meta.warnings ?? []).filter((w) => w.code === DEPRECATED_FLAG);

const area = defineArea({ name: 'demo-retired', description: 'test', connection: z.object({}) });
const probe = area.command({
  kind: 'area-local',
  path: ['demo-retired', 'item', 'read'],
  description: 'Echo the file it was given',
  input: z.object({ inputFile: z.string().optional().describe('The file'), ...allowWriteField }),
  writes: false,
  options: [{ flags: '--input-file <path>', field: 'inputFile', description: 'The file', deprecated: ['--file <path>', '--from <file>'] }],
  examples: [{ inputFile: 'a.txt' }],
  run: async (input) => ({ inputFile: input.inputFile ?? null }),
});

describe('a retired flag spelling', () => {
  it('still sets the field on the CLI, with a warning naming the flag that replaced it', async () => {
    for (const old of ['--file', '--from']) {
      const run = await runCli(['demo-retired', 'item', 'read', old, 'a.txt'], { commands: [probe], context: testContext().context });
      expect(run.envelope?.data).toEqual({ inputFile: 'a.txt' });
      expect(warningsOf(run.envelope)).toEqual([{ code: DEPRECATED_FLAG, message: `${old} is now --input-file. ${old} still works for now, so change it to --input-file before a later release drops it.` }]);
    }
  });

  it('loses to the current flag when both are given, and says it was ignored', async () => {
    const run = await runCli(['demo-retired', 'item', 'read', '--file', 'old.txt', '--input-file', 'new.txt'], { commands: [probe], context: testContext().context });
    expect(run.envelope?.data).toEqual({ inputFile: 'new.txt' });
    expect(warningsOf(run.envelope)[0]?.message).toContain('--input-file is also given, so --file is ignored.');
  });

  it('is left out of --help', async () => {
    const run = await runCli(['demo-retired', 'item', 'read', '--help'], { commands: [probe], context: testContext().context });
    expect(run.stdout).toContain('--input-file <path>');
    expect(run.stdout).not.toContain('--from');
  });

  it('is not an MCP field: the old field name is refused as unknown, with a fix naming the new one', async () => {
    const mcp = await connectMcp({ commands: [md], context: testContext({ files: { 'a.md': '# A' } }).context });
    try {
      const refused = (await mcp.call('util_md', { file: 'a.md', to: 'wiki' })).envelope.error;
      expect(refused?.code).toBe('INVALID_INPUT');
      expect(refused?.fix).toContain('The field "file" is now "inputFile".');
      expect((await mcp.call('util_md', { inputFile: 'a.md', to: 'wiki' })).envelope.ok).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  it("names the new field for every util command's old one, util secrets scan's included", async () => {
    const scan = commands.find((c) => c.path.join(' ') === 'util secrets scan')!;
    const mcp = await connectMcp({ commands: [scan], context: testContext({ files: { 'a.txt': 'nothing here' } }).context });
    try {
      expect((await mcp.call('util_secrets_scan', { file: 'a.txt' })).envelope.error?.fix).toContain('The field "file" is now "inputFile".');
    } finally {
      await mcp.close();
    }
  });
});

describe('a routed alias', () => {
  it("reads its route's retired spelling, with the warning (deps frisk --from)", async () => {
    const run = await runCli(['deps', 'frisk', '--from', 'inv.json'], { commands, routed: routedAliases, context: testContext({ files: { 'inv.json': '[]' } }).context });
    expect(run.envelope?.meta.command).toBe('osv vulns');
    expect(warningsOf(run.envelope)[0]?.message).toContain('--from is now --input-file');
  });
});

describe("util's retired [file] positional", () => {
  it('still reads the file, with a warning naming --input-file', async () => {
    const run = await runCli(['util', 'md', 'a.md', '--to', 'wiki'], { commands: [md], context: testContext({ files: { 'a.md': '# A' } }).context });
    expect(run.envelope?.ok).toBe(true);
    expect(warningsOf(run.envelope)).toEqual([{ code: DEPRECATED_FLAG, message: 'The [file] argument is now --input-file. The [file] argument still works for now, so change it to --input-file before a later release drops it.' }]);
  });

  it('loses to --input-file when both are given', async () => {
    const files = { 'a.md': '# A', 'b.md': '# B' };
    const both = await runCli(['util', 'md', 'a.md', '--input-file', 'b.md', '--to', 'wiki'], { commands: [md], context: testContext({ files }).context });
    expect((both.envelope?.data as { output: string }).output).toContain('B');
    expect(warningsOf(both.envelope)[0]?.message).toContain('--input-file is also given');
  });

  it('gives no warning for --input-file alone', async () => {
    const run = await runCli(['util', 'md', '--input-file', 'a.md', '--to', 'wiki'], { commands: [md], context: testContext({ files: { 'a.md': '# A' } }).context });
    expect(warningsOf(run.envelope)).toEqual([]);
  });
});
