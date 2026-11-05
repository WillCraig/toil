import { describe, expect, it } from 'vitest';
import { toilProjectContent, hasSecretUserinfo, normalizeRemote, samePath, stripUserinfo, validateToilProject } from './toil-project.js';

const areas = [
  { name: 'jira', context: ['project'] },
  { name: 'openshift', context: ['env', 'instance'] },
];

describe('remotes', () => {
  it('normalise so the SSH and HTTPS remotes of one repository compare equal', () => {
    const same = [
      'https://git.imagile.dev/pay/payments-api.git',
      'https://git.imagile.dev/pay/payments-api',
      'https://user:t0ken@GIT.imagile.dev:8443/pay/payments-api.git/',
      'ssh://git@git.imagile.dev:22/pay/payments-api.git',
      'git@git.imagile.dev:pay/payments-api.git',
      'git.imagile.dev:pay/payments-api',
    ];
    expect(new Set(same.map(normalizeRemote))).toEqual(new Set(['git.imagile.dev/pay/payments-api']));
    expect(normalizeRemote('https://git.imagile.dev/pay/other.git')).not.toBe(normalizeRemote(same[0]!));
  });

  it('keep a Windows path a path, not an scp-style host', () => {
    expect(normalizeRemote('C:\\Code\\repo.git')).toBe('C:/Code/repo');
    expect(normalizeRemote('C:/Code/repo/')).toBe('C:/Code/repo');
  });

  it('call http(s) userinfo and any password a credential, and a bare ssh login name not', () => {
    expect(hasSecretUserinfo('https://t0ken@git.imagile.dev/x.git')).toBe(true);
    expect(hasSecretUserinfo('ssh://git:pw@git.imagile.dev/x.git')).toBe(true);
    expect(hasSecretUserinfo('ssh://git@git.imagile.dev/x.git')).toBe(false);
    expect(hasSecretUserinfo('git@git.imagile.dev:x.git')).toBe(false);
    expect(stripUserinfo('https://bob:hunter2@git.imagile.dev/x.git')).toBe('https://git.imagile.dev/x.git');
    expect(stripUserinfo('git@git.imagile.dev:x.git')).toBe('git@git.imagile.dev:x.git');
  });
});

describe('samePath', () => {
  it('ignores case and slash direction on Windows only', () => {
    expect(samePath('C:\\Code\\Repo', 'c:/code/repo/', 'win32')).toBe(true);
    expect(samePath('/code/Repo', '/code/repo', 'linux')).toBe(false);
  });
});

describe('validateToilProject', () => {
  it('loads a valid toil project, keeping reference data and unknown sections, and strips credentials from remotes', () => {
    const { toilProject, problems } = validateToilProject(
      {
        name: 'payments',
        env: 'prod',
        repos: [{ name: 'api', path: 'C:/Code/api', remotes: ['https://bob:pw@git.imagile.dev/pay/api.git'] }],
        jira: { host: 'jira.imagile.dev', project: 'PAY', projects: ['PAY', 'PAY'], fields: { storyPoints: 'customfield_1', points: 'customfield_1' } },
        nonesuch: { anything: true },
        environments: { prod: { openshift: { connection: 'ocp-prod', namespace: 'payments-prod' } } },
      },
      areas,
    );
    expect(toilProject?.repos[0]?.remotes).toEqual(['https://git.imagile.dev/pay/api.git']);
    expect(toilProject?.sections.nonesuch).toEqual({ anything: true });
    expect(toilProject?.environments.prod?.openshift).toMatchObject({ namespace: 'payments-prod' });
    expect(problems.map((p) => [p.level, p.code, p.path])).toEqual([
      ['warning', 'TOIL_PROJECT_REMOTE_USERINFO', 'repos[0].remotes[0]'],
      ['warning', 'TOIL_PROJECT_DUPLICATE', 'jira.fields.points'],
      ['warning', 'TOIL_PROJECT_DUPLICATE', 'jira.projects[1]'],
      ['warning', 'TOIL_PROJECT_UNKNOWN_SECTION', 'nonesuch'],
    ]);
  });

  it("refuses what it can't use, by key path", () => {
    const { toilProject, problems } = validateToilProject(
      {
        name: 'Payments',
        env: 'nowhere',
        repos: [{ name: 'a' }, { path: 'x' }],
        jira: { connection: 'corp-jira', host: 'jira.imagile.dev', project: 7, fields: { 'story points': 'x' } },
        openshift: { host: 'https://api.ocp.imagile.dev' },
      },
      areas,
    );
    expect(toilProject).toBeUndefined();
    expect(problems.filter((p) => p.level === 'error').map((p) => p.path)).toEqual(['name', 'repos[1]', 'jira', 'jira.fields.story points', 'jira.project', 'openshift.host', 'env']);
  });

  it('reports the same repo name, path or remote twice', () => {
    const { problems } = validateToilProject(
      {
        name: 'p',
        repos: [
          { name: 'a', path: 'C:/x', remotes: ['git@git.imagile.dev:p/a.git'] },
          { name: 'a', path: 'C:/x', remotes: ['https://git.imagile.dev/p/a'] },
        ],
      },
      areas,
    );
    expect(problems.map((p) => p.path)).toEqual(['repos[1].name', 'repos[1].path', 'repos[1].remotes[0]']);
  });

  it('reads the people list and the work-in-progress limit, and shows them as written', () => {
    const raw = {
      name: 'payments',
      people: [
        { name: 'Pat Example', email: 'you@example.com', ids: { jira: 'pat', github: ' pat-ex ' } },
        { name: 'Claude', kind: 'agent', ids: {} },
      ],
      wipLimit: 3,
    };
    const { toilProject, problems } = validateToilProject(raw, [...areas, { name: 'github', context: ['owner', 'repo'] }]);
    expect(problems).toEqual([]);
    expect(toilProject?.people).toEqual([
      { name: 'Pat Example', email: 'you@example.com', ids: { jira: 'pat', github: 'pat-ex' } },
      { name: 'Claude', kind: 'agent', ids: {} },
    ]);
    expect(toilProject?.sections).toEqual({});
    expect(toilProjectContent(toilProject!)).toMatchObject({ people: toilProject!.people, wipLimit: 3 });
    expect(toilProjectContent(validateToilProject({ name: 'bare' }, areas).toilProject!)).not.toHaveProperty('people');
  });

  it("refuses a person it can't use, an identity on two people, one shaped like a token, and a limit that isn't a whole number", () => {
    const { toilProject, problems } = validateToilProject(
      {
        name: 'payments',
        people: [
          { name: 'Pat', kind: 'robot', email: 'not-an-email', ids: { jira: 'pat' } },
          { name: 'pat', ids: { jira: 'PAT', wiki: 'pat' } },
          { name: 'Sam', ids: { jira: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', github: 7 }, team: 'x' },
          { ids: {} },
        ],
        wipLimit: 2.5,
      },
      areas,
    );
    expect(toilProject).toBeUndefined();
    expect(problems.map((p) => [p.level, p.path])).toEqual([
      ['error', 'people[0].kind'],
      ['error', 'people[0].email'],
      ['error', 'people[1].name'],
      ['error', 'people[1].ids.jira'],
      ['warning', 'people[1].ids.wiki'],
      ['warning', 'people[2].team'],
      ['error', 'people[2].ids.jira'],
      ['error', 'people[2].ids.github'],
      ['error', 'people[3]'],
      ['error', 'wipLimit'],
    ]);
    // Where, never what: the token-shaped value isn't repeated.
    expect(JSON.stringify(problems)).not.toContain('ghp_');
    expect(validateToilProject({ name: 'p', people: { pat: {} } }, areas).problems.map((p) => p.path)).toEqual(['people']);
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const shaped = validateToilProject({ name: 'p', people: [{ name: token }, { name: 'Sam', email: `x@${token}` }] }, areas).problems;
    expect(shaped.map((p) => p.path)).toEqual(['people[0].name', 'people[1].email']);
    expect(JSON.stringify(shaped)).not.toContain('ghp_');
  });
});
