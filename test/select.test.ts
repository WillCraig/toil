import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineArea } from '../src/core/area.js';
import { defineCommand } from '../src/core/command.js';
import { allowWriteField, execute } from '../src/core/run.js';
import { testContext } from './harness/context.js';
import { runCli } from './harness/cli.js';
import { connectMcp } from './harness/mcp.js';

/**
 * `--select` on its own terms; test/parity/suite.ts runs it through both front
 * doors once for every area (its first command).
 */

const listing = defineCommand({
  path: ['demo', 'listing'],
  description: 'Return a page of issues',
  input: z.object({}),
  writes: false,
  examples: [{}],
  run: async (_input, ctx) => {
    ctx.setPage({ nextCursor: 'abc', limit: 2 });
    ctx.warn({ code: 'TRUNCATED', message: 'Only the first 2 rows were returned.' });
    return { issues: [{ key: 'PAY-1', fields: { status: { name: 'Open' } } }, { key: 'PAY-2', fields: { status: { name: 'Done' } } }], total: 9 };
  },
});

let ran = 0;
const writer = defineCommand({
  path: ['demo', 'writer'],
  description: 'Pretend to change something',
  input: z.object({ ...allowWriteField }),
  writes: false,
  examples: [{}],
  run: async () => {
    ran++;
    return { id: 7 };
  },
});

describe('--select', () => {
  it('cuts data down and leaves meta, page and warnings included, as it was', async () => {
    const { context } = testContext();
    const plain = await execute(listing, {}, context);
    const selected = await execute(listing, { select: 'issues[].{key: key, status: fields.status.name}' }, context);
    expect(selected.data).toEqual([
      { key: 'PAY-1', status: 'Open' },
      { key: 'PAY-2', status: 'Done' },
    ]);
    expect({ ...selected.meta, durationMs: 0 }).toEqual({ ...plain.meta, durationMs: 0 });
    expect(selected.meta.page).toEqual({ nextCursor: 'abc', limit: 2 });
  });

  it('gives data: null and a SELECT_EMPTY warning when it selects nothing, not an error', async () => {
    const { context } = testContext();
    const envelope = await execute(listing, { select: 'nothing.here' }, context);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toBeNull();
    expect(envelope.meta.warnings).toContainEqual(expect.objectContaining({ code: 'SELECT_EMPTY', message: expect.stringContaining('nothing.here') }));
  });

  it('refuses a bad expression as INVALID_INPUT with its position in the fix, before the command runs', async () => {
    ran = 0;
    const { context } = testContext();
    const envelope = await execute(writer, { select: 'id ||' }, context);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('At position 5: id ||>>>'), details: { kind: 'syntax', position: 5 } });
    expect(ran).toBe(0);
    for (const select of ['', '   ', 42]) {
      expect((await execute(writer, { select }, context)).error?.code).toBe('INVALID_INPUT');
    }
    expect(ran).toBe(0);
  });

  it('refuses an expression nested past the limit as INVALID_INPUT naming it, and data too deep to compare as INVALID_INPUT, never INTERNAL', async () => {
    ran = 0;
    const { context } = testContext();
    const tooDeep = await execute(writer, { select: '('.repeat(5000) + 'id' + ')'.repeat(5000) }, context);
    expect(tooDeep.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('more than 500 levels deep') });
    expect(ran).toBe(0);

    const nested = (n: number): unknown => {
      let v: unknown = 0;
      for (let i = 0; i < n; i++) v = [v];
      return v;
    };
    const deepData = defineCommand({ path: ['demo', 'deep'], description: 'Return data nested very deep', input: z.object({}), writes: false, examples: [{}], run: async () => ({ x: nested(200_000), y: nested(200_000) }) });
    const overflow = await execute(deepData, { select: 'x == y' }, context);
    expect(overflow.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining("couldn't be applied"), details: { kind: 'invalid-value' } });
  });

  it('refuses an expression that builds past the size bound as INVALID_INPUT, and still selects from large data', async () => {
    const { context } = testContext();
    const doubled = await execute(listing, { select: '[@,@][]'.repeat(40) }, context);
    expect(doubled.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('builds more than 16 MiB of JSON'), details: { kind: 'invalid-value' } });
    const many = defineCommand({
      path: ['demo', 'many'],
      description: 'Return many rows',
      input: z.object({}),
      writes: false,
      examples: [{}],
      run: async () => ({ rows: Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `row-${i}` })) }),
    });
    const large = await execute(many, { select: 'rows[*].{key: id}' }, context);
    expect(large.ok).toBe(true);
    expect(large.data).toHaveLength(50_000);
  });

  it('says a write was made when the expression fails on its result', async () => {
    const write = defineArea({ name: 'demo', description: 'd', connection: z.object({}) }).command({
      path: ['demo', 'make'],
      description: 'Make a thing',
      input: z.object({ ...allowWriteField }),
      writes: true,
      examples: [{ allowWrite: true }],
      run: async () => ({ id: 7 }),
    });
    const { context } = testContext({ config: { demo: { writes: true } } });
    const envelope = await execute(write, { allowWrite: true, select: 'abs(id) | length(@)' }, context);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('ran and made its change'), fix: expect.stringContaining("Don't repeat the write") });
  });

  it('is accepted before or after the command on the CLI, and is a field of every MCP tool', async () => {
    const { context } = testContext();
    const after = await runCli(['demo', 'listing', '--select', 'total'], { commands: [listing], context });
    const before = await runCli(['--select', 'total', 'demo', 'listing'], { commands: [listing], context });
    expect(after.envelope?.data).toBe(9);
    expect(before.envelope?.data).toBe(9);
    const session = await connectMcp({ commands: [listing], context });
    try {
      const { tools } = await session.client.listTools();
      expect(tools[0]?.inputSchema.properties).toHaveProperty('select');
      expect((await session.call('demo_listing', { select: 'total' })).envelope.data).toBe(9);
    } finally {
      await session.close();
    }
  });

  it('is core\'s: no command may declare a select field of its own', () => {
    expect(() => defineCommand({ path: ['demo', 'x'], description: 'x', input: z.object({ select: z.string() }), writes: false, examples: [{ select: 'a' }], run: async () => null })).toThrow(/added by core/);
  });
});
