import { describe, expect, it } from 'vitest';
import { GITHUB_PR_GETS, GITHUB_PRS } from '../src/fixtures/delivery.ts';
import { showData } from '../src/fixtures/toil-projects.ts';
import { fixtureExecute, type Canned } from '../src/fixtures/execute.ts';
import { GITHUB_ISSUES } from '../src/fixtures/work.ts';
import { githubRepos, parseRemote } from '../src/github-repos.ts';
import { loadToilProject, PR_INCLUDE } from '../src/load.ts';

const remotes = (...urls: string[]) => urls.map((u, i) => ({ name: `r${i}`, remotes: [u] }));
const slugs = (toilProject: Record<string, unknown>, resolved?: Record<string, string>) => githubRepos(toilProject, resolved).map((r) => r.slug);

describe('which GitHub repositories a Toil project covers', () => {
  it('reads a plain owner and repo, once, however many places name it', () => {
    const toilProject = { github: { owner: 'imagile', repo: 'app' }, repos: remotes('git@github.com:Imagile/App.git') };
    expect(slugs(toilProject, { owner: 'imagile', repo: 'app' })).toEqual(['imagile/app']);
  });

  it('reads a per-repo map, with a plain owner shared by all of them', () => {
    expect(slugs({ github: { owner: 'imagile', repo: { app: 'app-repo', lib: 'lib-repo' } } })).toEqual(['imagile/app-repo', 'imagile/lib-repo']);
  });

  it('reads an owner given per repo too, and skips a name that has no owner', () => {
    expect(slugs({ github: { owner: { app: 'a-org' }, repo: { app: 'app-repo', lib: 'lib-repo' } } })).toEqual(['a-org/app-repo']);
  });

  it('adds the Toil project remotes on github.com when the section names no repository', () => {
    const toilProject = { github: { connection: 'github' }, repos: remotes('https://github.com/imagile/web.git', 'git@github.com:imagile/sdk.git') };
    expect(slugs(toilProject)).toEqual(['imagile/web', 'imagile/sdk']);
  });

  it('follows the host of the repository the section names, so a GitHub Enterprise host counts', () => {
    const toilProject = {
      github: { owner: 'imagile', repo: 'web' },
      repos: remotes('https://ghe.imagile.dev/imagile/web.git', 'https://ghe.imagile.dev/imagile/sdk.git', 'https://bitbucket.imagile.dev/imagile/other.git'),
    };
    expect(slugs(toilProject)).toEqual(['imagile/web', 'imagile/sdk']);
  });

  it('ignores remotes that are not GitHub-shaped or sit on another host', () => {
    const toilProject = { github: { connection: 'github' }, repos: remotes('ssh://git@bitbucket.imagile.dev:7999/pay/core.git', 'https://dev.azure.com/imagile/proj/_git/repo', '/local/path', 'https://gitlab.com/imagile/b.git') };
    expect(slugs(toilProject)).toEqual([]);
    expect(parseRemote('/local/path')).toBeNull();
    expect(parseRemote('https://github.com/imagile/b/c')).toBeNull();
  });

  it('puts the resolved repository first', () => {
    const toilProject = { github: { connection: 'github' }, repos: remotes('https://github.com/imagile/b.git') };
    expect(slugs(toilProject, { owner: 'imagile', repo: 'a' })).toEqual(['imagile/a', 'imagile/b']);
  });
});

/** A fixture's GitHub data moved to another repository, by renaming it in every URL and key. */
const moved = <T,>(data: T): T => JSON.parse(JSON.stringify(data).replaceAll('payments-web', 'payments-lib')) as T;
const same = <T,>(data: T): T => data;

describe('a Toil project with two GitHub repositories', () => {
  const web = { owner: 'imagile', repo: 'payments-web' };
  const lib = { owner: 'imagile', repo: 'payments-lib' };

  it('reads issues and pull requests from each, keeping their ids apart', async () => {
    const toilProject = { name: 'two-repos', description: 'Two repositories, one owner.', repos: [], github: { connection: 'github', owner: 'imagile', repo: { web: 'payments-web', lib: 'payments-lib' } } };
    const base = { toilProject: 'two-repos' };
    const canned: Canned[] = [{ command: 'projects show', input: base, data: showData(toilProject) }];
    for (const [scope, shape] of [[web, same], [lib, moved]] as const) {
      canned.push(
        { command: 'github issue list', input: { ...base, ...scope, state: 'all' }, data: shape(GITHUB_ISSUES) },
        { command: 'github pr list', input: { ...base, ...scope, state: 'all' }, data: shape(GITHUB_PRS) },
        ...Object.entries(GITHUB_PR_GETS).map(([number, data]) => ({ command: 'github pr get', input: { ...base, ...scope, number: Number(number), include: PR_INCLUDE }, data: shape(data) })),
      );
    }
    const fixture = fixtureExecute(canned);
    const data = await loadToilProject(fixture.execute, 'two-repos');

    expect(data.readTargets).toEqual([
      { area: 'github', label: 'imagile/payments-web', work: true, pullRequests: true },
      { area: 'github', label: 'imagile/payments-lib', work: true, pullRequests: true },
    ]);
    const repos = (ids: string[]) => new Set(ids.map((id) => id.replace(/#\d+$/, '')));
    expect(repos(data.items.map((i) => i.id))).toEqual(new Set(['github:imagile/payments-web', 'github:imagile/payments-lib']));
    expect(repos(data.pullRequests.map((c) => c.id))).toEqual(new Set(['github:imagile/payments-web', 'github:imagile/payments-lib']));
    expect(new Set(data.items.map((i) => i.id)).size).toBe(data.items.length);
    expect(new Set(data.pullRequests.map((c) => c.id)).size).toBe(data.pullRequests.length);
    // Every GitHub call named its repository outright.
    const github = fixture.calls.filter((c) => c.command.startsWith('github '));
    expect(github.length).toBeGreaterThan(0);
    expect(github.every((c) => c.input.owner === 'imagile' && typeof c.input.repo === 'string')).toBe(true);
  });

  it("says so when one repository's pull requests could not be read", async () => {
    const toilProject = { name: 'half', description: 'Half read.', repos: [], github: { connection: 'github', owner: 'imagile', repo: { web: 'payments-web', lib: 'payments-lib' } } };
    const base = { toilProject: 'half' };
    const fixture = fixtureExecute([
      { command: 'projects show', input: base, data: showData(toilProject) },
      { command: 'github issue list', input: { ...base, ...web, state: 'all' }, data: [] },
      { command: 'github issue list', input: { ...base, ...lib, state: 'all' }, data: [] },
      { command: 'github pr list', input: { ...base, ...web, state: 'all' }, data: [] },
    ]);
    const data = await loadToilProject(fixture.execute, 'half');
    expect(data.readTargets).toEqual([
      { area: 'github', label: 'imagile/payments-web', work: true, pullRequests: true },
      { area: 'github', label: 'imagile/payments-lib', work: true, pullRequests: false },
    ]);
    // The Pull requests view words it from readTargets; prNotes stay for the reads' own caveats.
    expect(data.prNotes).toEqual([]);
  });
});
