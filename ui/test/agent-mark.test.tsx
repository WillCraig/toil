// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { AgentMark, agentMarkUrl } from '../src/components/agent-mark.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { fixtureWorklog } from '../src/fixtures/worklog.ts';
import { standupHref, toilProjectHref } from '../src/format.ts';
import { ThemeProvider } from '../src/skins.tsx';
import { THEMES } from '../src/themes.ts';

/**
 * The agent mark (principle 11, #657): every theme ships its own picture for "an AI agent does this", each a
 * different drawing, and every control that starts an agent run carries the one the theme picked, hidden from a
 * screen reader because the label already says what the button does.
 */

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => cleanup());

const themesDir = join(import.meta.dirname, '..', 'themes');

describe('the agent mark in every theme', () => {
  it('is listed by every theme, and no two themes draw the same picture', () => {
    const drawings = THEMES.map((t) => {
      expect(t.assets.agentMark, t.name).toBe('assets/agent.svg');
      return readFileSync(join(themesDir, t.name, t.assets.agentMark!), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    });
    expect(new Set(drawings).size).toBe(THEMES.length);
  });

  it("falls back to Plain's mark for a theme that lists none", () => {
    const plain = THEMES.find((t) => t.name === 'plain')!;
    expect(agentMarkUrl({ name: 'nameless', assets: {} })).toBe(agentMarkUrl(plain));
  });

  it("draws the theme's own mark, hidden from a screen reader", () => {
    for (const t of THEMES) {
      const { container, unmount } = render(
        <ThemeProvider value={t}>
          <button type="button">
            <AgentMark />
            Write it up
          </button>
        </ThemeProvider>,
      );
      const mark = container.querySelector('.agent-mark')!;
      expect(mark.getAttribute('aria-hidden')).toBe('true');
      expect(mark.getAttribute('data-agent-mark')).toBe(t.name);
      expect(screen.getByRole('button').textContent).toBe('Write it up');
      unmount();
    }
  });
});

describe('controls that start an AI agent run', () => {
  it('carry the mark: Ask, and Write it up on the stand-up', async () => {
    window.location.hash = toilProjectHref('sample-team');
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview worklog={fixtureWorklog()} />);
    const ask = await screen.findByRole('button', { name: 'Ask' });
    expect(ask.querySelector('.agent-mark')).toBeTruthy();
    cleanup();
    window.location.hash = standupHref('card-payments', { from: '2026-10-12', to: '2026-10-13' });
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview worklog={fixtureWorklog()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Write it up' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Write it up' }).querySelector('.agent-mark')).toBeTruthy();
    // A button that only copies or exports starts no agent, and has no mark.
    expect(screen.getByRole('button', { name: 'Copy text' }).querySelector('.agent-mark')).toBeNull();
  });

  it('keeps no agent on screen on the stand-up: a disabled Write it up and one line to set one up', async () => {
    window.location.hash = standupHref('card-payments', { from: '2026-10-12', to: '2026-10-13' });
    render(<App execute={fixtureExecute().execute} agent={{ ...scriptedAgent(), notice: 'No agent is set up yet, so nothing can answer questions.' }} now={FIXTURE_NOW} preview worklog={fixtureWorklog()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Write it up' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Write it up' }).hasAttribute('disabled')).toBe(true);
    const line = document.querySelector('[data-standup-no-agent]')!;
    expect(line.textContent).toBe('No AI agent is set up yet. Set one up in Settings, AI agent');
    expect(line.querySelector('a')!.getAttribute('href')).toBe('#/settings/agent');
  });
});
