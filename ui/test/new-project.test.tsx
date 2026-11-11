import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { App, parseRoute } from '../src/App.tsx';
import type { ConfigAnswers, ConfigApi, ConnectionRow } from '../src/config.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { nameProblem } from '../src/views/project-create.ts';
import type { Envelope } from '../src/toil.ts';

/**
 * The New Toil project wizard (`#/new-project`): its four steps, Next staying off
 * with a plain reason until a page is done, the Not now paths, the order of what
 * Create runs (init, add-repo per folder, link per tool, never `--shared`), a
 * failed folder that does not undo the project and can be retried, the old
 * addresses that now lead here, and axe on every screen.
 */

interface Call {
  command: string;
  input: Record<string, unknown>;
  extra: ConfigAnswers | undefined;
}

const row = (name: string, area: string, isDefault: boolean): ConnectionRow => ({ name, area, isDefault, host: `${area}.imagile.dev`, writes: false, values: {} });
const CONNECTIONS = [row('corp-jira', 'jira', true), row('alt-jira', 'jira', false), row('corp-github', 'github', true)];

interface Options {
  connections?: ConnectionRow[];
  taken?: string[];
  /** Locations `projects add-repo` refuses. */
  badFolders?: string[];
  failInit?: boolean;
  disabled?: string | null;
}

/** A config that answers like a machine with some connections, records every call, and allows changes. */
function machine(options: Options = {}) {
  const calls: Call[] = [];
  const bad = new Set(options.badFolders ?? []);
  const base = fixtureConfig();
  const ok = (command: string, data: unknown): Envelope => ({ ok: true, data, error: null, meta: { command, durationMs: 0, version: 'test', contractVersion: 1 } }) as Envelope;
  const fail = (command: string, message: string, fix: string): Envelope => ({ ok: false, data: null, error: { code: 'INVALID_INPUT', message, fix }, meta: { command, durationMs: 0, version: 'test', contractVersion: 1 } }) as Envelope;
  const config: ConfigApi = {
    disabled: options.disabled ?? null,
    areas: () => base.areas(),
    settings: () => base.settings(),
    run: async (command, input, extra) => {
      calls.push({ command, input, extra });
      if (command === 'connections list') return ok(command, { configFile: '/home/you/.toil/config.json', connections: options.connections ?? CONNECTIONS });
      if (command === 'projects list') return ok(command, { toilProjects: (options.taken ?? []).map((name) => ({ name, description: null })), places: {} });
      if (command === 'projects init' && options.failInit) return fail(command, 'Could not write the file.', 'Check the folder is writable.');
      if (command === 'projects add-repo' && bad.has(String(input.location))) return fail(command, 'That folder is not there.', 'Check the path.');
      return ok(command, {});
    },
  };
  return { config, calls };
}

const writes = (calls: Call[]) => calls.filter((c) => c.command.startsWith('projects ') && c.command !== 'projects list').map((c) => ({ command: c.command, input: c.input }));

async function open(config: ConfigApi, hash = '#/new-project') {
  window.location.hash = hash;
  const view = render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={config} now={FIXTURE_NOW} preview />);
  await screen.findByRole('heading', { level: 1, name: 'Name it' }, { timeout: 3000 });
  return view;
}

const nextButton = () => screen.getByRole('button', { name: /^(Next|Create )/ }) as HTMLButtonElement;
const why = () => document.querySelector('[data-new-project-why]')?.textContent ?? null;
const progress = () => screen.getByText(/^Step \d of 4/).textContent;
const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
const next = () => userEvent.click(nextButton());
const typeName = (text: string) => userEvent.type(screen.getByRole('textbox', { name: /^Name/ }), text);
const notNow = () => userEvent.click(screen.getByRole('checkbox', { name: /^Not now/ }));

/** Gets to the folders page with a valid name. */
async function toFolders(name = 'payments') {
  await typeName(name);
  await next();
  await heading('Where does it live? (optional)');
}
async function toTools(folders: string[] = []) {
  await toFolders();
  if (folders.length === 0) await notNow();
  for (const [i, f] of folders.entries()) {
    if (i > 0) await userEvent.click(screen.getByRole('button', { name: 'Add another' }));
    await userEvent.type(screen.getByRole('textbox', { name: `Folder or address ${i + 1}` }), f);
  }
  await next();
  await heading('Which tools does it use?');
  await screen.findAllByRole('checkbox', { name: /corp-/ });
}

beforeEach(() => {
  window.location.hash = '';
});

describe('the New Toil project wizard', () => {
  it('has an address of its own, and the two old ones lead to it', async () => {
    expect(parseRoute('#/new-project')).toEqual({ view: 'newProject' });
    expect(parseRoute('#/setup/project')).toEqual({ view: 'newProject' });
    expect(parseRoute('#/settings/projects/+new')).toEqual({ view: 'newProject' });
    expect(parseRoute('#/setup')).toEqual({ view: 'setup' });
    for (const old of ['#/setup/project', '#/settings/projects/+new']) {
      const view = await open(machine().config, old);
      expect(window.location.hash).toBe('#/new-project');
      expect(progress()).toContain('Step 1 of 4');
      view.unmount();
    }
  });

  it('names it first: Next stays off, with the reason, until the name can be used', async () => {
    await open(machine({ taken: ['payments'] }).config);
    expect(progress()).toContain('Step 1 of 4');
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    expect(nextButton().textContent).toBe('Next: Folders');
    expect(nextButton().disabled).toBe(true);
    expect(why()).toBe('Name the Toil project first.');
    await typeName('Pay ments');
    expect(nextButton().disabled).toBe(true);
    expect(why()).toMatch(/lowercase letters, digits and single hyphens/i);
    await userEvent.clear(screen.getByRole('textbox', { name: /^Name/ }));
    await typeName('payments');
    expect(nextButton().disabled).toBe(true);
    expect(why()).toBe('payments is already a Toil project. Choose another name.');
    await userEvent.clear(screen.getByRole('textbox', { name: /^Name/ }));
    await typeName('payments-2');
    expect(nextButton().disabled).toBe(false);
    expect(document.querySelector('[data-new-project-why]')).toBeNull();
    expect(nameProblem('a--b', [])).not.toBeNull();
    expect(nameProblem('-a', [])).not.toBeNull();
    expect(nameProblem('a-b-1', [])).toBeNull();
  });

  it('asks where it lives: Next waits for a folder or Not now, and refuses a repeat', async () => {
    await open(machine().config);
    await toFolders();
    expect(progress()).toContain('Step 2 of 4');
    expect(nextButton().textContent).toBe('Next: Tools');
    expect(nextButton().disabled).toBe(true);
    expect(why()).toBe('Enter a folder or address, or choose Not now, first.');
    await userEvent.click(screen.getByRole('button', { name: 'Add another' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder or address 1' }), 'C:/Code/pay');
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder or address 2' }), 'C:/Code/pay/');
    expect(nextButton().disabled).toBe(true);
    expect(why()).toBe('Remove the repeated folder or address first.');
    await userEvent.click(screen.getByRole('button', { name: 'Remove folder or address 2' }));
    expect(nextButton().disabled).toBe(false);
    // Not now is an answer too, and typing again takes it back.
    await userEvent.clear(screen.getByRole('textbox', { name: 'Folder or address 1' }));
    expect(nextButton().disabled).toBe(true);
    await notNow();
    expect(nextButton().disabled).toBe(false);
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder or address 1' }), 'x');
    expect((screen.getByRole('checkbox', { name: /^Not now/ }) as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await heading('Name it');
    expect((screen.getByRole('textbox', { name: /^Name/ }) as HTMLInputElement).value).toBe('payments');
  });

  it("ticks each tool's main connection, one per tool, with plain names and Not now", async () => {
    await open(machine().config);
    await toTools();
    expect(progress()).toContain('Step 3 of 4');
    expect(nextButton().textContent).toBe('Next: Create it');
    const box = (n: RegExp) => screen.getByRole('checkbox', { name: n }) as HTMLInputElement;
    expect(box(/corp-jira/).checked).toBe(true);
    expect(box(/alt-jira/).checked).toBe(false);
    expect(box(/corp-github/).checked).toBe(true);
    // The names are the tools' own, never an id in brackets.
    expect(box(/corp-jira/).closest('label')!.textContent).toContain('Jira');
    expect(document.querySelector('[data-new-project-tools]')!.textContent).not.toMatch(/\(jira\)|\(github\)/);
    // One connection per tool: ticking the other Jira swaps it.
    await userEvent.click(box(/alt-jira/));
    expect(box(/alt-jira/).checked).toBe(true);
    expect(box(/corp-jira/).checked).toBe(false);
    await userEvent.click(box(/alt-jira/));
    await userEvent.click(box(/corp-github/));
    expect(nextButton().disabled).toBe(true);
    expect(why()).toBe('Tick a tool, or choose Not now, first.');
    await notNow();
    expect(nextButton().disabled).toBe(false);
  });

  it('creates it in order: init, one add-repo per folder, one link per tool, and nothing else', async () => {
    const { config, calls } = machine();
    await open(config);
    await typeName('payments');
    await userEvent.type(screen.getByRole('textbox', { name: /^What is it/ }), 'Card payments');
    await next();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Folder or address 1' }), 'C:/Code/pay');
    await userEvent.click(screen.getByRole('button', { name: 'Add another' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder or address 2' }), 'https://github.imagile.dev/imagile/pay.git');
    await next();
    await screen.findByRole('checkbox', { name: /corp-jira/ });
    await next();
    await heading('Create it');
    expect(progress()).toContain('Step 4 of 4');
    const summary = document.querySelector('[data-new-project-summary]')!.textContent!;
    expect(summary).toContain('payments');
    expect(summary).toContain('Card payments');
    expect(summary).toContain('C:/Code/pay');
    expect(summary).toContain('Jira through corp-jira');
    expect(summary).toContain('GitHub through corp-github');
    expect(writes(calls)).toEqual([]);
    expect(nextButton().textContent).toBe('Create payments');
    await next();
    await heading('payments was created');
    expect(writes(calls)).toEqual([
      { command: 'projects init', input: { name: 'payments', description: 'Card payments' } },
      { command: 'projects add-repo', input: { toilProject: 'payments', location: 'C:/Code/pay' } },
      { command: 'projects add-repo', input: { toilProject: 'payments', location: 'https://github.imagile.dev/imagile/pay.git' } },
      { command: 'projects link', input: { toilProject: 'payments', area: 'jira', connection: 'corp-jira' } },
      { command: 'projects link', input: { toilProject: 'payments', area: 'github', connection: 'corp-github' } },
    ]);
    expect(JSON.stringify(calls)).not.toContain('shared');
    expect(calls.every((c) => c.extra === undefined)).toBe(true);
    expect(screen.getByRole('link', { name: 'Open payments' }).getAttribute('href')).toBe('#/project/payments');
    expect(screen.getByRole('link', { name: 'Name your Jira fields' }).getAttribute('href')).toBe('#/settings/projects/payments/fields');
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Retry/ })).toBeNull();
  });

  it('asks for the Jira project key when Jira is ticked, says what leaving it empty means, and saves it on the Jira link only', async () => {
    const { config, calls } = machine();
    await open(config);
    await toTools();
    const key = screen.getByRole('textbox', { name: /^Jira project key/ });
    expect(screen.getByText(/before the number in an issue key, such as PAY in PAY-123/)).toBeTruthy();
    // The consequence is one press away, in an (i) with a Read more link, and not on the screen.
    const field = document.querySelector('[data-new-project-jira-key]')!;
    expect(field.textContent).not.toMatch(/reads no Jira issues/);
    expect(within(field as HTMLElement).getByRole('button', { name: 'About the Jira project key' })).toBeTruthy();
    // It sits directly under the Jira row, so it goes when Jira is unticked.
    expect(field.previousElementSibling!.textContent).toContain('corp-jira');
    await userEvent.type(key, 'PAY');
    await next();
    await heading('Create it');
    expect(document.querySelector('[data-new-project-summary]')!.textContent).toContain('Jira through corp-jira (Jira project key PAY)');
    await next();
    await heading('payments was created');
    expect(writes(calls).filter((c) => c.command === 'projects link')).toEqual([
      { command: 'projects link', input: { toilProject: 'payments', area: 'jira', connection: 'corp-jira', set: ['project=PAY'] } },
      { command: 'projects link', input: { toilProject: 'payments', area: 'github', connection: 'corp-github' } },
    ]);
  });

  it('shows no Jira project key field when Jira is not ticked', async () => {
    const { config } = machine();
    await open(config);
    await toTools();
    await userEvent.click(screen.getByRole('checkbox', { name: /corp-jira/ }));
    expect(screen.queryByRole('textbox', { name: /^Jira project key/ })).toBeNull();
  });

  it('disables a writes-on connection that is not the main one of its tool, with the reason beside it', async () => {
    const risky = { ...row('alt-jira', 'jira', false), writes: true };
    const { config } = machine({ connections: [row('corp-jira', 'jira', true), risky] });
    await open(config);
    await toTools();
    const box = (await screen.findByRole('checkbox', { name: /alt-jira/ })) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.closest('li')!.textContent).toContain("Can't link here");
    expect((screen.getByRole('checkbox', { name: /corp-jira/ }) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole('checkbox', { name: /corp-jira/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('with Not now everywhere, runs only projects init, and offers no Jira fields', async () => {
    const { config, calls } = machine({ connections: [row('corp-github', 'github', true)] });
    await open(config);
    await toTools();
    await notNow();
    await next();
    await heading('Create it');
    expect(document.querySelector('[data-new-project-summary]')!.textContent).toContain('No folders or addresses yet.');
    expect(document.querySelector('[data-new-project-summary]')!.textContent).toContain('No tools linked yet.');
    await next();
    await heading('payments was created');
    expect(writes(calls)).toEqual([{ command: 'projects init', input: { name: 'payments' } }]);
    expect(screen.getByRole('link', { name: 'Open payments' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Name your Jira fields' })).toBeNull();
  });

  it('keeps the project when a folder fails, says which, and retries only that one', async () => {
    const { config, calls } = machine({ badFolders: ['C:/Code/gone'] });
    await open(config);
    await toTools(['C:/Code/pay', 'C:/Code/gone']);
    await next();
    await heading('Create it');
    await next();
    await heading('payments was created');
    const failures = document.querySelector('[data-new-project-failures]') as HTMLElement;
    expect(failures.getAttribute('role')).toBe('alert');
    expect(failures.textContent).toContain('1 of 2 folders or addresses were not added');
    expect(within(failures).getByText('C:/Code/gone')).toBeTruthy();
    expect(failures.textContent).toContain('That folder is not there. Check the path.');
    expect(failures.textContent).not.toContain('C:/Code/pay:');
    expect(screen.getByRole('link', { name: 'Open payments' })).toBeTruthy();
    const before = writes(calls).length;
    await userEvent.click(screen.getByRole('button', { name: 'Retry the ones that failed' }));
    await waitFor(() => expect(writes(calls).length).toBe(before + 1));
    expect(writes(calls).slice(before)).toEqual([{ command: 'projects add-repo', input: { toilProject: 'payments', location: 'C:/Code/gone' } }]);
    expect(writes(calls).filter((c) => c.command === 'projects init')).toHaveLength(1);
  });

  it('says plainly when the Toil project could not be created, and lets you press again', async () => {
    const { config, calls } = machine({ failInit: true });
    await open(config);
    await toTools();
    await notNow();
    await next();
    await heading('Create it');
    await next();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not write the file.');
    expect(alert.textContent).toContain('Check the folder is writable.');
    expect(writes(calls).map((c) => c.command)).toEqual(['projects init']);
    expect(nextButton().disabled).toBe(false);
    expect(screen.queryByRole('link', { name: /^Open/ })).toBeNull();
  });

  it('keeps Create off when changes are turned off, and says why', async () => {
    const { config, calls } = machine({ disabled: 'the preview reads only.' });
    await open(config);
    expect(screen.getByText(/Changes are turned off/)).toBeTruthy();
    await toTools();
    await notNow();
    await next();
    await heading('Create it');
    expect(nextButton().disabled).toBe(true);
    expect(why()).toBe('Changes are turned off, so nothing can be created.');
    await userEvent.click(nextButton());
    expect(writes(calls)).toEqual([]);
  });

  it('passes axe on every screen', async () => {
    const { container } = await open(machine().config);
    const check = async () => {
      const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
      return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
    };
    expect(await check()).toEqual([]);
    await toFolders();
    expect(await check()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Add another' }));
    expect(await check()).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove folder or address 2' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder or address 1' }), 'C:/Code/pay');
    await next();
    await screen.findByRole('checkbox', { name: /corp-jira/ });
    expect(await check()).toEqual([]);
    await next();
    await heading('Create it');
    expect(await check()).toEqual([]);
    await next();
    await heading('payments was created');
    expect(await check()).toEqual([]);
  }, 30_000);
});
