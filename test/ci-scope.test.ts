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
    for (const job of ['ui', 'integration']) {
      expect(ci.jobs[job]!.needs).toEqual(['changes']);
      expect(ci.jobs[job]!.if).toBe("needs.changes.outputs.full != 'false'");
    }
    expect(ci.jobs.gate!.needs).toBeUndefined();
  });

  it('CI ok accepts a skipped long job only when the scope check passed and said full=false', () => {
    const ok = ci.jobs['ci-ok']!;
    expect(ok.needs).toContain('changes');
    // The results reach each step through env, never `${{ }}` inside the script.
    const steps = ok.steps.map((s) => `${JSON.stringify(s.env ?? {})}\n${s.run ?? ''}`).join('\n');
    expect(steps).toContain('needs.changes.result');
    for (const job of ['ui', 'integration']) expect(steps).toContain(`needs.${job}.result`);
    expect(steps.match(/needs\.changes\.outputs\.full/g)?.length).toBeGreaterThanOrEqual(2);
    // The skip is accepted only on both conditions, in both long jobs' steps.
    expect(steps.split('[ "$RESULT" = "skipped" ] && [ "$FULL" = "false" ]').length - 1).toBe(2);
    expect(ok.steps.find((s) => s.name === 'The scope check passed')!.run).toContain('[ "$RESULT" != "success" ]');
  });
});
