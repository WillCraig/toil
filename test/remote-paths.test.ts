import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeFiles, type FileAccess } from '../src/core/files.js';
import { assertLocalPath, remotePathKind } from '../src/core/local-path.js';
import { createNodeContext } from '../src/node-context.js';
import { areas, commands } from '../src/registry.js';
import { runCli } from './harness/cli.js';
import { fakeFetch } from './harness/fake-fetch.js';
import { connectMcp } from './harness/mcp.js';

/**
 * A network or device path a call names is refused from its text, before any
 * `node:fs` call sees it (bound `files.remote`). Every fs function the code
 * under test can reach is wrapped: a call whose path names the probe host is
 * recorded, so "refused" here means refused with nothing touched, not refused
 * after a lookup. Paths on `toilhost` are mapped onto a temporary folder, so a
 * workspace that is itself on a share can be shown working on every OS.
 */
const PROBE = 'toil-unc-probe';
const SHARE = vi.hoisted(() => ({ dir: '' }));
const touched = vi.hoisted(() => [] as string[]);

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  /** `\\toilhost\share\x` (or `//toilhost/share/x`) -> the temporary folder; anything naming the probe host is recorded. */
  const map = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    if (value.includes('toil-unc-probe')) touched.push(value);
    const slashed = value.replace(/\\/g, '/');
    const m = /^\/{1,2}toilhost\/share(\/.*)?$/i.exec(slashed);
    return m && SHARE.dir ? fs.realpathSync.native(SHARE.dir) + (m[1] ?? '') : value;
  };
  const wrap = <F extends (...args: never[]) => unknown>(fn: F): F => ((...args: unknown[]) => (fn as unknown as (...a: unknown[]) => unknown)(...args.map((a, i) => (i < 2 ? map(a) : a)))) as unknown as F;
  const names = ['existsSync', 'statSync', 'lstatSync', 'readFileSync', 'readdirSync', 'createReadStream', 'mkdirSync', 'writeFileSync', 'openSync', 'accessSync', 'renameSync', 'rmSync', 'cpSync'] as const;
  const wrapped: Record<string, unknown> = Object.fromEntries(names.map((n) => [n, wrap(fs[n] as never)]));
  const realpathSync = Object.assign(wrap(fs.realpathSync), { native: wrap(fs.realpathSync.native) });
  const mod = { ...fs, ...wrapped, realpathSync };
  return { ...mod, default: mod };
});

const root = mkdtempSync(join(tmpdir(), 'toil-remote-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, 'home');
const cwd = join(root, 'work');
mkdirSync(join(home, '.toil'), { recursive: true });
mkdirSync(cwd, { recursive: true });
beforeEach(() => {
  touched.length = 0;
});

/** Every spelling of "another machine" or "a device", each naming the probe host where it can. */
const REMOTE = [
  `\\\\${PROBE}\\share\\x.md`,
  `//${PROBE}/share/x.md`,
  `\\/${PROBE}/share/x.md`,
  `/\\${PROBE}\\share\\x.md`,
  `\\\\?\\UNC\\${PROBE}\\share\\x.md`,
  `\\\\?\\C:\\${PROBE}\\x.md`,
  `\\\\.\\C:\\${PROBE}\\x.md`,
  `//./pipe/${PROBE}`,
  `\\??\\C:\\${PROBE}\\x.md`,
];

describe('remotePathKind and assertLocalPath, from text alone', () => {
  it('tells network, device and ordinary paths apart', () => {
    expect(REMOTE.map(remotePathKind)).toEqual(['unc', 'unc', 'unc', 'unc', 'device', 'device', 'device', 'device', 'device']);
    for (const p of ['C:\\work\\x.md', 'C:/work/x.md', '/home/me/x.md', 'x.md', '.\\x.md', '\\work\\x.md', '/work//x.md', '-']) expect(remotePathKind(p), p).toBeUndefined();
  });

  it('refuses each with INVALID_INPUT and a fix, and allows a network path only inside a workspace on that share', () => {
    for (const p of REMOTE) expect(() => assertLocalPath(p, 'C:\\work'), p).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', fix: expect.any(String) }));
    expect(() => assertLocalPath('\\\\host\\share\\ws\\a.md', '\\\\host\\share\\ws')).not.toThrow();
    expect(() => assertLocalPath('//HOST/Share/ws/sub/a.md', '\\\\host\\share\\ws')).not.toThrow();
    expect(() => assertLocalPath('\\\\host\\share\\ws\\..\\other\\a.md', '\\\\host\\share\\ws')).toThrow(/network \(UNC\) path/);
    expect(() => assertLocalPath('\\\\host\\share\\wsx\\a.md', '\\\\host\\share\\ws')).toThrow(/network \(UNC\) path/);
    expect(() => assertLocalPath('\\\\other\\share\\ws\\a.md', '\\\\host\\share\\ws')).toThrow(/network \(UNC\) path/);
    expect(() => assertLocalPath('\\\\?\\UNC\\host\\share\\ws\\a.md', '\\\\host\\share\\ws')).toThrow(/device path/);
  });
});

describe('the file service touches nothing for a network or device path', () => {
  const entryPoints: Array<[string, (f: FileAccess, p: string) => unknown]> = [
    ['resolve', (f, p) => f.resolve(p)],
    ['readText', (f, p) => f.readText(p)],
    ['readBytes', (f, p) => f.readBytes(p)],
    ['readStream', (f, p) => f.readStream(p)],
    ['writeBytes', (f, p) => f.writeBytes(p, new Uint8Array([1]))],
    ['writeCsv', (f, p) => f.writeCsv(p, ['a'], [[1]])],
    ['exists', (f, p) => f.exists(p)],
    ['stat', (f, p) => f.stat(p)],
    ['list', (f, p) => f.list(p)],
    ['findUp', (f, p) => f.findUp('x.md', p)],
  ];
  const bounded = nodeFiles({ cwd, stdin: true, home, env: {}, protect: [join(home, '.toil')] });
  const unbounded = nodeFiles({ cwd, stdin: true, unbounded: true, home, env: {}, protect: [join(home, '.toil')] });

  it.each(entryPoints)('%s refuses every spelling, bounded or not, before any fs call', (_name, call) => {
    for (const files of [bounded, unbounded]) {
      for (const p of REMOTE) {
        expect(() => call(files, p), p).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringMatching(/network \(UNC\) path|device path/) }));
      }
    }
    expect(touched).toEqual([]);
  });

  it('works inside a workspace that is itself on a share, and still refuses another share', () => {
    SHARE.dir = mkdtempSync(join(root, 'share-'));
    mkdirSync(join(SHARE.dir, 'ws', 'docs'), { recursive: true });
    writeFileSync(join(SHARE.dir, 'ws', 'docs', 'a.md'), '# on the share\n');
    const ws = process.platform === 'win32' ? '\\\\toilhost\\share\\ws' : '//toilhost/share/ws';
    const files = nodeFiles({ cwd, stdin: true, workspace: { dir: ws, source: 'flag' }, home, env: {} });
    expect(files.readText('docs/a.md')).toBe('# on the share\n');
    expect(files.readText(`${ws}/docs/a.md`)).toBe('# on the share\n');
    expect(files.exists('docs/a.md')).toBe(true);
    expect(files.stat('docs').type).toBe('directory');
    expect(files.list('docs')).toEqual(['a.md']);
    expect(files.writeBytes('docs/b.md', new TextEncoder().encode('b'))).toMatch(/\/docs\/b\.md$/);
    expect(() => files.readText(`//${PROBE}/share/ws/docs/a.md`)).toThrow(/network \(UNC\) path/);
    expect(() => files.readText('../../other/a.md')).toThrow();
    expect(touched).toEqual([]);
  });
});

function context(stdin: boolean, http = fakeFetch([])) {
  const ctx = createNodeContext({
    globals: {},
    signal: new AbortController().signal,
    env: {},
    cwd,
    home,
    areas: areas.map((a) => ({ name: a.name, fallbacks: a.fallbacks, contextInputs: Object.keys(a.context ?? {}) })),
    version: '0.0.0-test',
    stderr: () => {},
    stdin,
  });
  return { http, context: { ...ctx, fetch: http.fetch } };
}

describe('every entry point that takes a path, end to end with the real node context', () => {
  const unc = `\\\\${PROBE}\\share\\x`;
  const cli: Array<[string, string[]]> = [
    ['a file a command reads (util md)', ['util', 'md', `${unc}.md`, '--to', 'wiki']],
    ['--cwd on an area command, which picks the toil project and the git remotes', ['github', 'pr', 'get', '7', '--cwd', unc]],
    ['--toil-project as a file', ['github', 'pr', 'get', '7', '--toil-project', `${unc}.json`]],
    ['toil projects import', ['projects', 'import', `${unc}.json`]],
    ['toil projects export --file', ['projects', 'export', 'payments', '--file', `${unc}.json`]],
    ['toil projects export --repo', ['projects', 'export', 'payments', '--repo', unc]],
    ['repos scan', ['repos', 'scan', unc]],
  ];

  it('has a toil project of your own to export', async () => {
    const made = await runCli(['projects', 'init', 'payments'], { commands, context: context(true).context });
    expect(made.envelope?.ok, JSON.stringify(made.envelope?.error)).toBe(true);
  });

  it.each(cli)('%s on the CLI is refused with nothing touched and nothing sent', async (_name, argv) => {
    const { http, context: ctx } = context(true);
    const run = await runCli(argv, { commands, context: ctx });
    expect(run.envelope?.error, argv.join(' ')).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/network \(UNC\) path|device path/) });
    expect(touched).toEqual([]);
    expect(http.calls).toEqual([]);
  });

  it('over MCP, util_md with a file, and an area tool with cwd or toil project, are refused the same way', async () => {
    const { http, context: ctx } = context(false);
    const session = await connectMcp({ commands, context: ctx, areas: ['util', 'github'] });
    const calls: Array<[string, Record<string, unknown>]> = [
      ['util_md', { file: `${unc}.md`, to: 'wiki' }],
      ['github_pr_get', { number: '7', cwd: unc }],
      ['github_pr_get', { number: '7', toilProject: `//${PROBE}/share/x.json` }],
    ];
    for (const [tool, args] of calls) {
      const result = await session.call(tool, args);
      expect(result.envelope.error, tool).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/network \(UNC\) path|device path/) });
    }
    await session.close();
    expect(touched).toEqual([]);
    expect(http.calls).toEqual([]);
  });
});
