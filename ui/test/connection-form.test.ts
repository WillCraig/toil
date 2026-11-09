import { describe, expect, it } from 'vitest';
import { areas as realAreas } from '../../src/registry.ts';
import { registry } from '../../src/api.ts';
import { afterChoice, emptyState, needOf, reportOf, selectedOption, submission, type FormArea, type FormField, type FormState } from '../../src/core/connection-form.ts';
import { checkSecret } from '../../src/core/secret-input.ts';

/**
 * The connection form's rules (#561), table-driven from each area's own
 * description: what each deployment asks, the address each composes, the
 * advice on what was typed, and that nothing the form says repeats a secret.
 * The rules are pure functions, so none of this needs a page.
 */

/** Assembled so the repo-hygiene tenant check sees a placeholder, not a host. */
const ATL = 'atlassian';

const area = (name: string) => registry.areas.find((a) => a.name === name) as unknown as FormArea;
const rules = (f: FormField) => ({ password: f.password, empty: 'skip' as const });
const choose = (a: FormArea, field: string, label: RegExp | string, state: FormState = emptyState('example')): FormState => {
  const f = a.connection.find((x) => x.name === field)!;
  const index = f.choices!.options.findIndex((o) => (typeof label === 'string' ? o.label === label : label.test(o.label)));
  return afterChoice(a, state, field, index).state;
};
const run = (a: FormArea, s: FormState, existing: string[] = []) => reportOf(a, s, existing, rules);
const withText = (s: FormState, text: Record<string, string>, secrets: Record<string, string> = {}): FormState => ({ ...s, text: { ...s.text, ...text }, secrets: { ...s.secrets, ...secrets } });

describe('the address each deployment composes', () => {
  const cases: Array<[string, string, string, string, string]> = [
    // area, deployment label, typed, expected address
    ['jira', 'Cloud', 'example-site', `https://example-site.${ATL}.net`, 'a bare site name'],
    ['jira', 'Cloud', `https://example-site.${ATL}.net/`, `https://example-site.${ATL}.net`, 'a pasted address, cleaned back to the name'],
    ['confluence', 'Cloud', 'example-site', `https://example-site.${ATL}.net`, 'a bare site name'],
    ['ado', 'Services (cloud)', 'example-org', 'https://dev.azure.com/example-org', 'an organization name'],
    ['bitbucket', 'Cloud', '', 'https://api.bitbucket.org/2.0', 'nothing: the root is fixed'],
    ['jira', 'Data Center', 'https://jira.imagile.dev/', 'https://jira.imagile.dev', 'a server address with a trailing slash'],
    ['confluence', 'Data Center', 'https://confluence.imagile.dev/rest/api', 'https://confluence.imagile.dev', 'an API path toil adds itself'],
    ['bitbucket', 'Data Center', 'https://bitbucket.imagile.dev', 'https://bitbucket.imagile.dev', 'a server address'],
    ['ado', 'Server', 'https://ado.imagile.dev/tfs', 'https://ado.imagile.dev/tfs', 'a server address, /tfs kept'],
  ];
  for (const [name, deployment, typed, expected, what] of cases) {
    it(`${name} ${deployment}: ${what}`, () => {
      const a = area(name);
      const s = withText(choose(a, 'deployment', deployment), { baseUrl: typed });
      const report = run(a, s);
      expect(report.settings.baseUrl).toBe(expected);
      expect(report.problems.baseUrl?.filter((p) => p.level === 'error') ?? []).toEqual([]);
    });
  }
});

describe('the required radio', () => {
  for (const name of ['jira', 'confluence', 'bitbucket', 'ado']) {
    it(`${name}: nothing else is asked, and Save is blocked, until Cloud or Data Center is chosen`, () => {
      const a = area(name);
      const report = run(a, emptyState('example'));
      expect(selectedOption(a, a.connection.find((f) => f.name === 'deployment')!, emptyState())).toBeNull();
      expect(report.blockers[0]!.reason).toMatch(/^Choose .* or .* first\.$/);
      expect(Object.entries(report.needs).filter(([k, n]) => k !== 'deployment' && n !== 'hidden')).toEqual([]);
      expect(report.settings).toEqual({});
    });
  }
  it('github has no required radio: GitHub.com is selected, and its address is fixed', () => {
    const a = area('github');
    const r = run(a, withText(emptyState('example'), {}, { token: 'ghp_0000000000000000000000000000000000AB' }));
    expect(r.settings.baseUrl).toBe('https://api.github.com');
    expect(r.blockers).toEqual([]);
  });
});

describe('what each choice requires, from the area’s own variants', () => {
  const email = (n: string, deployment: string) => needOf(area(n), area(n).connection.find((f) => f.name === 'email')!, choose(area(n), 'deployment', deployment));
  it('jira and confluence: email is required for Cloud and does not exist for Data Center', () => {
    for (const n of ['jira', 'confluence']) {
      expect(email(n, 'Cloud')).toBe('required');
      expect(email(n, 'Data Center')).toBe('hidden');
    }
  });
  it('the Cloud form says why, and blocks, until the email is there', () => {
    const a = area('jira');
    const s = withText(choose(a, 'deployment', 'Cloud'), { baseUrl: 'example-site' }, { apiToken: 'fake-token-abc12345' });
    const r = run(a, s);
    expect(r.blockers[0]).toEqual({ field: 'email', reason: 'Add your email: Cloud signs in with email and token.' });
    expect(r.problems.email![0]!.message).toBe('Needed for Cloud.');
    const done = run(a, withText(s, { email: 'you@example.com' }));
    expect(done.blockers).toEqual([]);
    expect(submission(a, done)).toEqual({ deployment: 'cloud', baseUrl: `https://example-site.${ATL}.net`, email: 'you@example.com' });
  });
  it('bitbucket: the token Data Center needs is required there and not asked for Cloud, where the Cloud ones are', () => {
    const a = area('bitbucket');
    const need = (n: string, d: string) => needOf(a, a.connection.find((f) => f.name === n)!, choose(a, 'deployment', d));
    expect(need('pat', 'Data Center')).toBe('required');
    expect(need('pat', 'Cloud')).toBe('hidden');
    for (const k of ['email', 'apiToken', 'accessToken', 'workspace']) {
      expect(need(k, 'Cloud')).toBe('optional');
      expect(need(k, 'Data Center')).toBe('hidden');
    }
    expect(need('project', 'Cloud')).toBe('hidden');
    expect(need('project', 'Data Center')).toBe('optional');
  });
  it('ado: the collection is Server’s and the team is Services’', () => {
    const a = area('ado');
    const need = (n: string, d: string) => needOf(a, a.connection.find((f) => f.name === n)!, choose(a, 'deployment', d));
    expect(need('collection', 'Server')).toBe('optional');
    expect(need('collection', 'Services (cloud)')).toBe('hidden');
    expect(need('team', 'Services (cloud)')).toBe('optional');
    expect(need('team', 'Server')).toBe('hidden');
  });
  it('a setting that stops applying is cleared with a note, and never submitted', () => {
    const a = area('jira');
    const cloud = withText(choose(a, 'deployment', 'Cloud'), { baseUrl: 'example-site', email: 'you@example.com' });
    const { state, notes } = afterChoice(a, cloud, 'deployment', a.connection.find((f) => f.name === 'deployment')!.choices!.options.findIndex((o) => o.label === 'Data Center'));
    expect(notes).toEqual(['email was cleared: it isn\'t needed for Data Center.']);
    expect(state.text.email).toBeUndefined();
    // Even a value put back by some other route is not in what is sent.
    const sneaky = withText(state, { baseUrl: 'https://jira.imagile.dev', email: 'you@example.com' });
    const sent = submission(a, run(a, sneaky));
    expect(sent).toEqual({ deployment: 'server', baseUrl: 'https://jira.imagile.dev' });
    expect(Object.keys(sent)).not.toContain('email');
  });
});

describe('advice on what was typed', () => {
  const jiraServer = (url: string) => withText(choose(area('jira'), 'deployment', 'Data Center'), { baseUrl: url }, { apiToken: 'fake-token-abc12345' });
  const problems = (s: string) => run(area('jira'), jiraServer(s)).problems.baseUrl ?? [];
  it('refuses what is not a web address, is unencrypted off the private network, or carries credentials or a query', () => {
    expect(problems('jira.imagile.dev')[0]!.level).toBe('error');
    expect(problems('http://jira.imagile.dev')[0]!.message).toMatch(/not encrypted/);
    expect(problems('http://jira.imagile.dev')[0]!.level).toBe('error');
    expect(problems('https://me:pw@jira.imagile.dev')[0]!.message).toMatch(/user name or password/);
    expect(problems('https://jira.imagile.dev/?a=1')[0]!.message).toMatch(/query/);
    expect(problems('ftp://jira.imagile.dev')[0]!.message).toMatch(/https:\/\//);
  });
  it('allows http for a test server on this machine or the private network, with a warning', () => {
    for (const url of ['http://localhost:8080', 'http://127.0.0.1:2990/jira', 'http://192.168.1.5', 'http://jira.test']) {
      const p = problems(url);
      expect(p.map((x) => x.level), url).toEqual(['warning']);
      expect(p[0]!.message).toMatch(/not encrypted/);
    }
  });
  it('says what it will drop: a trailing slash or an API path', () => {
    expect(problems('https://jira.imagile.dev/')[0]).toMatchObject({ level: 'note', message: 'The trailing / is dropped when this is saved.' });
    expect(problems('https://jira.imagile.dev/rest/api/2')[0]!.message).toMatch(/API path/);
  });
  it('flags a Cloud address under Data Center, and the reverse, with a Switch to the other choice', () => {
    const a = area('jira');
    const wrong = run(a, jiraServer(`https://example-site.${ATL}.net`)).problems.baseUrl!.find((p) => p.switchTo)!;
    expect(wrong.message).toBe('That looks like a Cloud address, and you chose Data Center.');
    expect(wrong.switchTo).toEqual({ field: 'deployment', index: 0 });
    const bb = area('bitbucket');
    const s = withText(choose(bb, 'deployment', 'Data Center'), { baseUrl: 'https://bitbucket.org' });
    expect(run(bb, s).problems.baseUrl!.some((p) => p.switchTo?.field === 'deployment')).toBe(true);
    const ado = area('ado');
    const a2 = withText(choose(ado, 'deployment', 'Server'), { baseUrl: 'https://dev.azure.com/example-org' });
    expect(run(ado, a2).problems.baseUrl!.some((p) => p.message.includes('Services (cloud)'))).toBe(true);
    // The right choice draws no complaint.
    expect(run(a, withText(choose(a, 'deployment', 'Cloud'), { baseUrl: 'example-site' })).problems.baseUrl ?? []).toEqual([]);
  });
  it('cleans a full address typed into the Cloud site box, and says so', () => {
    const a = area('jira');
    const r = run(a, withText(choose(a, 'deployment', 'Cloud'), { baseUrl: `https://example-site.${ATL}.net/` }));
    expect(r.problems.baseUrl![0]!.message).toBe('Type just the site name, like example-site. The rest was removed.');
  });
  it('checks an email field, and the connection name, including one that is taken', () => {
    const a = area('jira');
    const cloud = withText(choose(a, 'deployment', 'Cloud'), { baseUrl: 'example-site', email: 'not-an-email' }, { apiToken: 'fake-token-abc12345' });
    expect(run(a, cloud).problems.email![0]!.message).toBe("That doesn't look like an email address.");
    expect(run(a, { ...cloud, name: 'Corp Jira' }).problems.name![0]!.fix).toMatch(/lowercase letters, digits and single hyphens/);
    const taken = run(a, { ...cloud, name: 'jira' }, ['jira']);
    expect(taken.problems.name![0]!.message).toBe('A connection called jira already exists.');
    expect(taken.blockers.some((b) => b.field === 'name')).toBe(true);
  });
});

describe('GitHub', () => {
  const gh = area('github');
  const base = (token: string, kind: string | null, text: Record<string, string> = {}, pick = 0): FormState => ({ ...emptyState('example'), picks: { baseUrl: pick }, text, secrets: { token }, tokenKind: kind });
  const messages = (s: FormState) => (run(gh, s).problems.token ?? []).map((p) => p.message);
  it('tells the kinds of token apart by prefix, against the chosen type, and offers the switch', () => {
    expect(messages(base('ghp_0000000000000000000000000000000000AB', 'classic'))).toEqual([]);
    expect(messages(base('github_pat_0000000000000000_00000000000000000000000000000000000000000000000000000000000AB', 'fine-grained'))).toEqual([]);
    const m = run(gh, base('github_pat_000000000000000000000000000000000000AB', 'classic')).problems.token![0]!;
    expect(m.message).toBe('That starts with github_pat_, which is a fine-grained token, and you chose classic token.');
    expect(m.switchToken).toBe('fine-grained');
    expect(messages(base('gho_0000000000000000000000000000000000AB', 'classic'))[0]).toBe('That starts with gho_, which is an OAuth token.');
  });
  it('sees through a pasted env assignment, quotes and Bearer, asking before removing them', () => {
    for (const [paste, what] of [
      ['GITHUB_TOKEN=ghp_0000000000000000000000000000000000AB', '"GITHUB_TOKEN="'],
      ['export GITHUB_TOKEN="ghp_0000000000000000000000000000000000AB"', 'the quotes and "GITHUB_TOKEN="'],
      ['Bearer ghp_0000000000000000000000000000000000AB', '"bearer "'],
    ] as const) {
      const c = checkSecret(paste, { empty: 'skip' });
      expect(c.status).toBe('ok');
      if (c.status === 'ok') {
        expect(c.wrapper?.without).toBe('ghp_0000000000000000000000000000000000AB');
        expect(c.wrapper?.what.toLowerCase()).toBe(what.toLowerCase());
      }
    }
  });
  it('GitHub.com has a fixed address; Enterprise Server asks for one and checks it ends in /api/v3', () => {
    expect(run(gh, base('ghp_0000000000000000000000000000000000AB', 'classic')).settings.baseUrl).toBe('https://api.github.com');
    const ghes = run(gh, base('ghp_0000000000000000000000000000000000AB', 'classic', { baseUrl: 'https://ghe.imagile.dev' }, 1));
    expect(ghes.problems.baseUrl![0]!.message).toBe('The REST address usually ends in /api/v3.');
    expect(ghes.settings.baseUrl).toBe('https://ghe.imagile.dev');
    const good = run(gh, base('ghp_0000000000000000000000000000000000AB', 'classic', { baseUrl: 'https://ghe.imagile.dev/api/v3/' }, 1));
    expect(good.problems.baseUrl!.map((p) => p.level)).toEqual(['note']);
    expect(good.settings.baseUrl).toBe('https://ghe.imagile.dev/api/v3');
    const wrong = run(gh, base('ghp_0000000000000000000000000000000000AB', 'classic', { baseUrl: 'https://api.github.com' }, 1));
    expect(wrong.problems.baseUrl!.some((p) => p.switchTo && p.message.includes('GitHub.com'))).toBe(true);
  });
});

describe('what the form says never contains the typed secret', () => {
  const SECRETS = ['ghp_SECRETSECRETSECRET0000000000000000', 'github_pat_SECRETSECRETSECRET00000000', 'gho_SECRETSECRETSECRET0000', 'Bearer SECRETSECRETSECRET', 'two lines\nSECRETSECRETSECRET', '"SECRETSECRETSECRET"', 'TOKEN=SECRETSECRETSECRET'];
  for (const secret of SECRETS) {
    it(`for ${JSON.stringify(secret.slice(0, 9))}…`, () => {
      for (const name of ['github', 'jira']) {
        const a = area(name);
        const key = a.connection.find((f) => f.secret)!.name;
        let s = withText(emptyState('example'), { baseUrl: 'https://example.invalid' }, { [key]: secret });
        if (name === 'jira') s = withText(choose(a, 'deployment', 'Cloud', s), { baseUrl: 'example-site' }, { [key]: secret });
        const report = run(a, { ...s, tokenKind: 'classic' });
        const said = JSON.stringify([report.problems, report.blockers, report.settings, report.needs]);
        expect(said).not.toContain('SECRETSECRETSECRET');
      }
    });
  }
});

describe('every area with variants has its conditional requirements covered, and the CLI agrees', () => {
  const withVariants = realAreas.filter((a) => a.variants && area(a.name).connection.find((f) => f.name === a.variants!.by)?.choices);
  it('db has variants too, keyed on a typed engine, so it gates nothing until one is typed', () => {
    const db = area('db');
    expect(db.variantBy).toBe('engine');
    expect(db.connection.find((f) => f.name === 'engine')!.choices).toBeUndefined();
    expect(db.connection.every((f) => needOf(db, f, emptyState()) !== 'hidden' || f.appliesTo !== undefined)).toBe(true);
  });
  it('there are four with a radio, and each is described to the form with its variant key', () => {
    expect(withVariants.map((a) => a.name).sort()).toEqual(['ado', 'bitbucket', 'confluence', 'jira']);
    for (const a of withVariants) expect(area(a.name).variantBy, a.name).toBe(a.variants!.by);
  });
  for (const a of withVariants) {
    const form = area(a.name);
    const by = a.variants!.by;
    for (const [value, variant] of Object.entries(a.variants!.of)) {
      it(`${a.name} ${value}: what the declaration requires is required by the form and by the CLI, and what it uses applies`, () => {
        const state = (() => {
          const f = form.connection.find((x) => x.name === by)!;
          return afterChoice(form, emptyState('example'), by, f.choices!.options.findIndex((o) => o.value === value)).state;
        })();
        const need = (key: string) => needOf(form, form.connection.find((x) => x.name === key)!, state);
        for (const key of variant.requires ?? []) expect(need(key), `${key} for ${value}`).toBe('required');
        for (const key of variant.uses ?? []) expect(need(key), `${key} for ${value}`).not.toBe('hidden');
        // The CLI's own check: a connection of this variant with a required key missing fails, with it passes.
        const shape = a.connection.shape as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
        const full: Record<string, unknown> = { [by]: value, baseUrl: 'https://example.invalid' };
        for (const key of Object.keys(shape)) if (shape[key]!.safeParse(undefined).success === false && !(key in full)) full[key] = 'fake-value-abc12345';
        for (const key of variant.requires ?? []) full[key] = 'fake-value-abc12345';
        expect(a.connection.safeParse(full).success, `${a.name} ${value} complete`).toBe(true);
        for (const key of variant.requires ?? []) {
          const { [key]: _gone, ...rest } = full;
          void _gone;
          expect(a.connection.safeParse(rest).success, `${a.name} ${value} without ${key}`).toBe(false);
        }
      });
    }
    it(`${a.name}: every key the declaration names is a real connection key, and a hidden one never applies to the chosen variant`, () => {
      const keys = new Set(Object.keys(a.connection.shape));
      for (const variant of Object.values(a.variants!.of)) for (const k of [...(variant.requires ?? []), ...(variant.uses ?? [])]) expect(keys.has(k)).toBe(true);
      for (const f of form.connection) {
        for (const v of f.appliesTo ?? []) expect(Object.keys(a.variants!.of), `${f.name}.appliesTo`).toContain(v);
      }
    });
  }
});
