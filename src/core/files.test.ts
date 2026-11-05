import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryFiles } from '../../test/harness/files.js';
import { ToilError } from './errors.js';
import { downloadFileName, forwardSlashes, isSystemPath, nodeFiles, resolveWorkspace, toCsv, unsafeFileName } from './files.js';
import { findGit } from './git.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('nodeFiles', () => {
  it('resolves relative paths against its working directory, and writes with parents created', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'toil-files-'));
    dirs.push(cwd);
    const files = nodeFiles({ cwd, stdin: true });
    const saved = files.writeBytes('out/deep/a.txt', new TextEncoder().encode('hi'));
    expect(saved).toBe(forwardSlashes(join(cwd, 'out', 'deep', 'a.txt')));
    expect(saved).not.toContain('\\');
    expect(readFileSync(join(cwd, 'out', 'deep', 'a.txt'), 'utf8')).toBe('hi');
    expect(files.readText('out/deep/a.txt')).toBe('hi');
    expect([...files.readBytes(join(cwd, 'out', 'deep', 'a.txt'))]).toEqual([104, 105]);
  });

  it('never replaces a file already there', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'toil-files-'));
    dirs.push(cwd);
    const files = nodeFiles({ cwd, stdin: true });
    writeFileSync(join(cwd, 'mine.txt'), 'mine');
    expect(() => files.writeBytes('mine.txt', new TextEncoder().encode('theirs'))).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('already exists') }));
    expect(readFileSync(join(cwd, 'mine.txt'), 'utf8')).toBe('mine');
  });

  it('refuses, on every platform, a name Windows would write somewhere else, and leaves the existing file alone', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'toil-files-'));
    dirs.push(cwd);
    const files = nodeFiles({ cwd, stdin: true });
    writeFileSync(join(cwd, 'mine.txt'), 'mine');
    for (const path of ['mine.txt:hidden', 'mine.txt.', 'mine.txt ', 'CON', 'out/nul.txt', 'LPT9.log', 'COM¹','conout$', 'aux/x.txt']) {
      expect(() => files.writeBytes(path, new TextEncoder().encode('theirs')), path).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining("can't be written") }));
    }
    expect(readFileSync(join(cwd, 'mine.txt'), 'utf8')).toBe('mine');
    // A drive letter is a drive, and a name merely starting like a device is a name.
    expect(files.writeBytes(join(cwd, 'console.txt'), new TextEncoder().encode('ok'))).toBe(forwardSlashes(join(cwd, 'console.txt')));
    expect(files.writeBytes('com10', new TextEncoder().encode('ok'))).toBe(forwardSlashes(join(cwd, 'com10')));
  });

  it('turns a server-supplied file name into one that is safe to save', () => {
    expect(downloadFileName('CON')).toBe('_CON');
    expect(downloadFileName('Prn.TXT')).toBe('_Prn.TXT');
    expect(downloadFileName('nul .txt')).toBe('_nul .txt');
    expect(downloadFileName('a.txt:stream:$DATA')).toBe('a.txt');
    expect(downloadFileName('..\\..\\x.txt..  ')).toBe('x.txt');
    expect(downloadFileName('dir/sub/')).toBe('sub');
    expect(downloadFileName(':')).toBe('download');
    expect(downloadFileName('', 'attachment')).toBe('attachment');
    expect(downloadFileName('ta\tb|c')).toBe('ta_b_c');
    for (const name of ['CON', 'a.txt:s', 'x. ', 'COM².png', 'ordinary.txt', '.hidden']) expect(unsafeFileName(downloadFileName(name)), name).toBeUndefined();
  });

  it('turns a missing file into INVALID_INPUT with a fix', () => {
    const files = nodeFiles({ cwd: tmpdir(), stdin: true });
    expect(() => files.readText('no-such-file-for-toil.json')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('does not exist') }));
  });

  it('refuses "-" when stdin carries the MCP protocol', () => {
    const files = nodeFiles({ cwd: tmpdir(), stdin: false });
    expect(() => files.readText('-')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('not available over MCP') }));
  });
});

describe('nodeFiles never touches toil\'s own config', () => {
  /** A home with ~/.toil/config.json and a toil project, a separate --config file, and a working directory. */
  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'toil-guard-'));
    dirs.push(root);
    const home = join(root, 'home');
    const cwd = join(root, 'work');
    mkdirSync(join(home, '.toil', 'projects'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(home, '.toil', 'config.json'), '{"jira":{"apiToken":"SECRET-TOKEN"}}');
    writeFileSync(join(home, '.toil', 'projects', 'team.json'), '{}');
    const custom = join(root, 'elsewhere', 'toil.json');
    mkdirSync(dirname(custom), { recursive: true });
    writeFileSync(custom, '{"jira":{"apiToken":"OTHER-SECRET"}}');
    writeFileSync(join(cwd, 'ok.txt'), 'fine');
    const files = nodeFiles({ cwd, stdin: false, protect: [join(home, '.toil'), custom] });
    return { root, home, cwd, custom, files };
  }

  const refused = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      expect(err).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining("toil's own configuration") });
      expect(JSON.stringify({ message: (err as Error).message, fix: (err as { fix?: string }).fix })).not.toMatch(/SECRET/);
      return;
    }
    throw new Error('expected a refusal');
  };

  it('refuses the config file, anything else under ~/.toil, and the --config file', () => {
    const { home, custom, files } = setup();
    refused(() => files.readText(join(home, '.toil', 'config.json')));
    refused(() => files.readBytes(join(home, '.toil', 'projects', 'team.json')));
    refused(() => files.readText(join(home, '.toil')));
    refused(() => files.readText(custom));
    refused(() => files.writeBytes(join(home, '.toil', 'new.json'), new Uint8Array([1])));
    refused(() => files.writeBytes(custom, new Uint8Array([1])));
    expect(files.readText('ok.txt')).toBe('fine');
  });

  it('refuses a .. traversal, and a differently cased path on Windows', () => {
    const { home, cwd, files } = setup();
    const rel = relative(cwd, join(home, '.toil', 'config.json'));
    refused(() => files.readText(rel));
    refused(() => files.readText(join(cwd, '..', 'home', 'x', '..', '.toil', 'config.json')));
    if (process.platform === 'win32') refused(() => files.readText(join(home, '.TOIL', 'CONFIG.JSON')));
  });

  it('refuses a symlink or junction into ~/.toil', () => {
    const { home, cwd, files } = setup();
    try {
      // A junction needs no privilege on Windows; elsewhere this is a plain directory symlink.
      symlinkSync(join(home, '.toil'), join(cwd, 'innocent'), 'junction');
    } catch {
      return; // the platform refused to make one, so there's nothing to get around
    }
    refused(() => files.readText(join('innocent', 'config.json')));
    refused(() => files.writeBytes(join('innocent', 'planted.json'), new Uint8Array([1])));
  });

});

describe('nodeFiles never reads /proc or /sys', () => {
  it('treats anything under /proc or /sys as a system path on Linux and macOS, never on Windows', () => {
    for (const p of ['/proc/self/environ', '/proc/1234/environ', '/proc', '/sys/kernel/x', '/sys']) expect(isSystemPath(p, 'linux'), p).toBe(true);
    for (const p of ['/procurement/a.txt', '/system/x', '/home/u/proc/environ', '/work/sys']) expect(isSystemPath(p, 'linux'), p).toBe(false);
    expect(isSystemPath('/proc/self/environ', 'darwin')).toBe(true);
    expect(isSystemPath('/proc/self/environ', 'win32')).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('refuses /proc/self/environ and a symlink to it (Linux only: the file exists only there)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'toil-proc-'));
    dirs.push(cwd);
    const files = nodeFiles({ cwd, stdin: false });
    expect(() => files.readText('/proc/self/environ')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('/proc or /sys') }));
    symlinkSync('/proc/self/environ', join(cwd, 'env.txt'));
    expect(() => files.readText('env.txt')).toThrow(/\/proc or \/sys/);
  });
});

describe('memoryFiles', () => {
  it('refuses to replace a file already there, as nodeFiles does', () => {
    const files = memoryFiles({ 'a.png': 'x' });
    expect(() => files.writeBytes('a.png', new Uint8Array([1]))).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: '"/work/a.png" already exists.' }));
    expect(files.readText('a.png')).toBe('x');
  });

  it('reads seeded files relative to /work, records writes, and serves stdin when given one', () => {
    const files = memoryFiles({ 'a.json': '{}' }, { stdin: 'piped' });
    expect(files.readText('./a.json')).toBe('{}');
    expect(files.readText('/work/a.json')).toBe('{}');
    expect(files.readText('-')).toBe('piped');
    expect(files.writeBytes('x/../b.bin', new Uint8Array([1]))).toBe('/work/b.bin');
    expect(Object.keys(files.written)).toEqual(['/work/b.bin']);
    expect(() => memoryFiles().readText('-')).toThrow(/not available over MCP/);
  });
});

describe('the file workspace', () => {
  /** A workspace inside a root, with a sibling folder outside it. */
  function setup(options: { unbounded?: boolean; protect?: (root: string) => string[] } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'toil-ws-'));
    dirs.push(root);
    const ws = join(root, 'ws');
    const outside = join(root, 'outside');
    mkdirSync(join(ws, 'sub'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(ws, 'in.txt'), 'in');
    writeFileSync(join(outside, 'secret.txt'), 'out');
    const files = nodeFiles({ cwd: join(ws, 'sub'), stdin: false, workspace: { dir: ws, source: 'flag' }, unbounded: options.unbounded ?? false, protect: options.protect?.(root) ?? [] });
    return { root, ws, outside, files };
  }
  const outsideError = expect.objectContaining({
    code: 'INVALID_INPUT',
    message: expect.stringContaining('is outside the workspace'),
    fix: expect.stringMatching(/--workspace <dir> or TOIL_WORKSPACE.*"bounds": \{ "files": "unbounded" \}/),
  });

  it('resolves relative paths against the workspace, not the working directory, and reports it with forward slashes', () => {
    const { ws, files } = setup();
    expect(files.workspace).toBe(forwardSlashes(ws));
    expect(files.readText('in.txt')).toBe('in');
    expect(files.writeBytes('sub/new.txt', new Uint8Array([1]))).toBe(forwardSlashes(join(ws, 'sub', 'new.txt')));
  });

  it('refuses .. and absolute paths that leave it, for reads, writes, exists, stat, list and findUp', () => {
    const { outside, files } = setup();
    expect(() => files.readText('../outside/secret.txt')).toThrow(outsideError);
    expect(() => files.readText(join(outside, 'secret.txt'))).toThrow(outsideError);
    expect(() => files.writeBytes('../outside/planted.txt', new Uint8Array([1]))).toThrow(outsideError);
    expect(() => files.exists(join(outside, 'secret.txt'))).toThrow(outsideError);
    expect(() => files.stat(outside)).toThrow(outsideError);
    expect(() => files.list(outside)).toThrow(outsideError);
    expect(() => files.findUp('secret.txt', outside)).toThrow(outsideError);
  });

  it('refuses a symlink or junction that leads out of it', () => {
    const { ws, outside, files } = setup();
    try {
      symlinkSync(outside, join(ws, 'link'), 'junction');
    } catch {
      return; // the platform refused to make one, so there's nothing to get around
    }
    expect(() => files.readText('link/secret.txt')).toThrow(outsideError);
    expect(() => files.writeBytes('link/planted.txt', new Uint8Array([1]))).toThrow(outsideError);
  });

  it('with "files": "unbounded", reaches outside it, but still never overwrites and never reads toil\'s own files', () => {
    const { root, outside, files } = setup({ unbounded: true, protect: (r) => [join(r, 'outside', 'secret.txt')] });
    writeFileSync(join(root, 'other.txt'), 'other');
    expect(files.readText('../other.txt')).toBe('other');
    expect(files.writeBytes(join(outside, 'new.txt'), new Uint8Array([1]))).toBe(forwardSlashes(join(outside, 'new.txt')));
    expect(() => files.writeBytes(join(outside, 'new.txt'), new Uint8Array([2]))).toThrow(/already exists/);
    expect(() => files.readText(join(outside, 'secret.txt'))).toThrow(/toil's own configuration/);
  });

  it('with no workspace, every file operation refuses with the reason, and unbounded still refuses relative paths', () => {
    const error = new ToilError('NOT_CONFIGURED', 'No workspace folder is set, and this command reads or writes files.', { fix: 'x' });
    const files = nodeFiles({ cwd: tmpdir(), stdin: false, workspace: { error, source: 'none' } });
    expect(files.workspace).toBeUndefined();
    expect(() => files.readText('a.txt')).toThrow(error);
    expect(() => files.readText(join(tmpdir(), 'a.txt'))).toThrow(error);
    expect(() => files.list()).toThrow(error);
    const open = nodeFiles({ cwd: tmpdir(), stdin: false, workspace: { error, source: 'none' }, unbounded: true });
    expect(() => open.readText(join(tmpdir(), 'no-such-file-for-toil.txt'))).toThrow(/does not exist/);
    expect(() => open.readText('relative.txt')).toThrow(error);
    expect(() => open.writeBytes('relative.txt', new Uint8Array([1]))).toThrow(error);
  });
});

describe('resolveWorkspace', () => {
  const base = () => {
    const root = mkdtempSync(join(tmpdir(), 'toil-wsr-'));
    dirs.push(root);
    for (const d of ['flag', 'env', 'cwd', 'root1', 'root2']) mkdirSync(join(root, d));
    return root;
  };

  it('takes --workspace, then TOIL_WORKSPACE, then the CLI working directory', () => {
    const r = base();
    const env = { TOIL_WORKSPACE: join(r, 'env') };
    expect(resolveWorkspace({ flag: 'flag', env, cwd: r, mcp: false })).toEqual({ dir: join(r, 'flag'), source: 'flag' });
    expect(resolveWorkspace({ env, cwd: r, mcp: false })).toEqual({ dir: join(r, 'env'), source: 'env' });
    expect(resolveWorkspace({ env: {}, cwd: join(r, 'cwd'), mcp: false })).toEqual({ dir: join(r, 'cwd'), source: 'cwd' });
  });

  it("under MCP, uses the client's single root instead of the working directory, and refuses none or several", () => {
    const r = base();
    expect(resolveWorkspace({ env: {}, cwd: join(r, 'cwd'), mcp: true, roots: [join(r, 'root1')] })).toEqual({ dir: join(r, 'root1'), source: 'mcp-root' });
    expect(resolveWorkspace({ env: { TOIL_WORKSPACE: join(r, 'env') }, cwd: r, mcp: true, roots: [join(r, 'root1')] }).source).toBe('env');
    const several = resolveWorkspace({ env: {}, cwd: r, mcp: true, roots: [join(r, 'root1'), join(r, 'root2')] });
    expect(several.dir).toBeUndefined();
    expect(several.error).toMatchObject({ code: 'NOT_CONFIGURED', message: expect.stringContaining('shared 2 roots'), fix: expect.stringContaining('--workspace <dir>') });
    expect(resolveWorkspace({ env: {}, cwd: r, mcp: true }).error).toMatchObject({ code: 'NOT_CONFIGURED', message: "This command reads or writes files, but there's no workspace folder to keep them in." });
  });

  it('defers a workspace that is not a folder to the first file operation', () => {
    const r = base();
    const ws = resolveWorkspace({ flag: 'missing', env: {}, cwd: r, mcp: false });
    expect(ws.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining("(from --workspace) isn't a folder that exists") });
  });
});

describe('exists, stat, findUp and writeCsv', () => {
  it('answers inside the workspace', () => {
    const ws = mkdtempSync(join(tmpdir(), 'toil-more-'));
    dirs.push(ws);
    mkdirSync(join(ws, 'a', 'b'), { recursive: true });
    writeFileSync(join(ws, 'Directory.Packages.props'), '<Project/>');
    writeFileSync(join(ws, 'a', 'x.txt'), 'hello');
    const files = nodeFiles({ cwd: ws, stdin: false });
    expect(files.exists('a/x.txt')).toBe(true);
    expect(files.exists('a/nope.txt')).toBe(false);
    expect(files.stat('a/x.txt')).toMatchObject({ type: 'file', size: 5, modified: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    expect(files.stat('a').type).toBe('directory');
    expect(() => files.stat('a/nope.txt')).toThrow(/does not exist/);
    expect(files.findUp('Directory.Packages.props', 'a/b')).toBe(forwardSlashes(join(ws, 'Directory.Packages.props')));
    expect(files.findUp('nowhere.json', 'a/b')).toBeUndefined();
    const saved = files.writeCsv('out/report.csv', ['week', 'author', 'commits'], [['2026-W01', 'Doe, Jane', 3], ['TOTAL', 'say "hi"', null]]);
    expect(saved).toBe(forwardSlashes(join(ws, 'out', 'report.csv')));
    expect(readFileSync(join(ws, 'out', 'report.csv'), 'utf8')).toBe('week,author,commits\n2026-W01,"Doe, Jane",3\nTOTAL,"say ""hi""",\n');
    expect(() => files.writeCsv('out/report.csv', ['a'], [])).toThrow(/already exists/);
  });

  it('findUp stops at the top of the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'toil-up-'));
    dirs.push(root);
    mkdirSync(join(root, 'ws', 'a'), { recursive: true });
    writeFileSync(join(root, 'above.json'), '{}');
    const files = nodeFiles({ cwd: join(root, 'ws'), stdin: false });
    expect(files.findUp('above.json', 'a')).toBeUndefined();
  });

  it('toCsv quotes only what needs it and ends every line with LF', () => {
    expect(toCsv(['a', 'b'], [['x\ny', 'p,q'], [undefined, 1.5]])).toBe('a,b\n"x\ny","p,q"\n,1.5\n');
  });
});

describe('list', () => {
  /** A tree exercising nested, negated, anchored and folder-only patterns. */
  function tree(root: string) {
    const put = (path: string, text = 'x') => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    put('.gitignore', '*.log\n!keep.log\n/build/\ndist\ntemp*/\n# comment\n\\#hash\n');
    put('a.log');
    put('keep.log');
    put('#hash');
    put('build/out.js');
    put('src/build/kept.js');
    put('src/dist');
    put('src/temp1/x.txt');
    put('src/tempfile.txt');
    put('src/index.ts');
    // A line with a reversed range is skipped; git lists m.txt too, since the range can't cover it (#262).
    put('src/.gitignore', 'secret.*\n!secret.example\n[z-a].txt\n');
    put('src/m.txt');
    put('src/secret.json');
    put('src/secret.example');
    put('docs/readme.md');
    put('local-only.txt');
  }

  it('skips .git and what .gitignore files say, the deepest file deciding', () => {
    const root = mkdtempSync(join(tmpdir(), 'toil-list-'));
    dirs.push(root);
    tree(root);
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const files = nodeFiles({ cwd: root, stdin: false });
    expect(files.list()).toEqual(['.gitignore', 'docs/readme.md', 'keep.log', 'local-only.txt', 'src/.gitignore', 'src/build/kept.js', 'src/index.ts', 'src/m.txt', 'src/secret.example', 'src/tempfile.txt']);
    expect(files.list('src')).toEqual(['.gitignore', 'build/kept.js', 'index.ts', 'm.txt', 'secret.example', 'tempfile.txt']);
    expect(files.list('.', { gitignore: false })).toContain('build/out.js');
    expect(files.list('.', { gitignore: false })).not.toContain('.git/HEAD');
    expect(() => files.list('.', { limit: 3 })).toThrow(/more than 3 files/);
  });

  // Tests that spawn the real git get 30 s, not vitest's 5 s default: each runs
  // git several times, and on a loaded machine (CI, or a laptop mid-build) that
  // has passed 5 s without anything being wrong.
  const REAL_GIT_TIMEOUT_MS = 30_000;
  const git = findGit({ env: process.env }).found;
  it.skipIf(!git)('matches git ls-files --cached --others --exclude-standard: tracked-but-ignored, deleted, nested repos, ignored folders, index v4 (skipped where git is not installed)', () => {
    const root = mkdtempSync(join(tmpdir(), 'toil-lsf-'));
    dirs.push(root);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-global') };
    execFileSync(git!, ['init', '-q'], { cwd: root, env });
    tree(root);
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'local-only.txt\n');
    const lsFiles = (cwd: string) =>
      execFileSync(git!, ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, env, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((p) => p.replace(/^"|"$/g, '').replace(/\\#/g, '#'))
        .sort();
    const files = nodeFiles({ cwd: root, stdin: false, env: { GIT_CONFIG_GLOBAL: join(root, 'no-global') }, home: root });
    const same = () => {
      for (const dir of ['', 'src', 'build', 'src/temp1']) expect(files.list(dir || '.'), dir || '(root)').toEqual(lsFiles(join(root, dir)));
    };
    same();

    // --cached: tracked files count even when ignored (git add -f) or deleted from disk;
    // a nested repository is one entry; an untracked file in an ignored folder never shows.
    const g = (...args: string[]) => execFileSync(git!, ['-c', 'user.name=toil', '-c', 'user.email=you@example.com', ...args], { cwd: root, env });
    g('add', '-f', 'a.log', 'build/out.js', 'src/index.ts', 'docs/readme.md');
    g('commit', '-q', '-m', 'first');
    rmSync(join(root, 'docs', 'readme.md'));
    writeFileSync(join(root, 'build', 'untracked.js'), 'x');
    mkdirSync(join(root, 'nested'));
    execFileSync(git!, ['init', '-q'], { cwd: join(root, 'nested'), env });
    writeFileSync(join(root, 'nested', 'inner.txt'), 'x');
    expect(files.list()).toContain('a.log');
    expect(files.list()).toContain('nested/');
    expect(files.list('build')).toEqual(['out.js']);
    same();

    // Index version 4 compresses paths; the reader must too.
    g('update-index', '--index-version', '4');
    same();
  }, REAL_GIT_TIMEOUT_MS);

  it('skips only the .gitignore line that does not compile, keeps the rest of that file, and warns with the file and line (#262)', () => {
    const root = mkdtempSync(join(tmpdir(), 'toil-badline-'));
    dirs.push(root);
    const put = (path: string, text = 'x') => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    put('.gitignore', '*.log\n# a comment\n[b-a]\n/build/\n');
    put('src/.gitignore', 'secret.*\n[z-a].txt\n');
    put('a.log');
    put('a');
    put('build/out.js');
    put('src/index.ts');
    put('src/secret.json');
    put('src/m.txt');
    const files = nodeFiles({ cwd: root, stdin: false, home: root });
    const warnings: Array<{ code: string; message: string }> = [];
    expect(files.list('.', { warn: (w) => warnings.push(w) })).toEqual(['.gitignore', 'a', 'src/.gitignore', 'src/index.ts', 'src/m.txt']);
    // The listing names the file by its real path (/private/var on macOS, a long name for a short one on Windows).
    const real = realpathSync.native(root);
    const top = forwardSlashes(join(real, '.gitignore'));
    const nested = forwardSlashes(join(real, 'src', '.gitignore'));
    expect(warnings).toEqual([
      { code: 'GITIGNORE_LINE_SKIPPED', message: expect.stringContaining(`Line 3 of ${top} ("[b-a]")`) },
      { code: 'GITIGNORE_LINE_SKIPPED', message: expect.stringContaining(`Line 2 of ${nested} ("[z-a].txt")`) },
    ]);
    expect(warnings[0]!.message).toContain('was skipped, and the rest of that file still applies: a range in brackets runs backwards');
    expect(warnings[0]!.message).toMatch(/Write the range from low to high, as in \[a-z\], or delete the line\.$/);

    // A .gitignore above the listing root is read the same way, and its bad line said the same way.
    const below: Array<{ code: string; message: string }> = [];
    expect(files.list('src', { warn: (w) => below.push(w) })).toEqual(['.gitignore', 'index.ts', 'm.txt']);
    expect(below.map((w) => w.message.slice(0, w.message.indexOf(')') + 1))).toEqual([`Line 3 of ${top} ("[b-a]")`, `Line 2 of ${nested} ("[z-a].txt")`]);

    // With .gitignore off, no ignore file is read at all, so nothing is said about one.
    const off: Array<{ code: string; message: string }> = [];
    expect(files.list('src', { gitignore: false, warn: (w) => off.push(w) })).toContain('secret.json');
    expect(off).toEqual([]);
  });

  it('outside a repository applies only the .gitignore files under the folder (git would list nothing: the deps area must check for a repository itself)', () => {
    const root = mkdtempSync(join(tmpdir(), 'toil-norepo-'));
    dirs.push(root);
    writeFileSync(join(root, '.gitignore'), '*.log\n');
    writeFileSync(join(root, 'a.log'), 'x');
    writeFileSync(join(root, 'b.txt'), 'x');
    expect(nodeFiles({ cwd: root, stdin: false }).list()).toEqual(['.gitignore', 'b.txt']);
  });
});

describe('readStream', () => {
  const collect = async (stream: AsyncIterable<Uint8Array>) => {
    const parts: Uint8Array[] = [];
    for await (const chunk of stream) parts.push(chunk);
    return parts;
  };

  it('streams a file in chunks of the size asked for, and the bytes add up to the file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'toil-stream-'));
    dirs.push(cwd);
    const bytes = new Uint8Array(10_000).map((_, i) => i % 251);
    writeFileSync(join(cwd, 'big.bin'), bytes);
    const parts = await collect(nodeFiles({ cwd, stdin: true }).readStream('big.bin', { chunkSize: 4096 }));
    expect(parts.map((p) => p.length)).toEqual([4096, 4096, 1808]);
    expect(Buffer.concat(parts).equals(Buffer.from(bytes))).toBe(true);
  });

  it('checks the bounds when called, before any chunk: outside the workspace, toil\'s own files and stdin over MCP', () => {
    const root = mkdtempSync(join(tmpdir(), 'toil-stream-'));
    dirs.push(root);
    mkdirSync(join(root, 'ws'));
    writeFileSync(join(root, 'outside.txt'), 'x');
    writeFileSync(join(root, 'ws', 'config.json'), '{}');
    const files = nodeFiles({ cwd: join(root, 'ws'), stdin: false, workspace: { dir: join(root, 'ws'), source: 'flag' }, protect: [join(root, 'ws', 'config.json')] });
    expect(() => files.readStream('../outside.txt')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('outside the workspace') }));
    expect(() => files.readStream('config.json')).toThrow(expect.objectContaining({ message: expect.stringContaining("toil's own configuration") }));
    expect(() => files.readStream('-')).toThrow(expect.objectContaining({ message: expect.stringContaining('not available over MCP') }));
  });

  it('turns a file that vanishes before it is read into INVALID_INPUT from the loop', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'toil-stream-'));
    dirs.push(cwd);
    const stream = nodeFiles({ cwd, stdin: true }).readStream('missing.txt');
    await expect(collect(stream)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('does not exist') });
  });

  it('memoryFiles streams the same way, so tests can choose chunk boundaries', async () => {
    const parts = await collect(memoryFiles({ 'a.txt': 'abcdefg' }).readStream('a.txt', { chunkSize: 3 }));
    expect(parts.map((p) => new TextDecoder().decode(p))).toEqual(['abc', 'def', 'g']);
  });
});
