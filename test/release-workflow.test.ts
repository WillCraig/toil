import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { npmGrammar } from '../src/core/versions/npm.js';

/**
 * One release-please run, two packages (#206, Packaging and release): toil at
 * the root, and Toil UI in ui/. These hold the release config and the publish
 * jobs to that plan, so a later edit can't let a UI commit bump toil, publish
 * the UI before the toil it pins, or let the two publish steps drift apart.
 * Two forms, one stamp, and a test that the stamps match.
 */

const root = join(import.meta.dirname, '..');
const json = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8'));

interface Step {
  name?: string;
  run?: string;
  'working-directory'?: string;
  if?: string;
  env?: Record<string, string>;
}
interface Job {
  permissions?: Record<string, string>;
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  steps: Step[];
}
const workflow = load(readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')) as { jobs: Record<string, Job> };
const { jobs } = workflow;
const step = (job: string, name: string) => jobs[job]!.steps.find((s) => s.name === name);
/** Both jobs after publish-toil wait for npm to serve the toil they need the same way (#363). */
const WAIT = 'node scripts/wait-for-npm.mjs @imagile-dev/toil "$PIN"';

describe('release-please', () => {
  const config = json('release-please-config.json');
  const manifest = json('.release-please-manifest.json');
  const toil = config.packages['.'];
  const ui = config.packages.ui;

  it('has toil and Toil UI, joined by the node-workspace plugin', () => {
    expect(Object.keys(config.packages)).toEqual(['.', 'ui']);
    expect(config.plugins).toEqual([{ type: 'node-workspace' }]);
    expect(Object.keys(manifest).sort()).toEqual(['.', 'ui']);
  });

  it("keeps UI commits out of toil's release, and toil's tag and committed bundle as they were", () => {
    expect(toil['exclude-paths']).toEqual(['ui']);
    expect(toil['include-component-in-tag']).toBe(false);
    expect(toil['extra-files']).toEqual([{ type: 'generic', path: 'dist/toil-lib.js' }]);
    expect(ui['extra-files']).toBeUndefined();
  });

  it('tags the UI toil-ui-v<version>, with the same beta settings as toil (#478)', () => {
    expect(ui).toMatchObject({ 'release-type': 'node', 'package-name': '@imagile-dev/toil-ui', component: 'toil-ui', 'include-component-in-tag': true });
    expect(toil).toMatchObject({ versioning: 'prerelease', prerelease: true, 'prerelease-type': 'beta' });
    for (const key of ['bump-minor-pre-major', 'initial-version', 'versioning', 'prerelease', 'prerelease-type', 'release-as', 'changelog-path']) expect(ui[key], key).toEqual(toil[key]);
  });

  // release-as forces one version. Left in after that version has gone out, it
  // forces it again, and the next release PR asks to publish a version npm
  // already has. Three runs see the manifest at that version with the override
  // still in, and all are exempt: the release PR, which is what moves the
  // manifest up to it; publish-toil, which tests the release's tag before
  // publishing it; and the lockfile PR the release opens, which has to be able
  // to land while the override is still in (#299; other PRs pass check:lockfile
  // with a warning until it merges).
  // Every other run fails here, with the fix, until a PR removes the override (#478).
  const head = process.env.GITHUB_HEAD_REF ?? '';
  const releasing = head.startsWith('release-please--') || head.startsWith('imagile-bot/lockfile-toil-') || process.env.GITHUB_JOB === 'publish-toil';
  it.skipIf(releasing)('drops a release-as override once that version is released (skipped on the release and lockfile PRs and in publish-toil)', () => {
    const parse = (text: string) => {
      const parsed = npmGrammar.parse(text);
      if (!parsed.ok) throw new Error(`${text}: ${parsed.reason}`);
      return parsed.value;
    };
    for (const [path, pkg] of Object.entries(config.packages) as Array<[string, Record<string, unknown>]>) {
      const forced = pkg['release-as'];
      if (typeof forced !== 'string') continue;
      const released = manifest[path] as string;
      expect(
        npmGrammar.compare(parse(released), parse(forced)),
        `release-please-config.json forces "${path}" to ${forced}, and .release-please-manifest.json says ${released} is already out. Remove "release-as" from that package so the next release counts up from it.`,
      ).toBeLessThan(0);
    }
  });

  it("names the packages each folder's package.json does", () => {
    expect(json('package.json').name).toBe(toil['package-name']);
    expect(json('ui/package.json').name).toBe(ui['package-name']);
    expect(json('package.json').workspaces).toEqual(['ui']);
  });
});

describe('the publish jobs', () => {
  it('reads the UI outputs release-please prefixes with its path', () => {
    expect(jobs['release-please']!.outputs).toMatchObject({
      release_created: '${{ steps.rp.outputs.release_created }}',
      ui_release_created: "${{ steps.rp.outputs['ui--release_created'] }}",
      ui_tag_name: "${{ steps.rp.outputs['ui--tag_name'] }}",
      ui_version: "${{ steps.rp.outputs['ui--version'] }}",
    });
  });

  it("publishes the UI after toil, when toil had nothing to release, and never after toil's publish failed", () => {
    expect(jobs['publish-toil']!.needs).toBe('release-please');
    expect(jobs['publish-ui']!.needs).toEqual(['release-please', 'publish-toil']);
    const gate = jobs['publish-ui']!.if!.replace(/\s+/g, ' ');
    expect(gate).toContain('!cancelled()');
    expect(gate).toContain("needs.release-please.outputs.ui_release_created == 'true'");
    expect(gate).toContain("(needs.publish-toil.result == 'success' || needs.publish-toil.result == 'skipped')");
  });

  it('gates both on TOIL_RELEASES, through the release-please job', () => {
    expect(jobs['release-please']!.if).toBe("vars.TOIL_RELEASES == 'on'");
    expect(jobs['publish-ui']!.if).toContain("needs.release-please.result == 'success'");
  });

  it("runs toil's publish script for the UI, word for word but the package name", () => {
    const toil = step('publish-toil', 'Publish to npm')!;
    const ui = step('publish-ui', 'Publish to npm')!;
    expect(ui['working-directory']).toBe('ui');
    expect(ui.run!.replaceAll('@imagile-dev/toil-ui', '@imagile-dev/toil')).toBe(toil.run);
    expect(ui.run).toContain('--provenance');
  });

  it('checks the UI before it publishes: its tests, its build, check:package and the two-tarball smoke', () => {
    const runs = jobs['publish-ui']!.steps.map((s) => s.run ?? '');
    const at = (cmd: string) => runs.findIndex((r) => r.includes(cmd));
    const publish = runs.findIndex((r) => r.includes('npm publish'));
    for (const cmd of [WAIT, 'npm test -w ui', 'npm run build -w ui', 'npm run check:package -w ui', 'npm run smoke -w ui']) {
      expect(at(cmd), cmd).toBeGreaterThan(-1);
      expect(at(cmd), cmd).toBeLessThan(publish);
    }
  });
});

/**
 * The dist-tag a version publishes under, and whether `latest` follows it,
 * from the publish script itself, run in bash with npm stubbed out: alphas
 * went out under `alpha`, betas go out under `beta`, and either moves `latest`
 * while no stable release exists (#478).
 */
const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
describe.skipIf(!hasBash)('the dist-tag a release publishes under (skipped where bash is not on PATH)', () => {
  const script = step('publish-toil', 'Publish to npm')!.run!;
  /** Runs the script with `npm` a shell function that logs each call to stderr and answers `npm view` with `latest`; returns both streams. */
  const publish = (version: string, latest: string) => {
    const stub = `npm() { echo "npm $*" >&2; if [[ "$1" == view ]]; then echo "${latest}"; fi; }\n`;
    const run = spawnSync('bash', ['-c', stub + script], { encoding: 'utf8', env: { ...process.env, VERSION: version } });
    expect(run.status, run.stderr).toBe(0);
    return run.stdout + run.stderr;
  };

  it('publishes a beta under `beta`, and moves `latest` to it while the newest release is a prerelease', () => {
    const out = publish('0.1.0-beta.1', '0.1.0-alpha.5');
    expect(out).toContain('Publishing 0.1.0-beta.1 under dist-tag beta');
    expect(out).toContain('npm publish --access public --provenance --ignore-scripts --tag beta');
    expect(out).toContain('npm dist-tag add @imagile-dev/toil@0.1.0-beta.1 latest');
  });

  it('counts later betas up under the same tag', () => {
    const out = publish('0.1.0-beta.2', '0.1.0-beta.1');
    expect(out).toContain('--tag beta');
    expect(out).toContain('npm dist-tag add @imagile-dev/toil@0.1.0-beta.2 latest');
  });

  it('still publishes an alpha under `alpha`', () => {
    expect(publish('0.1.0-alpha.6', '0.1.0-alpha.5')).toContain('--tag alpha');
  });

  it('leaves `latest` alone once it is a stable release', () => {
    const out = publish('1.1.0-beta.1', '1.0.0');
    expect(out).toContain('--tag beta');
    expect(out).not.toContain('dist-tag add');
  });

  it('publishes a stable release under `latest` and moves nothing else', () => {
    const out = publish('1.0.0', '0.1.0-beta.3');
    expect(out).toContain('--tag latest');
    expect(out).not.toContain('npm view');
  });
});

describe('waiting for npm (#363)', () => {
  it('gives publish-ui and lockfile the same long wait, with no loop of their own left beside it', () => {
    for (const [job, name] of [['publish-ui', 'Check that npm serves the toil the UI pins'], ['lockfile', 'Wait for npm to serve the toil Toil UI pins']] as const) {
      const run = step(job, name)!.run!;
      expect(run, job).toContain(`if ! ${WAIT}; then`);
      expect(run, job).toContain('after the wait above');
      expect(run, job).not.toMatch(/npm view|sleep|2>\/dev\/null/);
    }
  });
});

describe('the lockfile after a release (#299)', () => {
  const job = jobs.lockfile!;
  const runs = job.steps.map((s) => s.run ?? '');
  const ci = load(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')) as { jobs: { ui: { steps: Array<Step & { if?: string }> } } };

  it('runs once toil is on npm, and never before', () => {
    expect(job.needs).toEqual(['release-please', 'publish-toil']);
    expect(job.if).toBe("needs.publish-toil.result == 'success'");
    const served = runs.findIndex((r) => r.includes(WAIT));
    expect(served).toBeGreaterThan(-1);
    expect(served).toBeLessThan(runs.findIndex((r) => r.includes('--package-lock-only')));
  });

  it("points the entry at the published toil, proves it with npm ci and check:lockfile, and opens a PR with package-lock.json alone", () => {
    const fix = runs.find((r) => r.includes('--package-lock-only'))!;
    expect(fix).toContain('npm install --package-lock-only --prefer-online --ignore-scripts --no-audit --no-fund "@imagile-dev/toil@$PIN" -w ui --save-exact');
    expect(fix.indexOf('npm ci --ignore-scripts')).toBeLessThan(fix.indexOf('npm run check:lockfile -w ui'));
    // check:lockfile passes with a warning on the very state this job fixes, so only its `ok` line proves the fix.
    expect(fix).toContain("grep -q '^check:lockfile ok'");
    const pr = step('lockfile', 'Open the lockfile PR')!.run!;
    // The release-as check above skips this branch by its prefix.
    expect(pr).toContain('BRANCH="imagile-bot/lockfile-toil-$PIN"');
    expect(pr).toContain('git add package-lock.json\n');
    expect(pr).not.toMatch(/git add (-A|\.|--all)/);
    expect(pr).toContain('gh pr create --base main');
    expect(pr).toContain('git commit -m "chore(deps):');
  });

  it("is held by CI's check:lockfile on every PR, the release PR included", () => {
    const check = ci.jobs.ui.steps.find((s) => s.run === 'npm run check:lockfile -w ui')!;
    expect(check.if).toBeUndefined();
    const platforms = load(readFileSync(join(root, '.github', 'workflows', 'platforms.yml'), 'utf8')) as { jobs: { gate: { steps: Step[] } } };
    expect(platforms.jobs.gate.steps.find((s) => s.run === 'npm run check:lockfile -w ui')!.if).toBeUndefined();
  });
});

describe('a release PR that merges but does not release (#536)', () => {
  const job = 'release-guard';
  const ESCAPE = "Escape tag-like text in the release PR's body";
  const FAIL = 'Fail when a merged release PR was not released';

  it('runs after release-please in a job of its own, which no publish waits on', () => {
    expect(jobs[job]!.needs).toBe('release-please');
    for (const other of Object.keys(jobs).filter((j) => j !== job)) {
      expect([jobs[other]!.needs ?? []].flat(), other).not.toContain(job);
    }
    // The guard's steps don't live in release-please, where failing them would skip a publish.
    expect(step('release-please', ESCAPE)).toBeUndefined();
    expect(step('release-please', FAIL)).toBeUndefined();
    expect(jobs['release-please']!.permissions).toEqual({ contents: 'read' });
  });

  it("escapes the release PR's body whenever release-please opened or updated one", () => {
    expect(jobs['release-please']!.outputs!.pr).toBe('${{ steps.rp.outputs.pr }}');
    const escape = step(job, ESCAPE)!;
    expect(escape.if).toBe('needs.release-please.outputs.pr');
    expect(escape.run).toContain('node scripts/release-pr-body.mjs');
    expect(escape.run).toContain('gh pr edit');
    // No checkout carries a remote for gh to read the repository from on every run.
    expect(escape.env!.GH_REPO).toBe('${{ github.repository }}');
  });

  it('fails when a merged release PR is still waiting for its release, on every run', () => {
    const fail = step(job, FAIL)!;
    expect(fail.if).toBe('${{ !cancelled() }}');
    expect(fail.env!.GH_REPO).toBe('${{ github.repository }}');
    expect(fail.run).toContain('autorelease: pending');
    expect(fail.run).toContain('exit "$failed"');
    // A release PR merged while this run was going is the next run's to release.
    expect(fail.run).toContain('compare/$merge...$SHA');
  });

  it('fails a run that released some of the packages its merged release PR listed', () => {
    // release-please marks the PR tagged once any one package is released, so the pending check can't see this.
    const check = step(job, 'Fail when a release left out a package its PR listed')!;
    expect(check.if).toContain("needs.release-please.outputs.release_created == 'true'");
    expect(check.if).toContain("needs.release-please.outputs.ui_release_created == 'true'");
    expect(check.env!.GH_REPO).toBe('${{ github.repository }}');
    expect(check.run).toContain('node scripts/release-pr-body.mjs --packages');
    expect(check.run).toContain('toil) released="$TOIL_RELEASED"');
    expect(check.run).toContain('toil-ui) released="$UI_RELEASED"');
    expect(check.run).toContain('exit "$failed"');
  });

  it('lists pull requests with a token that only reads, and shouts on Discord when it fails', () => {
    expect(jobs[job]!.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    expect(step(job, 'Notify Discord on failure')!.if).toBe('failure()');
  });
});
