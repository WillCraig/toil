// @vitest-environment jsdom
import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import type { Agent, Answer } from '../src/agent.ts';
import type { AgentSettingsPanelProps } from '../src/agent-settings.tsx';
import { GUIDE_NARROW } from '../src/components/guide-panel.tsx';
import type { ConfigAnswers, ConfigApi } from '../src/config.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { SAMPLE_ADAPTER_STATUS } from '../src/fixtures/agent-status.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { GUIDE_REFUSAL, type GuideRequest } from '../src/guide.ts';
import { httpAgent, type AgentStatus } from '../src/server-client.ts';
import type { SetupProgress } from '../src/setup.ts';
import type { Envelope } from '../src/toil.ts';

/**
 * The setup guide in the wizard (#561): the AI agent first, the guide beside
 * the step once a helper is ready (and folded behind a disclosure on a narrow
 * screen), starters per step, the question box that refuses a token before
 * anything is sent, the masked box staying the only place a login goes, and a
 * suggested command run only when a person presses Run this, through the
 * wizard's own config call. The server's half is test/setup-guide-server.test.ts.
 * Every token here is built from pieces, so no scanner finds one in the repository.
 */

const SECRET = 'fake-pat-abc12345-typed-once';
const TOKEN = ['ghp', '_', '0'.repeat(34), 'AB'].join('');

interface Call {
  command: string;
  input: Record<string, unknown>;
  extra: ConfigAnswers | undefined;
}

function machine() {
  const calls: Call[] = [];
  const base = fixtureConfig();
  const ok = (command: string, data: unknown): Envelope => ({ ok: true, data, error: null, meta: { command, durationMs: 0, version: 'test', contractVersion: 1 } }) as Envelope;
  const config: ConfigApi = {
    disabled: null,
    areas: () => base.areas(),
    settings: () => base.settings(),
    run: async (command, input, extra) => {
      calls.push({ command, input, extra });
      if (command === 'connections list') return ok(command, { configFile: '/home/you/.toil/config.json', connections: [] });
      if (command === 'projects list') return ok(command, { toilProjects: [], places: { user: '/home/you/.toil/projects' } });
      if (command === 'connections add') return ok(command, { name: input.name, area: input.area, secrets: {}, writes: false });
      return ok(command, {});
    },
  };
  return { config, calls };
}

/** A helper client: `adapter` is what is saved now ('none', or an adapter that is installed with its program found). */
function helper(adapter: 'none' | 'copilot' = 'none') {
  let status: AgentStatus = { settings: { adapter, model: null, cliPath: null, endpoint: null, instructions: null, voice: null, models: {}, cliPaths: {} }, problem: null, adapters: SAMPLE_ADAPTER_STATUS, kind: adapter };
  const saved: unknown[] = [];
  const props: AgentSettingsPanelProps = {
    client: {
      status: async () => status,
      save: async (s) => {
        saved.push(s);
        status = { ...status, settings: s, kind: s.adapter };
        return status;
      },
      prompt: async () => '',
      installPlan: async () => SAMPLE_ADAPTER_STATUS[0]!.install,
      install: async () => SAMPLE_ADAPTER_STATUS[0]!,
    },
  };
  return { props, saved };
}

/** A guide that records every request and answers with one fixed answer. */
function spyAgent(answer: Partial<Answer> = {}) {
  const requests: Array<{ request: GuideRequest; history: unknown }> = [];
  const agent: Agent = {
    ...scriptedAgent(),
    guide: async function* (request, history) {
      requests.push({ request, history });
      yield { prompt: request.message, parts: [{ text: 'Open Jira in a browser and copy the first part of its address.' }], citations: [], by: 'test', proposals: [], ...answer };
    },
  };
  return { agent, requests };
}

const narrow = (on: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: on && query === GUIDE_NARROW, media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false }));
afterEach(() => vi.unstubAllGlobals());

async function open(opts: { config: ConfigApi; agent?: Agent; settings?: AgentSettingsPanelProps }) {
  window.location.hash = '#/setup';
  const view = render(<App execute={fixtureExecute().execute} agent={opts.agent ?? scriptedAgent()} config={opts.config} now={FIXTURE_NOW} preview {...(opts.settings ? { agentSettings: opts.settings } : {})} />);
  await screen.findByRole('heading', { level: 1, name: 'Welcome' }, { timeout: 3000 });
  return view;
}
const press = (name: string | RegExp) => userEvent.click(screen.getByRole('button', { name: name === 'Next' ? /^Next/ : name }));
const notNow = () => userEvent.click(screen.getByRole('radio', { name: /^Not now/ }));
const nextEnabled = () => waitFor(() => expect((screen.getByRole('button', { name: /^Next/ }) as HTMLButtonElement).disabled).toBe(false));
/** Fills and saves the Jira connection form, so the connect step is done and Next turns on. */
async function saveJira() {
  await userEvent.click(screen.getByRole('radio', { name: 'Data Center' }));
  await userEvent.type(screen.getByLabelText(/^Address/), 'https://jira.imagile.dev');
  await userEvent.type(screen.getByLabelText(/^apiToken/), SECRET);
  await userEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await waitFor(() => expect(document.querySelector('[data-setup-linked]')).not.toBeNull());
}
const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
const box = () => screen.getByLabelText('Ask a question (never paste a token here)') as HTMLTextAreaElement;

describe('the AI agent step, first', () => {
  it('comes right after the welcome, explained for someone new to AI, and optional', async () => {
    await open({ config: machine().config });
    await press('Start');
    await heading('An AI agent (optional)');
    expect(screen.getByText(/^Step 2 of 7/)).toBeTruthy();
    const facts = document.querySelector('[data-setup-helper-facts]')!.textContent!;
    expect(facts).toMatch(/only reads and suggests/);
    expect(facts).toMatch(/subscription you already have/);
    expect(facts).toMatch(/Toil UI stores no key/);
    expect(facts).toMatch(/never sees your login/);
    expect(document.querySelector('[data-setup-optional]')!.textContent).toMatch(/Everything else works without one/);
  });

  it('with none set up, the later steps are what they always were, plus one small line offering one', async () => {
    const { props } = helper('none');
    await open({ config: machine().config, settings: props });
    await press('Start');
    await screen.findByRole('radio', { name: /^Not now/ });
    await notNow();
    await press('Next');
    await heading('Which tools do you use?');
    expect(document.querySelector('[data-guide]')).toBeNull();
    const offer = document.querySelector('[data-setup-guide-offer]')!;
    expect(offer.textContent).toContain('Set up an AI agent to get explanations here.');
    expect(offer.querySelectorAll('button')).toHaveLength(1);
    expect(document.querySelector('.setup__layout')!.hasAttribute('data-guided')).toBe(false);
  });

  it('offers the helper again from a later step, and Next takes the person back to where they were', async () => {
    const { props, saved } = helper('none');
    await open({ config: machine().config, settings: props });
    await press('Start');
    await screen.findByRole('radio', { name: /^Not now/ });
    await notNow();
    await press('Next');
    await userEvent.click(await screen.findByRole('checkbox', { name: /Jira/ }));
    await press('Next');
    await heading('Link Jira');
    await userEvent.click(within(document.querySelector('[data-setup-guide-offer]') as HTMLElement).getByRole('button', { name: 'Set up an AI agent' }));
    await heading('An AI agent (optional)');
    // Choosing a ready helper is saving it: there is no second button.
    await userEvent.click(await screen.findByRole('radio', { name: /GitHub Copilot/ }));
    expect(screen.queryByRole('button', { name: 'Use this helper' })).toBeNull();
    await screen.findByText(/Saved: GitHub Copilot will answer your questions, and explain the next steps beside them/);
    expect(saved).toHaveLength(1);
    await press('Next');
    // Back where they left, with the guide now beside the step.
    await heading('Link Jira');
    expect(document.querySelector('[data-guide-side]')).not.toBeNull();
    expect(document.querySelector('[data-setup-guide-offer]')).toBeNull();
  }, 30_000);
});

describe('a remount of the App', () => {
  it('does not send the wizard back to Welcome: saving a helper or finishing a sync remounts the App, and the page keeps where it was', async () => {
    narrow(false);
    function Harness() {
      const [progress, setProgress] = useState<SetupProgress | null>(null);
      const [generation, setGeneration] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setGeneration((g) => g + 1)}>
            remount
          </button>
          <App key={generation} setupKeep={{ value: progress, save: setProgress }} execute={fixtureExecute().execute} agent={scriptedAgent()} config={machine().config} now={FIXTURE_NOW} preview />
        </>
      );
    }
    window.location.hash = '#/setup';
    render(<Harness />);
    await screen.findByRole('heading', { level: 1, name: 'Welcome' }, { timeout: 3000 });
    await press('Start');
    await notNow();
    await press('Next');
    await userEvent.click(await screen.findByRole('checkbox', { name: /Jira/ }));
    await press('Next');
    await heading('Link Jira');
    await userEvent.click(screen.getByRole('button', { name: 'remount' }));
    await heading('Link Jira');
    expect(screen.getByText(/^Step 4 of 7/)).toBeTruthy();
    await press('Back');
    expect((await screen.findByRole('checkbox', { name: /Jira/ })) as HTMLInputElement).toHaveProperty('checked', true);
  }, 30_000);
});

describe('the guide beside the step', () => {
  async function toConnect(o: { agent: Agent; adapter?: 'none' | 'copilot'; config?: ConfigApi }) {
    const { props } = helper(o.adapter ?? 'copilot');
    const config = o.config ?? machine().config;
    await open({ config, agent: o.agent, settings: props });
    await press('Start');
    await nextEnabled();
    await press('Next');
    await userEvent.click(await screen.findByRole('checkbox', { name: /Jira/ }));
    await press('Next');
    await heading('Link Jira');
  }

  it('sits beside the step on a wide screen, open, with the starter questions for the step', async () => {
    narrow(false);
    const { agent } = spyAgent();
    await toConnect({ agent });
    const side = document.querySelector('[data-guide-side]')!;
    expect(document.querySelector('.setup__layout')!.hasAttribute('data-guided')).toBe(true);
    expect(document.querySelector('[data-guide-fold]')).toBeNull();
    const starters = [...side.querySelectorAll('[data-guide-starter]')].map((b) => b.textContent);
    expect(starters).toEqual(expect.arrayContaining(['Which scopes does my token need?', 'Where do I find my Jira site name?', 'Cloud or Data Center?']));
  });

  it('folds behind "Ask the guide" on a narrow screen, closed until opened, and keeps the chat across steps', async () => {
    narrow(true);
    const { agent, requests } = spyAgent();
    await toConnect({ agent });
    const fold = document.querySelector('[data-guide-fold]') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')!.textContent).toBe('Ask the guide');
    expect(document.querySelector('[data-guide-side]')).toBeNull();
    await userEvent.click(fold.querySelector('summary')!);
    await userEvent.click(screen.getByRole('button', { name: 'Cloud or Data Center?' }));
    await screen.findByText(/copy the first part of its address/);
    expect(requests).toHaveLength(1);
    // The next step: the same chat is still there, with new starters.
    await saveJira();
    await press('Next');
    await heading('Your Toil project');
    expect(screen.getByText(/copy the first part of its address/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'What is a Toil project?' })).toBeTruthy();
  }, 30_000);

  it('tells the guide the step and the non-secret facts, and never a word typed in the masked box', async () => {
    narrow(false);
    const { agent, requests } = spyAgent();
    await toConnect({ agent });
    await userEvent.click(screen.getByRole('radio', { name: 'Data Center' }));
    await userEvent.type(screen.getByLabelText(/^Address/), 'https://jira.imagile.dev');
    await userEvent.type(screen.getByLabelText(/^apiToken/), SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Where do I find my Jira site name?' }));
    await screen.findByText(/copy the first part of its address/);
    const sent = JSON.stringify(requests);
    expect(sent).not.toContain(SECRET);
    expect(requests[0]!.request.state).toEqual({ step: 'connect', areas: ['jira'], area: 'jira', deployment: 'server', address: 'https://jira.imagile.dev' });
    expect(requests[0]!.request.message).toBe('Where do I find my Jira site name?');
    // The two boxes are different boxes, and the page says which is which.
    expect(box().type).toBe('textarea');
    expect((screen.getByLabelText(/^apiToken/) as HTMLInputElement).type).toBe('password');
    expect(document.body.textContent).not.toContain(SECRET);
  }, 30_000);

  it('refuses a token typed into the question box before anything is sent, says where it goes, and clears it', async () => {
    narrow(false);
    const { agent, requests } = spyAgent();
    await toConnect({ agent });
    await userEvent.type(box(), `my token is ${TOKEN}`);
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(screen.getByRole('alert').textContent).toBe(GUIDE_REFUSAL);
    expect(GUIDE_REFUSAL).toBe('That looks like a token. Type it in the masked box in the step instead; the guide never needs it.');
    expect(box().value).toBe('');
    expect(requests).toEqual([]);
    expect(document.body.textContent).not.toContain(TOKEN);
    // Nothing of it stays in the chat, and the notice goes when the person types again.
    expect(document.querySelector('[data-guide-log]')!.textContent).toBe('');
    await userEvent.type(box(), 'Cloud or Data Center?');
    expect(document.querySelector('[data-guide-refused]')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByText(/copy the first part of its address/);
    expect(requests).toHaveLength(1);
  }, 30_000);

  it('works with no sync and no Toil project: the first question needs neither, and the answer is plain text', async () => {
    narrow(false);
    const { agent, requests } = spyAgent();
    await toConnect({ agent });
    await userEvent.type(box(), 'What does a token do?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByText(/copy the first part of its address/);
    expect(requests[0]!.request.state.project).toBeUndefined();
  });

  it('folds earlier questions to their question line when another is asked, and opens any of them on a press', async () => {
    narrow(false);
    const { agent } = spyAgent();
    await toConnect({ agent });
    const ask = async (q: string) => {
      await userEvent.type(box(), q);
      await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Ask' }).hasAttribute('disabled')).toBe(true));
    };
    await ask('First question?');
    await screen.findAllByText(/copy the first part of its address/);
    await ask('Second question?');
    await waitFor(() => expect(document.querySelectorAll('[data-guide-turn]')).toHaveLength(2));
    const turns = () => [...document.querySelectorAll<HTMLDetailsElement>('[data-guide-turn]')];
    await waitFor(() => expect(turns().map((t) => t.open)).toEqual([false, true]));
    await userEvent.click(turns()[0]!.querySelector('summary')!);
    await waitFor(() => expect(turns()[0]!.open).toBe(true));
  });

  it('shows what went wrong in plain words, on screen', async () => {
    narrow(false);
    const agent: Agent = { ...scriptedAgent(), guide: () => (async function* (): AsyncGenerator<Answer> {
      yield* [];
      throw new Error('Claude was stopped before it finished.');
    })() };
    await toConnect({ agent });
    await userEvent.click(screen.getByRole('button', { name: 'Cloud or Data Center?' }));
    expect((await screen.findByRole('alert')).textContent).toContain("The guide couldn't answer: Claude was stopped before it finished.");
  });

  it('shows a suggested command with the line it would type, and runs it only when Run this is pressed, through the wizard\'s own call', async () => {
    narrow(false);
    const proposal = { id: 'guide:projects init:0', from: 'agent' as const, item: 'setup', title: 'Make a Toil project called payments', reason: 'None yet.', command: 'projects init', input: { name: 'payments' }, note: null };
    const { agent } = spyAgent({ proposals: [proposal] });
    const m = machine();
    await toConnect({ agent, config: m.config });
    await userEvent.click(screen.getByRole('button', { name: 'Cloud or Data Center?' }));
    const card = await screen.findByRole('article', { name: 'Suggested: Make a Toil project called payments' });
    expect(card.textContent).toContain("toil projects init 'payments'");
    expect(card.textContent).toContain('Suggested, not done yet');
    expect(m.calls.some((c) => c.command === 'projects init')).toBe(false);
    await userEvent.click(within(card).getByRole('button', { name: 'Run this' }));
    await waitFor(() => expect(m.calls.find((c) => c.command === 'projects init')).toBeTruthy());
    expect(m.calls.find((c) => c.command === 'projects init')!.input).toEqual({ name: 'payments' });
    await within(card).findByText('Done.');
    // The lists are read again afterwards, so the Toil project shows up in the steps.
    expect(m.calls.filter((c) => c.command === 'projects list').length).toBeGreaterThan(1);
  }, 30_000);

  it('offers no button for a command the guide may not suggest, or a value that looks like a token', async () => {
    narrow(false);
    const bad = [
      { id: 'a', from: 'agent' as const, item: 'setup', title: 'Create an issue', reason: '', command: 'jira issue create', input: { summary: 'x' }, note: null },
      { id: 'b', from: 'agent' as const, item: 'setup', title: 'Add a connection', reason: '', command: 'connections add', input: { name: 'j', area: 'jira', set: [`apiToken=${TOKEN}`] }, note: null },
    ];
    const { agent } = spyAgent({ proposals: bad });
    const m = machine();
    await toConnect({ agent, config: m.config });
    await userEvent.click(screen.getByRole('button', { name: 'Cloud or Data Center?' }));
    await screen.findByRole('article', { name: 'Suggested: Create an issue' });
    expect(screen.queryByRole('button', { name: 'Run this' })).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN);
  }, 30_000);

  it('keeps Run this off where changes are off', async () => {
    narrow(false);
    const proposal = { id: 'a', from: 'agent' as const, item: 'setup', title: 'Make it', reason: '', command: 'projects init', input: { name: 'payments' }, note: null };
    const { agent } = spyAgent({ proposals: [proposal] });
    const { config } = machine();
    await toConnect({ agent, config: { ...config, disabled: 'This is the preview.' } });
    await userEvent.click(screen.getByRole('button', { name: 'Cloud or Data Center?' }));
    const card = await screen.findByRole('article', { name: 'Suggested: Make it' });
    expect((within(card).getByRole('button', { name: 'Run this' }) as HTMLButtonElement).disabled).toBe(true);
  }, 30_000);

  it('passes axe, wide and narrow, with an answer showing', async () => {
    for (const on of [false, true]) {
      narrow(on);
      const { agent } = spyAgent();
      const { container, unmount } = await (async () => {
        await toConnect({ agent });
        return { container: document.body, unmount: () => undefined };
      })();
      if (on) await userEvent.click(document.querySelector('[data-guide-fold] summary')!);
      await userEvent.click(screen.getByRole('button', { name: 'Cloud or Data Center?' }));
      await screen.findByText(/copy the first part of its address/);
      const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
      expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
      unmount();
      document.body.innerHTML = '';
    }
  }, 60_000);
});

describe('the client door', () => {
  it('refuses a token-shaped message without making a request, and sends a clean one with only the state', async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes('starters')) return new Response('[]', { status: 200 });
      return new Response(`${JSON.stringify({ answer: { prompt: 'q', parts: [{ text: 'ok' }], citations: [], by: 'x', proposals: [] } })}\n${JSON.stringify({ done: true })}\n`, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    });
    vi.stubGlobal('fetch', fetch);
    const agent = await httpAgent({ agent: 'claude' } as never, [], './');
    const state = { step: 'connect' as const, areas: ['jira'] };
    await expect((async () => { for await (const _ of agent.guide!({ chat: 'guide-0000-0001', message: `token ${TOKEN}`, state })) void _; })()).rejects.toThrow(GUIDE_REFUSAL);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('agent/guide'))).toEqual([]);
    const got: Answer[] = [];
    for await (const a of agent.guide!({ chat: 'guide-0000-0001', message: 'Cloud or Data Center?', state }, [], undefined, { theme: 'crate', voice: false })) got.push(a);
    expect(got.at(-1)!.parts[0]!.text).toBe('ok');
    const sent = JSON.parse(String((fetch.mock.calls.find(([url]) => String(url).includes('agent/guide'))![1] as RequestInit).body));
    expect(sent).toEqual({ chat: 'guide-0000-0001', message: 'Cloud or Data Center?', state, stream: true, theme: 'crate', voice: false });
  });
});
