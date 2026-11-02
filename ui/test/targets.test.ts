import { describe, expect, it } from 'vitest';
import { showData } from '../src/fixtures/dossiers.ts';
import { fixtureExecute } from '../src/fixtures/execute.ts';
import { loadDossier } from '../src/load.ts';
import { ADO_CI_RUNS } from '../src/fixtures/delivery.ts';
import { resolveTargets, targetsOf, valuesOf } from '../src/targets.ts';

describe('the targets of a dossier section', () => {
  it('is one target naming nothing for plain values', () => {
    expect(targetsOf({ project: 'PAY', repo: 'api' }, ['project', 'repo'])).toEqual([{ inputs: {}, label: '' }]);
  });

  it('is one target per repo name a map mentions, carrying the plain values too', () => {
    expect(targetsOf({ project: 'PAY', repo: { api: 'pay-api', ui: 'pay-ui' } }, ['project', 'repo'])).toEqual([
      { inputs: { project: 'PAY', repo: 'pay-api' }, label: 'PAY/pay-api' },
      { inputs: { project: 'PAY', repo: 'pay-ui' }, label: 'PAY/pay-ui' },
    ]);
  });

  it('drops a repo name that lacks one of the values, and de-duplicates repos in one project', () => {
    expect(targetsOf({ project: { api: 'PAY', ui: 'PAY', lib: 'LEDG' } }, ['project'])).toEqual([
      { inputs: { project: 'PAY' }, label: 'PAY' },
      { inputs: { project: 'LEDG' }, label: 'LEDG' },
    ]);
    expect(targetsOf({ project: { api: 'PAY' }, repo: { ui: 'x' } }, ['project', 'repo'])).toEqual([]);
  });

  it('lists the distinct values of a key, plain or per repo', () => {
    expect(valuesOf({ project: 'PAY' }, 'project')).toEqual(['PAY']);
    expect(valuesOf({ project: { a: 'PAY', b: 'LEDG', c: 'PAY' } }, 'project')).toEqual(['PAY', 'LEDG']);
    expect(valuesOf({}, 'project')).toEqual([]);
  });
});

describe('a pipeline that lives in one of several Azure DevOps projects', () => {
  const dossier = {
    name: 'pipes',
    description: 'Two projects, one pipeline.',
    repos: [{ name: 'api', remotes: [] }, { name: 'ui', remotes: [] }],
    ado: { connection: 'corp-ado', collection: 'DefaultCollection', project: { api: 'Payments', ui: 'Ledger' }, repo: { api: 'a', ui: 'b' }, builds: ['ledger-ci'], deployments: ['nowhere-deploy'] },
  };
  const show = { command: 'dossiers show', input: { dossier: 'pipes' }, data: showData(dossier) };
  const runs = (project: string, name: string) => ({ command: 'ado run list', input: { dossier: 'pipes', collection: 'DefaultCollection', project, name, top: 20 } });

  it('is kept from the project that has it, with no failed call on the panel for the others', async () => {
    const fixture = fixtureExecute([show, { ...runs('Ledger', 'ledger-ci'), data: ADO_CI_RUNS }]);
    const data = await loadDossier(fixture.execute, 'pipes');
    expect(data.calls.builds.map((c) => [c.input.project, c.ok])).toEqual([['Ledger', true]]);
  });

  it("records one failure, the last project's, when none has the pipeline", async () => {
    const fixture = fixtureExecute([show]);
    const data = await loadDossier(fixture.execute, 'pipes');
    expect(data.calls.deployments.map((c) => [c.input.project, c.ok])).toEqual([['Ledger', false]]);
  });
});

describe('a repo name a section leaves half-named', () => {
  it('is returned as skipped', () => {
    expect(resolveTargets({ project: { api: 'PAY' }, repo: { api: 'a', ui: 'b' } }, ['project', 'repo'])).toEqual({
      targets: [{ inputs: { project: 'PAY', repo: 'a' }, label: 'PAY/a' }],
      skipped: ['ui'],
    });
  });

  it("is said not to have had its pull requests read, and nothing Bitbucket doesn't give", async () => {
    const dossier = { name: 'half', description: 'A repo with no project.', repos: [], bitbucket: { connection: 'corp-bitbucket', project: { api: 'PAY' }, repo: { api: 'pay-api', ui: 'pay-ui' } } };
    const fixture = fixtureExecute([{ command: 'dossiers show', input: { dossier: 'half' }, data: showData(dossier) }]);
    const data = await loadDossier(fixture.execute, 'half');
    expect(data.readTargets).toContainEqual({ area: 'bitbucket', label: 'bitbucket ui', work: true, pullRequests: false });
  });

  it('says of an Azure DevOps name only what it left unread: pull requests by repo, work items by project', async () => {
    const dossier = { name: 'half-ado', description: 'A repo for one project only.', repos: [], ado: { connection: 'corp-ado', project: { api: 'P', web: 'Q' }, repo: { api: 'api' } } };
    const fixture = fixtureExecute([{ command: 'dossiers show', input: { dossier: 'half-ado' }, data: showData(dossier) }]);
    const data = await loadDossier(fixture.execute, 'half-ado');
    expect(data.readTargets).toContainEqual({ area: 'ado', label: 'ado web', work: true, pullRequests: false });
  });
});

describe('a dossier with per-repo Jira, Bitbucket and Azure DevOps values', () => {
  const dossier = {
    name: 'per-repo',
    description: 'Three trackers, two repos.',
    repos: [{ name: 'api', remotes: [] }, { name: 'ui', remotes: [] }],
    jira: { connection: 'corp-jira', project: { api: 'PAY', ui: 'LEDG' } },
    bitbucket: { connection: 'corp-bitbucket', project: 'PAY', repo: { api: 'pay-api', ui: 'pay-ui' } },
    ado: { connection: 'corp-ado', collection: 'DefaultCollection', project: { api: 'Payments', ui: 'Ledger' }, repo: { api: 'pay-api', ui: 'ledger-ui' } },
  };

  it('sends every read once per target, with its context inputs passed outright', async () => {
    const fixture = fixtureExecute([{ command: 'dossiers show', input: { dossier: 'per-repo' }, data: showData(dossier) }]);
    const data = await loadDossier(fixture.execute, 'per-repo');
    const inputs = (command: string) => fixture.calls.filter((c) => c.command === command).map((c) => c.input);

    expect(inputs('jira issue search').map((i) => String(i.jql).split(' AND ')[0])).toEqual(['project = PAY', 'project = LEDG']);
    expect(inputs('bitbucket pr list')).toEqual([
      { dossier: 'per-repo', project: 'PAY', repo: 'pay-api', state: 'ALL' },
      { dossier: 'per-repo', project: 'PAY', repo: 'pay-ui', state: 'ALL' },
    ]);
    const scope = (project: string) => ({ dossier: 'per-repo', collection: 'DefaultCollection', project });
    expect(inputs('ado work-item iterations')).toEqual([scope('Payments'), scope('Ledger')]);
    expect(inputs('ado work-item search').map((i) => [i.collection, i.project])).toEqual([['DefaultCollection', 'Payments'], ['DefaultCollection', 'Ledger']]);
    expect(inputs('ado pr list')).toEqual([
      { ...scope('Payments'), repo: 'pay-api', state: 'all' },
      { ...scope('Ledger'), repo: 'ledger-ui', state: 'all' },
    ]);
    // None of the sample's answers match, so every target is said not to have been read.
    expect(data.readTargets?.map((t) => [t.label, t.work, t.pullRequests])).toEqual([
      ['jira PAY', false, true],
      ['jira LEDG', false, true],
      ['ado DefaultCollection/Payments', false, true],
      ['ado DefaultCollection/Ledger', false, true],
      ['bitbucket PAY/pay-api', true, false],
      ['bitbucket PAY/pay-ui', true, false],
      ['ado DefaultCollection/Payments/pay-api', true, false],
      ['ado DefaultCollection/Ledger/ledger-ui', true, false],
    ]);
  });
});
