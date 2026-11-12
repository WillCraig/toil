// @vitest-environment jsdom
// Settings are changed only by a person pressing something, a control no steering group has yet agreed to automate.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConfigApi } from '../src/config.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import type { AgentSettings, AgentStatus } from '../src/server-client.ts';
import { open, AXE_TIMEOUT, violations, panel, NO_INSTALL, resetBrowserState } from './views-kit.tsx';

beforeEach(resetBrowserState);

describe('settings', () => {
  it('is in the navigation, and says the preview changes nothing', async () => {
    await open('#/settings');
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings');
    // Settings opens on General, its first tab, and every tab's title is the same.
    expect(screen.getByRole('link', { name: 'General' }).getAttribute('aria-current')).toBe('page');
    window.location.hash = '#/settings/connections';
    await waitFor(() => expect(screen.getByRole('link', { name: 'Connections' }).getAttribute('aria-current')).toBe('page'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings');
    expect(document.body.textContent).toContain('Changes are turned off.');
  });

  it('keeps #/settings/toil as an alias of General, and opens the connection form only when the address asks', async () => {
    await open('#/settings/general');
    expect(screen.getByRole('link', { name: 'General' }).getAttribute('aria-current')).toBe('page');
    window.location.hash = '#/settings/connections';
    await screen.findByRole('article', { name: 'corp-jira' });
    expect(screen.queryByRole('form', { name: 'A new connection' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add a connection' })).toBeTruthy();
    window.location.hash = '#/settings/connections/+add';
    expect(await screen.findByRole('form', { name: 'A new connection' })).toBeTruthy();
  });

  /** Opens the add form the way a person does: the button, since the form is closed until asked for. */
  async function addConnectionForm() {
    await userEvent.click(await screen.findByRole('button', { name: 'Add a connection' }));
    return screen.findByRole('form', { name: 'A new connection' });
  }

  /** The preview's config with changes on, recording what each change sent, and answering it ok. */
  function recording() {
    const base = fixtureConfig();
    const sent: Array<{ command: string; input: Record<string, unknown>; answers: unknown }> = [];
    const config: ConfigApi = {
      ...base,
      disabled: null,
      run: async (command, input, answers) => {
        if (['connections list', 'connections test', 'projects list', 'projects show', 'projects check'].includes(command)) return base.run(command, input);
        sent.push({ command, input, answers: answers ?? null });
        return { ok: true, data: {}, error: null, meta: { command, durationMs: 0, version: 'x', contractVersion: 1 } };
      },
    };
    return { config, sent };
  }

  it('in the preview, shows the connections with every change turned off, and still tests one', async () => {
    await open('#/settings/connections');
    const card = await screen.findByRole('article', { name: 'corp-jira' });
    await userEvent.click(within(card).getByRole('button', { name: 'Make read only' }));
    const form = within(card).getByRole('form', { name: 'Make corp-jira read only' });
    expect((within(form).getByRole('button', { name: 'Make read only' }) as HTMLButtonElement).disabled).toBe(true);
    expect(form.textContent).toContain('Turned off: This is the preview');
    expect(form.textContent).not.toContain('Runs ');
    await userEvent.click(within(card).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(card.textContent).toContain('corp-jira answered, so its login works'));
  });

  it('shows a connection made by env vars read-only, with where it came from', async () => {
    await open('#/settings/connections');
    const card = await screen.findByRole('article', { name: 'github' });
    expect(within(card).queryByRole('button', { name: /Remove|Make default|Make read only|Allow writes|Update login/ })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Test' })).toBeTruthy();
    expect(card.textContent).not.toContain('TOIL_');
    expect(card.textContent).toContain("Set outside Toil UI, so it can't be changed here");
  });

  it("turns writes on only with the name typed, and sends what was typed as the command's own confirmation", async () => {
    const { config, sent } = recording();
    await open('#/settings/connections', { config });
    const card = await screen.findByRole('article', { name: 'corp-ado' });
    await userEvent.click(within(card).getByRole('button', { name: 'Allow writes' }));
    const form = within(card).getByRole('form', { name: 'Allow writes for corp-ado' });
    await userEvent.type(within(form).getByRole('textbox', { name: /Type corp-ado to allow writes/ }), 'corp-ado');
    await userEvent.click(within(form).getByRole('button', { name: 'Allow writes' }));
    expect(await within(form).findByRole('status')).toBeTruthy();
    expect(sent).toEqual([{ command: 'connections writes', input: { name: 'corp-ado', state: 'on' }, answers: { answers: { 'confirm-name': 'corp-ado' } } }]);
  });

  it("adds a connection: every setting answered, the secret sent once and cleared from the page", async () => {
    const { config, sent } = recording();
    await open('#/settings/connections', { config });
    const form = await addConnectionForm();
    await userEvent.type(within(form).getByRole('textbox', { name: /^Name/ }), 'corp-jira-2');
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Tool' }), 'jira');
    await userEvent.click(within(form).getByRole('radio', { name: 'Data Center' }));
    await userEvent.type(within(form).getByRole('textbox', { name: /^Address/ }), 'https://jira.imagile.dev');
    const secret = within(form).getByLabelText(/^apiToken/) as HTMLInputElement;
    expect(secret.type).toBe('password');
    await userEvent.type(secret, 'fake-pat-abc12345');
    expect(form.textContent).not.toContain('Saves:');
    expect(form.textContent).not.toContain('credential store');
    await userEvent.click(within(form).getByRole('button', { name: 'Save connection' }));
    expect(await within(form).findByRole('status')).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ command: 'connections add', input: { name: 'corp-jira-2', area: 'jira' }, answers: { secrets: { apiToken: 'fake-pat-abc12345' } } });
    const answers = (sent[0]!.answers as { answers: Record<string, string> }).answers;
    expect(answers).toMatchObject({ confirm: 'y', 'setting:deployment': 'server', 'setting:baseUrl': 'https://jira.imagile.dev', 'setting:project': '', 'setting:email': '' });
    // The form starts over, so the deployment must be chosen again and no secret box is left holding anything.
    expect(within(form).queryByLabelText(/^apiToken/)).toBeNull();
    expect(document.body.textContent).not.toContain('fake-pat-abc12345');
  });

  it("answers an optional secret left blank with '', so toil skips it as the CLI does", async () => {
    const { config, sent } = recording();
    await open('#/settings/connections', { config });
    const form = await addConnectionForm();
    await userEvent.type(within(form).getByRole('textbox', { name: /^Name/ }), 'ocp-lab');
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Tool' }), 'openshift');
    expect((within(form).getByLabelText(/^token/) as HTMLInputElement).required).toBe(false);
    await userEvent.click(within(form).getByRole('button', { name: 'Save connection' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ command: 'connections add', input: { name: 'ocp-lab', area: 'openshift' }, answers: { secrets: { token: '' } } });
  });

  it("replaces a secret with every field answered, an empty one as ''", async () => {
    const { config, sent } = recording();
    await open('#/settings/connections', { config });
    const card = await screen.findByRole('article', { name: 'corp-jenkins' });
    await userEvent.click(within(card).getByRole('button', { name: 'Update login' }));
    const form = within(card).getByRole('form', { name: "Update corp-jenkins's login" });
    await userEvent.click(within(form).getByRole('button', { name: 'Save securely' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ command: 'connections login', input: { name: 'corp-jenkins' }, answers: { secrets: { apiToken: '' } } });
  });

  describe('the paste checks on a secret field (#358)', () => {
    async function addForm() {
      const { config, sent } = recording();
      await open('#/settings/connections', { config });
      const form = await addConnectionForm();
      await userEvent.type(within(form).getByRole('textbox', { name: /^Name/ }), 'corp-jira-2');
      await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Tool' }), 'jira');
      await userEvent.click(within(form).getByRole('radio', { name: 'Data Center' }));
      await userEvent.type(within(form).getByRole('textbox', { name: /^Address/ }), 'https://jira.imagile.dev');
      const secret = within(form).getByLabelText(/^apiToken/) as HTMLInputElement;
      const note = () => document.getElementById(secret.getAttribute('aria-describedby')!.split(' ')[0]!)!.textContent;
      const save = () => userEvent.click(within(form).getByRole('button', { name: 'Save connection' }));
      return { form, secret, note, save, sent };
    }

    it('shows the length live, never the value, and says an empty required one is required', async () => {
      const { secret, note, save, sent, form } = await addForm();
      expect(note()).toBe('Empty: this one is required');
      await save();
      expect(form.textContent).toContain('Add the apiToken: Data Center needs it.');
      expect(within(form).getByRole('button', { name: 'Save connection' }).getAttribute('aria-disabled')).toBe('true');
      expect(sent).toHaveLength(0);
      await userEvent.type(secret, 'fake-pat-abc12345');
      expect(note()).toBe('17 characters');
      expect(within(form).queryByRole('button', { name: /Show/ })).toBeNull();
    });

    it('trims a pasted trailing newline, saying so, and sends the value', async () => {
      const { secret, note, save, sent } = await addForm();
      await userEvent.click(secret);
      await userEvent.paste('fake-pat-abc12345\n');
      expect(note()).toBe('17 characters (removed a trailing newline)');
      await save();
      await waitFor(() => expect(sent).toHaveLength(1));
      expect((sent[0]!.answers as { secrets: Record<string, string> }).secrets.apiToken?.trim()).toBe('fake-pat-abc12345');
    });

    it('refuses a paste with a line break in the middle, which a browser would silently join', async () => {
      const { secret, note, save, sent, form } = await addForm();
      await userEvent.click(secret);
      await userEvent.paste('fake-pat-abc12345\nfake-pat-abc12345');
      expect(note()).toContain('This has a line break in the middle, so the paste most likely took two lines.');
      await save();
      expect(within(form).getByRole('alert').textContent).toContain('Copy just the token, on its own, and paste it again.');
      expect(sent).toHaveLength(0);
    });

    it('asks about a Bearer prefix on submit, with a one-click Remove it', async () => {
      const { secret, note, save, sent, form } = await addForm();
      await userEvent.click(secret);
      await userEvent.paste('Bearer fake-pat-abc12345');
      expect(note()).toBe('24 characters');
      await save();
      expect(sent).toHaveLength(0);
      expect(within(form).getByRole('group', { name: /This starts with "Bearer "\. Store it without that\?/ })).toBeTruthy();
      await userEvent.click(within(form).getByRole('button', { name: 'Remove it' }));
      expect(secret.value).toBe('fake-pat-abc12345');
      expect(note()).toBe('17 characters');
      await save();
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]).toMatchObject({ answers: { secrets: { apiToken: 'fake-pat-abc12345' } } });
      expect(document.body.textContent).not.toContain('abc12345');
    });

    it('keeps quotes when the person says so, and tells toil with unwrap:<key>', async () => {
      const { secret, save, sent, form } = await addForm();
      await userEvent.type(secret, '"fake-pat-abc12345"');
      await save();
      await userEvent.click(within(form).getByRole('button', { name: 'Keep it' }));
      await save();
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0]).toMatchObject({ answers: { secrets: { apiToken: '"fake-pat-abc12345"' }, answers: { 'unwrap:apiToken': 'n' } } });
    });

    it('says an empty field keeps the current secret when replacing one', async () => {
      await open('#/settings/connections');
      const card = await screen.findByRole('article', { name: 'corp-jenkins' });
      await userEvent.click(within(card).getByRole('button', { name: 'Update login' }));
      const form = within(card).getByRole('form', { name: "Update corp-jenkins's login" });
      expect(form.textContent).toContain('Empty: the current secret is kept');
    });
  });

  it('changes a Toil project through toil projects, shows and checks one, and sends creation to the wizard', async () => {
    const { config, sent } = recording();
    await open('#/settings/projects', { config });
    const card = await screen.findByRole('article', { name: 'settlement' });
    await userEvent.click(within(card).getByRole('button', { name: /^Menu for / }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Check' }));
    expect(await within(card).findByText('settlement checks out: no problems.')).toBeTruthy();
    expect(within(card).getByText('settlement checks out: no problems.').closest('[role="status"]')).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: /^Menu for / }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Show details' }));
    expect(within(card).getByRole('table').textContent).toContain('corp-ado (toil-project)');

    expect(screen.queryByRole('form', { name: 'Create a Toil project' })).toBeNull();
    expect(document.querySelector('a[data-new-toil-project]')!.getAttribute('href')).toBe('#/new-project');
    // Each card's Edit opens that Toil project's own page, sources first; the forms are not on the list.
    expect(screen.queryByRole('form', { name: 'Name a field in card-payments' })).toBeNull();
    const editCard = screen.getByRole('article', { name: 'card-payments' });
    expect(within(editCard).getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe('#/settings/projects/card-payments/sources');
    window.location.hash = '#/settings/projects/card-payments/fields';
    await screen.findByRole('heading', { level: 2, name: 'Edit card-payments' });
    const field = screen.getByRole('form', { name: 'Name a field in card-payments' });
    await userEvent.type(within(field).getByRole('textbox', { name: /^Name/ }), 'storyPoints');
    await userEvent.type(within(field).getByRole('textbox', { name: /^Field id/ }), 'customfield_10002');
    await userEvent.click(within(field).getByRole('button', { name: 'Name field' }));
    await userEvent.click(screen.getByText('Sources'));
    const link = await screen.findByRole('form', { name: 'Link a tool to card-payments' });
    await userEvent.type(within(link).getByRole('textbox', { name: /^Settings for every call/ }), 'project=PAY');
    await userEvent.click(within(link).getByRole('button', { name: 'Link tool' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => [s.command, s.input])).toEqual([
      ['projects field', { toilProject: 'card-payments', area: 'jira', alias: 'storyPoints', id: 'customfield_10002' }],
      ['projects link', { toilProject: 'card-payments', area: 'jira', set: ['project=PAY'] }],
    ]);
  });

  it("sets up a repo: checks it with projects onboard --plan, offers the missing connection on the Toil project's host, and checks again after adding it", async () => {
    const base = fixtureConfig();
    const sent: Array<{ command: string; input: Record<string, unknown>; answers: unknown }> = [];
    const config: ConfigApi = {
      ...base,
      disabled: null,
      run: async (command, input, answers) => {
        sent.push({ command, input, answers: answers ?? null });
        if (command === 'connections add') return { ok: true, data: {}, error: null, meta: { command, durationMs: 0, version: 'x', contractVersion: 1 } };
        return base.run(command, input);
      },
    };
    await open('#/settings/projects', { config });
    const panelEl = await screen.findByRole('region', { name: 'Set up this repo' });
    await userEvent.click(within(panelEl).getByRole('button', { name: 'Check this repo' }));
    const table = await within(panelEl).findByRole('table');
    expect(table.textContent).toContain('host bitbucket-sdk.imagile.dev');
    expect(table.textContent).toContain('No connection yet');
    expect(table.textContent).toContain('Worked');
    expect(panelEl.textContent).toContain('checkout-web: 3 of 4 areas ready.');
    expect(panelEl.textContent).toContain('error: bitbucket.host');
    const add = within(panelEl).getByRole('form', { name: 'Add a Bitbucket connection on bitbucket-sdk.imagile.dev' });
    expect((within(add).getByRole('textbox', { name: /^Name/ }) as HTMLInputElement).value).toBe('bitbucket');
    // The deployment is the person's to choose; the suggested address waits under Data Center.
    await userEvent.click(within(add).getByRole('radio', { name: 'Data Center' }));
    expect((within(add).getByRole('textbox', { name: /^Address/ }) as HTMLInputElement).value).toBe('https://bitbucket-sdk.imagile.dev');
    // A required secret left empty is refused before anything is sent (#358), so one is typed.
    await userEvent.type(add.querySelector('input[type=password]')!, 'fake-pat-abc12345');
    await userEvent.click(within(add).getByRole('button', { name: 'Save connection' }));
    await waitFor(() => expect(sent.filter((s) => s.command === 'projects onboard')).toHaveLength(2));
    const steps = sent.filter((s) => s.command === 'projects onboard' || s.command === 'connections add');
    expect(steps.map((s) => s.command)).toEqual(['projects onboard', 'connections add', 'projects onboard']);
    expect(steps[0]!.input).toEqual({ plan: true });
    expect(steps[1]).toMatchObject({ input: { name: 'bitbucket', area: 'bitbucket' }, answers: { answers: { 'setting:deployment': 'server', 'setting:baseUrl': 'https://bitbucket-sdk.imagile.dev', confirm: 'y' } } });
  });

  it('shows the bounds and the time limit read-only, with where each is set', async () => {
    await open('#/settings/general');
    // Closed by default: the bounds are one step in, under Advanced, and name no file or variable.
    const advanced = document.querySelector('[data-advanced]') as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    await userEvent.click(within(advanced).getByText('Advanced'));
    await screen.findByRole('heading', { name: 'Bounds' });
    expect(advanced.textContent).toContain('Held: Toil reads and writes files only inside your working folder.');
    expect(advanced.textContent).not.toContain('.toil');
    expect(advanced.textContent).not.toContain('TOIL_');
    expect(advanced.textContent).toContain("120 s, Toil's default");
    expect(screen.queryByRole('button', { name: /^Save|Change/ })).toBeNull();
  });

  it("has a Usage page: a short plain summary first, everything else behind one More detail, and Toil UI's own calls left out", async () => {
    const config = fixtureConfig();
    await open('#/settings/usage', { config });
    await screen.findByRole('heading', { name: 'How Toil is used' });
    const more = document.querySelector('[data-usage-more]') as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.querySelector('summary')!.textContent).toBe('More detail');
    expect(document.querySelectorAll('[data-usage-more]')).toHaveLength(1);
    expect(document.body.textContent).toMatch(/Since .*: \d+ calls?, \d+ failed/);
    expect(document.body.textContent).not.toMatch(/toil audit|--by/);
    expect(screen.getByRole('link', { name: 'Usage' }).getAttribute('aria-current')).toBe('page');
    expect(document.body.textContent).not.toContain('Changes are turned off.');
    const until = config.calls[0]!.input.until;
    expect(until).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(config.calls.map((c) => [c.command, c.input])).toEqual([
      ['audit stats', { by: ['day', 'caller'], until }],
      ['audit stats', { by: ['command', 'caller'], until }],
      ['audit stats', { by: ['via', 'caller'], until }],
    ]);
    expect(screen.getByRole('img', { name: /^Calls per day: \d+ calls in 30 days/ })).toBeTruthy();
    const doors = panel('Who made the calls');
    for (const door of ['Toil UI itself', 'An AI assistant', 'A terminal']) expect(doors.textContent).toContain(door);
    // Toil UI's own calls are in this table, labelled, and in no total above it.
    const top = within(panel('Used most')).getAllByRole('rowheader').map((h) => h.textContent);
    expect(top[0]).toBe('Whatjira issue get');
    const failing = panel('Failed most');
    expect(failing.textContent).toContain('Usual fix:');
    const show = within(failing).getAllByRole('button', { name: 'Show recent failures' })[0]!;
    await userEvent.click(show);
    await within(failing).findByRole('region', { name: /^Recent failures of / });
    const last = config.calls.at(-1)!;
    expect(last.command).toBe('audit list');
    expect(last.input).toMatchObject({ outcome: 'failed', limit: 10 });
    expect(show.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText(/had no call in this window/)).toBeNull();
  });

  it("has an AI agent page, which says what the local app offers and changes nothing in the preview", async () => {
    await open('#/settings/agent');
    expect(screen.getByRole('link', { name: 'AI agent' }).getAttribute('aria-current')).toBe('page');
    const agentPanel = panel('AI agent');
    for (const name of ['Claude', 'GitHub Copilot', 'Codex']) expect(agentPanel.textContent).toContain(name);
    expect(within(agentPanel).queryByRole('button')).toBeNull();
    expect(document.body.textContent).not.toContain('Changes are turned off.');
  });

  it('installs a missing SDK in one press, after showing the exact command, streaming npm into the dialog (#344)', async () => {
    const ran: string[] = [];
    const client = {
      status: async () => STATUS({ adapter: 'none', model: null, cliPath: null, endpoint: null, instructions: null, voice: null, models: {}, cliPaths: {} }, ran.length > 0),
      save: async (s: AgentSettings) => STATUS(s),
      prompt: async () => '',
      installPlan: NO_INSTALL.installPlan,
      install: async (adapter: string, command: string, onLine: (l: string) => void) => {
        ran.push(`${adapter}: ${command}`);
        onLine('added 105 packages in 8s');
        return STATUS({ adapter: 'none', model: null, cliPath: null, endpoint: null, instructions: null, voice: null, models: {}, cliPaths: {} }, true).adapters[0]!;
      },
    };
    const { container } = await open('#/settings/agent', { preview: false, agentSettings: { client } });
    const card = await screen.findByRole('region', { name: 'Your AI agents' });
    await userEvent.click(within(card).getByRole('button', { name: 'Install GitHub Copilot' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install GitHub Copilot' });
    expect(within(dialog).getByRole('region', { name: 'The command' }).textContent).toBe('npm install --global --prefix /usr/local --ignore-scripts @x/y@1');
    expect(ran).toEqual([]);
    // Before anything runs, the dialog says in plain words what will and won't happen.
    expect(within(dialog).getByRole('list', { name: 'What this will do' }).textContent).toContain('Download @github/copilot-sdk 0.3.289');
    expect(within(dialog).getByRole('list', { name: 'What this will do' }).textContent).toContain('install scripts');
    expect(within(dialog).getByRole('list', { name: "What it won't do" }).textContent).toContain('Sign in for you');
    expect(within(dialog).queryByRole('list', { name: 'What changed' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Copy command' })).toBeTruthy();
    expect(await violations(container)).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(within(dialog).getByRole('log', { name: "npm's output" }).textContent).toBe('added 105 packages in 8s'));
    await waitFor(() => expect(dialog.textContent).toContain('Installed @github/copilot-sdk'));
    expect(within(dialog).getByRole('list', { name: 'What changed' }).textContent).toContain('Still yours');
    expect(ran).toEqual(['copilot: npm install --global --prefix /usr/local --ignore-scripts @x/y@1']);
  }, AXE_TIMEOUT);

  it('when an install fails, offers the organization-registry helper, which writes only the registry line and reports the file', async () => {
    const saved: string[] = [];
    const client = {
      status: async () => STATUS({ adapter: 'none', model: null, cliPath: null, endpoint: null, instructions: null, voice: null, models: {}, cliPaths: {} }),
      save: async (s: AgentSettings) => STATUS(s),
      prompt: async () => '',
      installPlan: NO_INSTALL.installPlan,
      install: async () => {
        throw new Error('npm stopped with exit code 1: ENOTFOUND registry.npmjs.org');
      },
      setRegistry: async (registry: string) => {
        saved.push(registry);
        return { file: '/home/me/.npmrc', registry: 'https://a.example.com/npm/', previous: null };
      },
    };
    await open('#/settings/agent', { preview: false, agentSettings: { client } });
    const card = await screen.findByRole('region', { name: 'Your AI agents' });
    await userEvent.click(within(card).getByRole('button', { name: 'Install GitHub Copilot' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install GitHub Copilot' });
    expect(dialog.querySelector('[data-registry-help]')).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(dialog.querySelector('[data-registry-help]')).not.toBeNull());
    expect(dialog.textContent).toContain('Artifactory');
    expect(dialog.textContent).toContain('never asks for a password');
    await userEvent.type(within(dialog).getByLabelText('Registry address'), 'https://a.example.com/npm');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save to my .npmrc' }));
    await waitFor(() => expect(dialog.textContent).toContain('Saved registry=https://a.example.com/npm/ in /home/me/.npmrc'));
    expect(saved).toEqual(['https://a.example.com/npm']);
  }, AXE_TIMEOUT);

  const STATUS = (settings: AgentSettings, installed = false): AgentStatus => ({
    settings,
    problem: null,
    kind: settings.adapter,
    adapters: [
      {
        name: 'claude',
        label: 'Claude',
        package: '@anthropic-ai/claude-agent-sdk',
        installed,
        cli: installed ? { path: '/usr/local/bin/claude', problem: null, fix: null } : { path: null, problem: "Toil UI found no claude on PATH, so it can't start Claude Code. It never downloads one.", fix: 'Install it.' },
        endpoints: ['anthropic', 'bedrock', 'foundry', 'vertex'],
        version: installed ? '0.3.289' : null, tested: '0.3.289', model: null, notes: [], install: { adapter: 'claude', kind: 'global', folder: '/usr/local', command: 'npm install --global --prefix /usr/local --ignore-scripts @x/y@1', argv: ['node', 'npm-cli.js'], problem: null, fix: null },
      },
      { name: 'copilot', label: 'GitHub Copilot', package: '@github/copilot-sdk', installed: false, cli: { path: null, problem: 'Toil UI found no copilot on PATH.', fix: null }, endpoints: [], version: null, tested: '0.3.289', model: null, notes: [], install: { adapter: 'copilot', kind: 'global', folder: '/usr/local', command: 'npm install --global --prefix /usr/local --ignore-scripts @x/y@1', argv: ['node', 'npm-cli.js'], problem: null, fix: null } },
      { name: 'codex', label: 'Codex', package: '@openai/codex-sdk', installed: false, cli: { path: null, problem: 'Toil UI found no codex on PATH.', fix: null }, endpoints: [], version: null, tested: '0.3.289', model: null, notes: [], install: { adapter: 'codex', kind: 'global', folder: '/usr/local', command: 'npm install --global --prefix /usr/local --ignore-scripts @x/y@1', argv: ['node', 'npm-cli.js'], problem: null, fix: null } },
    ],
  });

  it('in the local app, shows first-run setup as steps in a calm tone, the packages one step in, and never in red', async () => {
    const client = { status: async () => STATUS({ adapter: 'none', model: null, cliPath: null, endpoint: null, instructions: null, voice: null, models: {}, cliPaths: {} }), save: async (s: AgentSettings) => STATUS(s), prompt: async () => '', ...NO_INSTALL };
    const { container } = await open('#/settings/agent', { preview: false, agentSettings: { client } });
    const choice = await screen.findByRole('region', { name: 'Your AI agents' });
    const agentPanel = choice;
    await within(choice).findByRole('radiogroup', { name: 'Which AI agent answers' });
    // One card: each helper is a row with its choice, its state and Install, never in red.
    expect(choice.querySelector('.agent-missing, .failure')).toBeNull();
    expect(within(choice).getAllByRole('button', { name: /^Install / })).toHaveLength(3);
    const rows = [...document.querySelectorAll('.helper-row[data-adapter]')];
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['new', 'new', 'new']);
    expect(rows[0]!.textContent).toContain('Not set up yet');
    // The CLI problem is one step in; package names and npm notes aren't on screen, behind the details.
    const fold = rows[0]!.querySelector('details')!;
    expect(fold.open).toBe(false);
    expect(fold.textContent).not.toContain('@anthropic-ai/claude-agent-sdk');
    expect(fold.textContent).toContain('Toil UI found no claude on PATH');
    // Models, CLI path and endpoint are advanced: behind a fold, below the steps.
    expect((choice.querySelector('details[data-advanced]') as HTMLDetailsElement).open).toBe(false);
    expect(within(agentPanel).queryByLabelText(/key|token/i)).toBeNull();
    expect(await violations(container)).toEqual([]);
  }, AXE_TIMEOUT);

  it('says an installed helper that cannot start yet needs one more step, with the reason on screen and not in red', async () => {
    const base = STATUS({ adapter: 'none', model: null, cliPath: null, endpoint: null, instructions: null, voice: null, models: {}, cliPaths: {} });
    const adapters = base.adapters.map((a) => (a.name === 'claude' ? { ...a, installed: true, version: '0.3.289' } : a));
    const client = { status: async () => ({ ...base, adapters }), save: async (s: AgentSettings) => STATUS(s), prompt: async () => '', ...NO_INSTALL };
    await open('#/settings/agent', { preview: false, agentSettings: { client } });
    const row = await waitFor(() => {
      const r = document.querySelector('.helper-row[data-adapter="claude"]');
      if (!r) throw new Error('not yet');
      return r as HTMLElement;
    });
    expect(row.getAttribute('data-state')).toBe('fix');
    expect(row.querySelector('[data-needs-fix]')!.textContent).toContain('Toil UI found no claude on PATH');
    expect(row.querySelector('.failure, .agent-missing')).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Install Claude' })).toBeNull();
  });

  it('saves the adapter, model, CLI path and Claude endpoint, and says so', async () => {
    const saves: AgentSettings[] = [];
    const changed: AgentStatus[] = [];
    const client = { status: async () => STATUS({ adapter: 'none', model: null, cliPath: null, endpoint: null, instructions: null, voice: null, models: {}, cliPaths: {} }, true), save: async (s: AgentSettings) => (saves.push(s), STATUS(s, true)), prompt: async () => '', ...NO_INSTALL };
    const { container } = await open('#/settings/agent', { preview: false, agentSettings: { client, onChange: (s) => changed.push(s) } });
    const choice = await screen.findByRole('region', { name: 'Your AI agents' });
    await userEvent.click(await within(choice).findByRole('radio', { name: /^Claude/ }));
    await userEvent.click(within(choice).getByText(/^Advanced:/));
    await userEvent.type(within(choice).getByRole('textbox', { name: "Claude's model" }), 'sonnet');
    await userEvent.click(within(choice).getByRole('radio', { name: 'Amazon Bedrock' }));
    expect(await violations(container)).toEqual([]);
    // The instructions below are part of the same form, so there is one Save for the whole page.
    await userEvent.type(screen.getByRole('textbox', { name: 'General instructions' }), ' lead with risks ');
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getAllByRole('status').map((s) => s.textContent)).toContain('Saved: Claude answers from the next question, with your instructions.'));
    expect(saves).toEqual([{ adapter: 'claude', model: 'sonnet', cliPath: null, endpoint: 'bedrock', instructions: 'lead with risks', voice: null, models: { claude: 'sonnet' }, cliPaths: {} }]);
    expect(changed).toHaveLength(1);
  }, AXE_TIMEOUT);
});
