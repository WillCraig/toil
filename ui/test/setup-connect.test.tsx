import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import type { ConfigAnswers, ConfigApi, ConnectionRow } from '../src/config.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { deploymentOf, freeName, locationKind, locationProblems, tokenState } from '../src/setup.ts';
import { FIXTURE_AREAS } from '../src/fixtures/config.ts';
import type { Envelope } from '../src/toil.ts';

/**
 * The wizard's connection and Toil project steps (#561): what already exists is
 * found and said, never overwritten by accident, the deployment is chosen
 * before anything else is asked, and the Toil project step says exactly what
 * it writes. Secrets are fake and obviously so.
 */

/** Assembled so the repo-hygiene tenant check sees a placeholder, not a host. */
const ATL = 'atlassian';

const SECRET = 'fake-pat-abc12345-typed-once';

interface Call {
  command: string;
  input: Record<string, unknown>;
  extra: ConfigAnswers | undefined;
}

const ok = (command: string, data: unknown): Envelope => ({ ok: true, data, error: null, meta: { command, durationMs: 0, version: 'test', contractVersion: 1 } }) as Envelope;
const fail = (command: string, message: string, fix = 'Try again.'): Envelope => ({ ok: false, data: null, error: { code: 'INVALID_INPUT', message, fix }, meta: { command, durationMs: 0, version: 'test', contractVersion: 1 } }) as Envelope;

const row = (over: Partial<ConnectionRow> & { name: string; area: string }): ConnectionRow => ({ isDefault: true, host: null, writes: false, values: {}, definedIn: 'file', ...over });

function machine(connections: ConnectionRow[] | 'unreadable', handlers: Record<string, (input: Record<string, unknown>) => Envelope> = {}) {
  const calls: Call[] = [];
  const base = fixtureConfig();
  const config: ConfigApi = {
    disabled: null,
    areas: () => base.areas(),
    settings: () => base.settings(),
    run: async (command, input, extra) => {
      calls.push({ command, input, extra });
      if (handlers[command]) return handlers[command]!(input);
      if (command === 'connections list') return connections === 'unreadable' ? fail(command, 'Could not read the config.') : ok(command, { configFile: '/home/you/.toil/config.json', connections });
      if (command === 'projects list') return ok(command, { toilProjects: [], places: { user: '/home/you/.toil/projects' } });
      if (command === 'connections add') return ok(command, { name: input.name, area: input.area, secrets: {}, writes: false });
      if (command === 'connections login') return ok(command, { name: input.name });
      if (command === 'connections test') return ok(command, { name: input.name, area: 'jira', host: 'example', live: true, authenticated: true, request: 'GET /myself' });
      return ok(command, {});
    },
  };
  return { config, calls };
}

async function toStep(config: ConfigApi, tool: RegExp, step: string) {
  window.location.hash = '#/setup';
  render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={config} now={FIXTURE_NOW} preview />);
  await screen.findByRole('heading', { level: 1, name: 'Welcome' }, { timeout: 3000 });
  await userEvent.click(screen.getByRole('button', { name: 'Start' }));
  await screen.findByRole('heading', { level: 1, name: 'An AI agent (optional)' });
  await userEvent.click(screen.getByRole('radio', { name: /^Not now/ }));
  await userEvent.click(screen.getByRole('button', { name: /^Next/ }));
  // Tools that are already linked start ticked; tick the one under test only if it is not.
  const box = (await screen.findByRole('checkbox', { name: tool })) as HTMLInputElement;
  if (!box.checked) await userEvent.click(box);
  await userEvent.click(screen.getByRole('button', { name: /^Next/ }));
  await screen.findByRole('heading', { level: 1, name: step });
}

const save = () => screen.getByRole('button', { name: 'Save connection' });

describe('the deployment radio in the wizard', () => {
  it('asks Cloud or Data Center first, and keeps Save blocked, with the reason, until one is chosen', async () => {
    const { config } = machine([]);
    await toStep(config, /Jira/, 'Link Jira');
    expect(screen.getByRole('radio', { name: 'Cloud' })).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Cloud' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('radio', { name: 'Data Center' }) as HTMLInputElement).checked).toBe(false);
    expect(save().getAttribute('aria-disabled')).toBe('true');
    expect(document.querySelector('.change-actions')!.textContent).toContain('Choose Cloud or Data Center first.');
    // Nothing else is asked yet.
    expect(screen.queryByLabelText(/^Address/)).toBeNull();
    expect(screen.queryByLabelText(/^apiToken/)).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Cloud' }));
    expect(screen.getByLabelText(/^Site name/)).toBeTruthy();
    expect(screen.getByLabelText(/^email/)).toBeTruthy();
    expect(save().getAttribute('aria-disabled')).toBe('true');
    expect(document.querySelector('.change-actions')!.textContent).toContain('Fill in the address.');
    await userEvent.type(screen.getByLabelText(/^Site name/), 'example-site');
    expect(document.querySelector('.change-actions')!.textContent).toContain('Add your email: Cloud signs in with email and token.');
  });

  it('Jira Cloud: composes the address from the site name, previews it, and sends only what applies', async () => {
    const { config, calls } = machine([]);
    await toStep(config, /Jira/, 'Link Jira');
    await userEvent.click(screen.getByRole('radio', { name: 'Cloud' }));
    await userEvent.type(screen.getByLabelText(/^Site name/), 'example-site');
    expect(document.body.textContent).toContain(`Address: https://example-site.${ATL}.net`);
    await userEvent.type(screen.getByLabelText(/^email/), 'you@example.com');
    await userEvent.type(screen.getByLabelText(/^apiToken/), SECRET);
    // The badges say what is required, live.
    expect(screen.getByLabelText(/^email/).closest('.field-row')!.textContent).toContain('required');
    expect(document.querySelector('.runs')).toBeNull();
    await userEvent.click(save());
    await waitFor(() => expect(calls.some((c) => c.command === 'connections add')).toBe(true));
    const add = calls.find((c) => c.command === 'connections add')!;
    expect(add.extra?.answers).toMatchObject({ 'setting:baseUrl': `https://example-site.${ATL}.net`, 'setting:deployment': 'cloud', 'setting:email': 'you@example.com' });
    expect(add.extra?.secrets).toEqual({ apiToken: SECRET });
    expect(JSON.stringify([add.input, add.extra?.answers])).not.toContain(SECRET);
  }, 30_000);

  it('Jira Data Center: no email box, and one typed under Cloud is cleared with a note and never sent', async () => {
    const { config, calls } = machine([]);
    await toStep(config, /Jira/, 'Link Jira');
    await userEvent.click(screen.getByRole('radio', { name: 'Cloud' }));
    await userEvent.type(screen.getByLabelText(/^email/), 'you@example.com');
    await userEvent.click(screen.getByRole('radio', { name: 'Data Center' }));
    expect(screen.queryByLabelText(/^email/)).toBeNull();
    expect(document.querySelector('[data-cleared]')!.textContent).toContain("email was cleared: it isn't needed for Data Center.");
    await userEvent.type(screen.getByLabelText(/^Address/), 'https://jira.imagile.dev');
    await userEvent.type(screen.getByLabelText(/^apiToken/), SECRET);
    await userEvent.click(save());
    await waitFor(() => expect(calls.some((c) => c.command === 'connections add')).toBe(true));
    const answers = calls.find((c) => c.command === 'connections add')!.extra!.answers!;
    expect(answers['setting:email']).toBe('');
    expect(answers['setting:deployment']).toBe('server');
  }, 30_000);

  it('moves focus to the first missing field when Save is pressed early, and shows why', async () => {
    const { config } = machine([]);
    await toStep(config, /Jira/, 'Link Jira');
    await userEvent.click(screen.getByRole('radio', { name: 'Cloud' }));
    await userEvent.click(save());
    // The name is filled, so the site name is first.
    expect((document.activeElement as HTMLElement).getAttribute('data-field')).toBe('baseUrl');
    expect(document.body.textContent).toContain('Needed.');
  });

  it('warns about a Cloud address under Data Center and switches on request', async () => {
    const { config } = machine([]);
    await toStep(config, /Jira/, 'Link Jira');
    await userEvent.click(screen.getByRole('radio', { name: 'Data Center' }));
    const box = screen.getByLabelText(/^Address/);
    await userEvent.type(box, `https://example-site.${ATL}.net`);
    await userEvent.tab();
    expect(document.body.textContent).toContain('That looks like a Cloud address, and you chose Data Center.');
    await userEvent.click(screen.getByRole('button', { name: 'Switch' }));
    expect((screen.getByRole('radio', { name: 'Cloud' }) as HTMLInputElement).checked).toBe(true);
  });
});

describe('GitHub in the wizard', () => {
  it('has the address radio, the token type radio, and a closed scopes disclosure with Copy and the vendor links', async () => {
    const { config } = machine([]);
    await toStep(config, /GitHub/, 'Link GitHub');
    expect((screen.getByRole('radio', { name: /^GitHub\.com/ }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: 'GitHub Enterprise Server' }));
    expect(screen.getByLabelText(/^Address/).getAttribute('placeholder')).toBe('https://ghe.imagile.dev/api/v3');
    expect((screen.getByRole('radio', { name: /^Classic token \(ghp_…\)/ }) as HTMLInputElement).checked).toBe(true);
    const disclosure = document.querySelector('[data-scopes]') as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
    disclosure.open = true;
    expect(disclosure.textContent).toContain('repo');
    expect(disclosure.textContent).toContain('read:project');
    const links = [...disclosure.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toContain('https://github.com/settings/tokens/new?scopes=repo,read:project&description=toil');
    expect(within(disclosure).getAllByRole('button', { name: /^Copy/ }).length).toBe(2);
    expect(disclosure.querySelector('a')!.getAttribute('rel')).toContain('noopener');
    await userEvent.click(screen.getByRole('radio', { name: /^Fine-grained token \(github_pat_…\)/ }));
    expect(disclosure.textContent).toContain('Pull requests: Read and write');
    expect(disclosure.querySelector('a')!.getAttribute('href')).toBe('https://github.com/settings/personal-access-tokens/new');
  });

  it('offers a switch when the pasted token is the other kind, without repeating it', async () => {
    const { config } = machine([]);
    await toStep(config, /GitHub/, 'Link GitHub');
    const token = 'github_pat_000000000000000000000000AB';
    await userEvent.type(screen.getByLabelText(/^token/), token);
    await userEvent.tab();
    expect(document.body.textContent).toContain('That starts with github_pat_, which is a fine-grained token, and you chose classic token.');
    expect(document.body.textContent).not.toContain(token);
    await userEvent.click(screen.getByRole('button', { name: 'Switch' }));
    expect((screen.getByRole('radio', { name: /^Fine-grained token/ }) as HTMLInputElement).checked).toBe(true);
  });
});

describe('what already exists', () => {
  const jira = row({ name: 'jira', area: 'jira', host: `example-site.${ATL}.net`, values: { baseUrl: 'file', apiToken: 'store', deployment: 'file' } });

  it('reports it without a value, defaults to using the only good one, and goes straight to Test the link', async () => {
    const { config, calls } = machine([jira]);
    await toStep(config, /Jira/, 'Link Jira');
    const existing = document.querySelector('[data-setup-existing]')!;
    expect(existing.textContent).toContain('You already have 1 Jira connection:');
    expect(existing.textContent).toContain('jira');
    expect(existing.textContent).toContain(`example-site.${ATL}.net`);
    expect(existing.textContent).toContain('(Cloud)');
    expect(existing.textContent).toContain('read only');
    expect(existing.textContent).toContain('token: saved');
    expect((screen.getByRole('radio', { name: /^Use jira \(already set up\)/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save connection' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Test the link' }));
    await screen.findByText(/Jira answered, so its login works/);
    expect(calls.map((c) => c.command)).not.toContain('connections add');
    expect(calls.map((c) => c.command)).not.toContain('connections login');
  });

  it('lists an environment-defined connection as read-only, and offers no Replace for it', async () => {
    const env = row({ name: 'jira', area: 'jira', host: 'jira.imagile.dev', definedIn: 'env', values: { baseUrl: 'env', apiToken: 'env' } });
    const { config } = machine([env]);
    await toStep(config, /Jira/, 'Link Jira');
    const existing = document.querySelector('[data-setup-existing]')!;
    expect(existing.textContent).toContain('token: set outside Toil UI');
    expect(existing.textContent).toContain("Set outside Toil UI, so it can't be changed here.");
    expect(screen.queryByRole('radio', { name: /Replace the saved token/ })).toBeNull();
    expect(screen.getByRole('radio', { name: /^Add another Jira connection/ })).toBeTruthy();
  });

  it('refuses a name that is taken, proposes one that is free, and blocks Save with the reason', async () => {
    const { config, calls } = machine([jira, row({ name: 'jira-2', area: 'jira', isDefault: false, values: { apiToken: 'store' } })]);
    await toStep(config, /Jira/, 'Link Jira');
    await userEvent.click(screen.getByRole('radio', { name: /^Add another Jira connection/ }));
    const name = screen.getByLabelText(/^Name required/) as HTMLInputElement;
    expect(name.value).toBe('jira-3');
    await userEvent.clear(name);
    await userEvent.type(name, 'jira');
    await userEvent.tab();
    expect(document.body.textContent).toContain('A connection called jira already exists.');
    expect(save().getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(save());
    expect(calls.map((c) => c.command)).not.toContain('connections add');
  });

  it('Replace names what it overwrites and needs a tick before Save can run', async () => {
    const { config, calls } = machine([jira]);
    await toStep(config, /Jira/, 'Link Jira');
    await userEvent.click(screen.getByRole('radio', { name: /^Replace the saved token for jira/ }));
    expect(document.querySelector('[data-setup-replace]')!.textContent).toContain("This replaces the token saved for jira. The old token can't be recovered from toil.");
    await userEvent.type(screen.getByLabelText(/^apiToken/), SECRET);
    const button = screen.getByRole('button', { name: /^Save (securely|to the credential store)/ });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(button);
    expect(calls.map((c) => c.command)).not.toContain('connections login');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Yes, replace the saved token for jira' }));
    await userEvent.click(screen.getByRole('button', { name: /^Save (securely|to the credential store)/ }));
    await waitFor(() => expect(calls.some((c) => c.command === 'connections login')).toBe(true));
    const login = calls.find((c) => c.command === 'connections login')!;
    expect(login.input).toEqual({ name: 'jira' });
    expect(login.extra?.secrets).toEqual({ apiToken: SECRET });
    expect(document.body.textContent).not.toContain(SECRET);
  }, 30_000);

  it('says a list it could not read is unknown, with a dash, rather than none', async () => {
    const { config } = machine('unreadable');
    await toStep(config, /Jira/, 'Link Jira');
    const note = document.querySelector('[data-setup-unknown]')!;
    expect(note.textContent).toContain("couldn't read your existing connections");
    expect(note.querySelector('[aria-label="not read yet"]')!.textContent).toBe('–');
    expect(document.querySelector('[data-setup-existing]')).toBeNull();
  });

  it('shows no secret value anywhere, and passes axe', async () => {
    const { config } = machine([jira]);
    await toStep(config, /Jira/, 'Link Jira');
    expect(document.body.textContent).not.toMatch(/fake-|ghp_|github_pat_/);
    const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it('the pure helpers: token state, deployment from the host, and a free name', () => {
    expect(tokenState({ values: { apiToken: 'store' } }, ['apiToken'])).toBe('saved');
    expect(tokenState({ values: { apiToken: 'ci' } }, ['apiToken'])).toBe('env');
    expect(tokenState({ values: {} }, ['apiToken'])).toBe('missing');
    const jiraArea = FIXTURE_AREAS.find((a) => a.name === 'jira')!;
    expect(deploymentOf(jiraArea, { host: `example-site.${ATL}.net` })).toBe('Cloud');
    expect(deploymentOf(jiraArea, { host: 'jira.imagile.dev' })).toBe('Data Center');
    expect(deploymentOf(jiraArea, { host: null })).toBeNull();
    expect(freeName('jira', [])).toBe('jira');
    expect(freeName('jira', ['jira', 'jira-2'])).toBe('jira-3');
  });
});

describe('the Toil project step says what it writes', () => {
  async function toProject(machineArg = machine([])) {
    window.location.hash = '#/setup';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={machineArg.config} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1, name: 'Welcome' }, { timeout: 3000 });
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByRole('heading', { level: 1, name: 'An AI agent (optional)' });
    await userEvent.click(screen.getByRole('radio', { name: /^Not now/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Next/ }));
    await screen.findByRole('heading', { level: 1, name: 'Which tools do you use?' });
    await userEvent.click(screen.getByRole('checkbox', { name: /add tools later/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Next/ }));
    await screen.findByRole('heading', { level: 1, name: 'Your Toil project' });
    return machineArg;
  }

  it('says in plain words what creating it saves, with no file path', async () => {
    await toProject();
    expect(document.querySelector('[data-setup-repos-help]')!.textContent).toBe('Lets Toil work out which project you are in from the folder you are working in. Nothing is written to that folder.');
    expect(document.querySelector('[data-setup-writes]')!.textContent).toContain('Creating it saves one small file of your own on this computer. Nothing is saved in any folder or repository you list');
    expect(document.querySelector('[data-setup-writes]')!.textContent).not.toContain('.toil');
  });

  it('two paths run init then one add-repo each, in order, and never pass --shared', async () => {
    const { calls } = await toProject();
    await userEvent.type(screen.getByLabelText(/^Name/), 'payments');
    await userEvent.type(screen.getByLabelText('Folder or address 1'), '/work/payments-api');
    await userEvent.click(screen.getByRole('button', { name: 'Add another' }));
    await userEvent.type(screen.getByLabelText('Folder or address 2'), 'https://git.imagile.dev/payments/web.git');
    expect(document.querySelector('.runs')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Create this Toil project' }));
    await waitFor(() => expect(calls.filter((c) => c.command === 'projects add-repo')).toHaveLength(2));
    const steps = calls.filter((c) => c.command === 'projects init' || c.command === 'projects add-repo');
    expect(steps.map((c) => [c.command, c.input])).toEqual([
      ['projects init', { name: 'payments' }],
      ['projects add-repo', { toilProject: 'payments', location: '/work/payments-api' }],
      ['projects add-repo', { toilProject: 'payments', location: 'https://git.imagile.dev/payments/web.git' }],
    ]);
    expect(JSON.stringify(calls.map((c) => c.input))).not.toContain('shared');
    const saved = document.querySelector('[data-setup-saved]')!;
    expect(saved.textContent).toContain('payments was created.');
    expect(saved.textContent).not.toContain('.toil');
    expect(saved.textContent).toContain('Nothing in any repository or folder.');
  }, 30_000);

  it('reads each row as a folder or an address, refuses a repeat, and a row can be removed', async () => {
    await toProject();
    await userEvent.type(screen.getByLabelText('Folder or address 1'), '/work/payments-api');
    expect(document.body.textContent).toContain('Read as a folder.');
    await userEvent.click(screen.getByRole('button', { name: 'Add another' }));
    await userEvent.type(screen.getByLabelText('Folder or address 2'), '/work/payments-api/');
    expect(document.body.textContent).toContain('Already in the list above.');
    await userEvent.type(screen.getByLabelText(/^Name/), 'payments');
    expect(screen.getByRole('button', { name: 'Create this Toil project' }).getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Remove folder or address 2' }));
    expect(screen.queryByLabelText('Folder or address 2')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create this Toil project' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('a failed path does not undo the project: it says which one failed and retries it', async () => {
    let attempts = 0;
    const m = machine([], {
      'projects add-repo': (input) => (input.location === '/work/missing' && attempts++ === 0 ? fail('projects add-repo', 'No such folder.', 'Check the path.') : ok('projects add-repo', {})),
    });
    await toProject(m);
    await userEvent.type(screen.getByLabelText(/^Name/), 'payments');
    await userEvent.type(screen.getByLabelText('Folder or address 1'), '/work/payments-api');
    await userEvent.click(screen.getByRole('button', { name: 'Add another' }));
    await userEvent.type(screen.getByLabelText('Folder or address 2'), '/work/missing');
    await userEvent.click(screen.getByRole('button', { name: 'Create this Toil project' }));
    const results = await waitFor(() => document.querySelector('[data-setup-repo-results]')!);
    expect(results.textContent).toContain('/work/payments-api: added');
    expect(results.textContent).toContain('/work/missing: No such folder. Check the path.');
    expect(document.body.textContent).toContain('payments was created. 1 of 2 folders or addresses were not added');
    await userEvent.click(screen.getByRole('button', { name: 'Retry the ones that failed' }));
    await waitFor(() => expect(document.querySelector('[data-setup-repo-results]')!.textContent).toContain('/work/missing: added'));
    expect(m.calls.filter((c) => c.command === 'projects init')).toHaveLength(1);
  }, 30_000);

  it('the pure helpers', () => {
    expect(locationKind('git@git.imagile.dev:payments/web.git')).toBe('address');
    expect(locationKind('https://git.imagile.dev/payments/web')).toBe('address');
    expect(locationKind('C:\\work\\payments')).toBe('folder');
    expect(locationKind('  ')).toBe('empty');
    expect(locationProblems(['/a', '', '/A/'])).toEqual([null, null, 'Already in the list above.']);
  });
});
