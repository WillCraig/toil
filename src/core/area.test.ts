import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineArea } from './area.js';
import { assertUniquePaths, defineCommand, defineConfigCommand, isCliOnly, managesConfig, needsConfig, usesConnection } from './command.js';
import { emptyConfig } from './config.js';
import { resolveConnection } from './connection.js';
import { fromText } from './schema.js';

const run = async () => ({});
const base = { description: 'test', input: z.object({}), writes: false, examples: [{}], run };

describe('command kinds', () => {
  const area = defineArea({ name: 'kinds', description: 'test', connection: z.object({ token: z.string() }) });

  it('gives each helper and area.command its kind, and only an area command a connection', () => {
    const standalone = defineCommand({ ...base, path: ['kinds-version'] });
    const config = defineConfigCommand({ ...base, writesLocal: false, path: ['connections', 'look'] });
    const cliOnly = defineConfigCommand({ ...base, writesLocal: false, path: ['connections', 'ask'], kind: 'cli-only' });
    const withConnection = area.command({ ...base, path: ['kinds', 'get'] });
    const local = area.command({ ...base, path: ['kinds', 'schema'], kind: 'area-local' });

    expect([standalone, config, cliOnly, withConnection, local].map((d) => d.kind)).toEqual(['standalone', 'config', 'cli-only', 'area', 'area-local']);
    expect([standalone, config, cliOnly, withConnection, local].map(needsConfig)).toEqual([false, true, true, true, false]);
    expect([standalone, config, cliOnly, withConnection, local].map(usesConnection)).toEqual([false, false, false, true, false]);
    expect([standalone, config, cliOnly, withConnection, local].map(managesConfig)).toEqual([false, true, true, false, false]);
    expect([standalone, config, cliOnly, withConnection, local].map(isCliOnly)).toEqual([false, false, true, false, false]);
    expect(Object.keys(withConnection.input.shape)).toContain('connection');
    expect(Object.keys(local.input.shape), 'an area-local command has no connection to choose').not.toContain('connection');
    expect(local.area).toBe(area);
  });

  it('refuses retired definition fields and a kind an area command cannot have', () => {
    expect(() => area.command({ ...base, path: ['kinds', 'x'], cliOnly: true } as never)).toThrow(/"cliOnly" is gone/);
    expect(() => area.command({ ...base, path: ['kinds', 'x'], kind: 'config' } as never)).toThrow(/area or area-local/);
    expect(() => area.command({ ...base, path: ['kinds', 'x'], kind: 'area-local', context: {} })).toThrow(/no connection/);
    expect(() => area.command({ ...base, path: ['kinds', 'x'], connectionlessWhen: () => true })).toThrow(/connectionlessWhen is for a connectionOptional command/);
    expect(() => area.command({ ...base, path: ['kinds', 'x'], connectionOptional: true, connectionlessWhen: () => true })).not.toThrow();
  });

  it('refuses two commands on one path, aliases included', () => {
    const a = area.command({ ...base, path: ['kinds', 'a'], aliases: [['other', 'b']] });
    const b = defineCommand({ ...base, path: ['other', 'b'] });
    expect(() => assertUniquePaths([a, b])).toThrow('"other b" is claimed by both kinds a and other b.');
    expect(() => assertUniquePaths([a, area.command({ ...base, path: ['kinds', 'c'], aliases: ['a'] })])).toThrow(/"kinds a"/);
  });
});

describe('defineArea', () => {
  const connection = z.object({ baseUrl: z.string(), token: z.string(), project: z.string().optional(), instance: z.string().optional() });

  it('normalises secrets to a list with kinds, and names env vars for fix text', () => {
    const tokens = defineArea({ name: 'tok', description: 'test', connection, secrets: ['token'] });
    expect(tokens.secrets).toEqual(['token']);
    expect(tokens.secretKinds).toEqual({ token: 'token' });
    const passwords = defineArea({ name: 'pw-area', description: 'test', connection, secrets: { token: 'password' } });
    expect(passwords.secrets).toEqual(['token']);
    expect(passwords.secretKinds).toEqual({ token: 'password' });
    expect(passwords.envName('baseUrl')).toBe('TOIL_PW_AREA_BASE_URL');
    expect(() => defineArea({ name: 'bad', description: 'test', connection, secrets: ['nope' as never] })).toThrow(/isn't a connection key/);
  });

  it('adds context inputs: group ones to every command, command ones where listed, each as a field and a flag', () => {
    const area = defineArea({
      name: 'ctx',
      description: 'test',
      connection,
      context: {
        project: { description: 'Project', setting: 'project' },
        instance: { description: 'Instance', selectsConnection: true },
        boardId: { description: 'Board', scope: 'command' },
      },
    });
    const plain = area.command({ ...base, path: ['ctx', 'plain'] });
    const board = area.command({ ...base, path: ['ctx', 'board'], context: { boardId: 'required', project: 'required' } });

    expect(plain.context).toEqual({ project: 'optional', instance: 'optional' });
    expect(board.context).toEqual({ project: 'required', instance: 'optional', boardId: 'required' });
    expect(Object.keys(plain.input.shape).sort()).toEqual(['connection', 'cwd', 'instance', 'project', 'toilProject']);
    expect(board.options).toEqual(
      expect.arrayContaining([
        { flags: '--project <value>', field: 'project', description: "Project; defaults to your toil project's project, then the connection's project.", group: true },
        { flags: '--board-id <value>', field: 'boardId', description: "Board; defaults to your toil project's boardId." },
      ]),
    );
    expect(() => area.command({ ...base, path: ['ctx', 'x'], context: { nope: 'optional' } as never })).toThrow(/isn't a context input/);
    expect(() => area.command({ ...base, path: ['ctx', 'x'], input: z.object({ project: z.string() }), examples: [{ project: 'P' }] })).toThrow(/core adds it/);
  });

  it('refuses a context input that clashes with core, or reads a setting the connection lacks', () => {
    expect(() => defineArea({ name: 'a', description: 'test', connection, context: { connection: { description: 'x' } } })).toThrow(/can't be a context input/);
    expect(() => defineArea({ name: 'a', description: 'test', connection, context: { verbose: { description: 'x' } } })).toThrow(/can't be a context input/);
    expect(() => defineArea({ name: 'a', description: 'test', connection, context: { repo: { description: 'x', setting: 'repo' } } })).toThrow(/isn't a connection key/);
    expect(() => defineArea({ name: 'a', description: 'test', connection, context: { env: { description: 'x', selectsConnection: true } } })).toThrow(/must be a connection key/);
  });

  it('checks shared settings fit both areas, and adds the pairing setting', () => {
    const other = defineArea({ name: 'other', description: 'test', connection: z.object({ apiKey: z.string(), host: z.string().optional() }), secrets: ['apiKey'] });
    const make = (keys: string[], secrets: string[] = ['apiKey']) =>
      defineArea({ name: 'mine', description: 'test', connection: z.object({ apiKey: z.string().optional(), host: z.string().optional(), baseUrl: z.string() }), secrets: secrets as never, shares: { area: other, keys } });
    expect(() => make(['baseUrl'])).toThrow(/both mine and other/);
    expect(() => make(['apiKey'], [])).toThrow(/secret in both mine and other, or in neither/);
    expect(() => make(['host'], ['apiKey', 'host'])).toThrow(/secret in both/);
    expect(Object.keys(make(['apiKey']).connection.shape)).toContain('apiKeyFrom');
    expect(() => defineArea({ name: 'other', description: 'test', connection: z.object({ apiKey: z.string() }), shares: { area: other, keys: ['apiKey'] } })).toThrow(/itself/);
  });
});

describe('connection variants', () => {
  const engines = defineArea({
    name: 'engines',
    description: 'test',
    connection: z.object({ engine: z.enum(['file', 'server']), path: z.string().optional(), host: z.string().optional() }),
    variants: { by: 'engine', of: { file: { label: 'File', requires: ['path'] }, server: { requires: ['host'] } } },
  });
  const resolve = (settings: Record<string, unknown>) =>
    resolveConnection({ ...emptyConfig(), connections: { e: { area: 'engines', ...settings } }, sources: { 'e.engine': 'env' } }, engines, 'e', () => {});

  it("requires each variant's keys, naming the variant and the env var", async () => {
    await expect(resolve({ engine: 'file', path: '/x' })).resolves.toMatchObject({ engine: 'file', path: '/x' });
    await expect(resolve({ engine: 'file' })).rejects.toMatchObject({ code: 'CONFIG_INVALID', fix: expect.stringContaining('TOIL_ENGINES_PATH'), details: [{ path: ['path'], message: 'File connections need path.' }] });
    await expect(resolve({ engine: 'server' })).rejects.toMatchObject({ details: [{ path: ['host'], message: 'server connections need host.' }] });
    expect(engines.connection.safeParse({ engine: 'server', host: 'h' }).success, 'the schema itself carries the rule, for connections add').toBe(true);
    expect(engines.connection.safeParse({ engine: 'server' }).success).toBe(false);
  });

  it('refuses variants keyed on a field the connection lacks', () => {
    expect(() => defineArea({ name: 'v', description: 'test', connection: z.object({ a: z.string() }), variants: { by: 'b' as never, of: {} } })).toThrow(/isn't a connection key/);
  });
});

describe('fromText', () => {
  it('types text the one way argv and env share', () => {
    expect(fromText(z.number().optional(), '50')).toBe(50);
    expect(fromText(z.number(), '-1.5')).toBe(-1.5);
    expect(fromText(z.number(), 'five')).toBe('five');
    expect(fromText(z.number(), ' ')).toBe(' ');
    // Decimal only, as argv was read before: no hex, binary, exponents, padding or Infinity.
    for (const text of ['0x10', '0b11', '1e3', ' 5 ', 'Infinity']) expect(fromText(z.number(), text), text).toBe(text);
    expect(fromText(z.boolean().default(false), 'true')).toBe(true);
    expect(fromText(z.boolean(), 'yes')).toBe('yes');
    expect(fromText(z.array(z.string()), '["a","b"]')).toEqual(['a', 'b']);
    expect(fromText(z.object({ a: z.number() }), '{"a":1}')).toEqual({ a: 1 });
    expect(fromText(z.record(z.string(), z.string()), '{"a":"b"}')).toEqual({ a: 'b' });
    expect(fromText(z.object({}), '{nope')).toBe('{nope');
    expect(fromText(z.enum(['a', 'b']), 'a')).toBe('a');
    // A union stays text: Jira's maxResults reads it with parseInt, as the contract specifies.
    expect(fromText(z.union([z.number(), z.string()]), '10x')).toBe('10x');
    expect(fromText(z.number(), 7)).toBe(7);
  });
});
