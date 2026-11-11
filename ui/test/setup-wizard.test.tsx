import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { App, parseRoute } from '../src/App.tsx';
import type { ConfigAnswers, ConfigApi } from '../src/config.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { groupAreas } from '../src/setup.ts';
import { FIXTURE_AREAS } from '../src/fixtures/config.ts';
import type { Envelope } from '../src/toil.ts';

/**
 * The setup wizard (#561): the step flow, skipping and going back, what it
 * sends to toil (the secret only as the call's `secrets`, writes never turned
 * on), and that no password field exists outside the one Settings form it
 * reuses. The server's side of the secret (never in a response, the config
 * file, the audit log or the output) is held by config.test.ts for the same
 * `connections add` call.
 */

const SECRET = 'fake-pat-abc12345-typed-once';

interface Call {
  command: string;
  input: Record<string, unknown>;
  extra: ConfigAnswers | undefined;
}

/** A config that answers like an empty machine, records every call, and allows changes. */
function emptyMachine(existing: unknown[] = [], payments?: { show: 'fails' | Record<string, unknown> }) {
  const calls: Call[] = [];
  const base = fixtureConfig();
  const ok = (command: string, data: unknown): Envelope => ({ ok: true, data, error: null, meta: { command, durationMs: 0, version: 'test', contractVersion: 1 } }) as Envelope;
  const config: ConfigApi = {
    disabled: null,
    areas: () => base.areas(),
    settings: () => base.settings(),
    run: async (command, input, extra) => {
      calls.push({ command, input, extra });
      if (command === 'connections list') return ok(command, { configFile: '/home/you/.toil/config.json', connections: existing });
      if (command === 'projects list') return ok(command, { toilProjects: payments ? [{ name: 'payments', description: null, source: 'user', file: '/home/you/.toil/projects/payments.json', shadowedBy: null, problems: 0 }] : [], places: { user: '/home/you/.toil/projects' } });
      if (command === 'projects show' && payments) return payments.show === 'fails' ? ({ ok: false, data: null, error: { code: 'NOT_FOUND', message: 'No such Toil project.', fix: 'Check the name.' }, meta: { command, durationMs: 0, version: 'test', contractVersion: 1 } } as Envelope) : ok(command, { name: 'payments', areas: {}, toilProject: payments.show });
      if (command === 'connections add') return ok(command, { name: input.name, area: input.area, secrets: { token: 'store' }, writes: false });
      if (command === 'connections test') return ok(command, { name: input.name, area: 'github', host: 'github.imagile.dev', live: true, authenticated: true, request: 'GET /user' });
      return ok(command, {});
    },
  };
  return { config, calls };
}

async function open(config: ConfigApi, onSync?: () => void) {
  window.location.hash = '#/setup';
  const view = render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={config} now={FIXTURE_NOW} preview {...(onSync ? { onSync } : {})} />);
  await screen.findByRole('heading', { level: 1, name: 'Welcome' }, { timeout: 3000 });
  return view;
}

const press = (name: string) => userEvent.click(name === 'Next' ? screen.getByRole('button', { name: /^Next/ }) : screen.getByRole('button', { name }));
const nextButton = () => screen.getByRole('button', { name: /^Next/ }) as HTMLButtonElement;
const why = () => document.querySelector('[data-setup-why]')?.textContent ?? null;
/** The optional choice on a page: the AI agent's and the Toil project's "Not now" radio. */
const notNow = () => userEvent.click(screen.getByRole('radio', { name: /^Not now/ }));
const laterTools = () => userEvent.click(screen.getByRole('checkbox', { name: /add tools later/ }));
const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
const progress = () => screen.getByText(/^Step \d of 7/).textContent;
const passwordFields = () => document.querySelectorAll('input[type="password"]').length;

describe('the setup wizard', () => {
  it('has an address of its own, and the first run, Settings and the palette lead to it', () => {
    expect(parseRoute('#/setup')).toEqual({ view: 'setup' });
    const src = (file: string) => readFileSync(join(import.meta.dirname, '..', 'src', file), 'utf8');
    expect(src('components/first-run.tsx')).toContain('SETUP_HREF');
    expect(src('views/Settings.tsx')).toContain('href="#/setup"');
    expect(src('components/palette.tsx')).toContain("go: { href: '#/setup' }");
  });

  it('welcomes in plain words and promises nothing changes without you', async () => {
    await open(emptyMachine().config);
    expect(progress()).toContain('Step 1 of 7');
    expect(document.querySelector('[data-setup-promise]')!.textContent).toMatch(/Nothing is changed in your tools without you/);
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
  });

  it('lists the common tools first, from the registry, and the rest behind More', async () => {
    const { common, more } = groupAreas(FIXTURE_AREAS);
    expect(common.map((a) => a.name)).toEqual(['github', 'jira', 'ado', 'bitbucket']);
    expect(more.map((a) => a.name)).toEqual(['jenkins', 'openshift']);
    await open(emptyMachine().config);
    await press('Start');
    await screen.findByRole('heading', { level: 1, name: 'An AI agent (optional)' });
    await notNow();
    await press('Next');
    await screen.findByRole('heading', { level: 1, name: 'Which tools do you use?' });
    const boxes = screen.getAllByRole('checkbox').map((b) => b.getAttribute('data-setup-tool'));
    expect(boxes.slice(0, 4)).toEqual(['github', 'jira', 'ado', 'bitbucket']);
    expect(document.querySelector('[data-setup-more] summary')!.textContent).toBe('More tools (2)');
  });

  it('asks for the Jira project key on the Toil project step and saves it on the Jira link', async () => {
    const jira = { name: 'corp-jira', area: 'jira', isDefault: true, host: 'jira.imagile.dev', writes: false, values: { baseUrl: 'file', apiToken: 'store' }, definedIn: 'file' };
    const { config, calls } = emptyMachine([jira]);
    await open(config);
    await press('Start');
    await screen.findByRole('heading', { level: 1, name: 'An AI agent (optional)' });
    await notNow();
    await press('Next');
    // A tool that is already linked starts ticked.
    expect(((await screen.findByRole('checkbox', { name: /Jira/ })) as HTMLInputElement).checked).toBe(true);
    await press('Next');
    await screen.findByRole('heading', { level: 1, name: 'Link Jira' });
    await press('Next');
    await screen.findByRole('heading', { level: 1, name: 'Your Toil project' });
    const field = document.querySelector('[data-setup-jira-key]')!;
    expect(field.textContent).toContain('Jira project key (optional)');
    expect(field.textContent).toMatch(/such as PAY in PAY-123/);
    // The consequence is in the (i), not on the screen; the field sits inside the create panel, after the folders.
    expect(field.textContent).not.toMatch(/reads no Jira issues/);
    expect(field.closest('form')).not.toBeNull();
    expect(field.previousElementSibling!.getAttribute('data-setup-repos')).toBe('');
    await userEvent.type(screen.getByLabelText(/^Jira project key/), 'PAY');
    await userEvent.type(screen.getByLabelText(/^Name/), 'payments');
    await userEvent.click(screen.getByRole('button', { name: 'Create this Toil project' }));
    await screen.findByText(/payments was created. Jira linked to payments./);
    expect(calls.find((c) => c.command === 'projects link')!.input).toEqual({ toilProject: 'payments', area: 'jira', connection: 'corp-jira', set: ['project=PAY'] });
  });

  describe('with a Toil project that exists', () => {
    const jira = { name: 'corp-jira', area: 'jira', isDefault: true, host: 'jira.imagile.dev', writes: false, values: { baseUrl: 'file', apiToken: 'store' }, definedIn: 'file' };
    async function toProjectStep(config: ConfigApi) {
      await open(config);
      await press('Start');
      await screen.findByRole('heading', { level: 1, name: 'An AI agent (optional)' });
      await notNow();
      await press('Next');
      await screen.findByRole('checkbox', { name: /Jira/ });
      await press('Next');
      await screen.findByRole('heading', { level: 1, name: 'Link Jira' });
      await press('Next');
      await screen.findByRole('heading', { level: 1, name: 'Your Toil project' });
    }
    const links = (calls: Call[]) => calls.filter((c) => c.command === 'projects link').map((c) => c.input);

    it('shows a quiet line, and no field, when it already names a Jira project, and sends no key', async () => {
      const { config, calls } = emptyMachine([jira], { show: { jira: { project: 'PAY' } } });
      await toProjectStep(config);
      expect((await screen.findByText('Reads Jira project PAY.')).getAttribute('data-jira-named')).toBe('');
      expect(document.querySelector('[data-setup-jira-key]')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Link Jira to payments' }));
      await screen.findByText(/Jira linked to payments/);
      expect(links(calls)).toEqual([{ toilProject: 'payments', area: 'jira', connection: 'corp-jira' }]);
    });

    it('says a per-repository map reads a project per repository, with no field and no warning', async () => {
      const { config } = emptyMachine([jira], { show: { jira: { project: { 'C:/Code/pay': 'PAY' } } } });
      await toProjectStep(config);
      await screen.findByText('Reads a Jira project per repository.');
      expect(document.querySelector('[data-setup-jira-key]')).toBeNull();
      expect(document.querySelector('[role="alert"]')).toBeNull();
    });

    it('asks for the key above the Link button when it names none, and sends it with the connection', async () => {
      const { config, calls } = emptyMachine([jira], { show: { jira: {} } });
      await toProjectStep(config);
      const field = (await waitFor(() => document.querySelector('[data-setup-jira-key]')!)) as HTMLElement;
      const link = screen.getByRole('button', { name: 'Link Jira to payments' });
      expect(field.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await userEvent.type(screen.getByLabelText(/^Jira project key/), 'PAY');
      await userEvent.click(link);
      await screen.findByText(/Jira linked to payments/);
      expect(links(calls)).toEqual([{ toilProject: 'payments', area: 'jira', connection: 'corp-jira', set: ['project=PAY'] }]);
    });

    it('shows no field and sends no key when what it names could not be read (unknown is not none)', async () => {
      const { config, calls } = emptyMachine([jira], { show: 'fails' });
      await toProjectStep(config);
      await userEvent.click(screen.getByRole('button', { name: 'Link Jira to payments' }));
      await screen.findByText(/Jira linked to payments/);
      expect(document.querySelector('[data-setup-jira-key]')).toBeNull();
      expect(document.querySelector('[data-jira-named]')).toBeNull();
      expect(links(calls)).toEqual([{ toilProject: 'payments', area: 'jira', connection: 'corp-jira' }]);
    });
  });

  it('walks every step, sending the secret only as the call\'s secrets and leaving writes off', async () => {
    const { config, calls } = emptyMachine();
    let synced = 0;
    await open(config, () => synced++);
    await press('Start');
    // The AI agent comes first, and is skipped here: the wizard is what it always was.
    await screen.findByRole('heading', { level: 1, name: 'An AI agent (optional)' });
    expect(progress()).toContain('Step 2 of 7');
    expect(document.querySelector('[data-setup-optional]')!.textContent).toMatch(/Everything else works without one/);
    await notNow();
    await press('Next');
    await userEvent.click(await screen.findByRole('checkbox', { name: /GitHub/ }));
    await press('Next');

    await screen.findByRole('heading', { level: 1, name: 'Link GitHub' });
    expect(progress()).toContain('Step 4 of 7');
    // GitHub.com is the selected radio, so there is no address to type.
    expect((screen.getByRole('radio', { name: /^GitHub.com/ }) as HTMLInputElement).checked).toBe(true);
    await userEvent.type(screen.getByLabelText(/^token/), SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Save connection' }));
    await waitFor(() => expect(document.querySelector('[data-setup-linked="github"]')).not.toBeNull());

    const add = calls.find((c) => c.command === 'connections add')!;
    expect(add.input).toEqual({ name: 'github', area: 'github' });
    expect(add.extra?.answers).toMatchObject({ 'setting:baseUrl': 'https://api.github.com' });
    expect(add.extra?.secrets).toEqual({ token: SECRET });
    expect(JSON.stringify([add.input, add.extra?.answers])).not.toContain(SECRET);
    expect(calls.some((c) => c.command === 'connections writes')).toBe(false);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.querySelector('[data-setup-linked]')!.textContent).toMatch(/It can only read/);

    await press('Test the link');
    await screen.findByText(/GitHub answered, so its login works/);

    await press('Next');
    await screen.findByRole('heading', { level: 1, name: 'Your Toil project' });
    expect(nextButton().disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(/^Name/), 'payments');
    await userEvent.click(screen.getByRole('button', { name: 'Create this Toil project' }));
    await screen.findByText(/payments was created\. GitHub linked to payments\./);
    await waitFor(() => expect(nextButton().disabled).toBe(false));
    expect(nextButton().textContent).toBe('Next: Fields');
    expect(calls.find((c) => c.command === 'projects init')!.input).toEqual({ name: 'payments' });
    expect(calls.find((c) => c.command === 'projects link')!.input).toEqual({ toilProject: 'payments', area: 'github', connection: 'github' });

    await press('Next');
    // Jira isn't linked, so the optional field step has nothing to read or decide.
    await screen.findByRole('heading', { level: 1, name: 'Let toil learn your Jira fields (optional)' });
    expect(document.querySelector('[data-find-none]')!.textContent).toMatch(/Jira isn't linked/);
    await press('Next');

    await screen.findByRole('heading', { level: 1, name: 'All set' });
    const summary = screen.getByRole('list', { name: 'What was set up' });
    expect(summary.textContent).toContain('GitHub (github), read-only');
    expect(summary.textContent).toContain('Toil project: payments');
    expect(summary.textContent).toContain('No AI agent, which is fine');
    await press('Sync now');
    expect(synced).toBe(1);
    expect(document.body.textContent).not.toContain(SECRET);
  }, 30_000);

  it('has no Skip button; each optional page is answered with Not now, and walking back works', async () => {
    await open(emptyMachine().config);
    await press('Start');
    await screen.findByRole('heading', { level: 1, name: 'An AI agent (optional)' });
    await notNow();
    await press('Next');
    await screen.findByRole('heading', { level: 1, name: 'Which tools do you use?' });
    await laterTools();
    expect(nextButton().textContent).toBe('Next: Toil project');
    await press('Next');
    await screen.findByRole('heading', { level: 1, name: 'Your Toil project' });
    expect(progress()).toContain('Step 5 of 7');
    await notNow();
    await press('Next');
    await screen.findByRole('heading', { level: 1, name: 'Let toil learn your Jira fields (optional)' });
    await press('Next');
    await screen.findByRole('heading', { level: 1, name: 'All set' });
    expect(screen.getByRole('list', { name: 'What was set up' }).textContent).toContain('No new tool links');
    expect(screen.getByRole('list', { name: 'What was set up' }).textContent).toContain('No AI agent, which is fine');
    await press('Back');
    await screen.findByRole('heading', { level: 1, name: 'Let toil learn your Jira fields (optional)' });
    await press('Back');
    await press('Back');
    await screen.findByRole('heading', { level: 1, name: 'Which tools do you use?' });
    expect((screen.getByRole('checkbox', { name: /add tools later/ }) as HTMLInputElement).checked).toBe(true);
    await press('Back');
    await screen.findByRole('heading', { level: 1, name: 'An AI agent (optional)' });
    expect((screen.getByRole('radio', { name: /^Not now/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('keeps Next off, with the reason beside it, until each page is done, and has no Skip anywhere', async () => {
    await open(emptyMachine().config);
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull();
    await press('Start');
    await heading('An AI agent (optional)');
    expect(nextButton().disabled).toBe(true);
    expect(nextButton().textContent).toBe('Next: Tools');
    expect(why()).toBe('Choose an AI agent, or Not now, first.');
    expect(nextButton().getAttribute('aria-describedby')).toBe('setup-next-why');
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull();
    await notNow();
    expect(nextButton().disabled).toBe(false);
    expect(why()).toBeNull();
    await press('Next');
    await heading('Which tools do you use?');
    expect(nextButton().disabled).toBe(true);
    expect(why()).toMatch(/Tick a tool, or choose I'll add tools later/);
    await userEvent.click(screen.getByRole('checkbox', { name: /GitHub/ }));
    expect(nextButton().disabled).toBe(false);
    await userEvent.click(screen.getByRole('checkbox', { name: /GitHub/ }));
    expect(nextButton().disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: /GitHub/ }));
    await press('Next');
    await heading('Link GitHub');
    expect(nextButton().disabled).toBe(true);
    expect(why()).toMatch(/Save the connection/);
    await press('Back');
    await laterTools();
    await press('Next');
    await heading('Your Toil project');
    expect(nextButton().disabled).toBe(true);
    expect(why()).toMatch(/Choose a Toil project, create one, or choose Not now/);
    await notNow();
    expect(nextButton().disabled).toBe(false);
    expect(screen.queryByRole('button', { name: /Skip/ })).toBeNull();
  }, 30_000);

  it('keeps Next off on the Fields step until the fields are named or Not now is chosen', async () => {
    const jira = { name: 'corp-jira', area: 'jira', isDefault: true, host: 'jira.imagile.dev', writes: false, values: {}, definedIn: 'file' };
    const { config } = emptyMachine([jira]);
    const run = config.run;
    config.run = async (command, input, extra) => (command === 'projects list' ? ({ ok: true, data: { toilProjects: [{ name: 'payments', description: null }], places: {} }, error: null, meta: { command, durationMs: 0, version: 't', contractVersion: 1 } } as Envelope) : run(command, input, extra));
    await open(config);
    await press('Start');
    await notNow();
    await press('Next');
    await laterTools();
    await press('Next');
    await heading('Your Toil project');
    await press('Next');
    await heading('Let toil learn your Jira fields (optional)');
    expect(nextButton().disabled).toBe(true);
    expect(nextButton().textContent).toBe('Next: All set');
    expect(why()).toBe('Name the fields, or choose Not now, first.');
    await userEvent.click(screen.getByRole('radio', { name: /^Not now/ }));
    expect(nextButton().disabled).toBe(false);
    await press('Next');
    await heading('All set');
  }, 30_000);

  it('lists each AI agent once, as one choice with Not now, and a helper that is not ready cannot be chosen', async () => {
    await open(emptyMachine().config);
    await press('Start');
    await heading('An AI agent (optional)');
    expect(document.querySelectorAll('[data-adapter]')).toHaveLength(3);
    expect(screen.getAllByText('GitHub Copilot')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Your AI agents' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use this helper' })).toBeNull();
    expect(screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['claude', 'copilot', 'codex', '__later']);
    expect((screen.getByRole('radio', { name: /^Claude/ }) as HTMLInputElement).disabled).toBe(true);
    expect(document.querySelector('[data-adapter="claude"]')!.textContent).toContain('It has to be installed and signed in before you can choose it.');
    // Choosing a ready one is the whole answer.
    await userEvent.click(screen.getByRole('radio', { name: /^GitHub Copilot/ }));
    expect(nextButton().disabled).toBe(false);
    await press('Next');
    await heading('Which tools do you use?');
  });

  it('starts the tools that are already linked ticked', async () => {
    const jira = { name: 'corp-jira', area: 'jira', isDefault: true, host: 'jira.imagile.dev', writes: false, values: {}, definedIn: 'file' };
    await open(emptyMachine([jira]).config);
    await press('Start');
    await notNow();
    await press('Next');
    await heading('Which tools do you use?');
    await waitFor(() => expect((screen.getByRole('checkbox', { name: /Jira/ }) as HTMLInputElement).checked).toBe(true));
    expect(screen.getByText(/Already linked: corp-jira/)).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: /GitHub/ }) as HTMLInputElement).checked).toBe(false);
    expect(nextButton().disabled).toBe(false);
  });

  it('offers no terminal command, and a refusal from toil stays on screen', async () => {
    const { config } = emptyMachine();
    const run = config.run;
    config.run = async (command, input, extra) => (command === 'connections add' ? { ok: false, data: null, error: { code: 'INVALID_INPUT', message: 'That name is taken.', fix: 'Pick another.' }, meta: { command, durationMs: 0, version: 't', contractVersion: 1 } } as Envelope : run(command, input, extra));
    await open(config);
    await press('Start');
    await notNow();
    await press('Next');
    await userEvent.click(await screen.findByRole('checkbox', { name: /Jira/ }));
    await press('Next');
    await screen.findByRole('heading', { level: 1, name: 'Link Jira' });
    expect(document.querySelector('[data-setup-terminal]')).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Data Center' }));
    await userEvent.type(screen.getByLabelText(/^Address/), 'https://jira.imagile.dev');
    await userEvent.type(screen.getByLabelText(/^apiToken/), SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Save connection' }));
    await screen.findByText('That name is taken.');
    expect(screen.getByRole('alert').textContent).toContain('Pick another.');
  }, 30_000);

  it('has no password field on any screen but the shared connection form', async () => {
    await open(emptyMachine().config);
    expect(passwordFields()).toBe(0);
    await press('Start');
    await screen.findByRole('heading', { level: 1, name: 'An AI agent (optional)' });
    expect(passwordFields()).toBe(0);
    await notNow();
    await press('Next');
    await screen.findByRole('heading', { level: 1, name: 'Which tools do you use?' });
    expect(passwordFields()).toBe(0);
    await userEvent.click(screen.getByRole('checkbox', { name: /GitHub/ }));
    await press('Next');
    await screen.findByRole('heading', { level: 1, name: 'Link GitHub' });
    expect(passwordFields()).toBe(1);
    await press('Back');
    await laterTools();
    await press('Next');
    expect(passwordFields()).toBe(0);
    await notNow();
    await press('Next');
    expect(passwordFields()).toBe(0);
    await press('Next');
    expect(passwordFields()).toBe(0);
  });

  it('never imports the Ask chat, holds no proposal of its own, and keeps nothing in browser storage', () => {
    const text = readFileSync(join(import.meta.dirname, '..', 'src', 'views', 'Setup.tsx'), 'utf8');
    // The guide is its own component (components/guide-panel.tsx, test/setup-guide.test.tsx); the wizard imports it and the Agent's type, never the Ask chat.
    expect(text).not.toMatch(/components\/ask|proposal|localStorage|sessionStorage|document\.cookie/);
    expect(text).toContain('components/guide-panel.tsx');
  });

  it('keeps its changes off in the preview and says why', async () => {
    await open(fixtureConfig());
    await press('Start');
    await notNow();
    await press('Next');
    await userEvent.click(await screen.findByRole('checkbox', { name: /GitHub/ }));
    await press('Next');
    await screen.findByText(/Changes are turned off/);
  });

  it('passes axe on its screens', async () => {
    const { container } = await open(emptyMachine().config);
    const check = async () => {
      const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
      return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
    };
    expect(await check()).toEqual([]);
    await press('Start');
    await screen.findByRole('heading', { level: 1, name: 'An AI agent (optional)' });
    expect(await check()).toEqual([]);
    await notNow();
    expect(await check()).toEqual([]);
    await press('Next');
    expect(await check()).toEqual([]);
    await userEvent.click(await screen.findByRole('checkbox', { name: /GitHub/ }));
    expect(await check()).toEqual([]);
    await press('Next');
    await screen.findByRole('heading', { level: 1, name: 'Link GitHub' });
    expect(await check()).toEqual([]);
    await press('Back');
    await laterTools();
    await press('Next');
    expect(await check()).toEqual([]);
    await notNow();
    await press('Next');
    expect(await check()).toEqual([]);
    await press('Next');
    expect(await check()).toEqual([]);
  }, 30_000);
});
