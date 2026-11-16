// A test, never shipped: it builds a scratch repository with the real git to check the parsers against it.
// eslint-disable-next-line no-restricted-imports
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { execute } from '../../core/run.js';
import { ToilError } from '../../core/errors.js';
import { createGitRunner, findGit, gitArgv, type GitCall, type GitResult, type GitRunner } from '../../core/git.js';
import type { GitContext } from '../../core/git-repo.js';
import type { AnyCommand } from '../../core/command.js';
import { testContext } from '../../../test/harness/context.js';
import { BRANCHES, DIFF, LOG, NUMSTAT, STATUS } from '../../../test/fixtures/git.fixture.js';
import { commands } from './index.js';
import { parseBranches } from './branch.js';
import { parseDiff, rootRelativePathspec } from './diff.js';
import { normalizeGitDate, parseReport, reportRange } from './report.js';
import { parseStatus } from './status.js';

/**
 * The git area against a fake git that records every call, pinning the
 * behaviour the contract specifies, item by item from #74, then once against the real
 * binary. Two witnesses, as the procedure requires.
 */
const cmd = (name: string) => commands.find((c) => c.path.join(' ') === `git ${name}`)! as AnyCommand;
const REPO: GitContext = { root: '/work', branch: 'feature/retries', remotes: [] };

/** A git that records each call and answers from `answer`. */
function fakeGit(answer: (call: GitCall) => GitResult | Promise<GitResult>): GitRunner & { calls: GitCall[] } {
  const calls: GitCall[] = [];
  // gitArgv first, as the real runner does, so a call core would refuse is refused here too.
  return { calls, run: async (call) => (gitArgv(call), calls.push(call), answer(call)) };
}
const ok = (stdout: string): GitResult => ({ exitCode: 0, stdout, stderr: '' });
const failed = (stderr: string): GitResult => ({ exitCode: 128, stdout: '', stderr });

async function run(name: string, input: Record<string, unknown>, git: GitRunner, options: { repo?: GitContext | null } = {}) {
  const repo = options.repo === null ? undefined : (options.repo ?? REPO);
  const t = testContext({ git, ...(repo ? { repo } : {}) });
  return { ...t, envelope: await execute(cmd(name), input, t.context) };
}

const notFound = () => {
  throw new ToilError('GIT_NOT_FOUND', "git isn't on PATH, and toil git diff needs it.", { fix: 'Install git.' });
};

describe('every git command', () => {
  it('needs no connection or config, and reads only', () => {
    expect(commands.map((c) => c.path.join(' '))).toEqual(['git status', 'git diff', 'git log', 'git branch', 'git report']);
    for (const c of commands) {
      expect(c.kind).toBe('area-local');
      expect(c.writes).toBe(false);
    }
  });

  it.each(['status', 'diff', 'log', 'branch', 'report'])('%s outside a repository is "Not a git repository", once git is known to be there', async (name) => {
    const git = fakeGit(() => ok('git version 2.49.0'));
    const { envelope } = await run(name, {}, git, { repo: null });
    expect(envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'Not a git repository', fix: 'Run it inside a git clone, or point --workspace at one.' } });
    expect(git.calls).toEqual([{ subcommand: 'version' }]);
  });

  it('outside a repository with no git, is GIT_NOT_FOUND: no git outranks no repository', async () => {
    const { envelope } = await run('status', {}, fakeGit(notFound), { repo: null });
    expect(envelope).toMatchObject({ ok: false, error: { code: 'GIT_NOT_FOUND' } });
  });

  it.each(['status', 'diff', 'log', 'branch', 'report'])('%s with no git on PATH is GIT_NOT_FOUND, never an empty result', async (name) => {
    const { envelope } = await run(name, {}, fakeGit(notFound));
    expect(envelope).toMatchObject({ ok: false, error: { code: 'GIT_NOT_FOUND' } });
  });
});

describe('git status', () => {
  it('runs git status --porcelain and splits it into staged, unstaged and untracked', async () => {
    const git = fakeGit(() => ok(STATUS));
    const { envelope } = await run('status', {}, git);
    expect(git.calls).toEqual([{ subcommand: 'status', options: ['--porcelain'] }]);
    // The first line lost its leading space to the trim, so src/retry.ts reads as staged rc/retry.ts (#74 item 1).
    expect(envelope.data).toEqual({ staged: ['rc/retry.ts', 'README.md', 'src/client.ts'], unstaged: ['src/client.ts'], untracked: ['notes.txt'] });
  });

  it('pins #74 item 1: trimming the output moves an unstaged-only first file to staged and cuts its first character', () => {
    expect(parseStatus(' M .claude/launch.json\n M b.txt'.trim())).toEqual({ staged: ['claude/launch.json'], unstaged: ['b.txt'], untracked: [] });
  });

  it('pins #74 item 2: renames stay "old -> new" and quoted paths keep their quotes', () => {
    expect(parseStatus('R  a.txt -> b c.txt\n?? "caf\\303\\251.txt"')).toEqual({ staged: ['a.txt -> b c.txt'], unstaged: [], untracked: ['"caf\\303\\251.txt"'] });
  });

  it("fails with git's own message when git does, uncaught, as specified", async () => {
    const { envelope } = await run('status', {}, fakeGit(() => failed('fatal: not a git repository (or any of the parent directories): .git\n')));
    expect(envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'Command failed: git status --porcelain\nfatal: not a git repository (or any of the parent directories): .git' } });
  });

  it("fails past execSync's 1 MB, as specified (execSync's ENOBUFS)", async () => {
    const { envelope } = await run('status', {}, fakeGit(() => ok(`?? ${'x'.repeat(1024 * 1024)}`)));
    expect(envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('printed more than 1 MB') } });
  });
});

describe('git diff', () => {
  it('parses files and hunks, dropping headers and "\\ No newline", and marks binaries', async () => {
    const git = fakeGit(() => ok(DIFF));
    const { envelope } = await run('diff', {}, git);
    expect(git.calls).toEqual([{ subcommand: 'diff', options: [] }]);
    expect(envelope.data).toEqual({
      files: [
        {
          path: 'src/retry.ts',
          binary: false,
          truncated: false,
          hunks: [{ oldStart: 1, oldCount: 3, newStart: 1, newCount: 4, lines: [' export const MAX_RETRIES = 3;', '-export const BACKOFF_MS = 100;', '+export const BACKOFF_MS = 250;', '+export const JITTER = true;', ' export default MAX_RETRIES;'] }],
        },
        { path: 'logo.png', binary: true, truncated: false, hunks: [] },
      ],
      truncated: false,
    });
  });

  it('passes --staged and the file as one pathspec after --, with no shell', async () => {
    const git = fakeGit(() => ok(''));
    const { envelope } = await run('diff', { staged: true, path: 'my file.txt' }, git);
    expect(git.calls).toEqual([{ subcommand: 'diff', options: ['--staged'], paths: ['my file.txt'] }]);
    expect(envelope.data).toEqual({ files: [], truncated: false });
  });

  it('keeps --file relative to the repository root when the workspace is a folder below it', () => {
    expect(rootRelativePathspec('src/a.ts', '/work', '/work')).toBe('src/a.ts');
    expect(rootRelativePathspec('src/a.ts', '/work', '/work/')).toBe('src/a.ts');
    // Case folds only on Windows, where C:/Work and C:/work are the same folder.
    expect(rootRelativePathspec('src/a.ts', 'C:/Work', 'C:/work/')).toBe(process.platform === 'win32' ? 'src/a.ts' : ':(top)src/a.ts');
    expect(rootRelativePathspec('src/a.ts', '/work', '/work/packages/api')).toBe(':(top)src/a.ts');
    expect(rootRelativePathspec('/work/src/a.ts', '/work', '/work/packages')).toBe('/work/src/a.ts');
  });

  it('counts default to 1 and an unreadable hunk header is all zeros', () => {
    const out = parseDiff('diff --git a/x b/x\n@@ -3 +4 @@\n+y\n@@ bogus @@\n-z');
    expect(out.files[0]!.hunks.map(({ lines: _, ...h }) => h)).toEqual([
      { oldStart: 3, oldCount: 1, newStart: 4, newCount: 1 },
      { oldStart: 0, oldCount: 0, newStart: 0, newCount: 0 },
    ]);
  });

  it('stops after 5,000 lines and marks the diff and the open file truncated', () => {
    const raw = ['diff --git a/big b/big', '@@ -1,6000 +1,6000 @@', ...Array.from({ length: 6000 }, (_, i) => `+${i}`)].join('\n');
    const out = parseDiff(raw);
    expect(out.truncated).toBe(true);
    expect(out.files[0]!.truncated).toBe(true);
    expect(out.files[0]!.hunks[0]!.lines).toHaveLength(4998);
  });

  it('pins #74 item 4: a diff past 1 MB is no files and truncated false', async () => {
    const { envelope } = await run('diff', {}, fakeGit(() => ok(`diff --git a/x b/x\n@@ -1 +1 @@\n+${'y'.repeat(1024 * 1024)}`)));
    expect(envelope).toMatchObject({ ok: true, data: { files: [], truncated: false } });
  });

  it('pins #74 item 5: quoted, noprefix and " b/" paths come out wrong', () => {
    expect(parseDiff('diff --git "a/my file" "b/my file"').files[0]!.path).toBe('diff --git "a/my file" "b/my file"');
    expect(parseDiff('diff --git x y').files[0]!.path).toBe('diff --git x y');
    expect(parseDiff('diff --git a/x b/y b/x b/y b/z').files[0]!.path).toBe('x b/y b/x b/y');
  });

  it("returns an empty diff when git fails, as specified (#74 item 3's swallow)", async () => {
    const { envelope } = await run('diff', { path: 'nope' }, fakeGit(() => failed('fatal: bad revision')));
    expect(envelope).toEqual(expect.objectContaining({ ok: true, data: { files: [], truncated: false } }));
  });
});

describe('git log', () => {
  const FORMAT = '--format=%H\x1F%an\x1F%aI\x1F%s';

  it('asks for 10 commits by default and splits each on the unit separator', async () => {
    const git = fakeGit(() => ok(LOG));
    const { envelope } = await run('log', {}, git);
    expect(git.calls).toEqual([{ subcommand: 'log', options: [FORMAT, '-n10'] }]);
    expect(envelope.data).toEqual([
      { hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', author: 'Ada Lovelace', date: '2026-09-29T10:15:00+02:00', message: 'Raise the retry backoff' },
      { hash: '0f9e8d7c6b5a49382716f5e4d3c2b1a098765432', author: 'Grace Hopper', date: '2026-09-21T23:30:00-04:00', message: 'Add jitter, with a comma, to retries' },
    ]);
  });

  it('passes --count with parseInt and --since as git takes it', async () => {
    const git = fakeGit(() => ok(''));
    await run('log', { count: '5x', since: '2 weeks ago' }, git);
    expect(git.calls[0]!.options).toEqual([FORMAT, '-n5', '--since=2 weeks ago']);
  });

  it.each(['0', 'abc', ''])('pins #74 item 6: --count %j passes no limit at all', async (count) => {
    const git = fakeGit(() => ok(''));
    await run('log', { count }, git);
    expect(git.calls[0]!.options).toEqual([FORMAT]);
  });

  it('returns [] when git fails or prints more than 1 MB', async () => {
    expect((await run('log', { since: 'whenever' }, fakeGit(() => failed('fatal: bad date')))).envelope).toMatchObject({ ok: true, data: [] });
    expect((await run('log', {}, fakeGit(() => ok('x'.repeat(1024 * 1024 + 1))))).envelope).toMatchObject({ ok: true, data: [] });
  });

  it('lets a cancel through rather than reading it as an empty history', async () => {
    const reason = new ToilError('CANCELLED', 'Cancelled.');
    const { envelope } = await run('log', {}, fakeGit(() => Promise.reject(reason)));
    expect(envelope).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  });
});

describe('git branch', () => {
  it('runs git branch -a and splits local from remote', async () => {
    const git = fakeGit(() => ok(BRANCHES));
    const { envelope } = await run('branch', {}, git);
    expect(git.calls).toEqual([{ subcommand: 'branch', options: ['-a'] }]);
    expect(envelope.data).toEqual({ current: 'feature/retries', local: ['feature/retries', 'main'], remote: ['origin/HEAD -> origin/main', 'origin/main'] });
  });

  it('pins #74 item 7: worktree markers and detached HEAD stay in the names', () => {
    expect(parseBranches('* (HEAD detached at abc1234)\n+ feature/x\n  main')).toEqual({ current: '(HEAD detached at abc1234)', local: ['(HEAD detached at abc1234)', '+ feature/x', 'main'], remote: [] });
  });

  it('fails when git does', async () => {
    const { envelope } = await run('branch', {}, fakeGit(() => failed('fatal: broken')));
    expect(envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'Command failed: git branch -a\nfatal: broken' } });
  });
});

describe('git report', () => {
  const FORMAT = '--format=__TOIL_COMMIT__%H\t%an\t%aI\t%s';

  it('reports the current branch from git log --numstat, by week and by author', async () => {
    const git = fakeGit(() => ok(NUMSTAT));
    const { envelope } = await run('report', {}, git);
    expect(git.calls).toEqual([{ subcommand: 'log', options: [FORMAT, '--numstat'] }]);
    const ada = { author: 'Ada Lovelace', commitCount: 1, insertions: 2, deletions: 1, netLines: 1, filesChanged: 2 };
    const grace = { author: 'Grace Hopper', commitCount: 1, insertions: 10, deletions: 0, netLines: 10, filesChanged: 1 };
    expect(envelope.data).toEqual({
      branch: 'feature/retries',
      since: null,
      until: null,
      commits: [
        { hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', author: 'Ada Lovelace', date: '2026-09-29T10:15:00+02:00', message: 'Raise the retry backoff', ...{ filesChanged: 2, insertions: 2, deletions: 1, netLines: 1 } },
        { hash: '0f9e8d7c6b5a49382716f5e4d3c2b1a098765432', author: 'Grace Hopper', date: '2026-09-21T23:30:00-04:00', message: 'Add jitter, with a comma, to retries', ...{ filesChanged: 1, insertions: 10, deletions: 0, netLines: 10 } },
      ],
      // Grace's Sunday-night commit is Monday in UTC, so it lands in the next week (#74 item 10, pinned).
      weeks: [
        { week: '2026-W39', weekStart: '2026-09-21', weekEnd: '2026-09-27', authors: [grace], summary: { commitCount: 1, totalInsertions: 10, totalDeletions: 0, totalNetLines: 10, totalFilesChanged: 1 } },
        { week: '2026-W40', weekStart: '2026-09-28', weekEnd: '2026-10-04', authors: [ada], summary: { commitCount: 1, totalInsertions: 2, totalDeletions: 1, totalNetLines: 1, totalFilesChanged: 2 } },
      ],
      byAuthor: [ada, grace],
      summary: { commitCount: 2, totalInsertions: 12, totalDeletions: 1, totalNetLines: 11, totalFilesChanged: 3 },
    });
  });

  it('pins #74 item 10: a commit at 23:30 on a Sunday in -04:00 is bucketed by its UTC day', () => {
    const report = parseReport(`__TOIL_COMMIT__h\ta\t2026-09-20T23:30:00-04:00\tm`, 'b', {});
    expect(report.weeks.map((w) => w.weekStart)).toEqual(['2026-09-21']);
  });

  it('sends dates as UTC midnight and the range after --end-of-options', async () => {
    const git = fakeGit(() => ok(''));
    await run('report', { branch: 'feature/retries', base: 'main', since: '2026-09-01', until: '2 days ago' }, git);
    expect(git.calls).toEqual([{ subcommand: 'log', options: [FORMAT, '--numstat', '--since=2026-09-01T00:00:00+00:00', '--until=2 days ago'], revisions: ['main..feature/retries'] }]);
  });

  it('builds base..branch, base..HEAD, branch, or nothing', () => {
    expect(reportRange({ base: 'main', branch: 'x' })).toEqual(['main..x']);
    expect(reportRange({ base: 'main' })).toEqual(['main..HEAD']);
    expect(reportRange({ branch: 'x' })).toEqual(['x']);
    expect(reportRange({})).toEqual([]);
  });

  it('pins #74 item 8: a plain --until is the start of that day, so git leaves the day out', () => {
    expect(normalizeGitDate('2026-09-30')).toBe('2026-09-30T00:00:00+00:00');
    expect(normalizeGitDate('2026-09-30T12:00:00Z')).toBe('2026-09-30T12:00:00Z');
  });

  it('filters absolute dates again by author date, and leaves relative ones to git', () => {
    const raw = ['__TOIL_COMMIT__1\ta\t2026-08-31T23:00:00+00:00\tm', '__TOIL_COMMIT__2\ta\t2026-09-01T00:00:00+00:00\tm', '__TOIL_COMMIT__3\ta\t2026-10-01T00:00:00+00:00\tm'].join('\n');
    expect(parseReport(raw, 'b', { since: '2026-09-01', until: '2026-09-30' }).commits.map((c) => c.hash)).toEqual(['2']);
    expect(parseReport(raw, 'b', { since: '2 weeks ago' }).commits).toHaveLength(3);
  });

  it('names the branch HEAD when the current one has no commits, and keeps --branch as given', async () => {
    expect((await run('report', {}, fakeGit(() => ok('')), { repo: { ...REPO, branch: 'unknown' } })).envelope.data).toMatchObject({ branch: 'HEAD', commits: [] });
    expect((await run('report', { branch: 'main' }, fakeGit(() => ok('')))).envelope.data).toMatchObject({ branch: 'main' });
  });

  it('pins #74 item 9: a git failure is an empty report', async () => {
    const { envelope } = await run('report', { branch: 'does-not-exist' }, fakeGit(() => failed("fatal: ambiguous argument 'does-not-exist'")));
    expect(envelope).toMatchObject({ ok: true, data: { branch: 'does-not-exist', commits: [], weeks: [], byAuthor: [], summary: { commitCount: 0 } } });
  });

  it('refuses a branch that would read as a git option, before running git', async () => {
    const git = fakeGit(() => ok(''));
    const { envelope } = await run('report', { branch: '--output=/tmp/x' }, git);
    expect(envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: '"--output=/tmp/x" isn\'t a revision.' } });
    expect(git.calls).toEqual([]);
  });

  it('writes --csv to the --out file, one row per week and author then TOTAL, and adds its path', async () => {
    const { envelope, files } = await run('report', { csv: true, out: 'report.csv' }, fakeGit(() => ok(NUMSTAT)));
    expect(envelope).toMatchObject({ ok: true, data: { file: '/work/report.csv', summary: { commitCount: 2 } } });
    expect(new TextDecoder().decode(files.written['/work/report.csv'])).toBe(
      [
        'week,week_start,author,commits,insertions,deletions,net_lines,files_changed',
        '2026-W39,2026-09-21,Grace Hopper,1,10,0,10,1',
        '2026-W40,2026-09-28,Ada Lovelace,1,2,1,1,2',
        'TOTAL,,,2,12,1,11,3',
        '',
      ].join('\n'),
    );
  });

  it('quotes an author with a comma or a quote in the CSV', async () => {
    const { files } = await run('report', { csv: true, out: 'r.csv' }, fakeGit(() => ok('__TOIL_COMMIT__h\tLovelace, "Ada"\t2026-09-29T10:00:00Z\tm')));
    expect(new TextDecoder().decode(files.written['/work/r.csv'])).toContain('2026-W40,2026-09-28,"Lovelace, ""Ada""",1,0,0,0,0');
  });

  it.each([
    [{ csv: true }, '--csv writes the CSV to a file, and no --out <file> was given.'],
    [{ out: 'r.csv' }, "--out names the CSV file, but --csv wasn't given."],
  ])('refuses %j before running git', async (input, message) => {
    const git = fakeGit(() => ok(''));
    expect((await run('report', input, git)).envelope).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message } });
    expect(git.calls).toEqual([]);
  });
});

// Tests that spawn the real git get 30 s: each runs git several times.
const REAL_GIT_TIMEOUT_MS = 30_000;
// Only to find git, as core's own tests do; the commands themselves never see env.
// eslint-disable-next-line no-restricted-properties
const realGit = findGit({ env: process.env }).found;

describe.skipIf(!realGit)('against the real git (skipped where git is not installed)', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'toil-git-area-')));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const work = join(root, 'work');
  mkdirSync(home);
  mkdirSync(join(work, 'src'), { recursive: true });
  const env = { PATH: dirname(realGit!), HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) =>
    execFileSync(realGit!, ['-c', 'user.name=Ada Lovelace', '-c', 'user.email=you@example.com', '-c', 'core.autocrlf=false', ...args], {
      cwd: work,
      env: { ...env, GIT_AUTHOR_DATE: '2026-09-29T10:15:00+02:00', GIT_COMMITTER_DATE: '2026-09-29T10:15:00+02:00' },
      encoding: 'utf8',
    });

  async function real(name: string, input: Record<string, unknown> = {}) {
    const t = testContext({ repo: { root: work.replace(/\\/g, '/'), branch: 'main', remotes: [] } });
    t.context.git = createGitRunner({ command: `git ${name}`, env, workspace: () => work, exclude: [work], home });
    return execute(cmd(name), input, t.context);
  }

  it('parses what git really prints for status, diff, log, branch and report', async () => {
    writeFileSync(join(home, '.gitconfig'), '');
    git('init', '-q', '-b', 'main');
    writeFileSync(join(work, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(work, 'src', 'my file.txt'), 'x\n');
    git('add', '.');
    git('commit', '-q', '-m', 'First, with a comma');
    writeFileSync(join(work, 'a.txt'), 'one\nTWO\n');
    writeFileSync(join(work, 'src', 'my file.txt'), 'y\n');
    git('add', 'src');
    writeFileSync(join(work, 'new.txt'), 'n\n');

    // " M a.txt" sorts first, so it's the line the trim cuts (#74 item 1).
    expect((await real('status')).data).toEqual({ staged: ['.txt', '"src/my file.txt"'], unstaged: [], untracked: ['new.txt'] });
    const diff = (await real('diff')).data as { files: Array<{ path: string; hunks: Array<{ lines: string[] }> }> };
    expect(diff.files.map((f) => f.path)).toEqual(['a.txt']);
    expect(diff.files[0]!.hunks[0]!.lines).toEqual([' one', '-two', '+TWO']);
    // One pathspec, space and all, relative to the root; the memory workspace isn't the root, so it goes as :(top).
    expect(((await real('diff', { staged: true, path: 'src/my file.txt' })).data as { files: unknown[] }).files).toHaveLength(1);
    expect((await real('log')).data).toEqual([{ hash: expect.stringMatching(/^[0-9a-f]{40}$/), author: 'Ada Lovelace', date: '2026-09-29T10:15:00+02:00', message: 'First, with a comma' }]);
    expect((await real('branch')).data).toEqual({ current: 'main', local: ['main'], remote: [] });
    expect((await real('report', { since: '2026-09-01' })).data).toMatchObject({ branch: 'main', summary: { commitCount: 1, totalInsertions: 3, totalFilesChanged: 2 }, weeks: [{ week: '2026-W40' }] });
    expect((await real('report', { branch: 'nope' })).data).toMatchObject({ branch: 'nope', commits: [] });
  }, REAL_GIT_TIMEOUT_MS);
});
