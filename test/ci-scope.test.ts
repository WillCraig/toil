import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { keptBy, needsFullRun } from '../scripts/ci-scope.mjs';

const root = join(import.meta.dirname, '..');

describe('which pull requests skip the long CI jobs', () => {
  it('skips them only when every changed path is docs or config', () => {
    expect(needsFullRun(['.github/dependabot.yml', 'docs/decisions/586-dependabot-limit.md'])).toBe(false);
    expect(needsFullRun(['CLAUDE.md', '.claude/skills/ship/SKILL.md', 'docs/briefs/x.md'])).toBe(false);
    expect(needsFullRun(['site/src/pages/index.astro', 'functions/feedback/src/index.ts', 'infra/main.bicep'])).toBe(false);
  });

  it('runs them for anything either job reads', () => {
    for (const path of [
      'src/core/execute.ts',
      'ui/src/views/Board.tsx',
      'skills/toil/core.md', // embedded in the bundle and read by Toil UI
      'docs/owi/schema.json', // Toil UI's tests import it
      'docs/work-insights-proposal.md', // Toil UI's chart test reads its theme colours
      'docs/bounds.md', // held to code by toil's gate, but other docs are read by tests and new ones appear
      'docs/decisions/nested/x.md',
      'docs/command-contract.json',
      'site/src/lib/skill-pages.mjs', // Toil UI's help test imports it
      'CHANGELOG.md', // Toil UI's build reads it
      'README.md', // in the tarball Toil UI's smoke installs
      'package.json',
      'package-lock.json',
      'scripts/ci-scope.mjs',
      'test/db/postgres.test.ts',
      '.github/workflows/ci.yml',
    ]) expect(needsFullRun(['docs/decisions/x.md', path]), path).toBe(true);
  });

  it('runs them when nothing was listed, and names what kept them on', () => {
    expect(needsFullRun([])).toBe(true);
    expect(keptBy(['docs/decisions/a.md', 'src/b.ts', 'ui/c.tsx'])).toEqual(['src/b.ts', 'ui/c.tsx']);
  });

  it('prints full=true from a missing list, and full=false from a docs-only one', () => {
    const run = (args: string[]) => spawnSync(process.execPath, [join(root, 'scripts', 'ci-scope.mjs'), ...args], { encoding: 'utf8' });
    expect(run([join(tmpdir(), 'no-such-ci-scope-list')]).stdout.trim()).toBe('full=true');
    const dir = mkdtempSync(join(tmpdir(), 'toil-ci-scope-'));
    try {
      const list = join(dir, 'changed');
      writeFileSync(list, ['docs/decisions/a.md', '.github/dependabot.yml', ''].join('\0'));
      expect(run([list]).stdout.trim()).toBe('full=false');
      writeFileSync(list, ['docs/decisions/a.md', 'ui/src/a.ts'].join('\0'));
      expect(run([list]).stdout.trim()).toBe('full=true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ci.yml wires the scope check fail-closed', () => {
  type Job = { needs?: string[]; if?: string; outputs?: Record<string, string>; steps: { name?: string; run?: string; env?: Record<string, string> }[] };
  const ci = load(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')) as { jobs: Record<string, Job> };

  it("runs main's copy of the script, and everything on a push", () => {
    const run = ci.jobs.changes!.steps.map((s) => s.run ?? '').join('\n');
    expect(run).toContain('git show "$BASE_SHA:scripts/ci-scope.mjs"');
    // Both sides of a rename, NUL-separated, against the merge base.
    expect(run).toContain('git diff --no-renames --name-only -z "$BASE_SHA...$HEAD_SHA"');
    // Only a PR against main may skip.
    expect(run).toContain('[ "$BASE_REF" != "main" ]');
    expect(run).not.toMatch(/node scripts\/ci-scope\.mjs/);
    expect(run).toContain('echo "full=true"');
    expect(run).not.toContain('${{');
  });

  it('skips the long jobs only on an explicit full=false', () => {
    for (const job of ['ui', 'ui-layout', 'integration']) {
      expect(ci.jobs[job]!.needs).toEqual(['changes']);
      expect(ci.jobs[job]!.if).toBe("needs.changes.outputs.full != 'false'");
    }
    expect(ci.jobs.gate!.needs).toBeUndefined();
  });

  it("splits Toil UI's smoke into shards that cover 1 to N, each told it is one of N (#640)", () => {
    const layout = ci.jobs['ui-layout'] as Job & { name: string; strategy: { 'fail-fast': boolean; matrix: { shard: number[] } } };
    const shards = layout.strategy.matrix.shard;
    expect(shards).toEqual(Array.from({ length: shards.length }, (_, i) => i + 1));
    expect(layout.strategy['fail-fast']).toBe(false);
    const run = layout.steps.map((s) => s.run ?? '').join('\n');
    // N comes from the matrix itself, in the command and the job's name, so it can't drift from the list.
    expect(run).toContain('npm run smoke -w ui -- --include-tests layout:${{ matrix.shard }}/${{ strategy.job-total }}');
    expect(layout.name).toBe('Toil UI layout (${{ matrix.shard }}/${{ strategy.job-total }})');
  });

  it('runs both gates on Windows, macOS and Node 26, Toil UI without the layout, and CI ok needs them (#605)', () => {
    const job = ci.jobs.platforms as Job & { 'runs-on': string; strategy: { 'fail-fast': boolean; matrix: { include: { os: string; node: string }[] } }; env: Record<string, string> };
    expect(job.needs).toEqual(['changes']);
    // toil's steps run on every PR, as its Linux gate does, so the job itself never skips.
    expect(job.if).toBeUndefined();
    expect(job['runs-on']).toBe('${{ matrix.os }}');
    expect(job.strategy['fail-fast']).toBe(false);
    const combos = job.strategy.matrix.include.map((c) => `${c.os} ${c.node}`).sort();
    expect(combos).toEqual(['macos-latest 24.22.1', 'macos-latest 26.12.1', 'ubuntu-latest 26.12.1', 'windows-latest 24.22.1', 'windows-latest 26.12.1']);
    const steps = (job.steps as { run?: string; if?: string }[]).filter((s) => s.run?.startsWith('npm '));
    expect(job.env.FULL).toBe('${{ needs.changes.outputs.full }}');
    // Toil UI's steps follow the scope check; toil's run on every PR, check:dist on the release PR.
    for (const s of steps) {
      if (s.run!.includes(' -w ui')) expect(s.if, s.run).toBe("env.FULL != 'false'");
      else if (s.run === 'npm run check:dist') expect(s.if).toBe("startsWith(github.head_ref, 'release-please--')");
      else expect(s.if, s.run).toBeUndefined();
    }
    for (const run of ['npm run typecheck', 'npm test', 'npm run build', 'npm run check:pure', 'npm run check:dist', 'npm run smoke', 'npm test -w ui', 'npm run smoke -w ui -- --include-tests none']) expect(steps.some((s) => s.run === run), run).toBe(true);
    const ok = ci.jobs['ci-ok']!;
    expect(ok.needs).toContain('platforms');
    expect(ok.steps.find((s) => s.env?.RESULT === '${{ needs.platforms.result }}')!.run).toContain('[ "$RESULT" != "success" ]');
  });

  it('gives every job a time limit, in CI and the daily run', () => {
    const platforms = load(readFileSync(join(root, '.github', 'workflows', 'platforms.yml'), 'utf8')) as { jobs: Record<string, Job> };
    for (const [name, job] of [...Object.entries(ci.jobs), ...Object.entries(platforms.jobs)]) expect((job as { 'timeout-minutes'?: number })['timeout-minutes'], name).toBeGreaterThan(0);
    // A job past its limit ends as cancelled, so the daily report counts that as a failure too.
    expect(platforms.jobs.report!.if).toContain("contains(needs.*.result, 'cancelled')");
  });

  it('holds the release PR while a platforms-failure issue is open, and a passing run on main closes it (#605)', () => {
    const job = ci.jobs['release-platforms'] as Job & { permissions: Record<string, string> };
    expect(job.if).toBe("startsWith(github.head_ref, 'release-please--')");
    expect(job.permissions).toEqual({ issues: 'read' });
    const run = job.steps.map((s) => s.run ?? '').join('\n');
    expect(run).toContain('gh issue list --label platforms-failure --state open');
    expect(run).toContain('exit 1');
    expect(run).not.toContain('${{');
    const ok = ci.jobs['ci-ok']!;
    expect(ok.needs).toContain('release-platforms');
    const step = ok.steps.find((s) => s.env?.RESULT === '${{ needs.release-platforms.result }}')!;
    expect(step.env!.HEAD_REF).toBe('${{ github.head_ref }}');
    expect(step.run).toContain('release-please--*) ;;');
    expect(step.run).toContain('[ "$RESULT" != "success" ]');
    const platforms = load(readFileSync(join(root, '.github', 'workflows', 'platforms.yml'), 'utf8')) as { on: Record<string, unknown>; jobs: Record<string, Job & { permissions?: Record<string, string> }> };
    expect(Object.keys(platforms.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    // The report counts cancelled as failed, so runs must queue, never cancel each other.
    expect((platforms as unknown as { concurrency: { 'cancel-in-progress': boolean } }).concurrency['cancel-in-progress']).toBe(false);
    const resolve = platforms.jobs.resolve!;
    expect(resolve.needs).toEqual(['gate', 'skill-install']);
    expect(resolve.if).toBe("success() && github.ref == 'refs/heads/main'");
    expect(resolve.permissions).toEqual({ issues: 'write' });
    expect(resolve.steps.map((s) => s.run ?? '').join('\n')).toContain('gh issue close');
  });

  it('CI ok accepts a skipped long job only when the scope check passed and said full=false', () => {
    const ok = ci.jobs['ci-ok']!;
    expect(ok.needs).toContain('changes');
    // The results reach each step through env, never `${{ }}` inside the script.
    const steps = ok.steps.map((s) => `${JSON.stringify(s.env ?? {})}\n${s.run ?? ''}`).join('\n');
    expect(steps).toContain('needs.changes.result');
    for (const job of ['ui', 'ui-layout', 'integration']) {
      expect(ok.needs).toContain(job);
      expect(steps).toContain(`needs.${job}.result`);
    }
    expect(steps.match(/needs\.changes\.outputs\.full/g)?.length).toBeGreaterThanOrEqual(2);
    // The skip is accepted only on both conditions, in each long job's step.
    expect(steps.split('[ "$RESULT" = "skipped" ] && [ "$FULL" = "false" ]').length - 1).toBe(3);
    expect(ok.steps.find((s) => s.name === 'The scope check passed')!.run).toContain('[ "$RESULT" != "success" ]');
  });
});
