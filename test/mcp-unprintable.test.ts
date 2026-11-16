import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCommand } from '../src/core/command.js';
import { success } from '../src/core/envelope.js';
import { ToilError } from '../src/core/errors.js';
import { allowWriteField } from '../src/core/run.js';
import { serializable } from '../src/core/unprintable.js';
import { commands } from '../src/registry.js';
import { demoArea, demoRoutes } from './fixtures/demo-commands.js';
import { testContext } from './harness/context.js';
import { connectMcp } from './harness/mcp.js';

// A tool result JSON can't hold must still come back as one envelope, as a
// tool error, never as a JSON-RPC protocol error (#647; the CLI half is #642).

const circular = () => {
  const value: Record<string, unknown> = { name: 'loop' };
  value['self'] = value;
  return value;
};

describe('MCP results that cannot be serialized', () => {
  it('answers a result nested past the stack with an INTERNAL tool error, not -32603', async () => {
    // A placeholder token whose payload nests far past the stringify cliff.
    const depth = 20_000;
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(`{"a":${'['.repeat(depth)}1${']'.repeat(depth)}}`).toString('base64url');
    const token = `${header}.${payload}.c2lnbmF0dXJlLW5vdC1jaGVja2Vk`;
    const mcp = await connectMcp({ commands, context: testContext().context, areas: ['util'] });
    try {
      const result = await mcp.call('util_jwt_decode', { token });
      expect(result.isError).toBe(true);
      expect(result.envelope).toMatchObject({
        ok: false,
        data: null,
        error: { code: 'INTERNAL', message: expect.stringContaining("couldn't be printed as JSON"), fix: expect.stringContaining('--select') },
        meta: { command: 'util jwt decode' },
      });
      expect(JSON.parse(result.text)).toEqual(result.envelope);
    } finally {
      await mcp.close();
    }
  });

  it('answers circular and BigInt results the same way', async () => {
    const readCircular = defineCommand({ path: ['read-circular'], description: 'read returning a circular result', input: z.object({}), writes: false, examples: [{}], run: async () => circular() });
    const readBigInt = defineCommand({ path: ['read-bigint'], description: 'read returning a BigInt', input: z.object({}), writes: false, examples: [{}], run: async () => ({ count: 10n }) });
    const mcp = await connectMcp({ commands: [readCircular, readBigInt], context: testContext().context });
    try {
      for (const name of ['read_circular', 'read_bigint']) {
        const result = await mcp.call(name, {});
        expect(result.isError, name).toBe(true);
        expect(result.envelope, name).toMatchObject({ ok: false, data: null, error: { code: 'INTERNAL', message: expect.stringContaining("couldn't be printed as JSON") } });
        expect(JSON.parse(result.text), name).toEqual(result.envelope);
      }
    } finally {
      await mcp.close();
    }
  });

  it('says a write may already have been applied when the command writes', async () => {
    const writeCircular = demoArea.command({ path: ['demo', 'write-circular'], description: 'write returning a circular result', input: z.object({ ...allowWriteField }), writes: true, examples: [{ allowWrite: true }], run: async () => circular() });
    const { context } = testContext({ config: { demo: { token: 't', writes: true } }, routes: demoRoutes });
    const mcp = await connectMcp({ commands: [writeCircular], context });
    try {
      const result = await mcp.call('demo_write_circular', { allowWrite: true });
      expect(result.isError).toBe(true);
      expect(result.envelope).toMatchObject({
        ok: false,
        data: null,
        error: { code: 'INTERNAL', message: expect.stringContaining('may already have been applied'), fix: expect.stringContaining('Check whether the change was made before retrying') },
        meta: { command: 'demo write-circular' },
      });
      expect(JSON.parse(result.text)).toEqual(result.envelope);
    } finally {
      await mcp.close();
    }
  });

  it('keeps a failure\'s own code, message and fix, and drops details that cannot be serialized', async () => {
    const failCircular = defineCommand({
      path: ['fail-circular'],
      description: 'read failing with circular details',
      input: z.object({}),
      writes: false,
      examples: [{}],
      run: async () => {
        throw new ToilError('NOT_FOUND', 'No such thing.', { fix: 'Check the id.', details: circular() });
      },
    });
    const mcp = await connectMcp({ commands: [failCircular], context: testContext().context });
    try {
      const result = await mcp.call('fail_circular', {});
      expect(result.isError).toBe(true);
      expect(result.envelope).toMatchObject({ ok: false, data: null, error: { code: 'NOT_FOUND', message: 'No such thing.', fix: 'Check the id.' } });
      expect(result.envelope.error).not.toHaveProperty('details');
      expect(JSON.parse(result.text)).toEqual(result.envelope);
    } finally {
      await mcp.close();
    }
  });

  it('falls back to an envelope naming only the command when meta itself refuses', () => {
    const envelope = success({ ok: 1 }, { command: 'demo read', durationMs: 3, version: '0.0.0', warnings: [] });
    let calls = 0;
    const { envelope: last, text } = serializable(envelope, false, (e) => {
      calls++;
      if (calls <= 2) throw new Error('refused');
      return JSON.stringify(e);
    });
    expect(calls).toBe(3);
    expect(last).toMatchObject({ ok: false, data: null, error: { code: 'INTERNAL', message: "The result of demo read couldn't be printed as JSON." } });
    expect(Object.keys(last.meta).sort()).toEqual(['command', 'contractVersion', 'durationMs', 'version']);
    expect(JSON.parse(text)).toEqual(last);
  });
});

describe('the stand-in failure', () => {
  it('drops meta.page and meta.summary, which describe data it no longer carries', () => {
    const envelope = success({ self: circular() }, { command: 'demo list', durationMs: 3, version: '0.0.0', page: { nextCursor: 'c2', limit: 50 }, summary: { file: 'out.json', rules: [] } } as never);
    const { envelope: stand } = serializable(envelope, false);
    expect(stand).toMatchObject({ ok: false, error: { code: 'INTERNAL' }, meta: { command: 'demo list' } });
    expect(stand.meta).not.toHaveProperty('page');
    expect(stand.meta).not.toHaveProperty('summary');
  });
});
