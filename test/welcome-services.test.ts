import { describe, expect, it } from 'vitest';
import { areas, commands } from '../src/registry.js';
import { commandSummaries } from '../src/welcome/data.js';
import { finish, initialState, reduce, render, top, type MenuState } from '../src/welcome/menu.js';
import type { AreaSummary, CommandSummary, WelcomeData } from '../src/welcome/screens.js';
import { matching, resourcesOf, splitArgs, usage } from '../src/welcome/views/services.js';
import { testConfig } from './harness/context.js';

/**
 * The Services menu module: every command as the tree the CLI is, driven as
 * data through the menu's reducer. Runs are checked by the argv they would
 * hand the CLI, never by running them, since the CLI is tested on its own.
 */

type K = string | { name: string };
const keyOf = (k: K) => (typeof k === 'string' ? (k.length === 1 ? { sequence: k, name: k === ' ' ? 'space' : k } : { name: k }) : k);
const press = (state: MenuState, d: WelcomeData, ...keys: K[]) => keys.reduce((s, k) => reduce(s, keyOf(k), d), state);
const type = (state: MenuState, d: WelcomeData, text: string) => press(state, d, ...[...text]);
const clear = (state: MenuState, d: WelcomeData) => press(state, d, ...Array<K>(40).fill('backspace'));
const where = (s: MenuState) => top(s).view;
const plain = { colorDepth: 1, unicode: true, columns: 120, rows: 60 } as const;
const screen = (s: MenuState, d: WelcomeData) => render(s, plain, d).join('\n');

const cmd = (path: string[], over: Partial<CommandSummary> = {}): CommandSummary => ({ path, description: `${path.slice(1).join(' ')} does a thing`, writes: false, args: [], flags: [], ...over });
const ISSUE_GET = cmd(['jira', 'issue', 'get'], { args: [{ name: 'key', description: 'Issue key', required: true, variadic: true }], flags: [{ flags: '--fields <list>', description: 'Fields', required: false }] });
const ISSUE_COMMENT = cmd(['jira', 'issue', 'comment'], { writes: true, args: [{ name: 'key', description: 'Issue key', required: true, variadic: false }], flags: [{ flags: '--body <text>', description: 'Comment text', required: true }] });
const JIRA: AreaSummary = {
  name: 'jira',
  description: 'Jira Data Center',
  signsIn: true,
  live: true,
  configurable: true,
  commands: [ISSUE_COMMENT, ISSUE_GET, cmd(['jira', 'board', 'list']), cmd(['jira', 'check-toil-project'])],
};
const SONAR: AreaSummary = { name: 'sonar', description: 'SonarQube', signsIn: true, live: true, configurable: true, commands: [cmd(['sonar', 'issue', 'list'])] };

const data = (): WelcomeData => ({
  version: '0.0.0-test',
  node: '24.14.0',
  platform: 'linux x64',
  configPath: '/home/test/.toil/config.json',
  configExists: true,
  config: testConfig({ jira: { baseUrl: 'https://jira.imagile.dev', token: 't' } }),
  areas: [SONAR, JIRA],
  mcpAreas: ['jira', 'sonar'],
  launch: { command: 'toil', args: [] },
  folder: { cwd: '/work' },
});
const settled: MenuState = { ...initialState, session: { health: { jira: { ok: true, live: true } } } };

describe('the Services module', () => {
  it('is the first thing on home, and lists services with a connection first, after Find', () => {
    const d = data();
    expect(where(press(settled, d, '1'))).toBe('services');
    const s = press(settled, d, '1');
    expect(screen(s, d)).toMatch(/Find a command[\s\S]*jira[\s\S]*sonar/);
  });

  it('groups a service by resource, lists reads before writes, and shows a command as you would type it', () => {
    const d = data();
    let s = press(settled, d, '1', '2');
    expect(top(s)).toMatchObject({ view: 'service', params: { area: 'jira' } });
    expect(screen(s, d)).toMatch(/issue\s+comment, get[\s\S]*board\s+list[\s\S]*check-toil-project/);
    s = press(s, d, '1');
    expect(where(s)).toBe('service-resource');
    expect(screen(s, d)).toMatch(/get[\s\S]*comment[\s\S]*\(writes\)/);
    s = press(s, d, '1');
    expect(screen(s, d)).toContain('toil jira issue get <key...> [flags]');
  });

  it('asks for each argument, then flags, and runs the line it showed', () => {
    const d = data();
    let s = press(settled, d, '1', '2', '1', '1', '1');
    expect(where(s)).toBe('service-arg');
    expect(top(press(s, d, 'return')).error).toBe('<key> is required.');
    s = press(type(s, d, 'PROJ-1 PROJ-2'), d, 'return');
    expect(where(s)).toBe('service-flags');
    s = press(type(s, d, '--fields "summary,status"'), d, 'return');
    expect(s.pending?.steps.map((step) => step.args)).toEqual([['jira', 'issue', 'get', 'PROJ-1', 'PROJ-2', '--fields', 'summary,status']]);
    expect(s.pending?.showData).toBe(true);
  });

  it('confirms a write before it runs, with --allow-write, and fills in the required flags to edit', () => {
    const d = data();
    let s = press(settled, d, '1', '2', '1', '2', '1');
    s = press(type(s, d, 'PROJ-1'), d, 'return');
    expect(screen(s, d)).toContain('Flags (optional): --body');
    s = press(type(clear(s, d), d, '--body "Looks good"'), d, 'return');
    expect(s.pending).toBeUndefined();
    expect(where(s)).toBe('service-confirm');
    expect(screen(s, d)).toContain('$ toil jira issue comment PROJ-1 --body "Looks good" --allow-write');
    expect(press(s, d, '1').pending).toBeUndefined();
    expect(press(s, d, 'return').pending).toBeUndefined();
    s = press(s, d, '2');
    expect(s.pending?.steps.map((step) => step.args)).toEqual([['jira', 'issue', 'comment', 'PROJ-1', '--body', 'Looks good', '--allow-write']]);
  });

  it("shows what the command returned, and goes back to the command's screen", () => {
    const d = data();
    let s = press(type(press(settled, d, '1', '2', '1', '1', '1'), d, 'PROJ-1'), d, 'return', 'return');
    s = finish(s, [{ args: ['jira', 'issue', 'get', 'PROJ-1'], envelope: { ok: true, data: { key: 'PROJ-1' }, error: null, meta: { command: 'jira issue get', durationMs: 1, version: 'x', contractVersion: 1, context: { connection: { value: 'jira', source: 'default' } } } } }]);
    expect(screen(s, d)).toMatch(/\$ toil jira issue get PROJ-1[\s\S]*on jira \(default\)[\s\S]*"key": "PROJ-1"/);
    expect(where(press(s, d, 'return'))).toBe('service-command');
  });

  it('runs a command whose input decides whether it writes as typed, and says how to make it write', () => {
    const api = cmd(['jira', 'api'], { mayWrite: true, args: [{ name: 'method', description: 'Method', required: true, variadic: false }, { name: 'path', description: 'Path', required: true, variadic: false }] });
    const d = { ...data(), areas: [SONAR, { ...JIRA, commands: [...JIRA.commands!, api] }] };
    let s = press(settled, d, '1', '2', '4');
    expect(screen(s, d)).toContain('add --allow-write to the flags for those');
    s = press(type(press(type(press(s, d, '1'), d, 'GET'), d, 'return'), d, '/rest/api/2/myself'), d, 'return', 'return');
    expect(where(s)).toBe('service-flags');
    expect(s.pending?.steps.map((step) => step.args)).toEqual([['jira', 'api', 'GET', '/rest/api/2/myself']]);
  });

  it('refuses an argument that would read as a flag, and names --connection when there is more than one', () => {
    const d = data();
    const s = press(settled, d, '1', '2', '1', '1', '1');
    expect(top(press(type(s, d, '-PROJ'), d, 'return')).error).toContain("can't start with -");
    const two = { ...d, config: testConfig({ jira: { baseUrl: 'https://jira.imagile.dev', token: 't' }, 'jira-2': { baseUrl: 'https://jira2.imagile.dev', token: 't' } }) };
    two.config.connections['jira-2']!.area = 'jira';
    const flags = press(type(press(settled, two, '1', '2', '1', '1', '1'), two, 'PROJ-1'), two, 'return');
    expect(screen(flags, two)).toMatch(/--connection <name>\s+One of jira, jira-2/);
  });

  it('finds commands holding every word typed, across services', () => {
    const d = data();
    expect(matching(d, 'issue comment').map((c) => c.path.join(' '))).toEqual(['jira issue comment']);
    expect(matching(d, 'SONAR ISSUE').map((c) => c.path.join(' '))).toEqual(['sonar issue list']);
    const s = press(type(press(settled, d, '1', '1'), d, 'board'), d, 'return');
    expect(screen(s, d)).toContain('jira board list');
  });

  it('splits flags like a shell for plain words and quotes, and refuses an open quote', () => {
    expect(splitArgs(`--body "two words" --x 'a b' ""`)).toEqual(['--body', 'two words', '--x', 'a b', '']);
    expect(splitArgs('--body "open')).toEqual({ error: 'A " quote isn\'t closed.' });
  });
});

describe('the Services tree over the real registry', () => {
  it('marks a flag required when its field is, and shows a variadic id as such', () => {
    const jira = commandSummaries('jira', commands);
    const comment = jira.find((c) => c.path.join(' ') === 'jira issue comment')!;
    expect(comment.flags.find((f) => f.flags.startsWith('--body'))?.required).toBe(true);
    // Either --transition or --to moves an issue, so neither is required on its own.
    const transition = jira.find((c) => c.path.join(' ') === 'jira issue transition')!;
    expect(transition.flags.filter((f) => f.required)).toEqual([]);
    expect(usage(jira.find((c) => c.path.join(' ') === 'jira issue get')!)).toBe('toil jira issue get <key...>');
  });

  it('reaches every area command, with no flag core adds to all of them', () => {
    for (const area of areas) {
      const summary: AreaSummary = { name: area.name, description: area.description, signsIn: false, live: false, configurable: true, commands: commandSummaries(area.name, commands) };
      const reachable = resourcesOf(summary).flatMap((r) => r.commands.map((c) => c.path.join(' ')));
      const expected = commands.filter((def) => def.path[0] === area.name && (def.kind === 'area' || def.kind === 'area-local')).map((def) => def.path.join(' '));
      expect(reachable.sort()).toEqual(expected.sort());
      for (const c of summary.commands!) {
        expect(c.flags.map((f) => f.flags)).not.toContain('--connection <name>');
        expect(usage(c).startsWith(`toil ${c.path.join(' ')}`)).toBe(true);
      }
    }
  });
});
