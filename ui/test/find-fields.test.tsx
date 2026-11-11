import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import type { ConfigApi } from '../src/config.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIELD_DISCOVERY, fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import type { Envelope } from '../src/toil.ts';
import { FindFields } from '../src/views/settings/FindFields.tsx';

/**
 * Find the fields (#561): the read, the table per issue type, what starts
 * ticked, the one `projects field` call per name and its own result, a partial
 * failure with a retry that repeats only what failed, and the wizard step that
 * can be skipped without any call. Nothing here reaches a Jira.
 */

const meta = (command: string) => ({ command, durationMs: 0, version: 'test', contractVersion: 1 });
const ok = (command: string, data: unknown): Envelope => ({ ok: true, data, error: null, meta: meta(command) }) as Envelope;
const refused = (command: string, message: string): Envelope => ({ ok: false, data: null, error: { code: 'INVALID_INPUT', message, fix: 'Pass --replace.' }, meta: meta(command) }) as Envelope;

interface Call {
  command: string;
  input: Record<string, unknown>;
}

/** A machine with a Jira connection and one Toil project; `failing` lines are refused until `heal()`. */
function machine(failing: string[] = [], named: string | Record<string, string> | null = null) {
  const calls: Call[] = [];
  let broken = new Set(failing);
  const config: ConfigApi = {
    disabled: null,
    areas: () => fixtureConfig().areas(),
    settings: () => fixtureConfig().settings(),
    run: async (command, input) => {
      calls.push({ command, input });
      if (command === 'connections list') return ok(command, { configFile: '/home/you/.toil/config.json', connections: [{ name: 'corp-jira', area: 'jira', isDefault: true, host: 'jira.imagile.dev', writes: false, values: {}, definedIn: 'file' }] });
      if (command === 'projects list') return ok(command, { toilProjects: [{ name: 'payments', description: null, source: 'user', file: '/home/you/.toil/projects/payments.json', shadowedBy: null, problems: 0 }], places: { user: '/home/you/.toil/projects' } });
      if (command === 'projects show') return ok(command, { areas: typeof named === 'string' ? { jira: { inputs: { project: named } } } : {}, toilProject: named ? { jira: { project: named } } : {} });
      if (command === 'jira field discover') return ok(command, (input.project === 'NONE' || Array.isArray(input.issue)) ? { ...FIELD_DISCOVERY, issueTypes: [{ name: 'Story', sampled: ['NONE-1'], status: 'sampled', fields: [] }], fields: [], commands: [] } : FIELD_DISCOVERY);
      if (command === 'projects field') {
        const line = `${input.alias}`;
        if (broken.has(line)) return refused(command, `"${line}" already names another field.`);
        return ok(command, { name: input.toilProject, file: '/home/you/.toil/projects/payments.json', source: 'user', changed: true });
      }
      return ok(command, {});
    },
  };
  return { config, calls, heal: () => (broken = new Set()) };
}

const connections = [{ name: 'corp-jira', area: 'jira' }];
const mount = (config: ConfigApi, extra: Partial<Parameters<typeof FindFields>[0]> = {}) => render(<FindFields config={config} toilProjects={['payments']} toilProject="payments" connections={connections} connection="corp-jira" {...extra} />);
const press = (name: string | RegExp) => userEvent.click(screen.getByRole('button', { name }));
const reads = (calls: Call[]) => calls.filter((c) => c.command === 'jira field discover');
const keySaves = (calls: Call[]) => calls.filter((c) => c.command === 'projects link').map((c) => c.input);
const saves = (calls: Call[]) => calls.filter((c) => c.command === 'projects field').map((c) => `${c.input.alias}=${c.input.id}${c.input.replace ? ' --replace' : ''}`);

async function read(project = 'PAY') {
  await userEvent.type(screen.getByLabelText(/^Jira project key/), project);
  await press('Read the fields');
  await screen.findByRole('heading', { level: 4, name: 'Story' });
}

describe('Find the fields', () => {
  it('reads one issue of each type through toil jira field discover and shows a table per type', async () => {
    const { config, calls } = machine();
    mount(config);
    expect(document.body.textContent).toContain('changes nothing in it');
    await read();
    expect(reads(calls).map((c) => c.input)).toEqual([{ connection: 'corp-jira', project: 'PAY', perType: 1 }]);
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Story', 'Bug', 'Epic']);
    const story = screen.getByRole('table', { name: /Custom fields that hold a value on Story/ });
    expect(within(story).getAllByRole('row')).toHaveLength(4);
    expect(story.textContent).toContain('Sprint 7 (active)');
    expect(story.textContent).toContain('Story points, sure');
    expect(story.textContent).toContain('Sprint, sure');
    // No Epic to read is unknown, and says so, rather than "no fields".
    expect(screen.getByText(/No Epic issue was found to read, so toil can't say which fields it uses/)).toBeTruthy();
    // Nothing was written by reading.
    expect(saves(calls)).toEqual([]);
  });

  it('ticks only what toil is sure of, and names each ticked field with one projects field call, shown first', async () => {
    const { config, calls } = machine();
    mount(config);
    await read();
    const ticked = (name: RegExp) => (screen.getAllByRole('checkbox', { name })[0] as HTMLInputElement).checked;
    expect(ticked(/Name Story point estimate/)).toBe(true);
    expect(ticked(/Name Sprint in/)).toBe(true);
    expect(ticked(/Name Crew/)).toBe(false);
    expect(document.body.textContent).not.toContain('Runs ');
    await press('Name these fields');
    await screen.findByText(/5 of 5 saved/);
    expect(saves(calls)).toEqual(['storyPointEstimate=customfield_10016', 'estimate=customfield_10016 --replace', 'sprint=customfield_10020', 'iteration=customfield_10020 --replace']);
    const done = document.querySelector('[data-find-done]')!.textContent!;
    expect(done).toContain('Nothing was changed in Jira.');
    // A name is the person's to change, and an unticked row is not sent.
    expect(calls.some((c) => c.command === 'projects field' && c.input.id === 'customfield_10200')).toBe(false);
  });

  it('lets a person tick a field toil was unsure of, and rename one', async () => {
    const { config, calls } = machine();
    mount(config);
    await read();
    await userEvent.click(screen.getAllByRole('checkbox', { name: /Name Crew/ })[0]!);
    const alias = screen.getAllByLabelText('Name for Crew in toil')[0]!;
    await userEvent.clear(alias);
    await userEvent.type(alias, 'team');
    await userEvent.click(screen.getAllByRole('checkbox', { name: /Name Sprint in/ })[0]!);
    await userEvent.click(screen.getAllByRole('checkbox', { name: /Name Story point estimate/ })[0]!);
    await press('Name these fields');
    await screen.findByText(/2 of 2 saved/);
    expect(saves(calls)).toEqual(['team=customfield_10200']);
  });

  it('refuses a name that is not a camelCase word, and sends nothing', async () => {
    const { config, calls } = machine();
    mount(config);
    await read();
    const alias = screen.getAllByLabelText('Name for Sprint in toil')[0]!;
    await userEvent.clear(alias);
    await userEvent.type(alias, 'My Sprint');
    expect(screen.getByRole('alert').textContent).toContain('camelCase');
    expect((screen.getByRole('button', { name: 'Name these fields' }) as HTMLButtonElement).disabled).toBe(true);
    expect(saves(calls)).toEqual([]);
  });

  it('reports each name on its own, and retries only the ones that failed', async () => {
    const { config, calls, heal } = machine(['iteration']);
    mount(config);
    await read();
    await press('Name these fields');
    await screen.findByText(/4 of 5 saved/);
    const list = screen.getByRole('list', { name: 'What happened to each name' });
    const lines = within(list).getAllByRole('listitem').map((li) => li.textContent);
    expect(lines.filter((l) => l!.includes('failed'))).toHaveLength(1);
    expect(lines.find((l) => l!.includes('failed'))).toContain('"iteration" already names another field. Fix: Pass --replace.');
    expect(lines.filter((l) => l!.includes(': saved'))).toHaveLength(4);
    const before = saves(calls).length;
    heal();
    await press('Try the failed ones again');
    await screen.findByText(/5 of 5 saved/);
    expect(saves(calls).slice(before)).toEqual(['iteration=customfield_10020 --replace']);
    expect(screen.queryByRole('button', { name: 'Try the failed ones again' })).toBeNull();
  });

  it('saves the Jira project key it sampled from where the Toil project names none, as one more call, and never with --replace', async () => {
    const { config, calls } = machine();
    mount(config);
    await read('PAY');
    expect(document.querySelector('[data-find-key]')!.textContent).toMatch(/payments names no Jira project yet.*PAY/);
    await press('Name these fields');
    await screen.findByText(/5 of 5 saved/);
    expect(keySaves(calls)).toEqual([{ toilProject: 'payments', area: 'jira', set: ['project=PAY'] }]);
    // The key goes after the field names, and shows in the results by its own label.
    expect(calls.filter((c) => c.command === 'projects field' || c.command === 'projects link').at(-1)!.command).toBe('projects link');
    expect(screen.getByRole('list', { name: 'What happened to each name' }).textContent).toContain('Jira project key: saved');
  });

  it('saves the key the sample was read from, not one edited into the box after the read', async () => {
    const { config, calls } = machine();
    mount(config);
    await read('PAY');
    await userEvent.type(screen.getByLabelText(/^Jira project key/), 'X');
    await press('Name these fields');
    await screen.findByText(/5 of 5 saved/);
    expect(keySaves(calls)).toEqual([{ toilProject: 'payments', area: 'jira', set: ['project=PAY'] }]);
  });

  it('leaves the key alone when the Toil project already names one, and says nothing about it', async () => {
    const { config, calls } = machine([], 'PAY');
    mount(config);
    await waitFor(() => expect((screen.getByLabelText(/^Jira project key/) as HTMLInputElement).value).toBe('PAY'));
    await press('Read the fields');
    await screen.findByRole('heading', { level: 4, name: 'Story' });
    expect(document.querySelector('[data-find-key]')).toBeNull();
    await press('Name these fields');
    await screen.findByText(/4 of 4 saved/);
    expect(keySaves(calls)).toEqual([]);
  });

  it('treats a per-repository project map as naming one, though it resolves to nothing here: no save and no note', async () => {
    const { config, calls } = machine([], { 'C:/Code/elsewhere': 'PAY' });
    mount(config);
    await read('PAY');
    expect(document.querySelector('[data-find-key]')).toBeNull();
    expect(document.body.textContent).not.toContain('names no Jira project yet');
    await press('Name these fields');
    await screen.findByText(/4 of 4 saved/);
    expect(keySaves(calls)).toEqual([]);
  });

  it('does not save a key it could not compare with the Toil project (unknown is not none)', async () => {
    const { config, calls } = machine();
    const run = config.run;
    config.run = async (command, input, extra) => (command === 'projects show' ? refused(command, 'Could not read it.') : run(command, input, extra));
    mount(config);
    await read('PAY');
    expect(document.querySelector('[data-find-key]')).toBeNull();
    await press('Name these fields');
    await screen.findByText(/4 of 4 saved/);
    expect(keySaves(calls)).toEqual([]);
  });

  it('reads issues the person names, and says a type with nothing set has no custom fields (not unknown)', async () => {
    const { config, calls } = machine();
    mount(config);
    await userEvent.click(screen.getByRole('radio', { name: /Use issues I pick/ }));
    await userEvent.type(screen.getByLabelText(/^Issue keys/), 'NONE-1, NONE-2');
    expect(document.body.textContent).not.toContain('Runs ');
    await press('Read the fields');
    await screen.findByRole('heading', { level: 4, name: 'Story' });
    expect(reads(calls)[0]!.input).toEqual({ connection: 'corp-jira', issue: ['NONE-1', 'NONE-2'] });
    expect(document.body.textContent).toContain('No custom field holds a value on NONE-1.');
    expect(document.body.textContent).toContain('No custom fields hold a value on what toil read.');
    expect(screen.queryByRole('button', { name: 'Name these fields' })).toBeNull();
  });

  it('shows a refusal from toil, with its fix, and nothing else', async () => {
    const { config } = machine();
    const run = config.run;
    config.run = async (command, input, extra) => (command === 'jira field discover' ? refused(command, 'Jira says no such project.') : run(command, input, extra));
    mount(config);
    await userEvent.type(screen.getByLabelText(/^Jira project key/), 'NOPE');
    await press('Read the fields');
    expect((await screen.findByRole('alert')).textContent).toContain('Jira says no such project.');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('is off in the preview, with the reason beside the button', async () => {
    mount(fixtureConfig());
    await userEvent.clear(screen.getByLabelText(/^Jira project key/));
    await userEvent.type(screen.getByLabelText(/^Jira project key/), 'PAY');
    await press('Read the fields');
    await screen.findByRole('heading', { level: 4, name: 'Story' });
    expect((screen.getByRole('button', { name: 'Name these fields' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toMatch(/Turned off: This is the preview/);
  });

  it('says what is missing instead of offering a read it cannot make', () => {
    mount(machine().config, { connections: [] });
    expect(document.body.textContent).toContain('There is no Jira connection yet');
    expect(screen.queryByRole('button', { name: 'Read the fields' })).toBeNull();
  });

  it('passes axe with results on screen', async () => {
    const { container } = mount(machine().config);
    await read();
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
});

describe('the wizard step', () => {
  async function toStep(config: ConfigApi) {
    window.location.hash = '#/setup';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={config} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1, name: 'Welcome' }, { timeout: 3000 });
    await press('Start');
    await screen.findByRole('heading', { level: 1, name: 'An AI agent (optional)' });
    await userEvent.click(screen.getByRole('radio', { name: /^Not now/ }));
    await press(/^Next/);
    await screen.findByRole('heading', { level: 1, name: 'Which tools do you use?' });
    await userEvent.click(screen.getByRole('checkbox', { name: /add tools later/ }));
    await press(/^Next/);
    await screen.findByRole('heading', { level: 1, name: 'Your Toil project' });
    await press(/^Next/);
    await screen.findByRole('heading', { level: 1, name: 'Let toil learn your Jira fields (optional)' });
  }

  it('is optional: Next is off until Not now is chosen, then it moves on and nothing is read or saved', async () => {
    const { config, calls } = machine();
    await toStep(config);
    expect(document.body.textContent).toContain('Recommended.');
    expect((screen.getByRole('button', { name: /^Next/ }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('radio', { name: /^Not now/ }));
    await press(/^Next/);
    await screen.findByRole('heading', { level: 1, name: 'All set' });
    expect(reads(calls)).toEqual([]);
    expect(saves(calls)).toEqual([]);
  });

  it('reads through the linked Jira connection into the chosen Toil project', async () => {
    const { config, calls } = machine();
    await toStep(config);
    await userEvent.type(screen.getByLabelText(/^Jira project key/), 'PAY');
    await press('Read the fields');
    await screen.findByRole('heading', { level: 4, name: 'Story' });
    await press('Name these fields');
    await waitFor(() => expect(saves(calls)).toHaveLength(4));
    expect(calls.find((c) => c.command === 'projects field')!.input).toMatchObject({ toilProject: 'payments', area: 'jira' });
    expect(reads(calls)[0]!.input).toMatchObject({ connection: 'corp-jira' });
  }, 30_000);
});

describe('in Settings and the palette', () => {
  it('has its own address in Settings, Toil projects, and the form that names one field links to it', async () => {
    window.location.hash = '#/settings/projects/card-payments/find-fields';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 3, name: 'Find the fields' }, { timeout: 5000 });
    const link = screen.getByRole('link', { name: 'Find the fields' });
    expect(link.getAttribute('href')).toBe('#/settings/projects/card-payments/find-fields');
  }, 15_000);
});
