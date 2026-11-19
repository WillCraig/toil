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
          { name: 'Sam', ids: { jira: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', github: 7 }, colour: 'x' },
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
      ['warning', 'people[2].colour'],
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

describe("a toil project's classify key (#566)", () => {
  const read = (classify: unknown) => validateToilProject({ name: 'payments', classify }, areas);
  const errors = (classify: unknown) => read(classify).problems.filter((p) => p.level === 'error');
  const warnings = (classify: unknown) => read(classify).problems.filter((p) => p.level === 'warning');
  const full = {
    scheme: 'ktlo-feature',
    targets: {
      jira: { field: 'workCategory' },
      ado: { field: 'workCategory', values: { ktlo: 'KTLO (keep the lights on)' } },
      github: { project: 'imagile/7', field: 'Category', values: { ktlo: 'Keep the lights on', feature: 'Feature' } },
    },
  };

  it('reads a scheme and a target for each tracker', () => {
    const out = read(full);
    expect(out.problems).toEqual([]);
    expect(out.toilProject?.classify).toEqual(full);
  });

  it('reads a scheme named by a path relative to the toil project, and a toil project with no classify key', () => {
    expect(read({ scheme: './ktlo-feature.json' }).toilProject?.classify).toEqual({ scheme: './ktlo-feature.json', targets: {} });
    expect(read({ scheme: '../shared/team.json' }).problems).toEqual([]);
    expect(validateToilProject({ name: 'payments' }, areas).toilProject).not.toHaveProperty('classify');
  });

  it('writes the key back as it was read, so reading it again changes nothing', () => {
    const first = read(full).toilProject!;
    const content = toilProjectContent(first);
    expect(content.classify).toEqual(full);
    expect(validateToilProject(content, areas).toilProject).toEqual(first);
    // An empty targets object is left out, not written as {}.
    expect(toilProjectContent(read({ scheme: 'balance' }).toilProject!).classify).toEqual({ scheme: 'balance' });
    expect(toilProjectContent(read({}).toilProject!).classify).toEqual({});
  });

  it('ignores an unknown key with TOIL_PROJECT_UNKNOWN_KEY, at classify, a target and a tracker', () => {
    const out = read({ scheme: 'balance', colour: 'blue', targets: { jira: { field: 'f', shade: 1 }, gitlab: { field: 'f' } } });
    expect(out.toilProject?.classify).toEqual({ scheme: 'balance', targets: { jira: { field: 'f' } } });
    expect(warnings({ scheme: 'balance', colour: 'blue', targets: { jira: { field: 'f', shade: 1 }, gitlab: { field: 'f' } } }).map((p) => [p.code, p.path])).toEqual([
      ['TOIL_PROJECT_UNKNOWN_KEY', 'classify.colour'],
      ['TOIL_PROJECT_UNKNOWN_KEY', 'classify.targets.jira.shade'],
      ['TOIL_PROJECT_UNKNOWN_KEY', 'classify.targets.gitlab'],
    ]);
    expect(warnings({ scheme: 'balance', colour: 'blue' })[0]!.message).toContain('It was ignored.');
  });

  it('refuses what a tracker section holds, saying a classify key never holds it', () => {
    for (const key of ['connection', 'host', 'fields', 'transitions', 'writes']) {
      const found = errors({ scheme: 'balance', [key]: key === 'writes' ? true : 'x' });
      expect(found.map((p) => p.path)).toEqual([`classify.${key}`]);
      expect(found[0]!.message).toContain(`"classify" never holds "${key}"`);
    }
  });

  it('refuses a classify that is not an object, and targets that are not', () => {
    expect(errors('balance')[0]).toMatchObject({ path: 'classify', code: 'TOIL_PROJECT_INVALID' });
    expect(errors([])[0]!.path).toBe('classify');
    expect(errors({ targets: [] })[0]!.path).toBe('classify.targets');
    expect(errors({ targets: { jira: 'workCategory' } })[0]!.path).toBe('classify.targets.jira');
  });

  it('holds scheme to a name or a relative .json path', () => {
    for (const scheme of ['Not A Name', 'a/b', 'x.txt', '/etc/team.json', String.raw`C:\x\team.json`, String.raw`\\host\share\team.json`, 7, '']) {
      expect(errors({ scheme }).map((p) => p.path), String(scheme)).toEqual(['classify.scheme']);
    }
    expect(errors({ scheme: '/etc/team.json' })[0]!.message).toContain('never an absolute one');
  });

  it('takes project only under github, as <owner>/<number>', () => {
    expect(errors({ targets: { jira: { project: 'imagile/7' } } })[0]).toMatchObject({ path: 'classify.targets.jira.project' });
    expect(errors({ targets: { jira: { project: 'imagile/7' } } })[0]!.message).toContain('Only the github target takes "project"');
    for (const project of ['imagile', 'imagile/seven', 'imagile/0', '/7', 'a b/7', 'imagile/7/8']) {
      expect(errors({ targets: { github: { project } } }).map((p) => p.path), project).toEqual(['classify.targets.github.project']);
    }
  });

  it('holds values to category ids mapped to one-line texts', () => {
    expect(errors({ targets: { ado: { values: { 'Bad Id': 'x' } } } })[0]!.path).toBe('classify.targets.ado.values.Bad Id');
    expect(errors({ targets: { ado: { values: { ktlo: '' } } } })[0]!.path).toBe('classify.targets.ado.values.ktlo');
    expect(errors({ targets: { ado: { values: ['x'] } } })[0]!.path).toBe('classify.targets.ado.values');
  });

  it('checks every text for length, line breaks and a credential shape', () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    expect(errors({ targets: { jira: { field: 'x'.repeat(201) } } })[0]!.message).toContain('the most is 200');
    expect(errors({ targets: { jira: { field: 'a\nb' } } })[0]!.message).toContain('one line');
    expect(errors({ targets: { jira: { field: token } } })[0]!.message).toContain('shaped like a credential');
    expect(errors({ targets: { github: { values: { ktlo: token } } } })[0]!.path).toBe('classify.targets.github.values.ktlo');
    expect(errors({ scheme: token })[0]!.path).toBe('classify.scheme');
  });

  it('keeps a toil project that has an error in classify from loading', () => {
    expect(read({ writes: true }).toilProject).toBeUndefined();
  });
});

describe("a toil project's standards key (#657)", () => {
  const read = (standards: unknown) => validateToilProject({ name: 'payments', standards }, areas);
  const errors = (standards: unknown) => read(standards).problems.filter((p) => p.level === 'error');

  it('reads names and relative .json paths in order, and writes them back as read', () => {
    const out = read({ use: ['gherkin', './rules/team.json', 'bug-repro'] });
    expect(out.problems).toEqual([]);
    expect(out.toilProject?.standards).toEqual({ use: ['gherkin', './rules/team.json', 'bug-repro'] });
    expect(toilProjectContent(out.toilProject!).standards).toEqual({ use: ['gherkin', './rules/team.json', 'bug-repro'] });
    expect(validateToilProject({ name: 'payments' }, areas).toilProject).not.toHaveProperty('standards');
  });

  it('ignores an unknown key with TOIL_PROJECT_UNKNOWN_KEY, and refuses what a tracker section holds', () => {
    expect(read({ use: ['gherkin'], colour: 'blue' }).problems.map((p) => [p.code, p.path])).toEqual([['TOIL_PROJECT_UNKNOWN_KEY', 'standards.colour']]);
    for (const key of ['connection', 'host', 'fields', 'transitions', 'writes']) {
      const found = errors({ use: ['gherkin'], [key]: key === 'writes' ? true : 'x' });
      expect(found.map((p) => p.path)).toEqual([`standards.${key}`]);
      expect(found[0]!.message).toContain(`"standards" never holds "${key}"`);
    }
  });

  it('holds each standard to a name or a relative .json path, named once, at most 20', () => {
    for (const ref of ['Not A Name', 'a/b', 'x.txt', '/etc/team.json', String.raw`C:\x\team.json`, String.raw`\\host\share\team.json`, 7, '', 'one\ntwo']) {
      expect(errors({ use: [ref] }).map((p) => p.path), String(ref)).toEqual(['standards.use[0]']);
    }
    expect(errors({ use: ['/etc/team.json'] })[0]!.message).toContain('never an absolute one');
    expect(errors({ use: ['gherkin', 'gherkin'] })[0]).toMatchObject({ path: 'standards.use[1]', message: expect.stringContaining('listed twice') });
    expect(errors({ use: Array.from({ length: 21 }, (_, i) => `s${i}`) })[0]).toMatchObject({ path: 'standards.use', message: expect.stringContaining('the most is 20') });
    expect(errors({ use: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789.json'] })[0]!.message).toContain('shaped like a credential');
  });

  it('refuses standards that are not an object, and use that is not a list', () => {
    expect(errors(['gherkin'])[0]).toMatchObject({ path: 'standards', code: 'TOIL_PROJECT_INVALID' });
    expect(errors({ use: 'gherkin' })[0]!.path).toBe('standards.use');
  });
});

describe("a toil project's dimensions key and a person's team (#567)", () => {
  const LF = String.fromCharCode(10);
  const read = (dimensions: unknown) => validateToilProject({ name: 'payments', dimensions }, areas);
  const errors = (dimensions: unknown) => read(dimensions).problems.filter((p) => p.level === 'error');
  const full = { customer: { jira: 'customfield_10500', openshift: 'Custom.Customer' }, 'product-line': { jira: 'Product line' } };

  it('reads each dimension with its field per area, and writes it back as it read it', () => {
    const out = read(full);
    expect(out.problems).toEqual([]);
    expect(out.toilProject?.dimensions).toEqual(full);
    expect(toilProjectContent(out.toilProject!).dimensions).toEqual(full);
    expect(validateToilProject({ name: 'payments' }, areas).toilProject).not.toHaveProperty('dimensions');
    expect(toilProjectContent(validateToilProject({ name: 'payments' }, areas).toilProject!)).not.toHaveProperty('dimensions');
    // The key is a dimension register, never an area's section.
    expect(out.toilProject?.sections).not.toHaveProperty('dimensions');
  });

  it('refuses a dimension named for what a section holds, saying so by key path', () => {
    for (const key of ['fields', 'connection', 'host', 'transitions', 'writes']) {
      const found = errors({ [key]: { jira: 'f' } });
      expect(found.map((p) => p.path), key).toEqual([`dimensions.${key}`]);
      expect(found[0]!.message).toContain(`"dimensions" never holds a key named "${key}"`);
    }
  });

  it('refuses a bad name, a bad shape, an empty or credential-shaped field, and keeps the file from loading', () => {
    expect(errors({ Customer: { jira: 'f' } }).map((p) => p.path)).toEqual(['dimensions.Customer']);
    expect(errors({ 'a--b': { jira: 'f' } }).map((p) => p.path)).toEqual(['dimensions.a--b']);
    expect(errors({ customer: 'customfield_1' }).map((p) => p.path)).toEqual(['dimensions.customer']);
    expect(errors({ customer: { jira: '' } }).map((p) => p.path)).toEqual(['dimensions.customer.jira']);
    expect(errors({ customer: { jira: 7 } }).map((p) => p.path)).toEqual(['dimensions.customer.jira']);
    expect(errors({ customer: { jira: `a${LF}b` } }).map((p) => p.path)).toEqual(['dimensions.customer.jira']);
    const token = errors({ customer: { jira: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } });
    expect(token.map((p) => p.path)).toEqual(['dimensions.customer.jira']);
    expect(JSON.stringify(token)).not.toContain('ghp_');
    expect(errors([]).map((p) => p.path)).toEqual(['dimensions']);
    expect(read({ customer: 'x' }).toilProject).toBeUndefined();
  });

  it("keeps a field for an area this toil hasn't got, with a warning", () => {
    const out = read({ customer: { gitlab: 'Customer' } });
    expect(out.toilProject?.dimensions).toEqual({ customer: { gitlab: 'Customer' } });
    expect(out.problems.map((p) => [p.level, p.code, p.path])).toEqual([['warning', 'TOIL_PROJECT_UNKNOWN_SECTION', 'dimensions.customer.gitlab']]);
  });

  it("reads a person's team, trims it, and refuses one that isn't a short line of text or is a credential", () => {
    const people = (team: unknown) => validateToilProject({ name: 'payments', people: [{ name: 'Pat Example', team, ids: {} }] }, areas);
    expect(people(' Checkout ').toilProject?.people).toEqual([{ name: 'Pat Example', team: 'Checkout', ids: {} }]);
    expect(toilProjectContent(people('Checkout').toilProject!).people).toEqual([{ name: 'Pat Example', team: 'Checkout', ids: {} }]);
    expect(validateToilProject({ name: 'payments', people: [{ name: 'Pat Example', ids: {} }] }, areas).toilProject?.people[0]).not.toHaveProperty('team');
    for (const bad of ['', '   ', 7, 'x'.repeat(101), `a${LF}b`, 'ghp_abcdefghijklmnopqrstuvwxyz0123456789']) {
      const problems = people(bad).problems.filter((p) => p.level === 'error');
      expect(problems.map((p) => p.path), String(bad)).toEqual(['people[0].team']);
    }
    // A team is a known person key now: no unknown-key warning.
    expect(people('Checkout').problems).toEqual([]);
  });
});

describe("a toil project's views key (#567)", () => {
  const read = (views: unknown) => validateToilProject({ name: 'payments', views }, areas);
  const view = { measure: 'items', split: 'release', share: true, top: 3, title: 'Releases' };

  it('reads each view, and writes it back as it read it', () => {
    const out = read({ 'release-mix': view });
    expect(out.problems).toEqual([]);
    expect(out.toilProject?.views).toEqual({ 'release-mix': view });
    expect(toilProjectContent(out.toilProject!).views).toEqual({ 'release-mix': view });
    expect(out.toilProject?.sections).not.toHaveProperty('views');
    expect(validateToilProject({ name: 'payments' }, areas).toilProject).not.toHaveProperty('views');
    expect(toilProjectContent(validateToilProject({ name: 'payments' }, areas).toilProject!)).not.toHaveProperty('views');
  });

  it('refuses a view named for what a section holds, saying so by key path, and keeps the file from loading', () => {
    for (const key of ['fields', 'connection', 'host', 'transitions', 'writes']) {
      const found = read({ [key]: view }).problems.filter((p) => p.level === 'error');
      expect(found.map((p) => p.path), key).toEqual([`views.${key}`]);
      expect(found[0]!.message).toContain(`"views" never holds a key named "${key}"`);
    }
    expect(read({ writes: view }).toilProject).toBeUndefined();
    expect(read([]).problems.map((p) => [p.level, p.path])).toEqual([['error', 'views']]);
  });

  it('refuses a bad view or name by key path rather than dropping it, so no rewrite loses one', () => {
    const out = read({ good: view, bad: { measure: 'nope' }, 'Bad-Name': view });
    expect(out.toilProject).toBeUndefined();
    expect(out.problems.map((p) => [p.level, p.path])).toEqual([['error', 'views.bad'], ['error', 'views.Bad-Name']]);
    expect(out.problems[0]!.message).toContain('views.bad.measure');
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`v${i}`, view]));
    expect(read(many).problems.map((p) => [p.level, p.path])).toEqual([['error', 'views']]);
  });
});
