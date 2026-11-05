import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { SCRIPTS, VOICED, scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { systemPrompt } from '../server/agents/prompts.ts';
import { promptStyle } from '../server/agents/voices.ts';
import { CHECKBOXES, TOIL_PROJECT, QUESTION, SAMPLE_INSTRUCTIONS, START, STANDARD_PROMPT, THEMES, cited } from '../scripts/showcase.ts';
import { openChat } from './chat.ts';

/**
 * The site's Toil UI showcase (/ui/, #374) reads this package's prompt,
 * voices, wording and sample answers when the site builds
 * (scripts/showcase.ts), and its tour presses a few of the app's
 * controls inside its frame (site/src/scripts/ui-showcase.ts). This holds
 * both to the app in the same run as the rest of Toil UI's tests, so a change
 * here that the page can't follow fails before the site build does. A
 * showroom inspected on the same schedule as the factory floor.
 */

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('what the showcase reads from Toil UI', () => {
  it('shows each theme\'s prompt as the server builds it, cut into its three layers', () => {
    expect(THEMES.map((t) => t.name)).toEqual(['plain', 'crate', 'harvest', 'starship', 'realm', 'sprawl', 'frontier', 'overworld']);
    for (const t of THEMES) {
      const style = promptStyle({ theme: t.name, voice: true }, { instructions: SAMPLE_INSTRUCTIONS, voice: null });
      expect(t.prompt.full).toBe(systemPrompt(TOIL_PROJECT, FIXTURE_NOW, style));
      expect(t.prompt.full.startsWith(t.prompt.rules)).toBe(true);
      expect(Boolean(t.prompt.style)).toBe(t.voice);
      if (t.prompt.style) expect(t.prompt.full).toContain(`Style:\n${t.prompt.style.voice}\n\n${t.prompt.style.rule}`);
      expect(t.prompt.full.endsWith(`${t.prompt.instructions.text}\n\n${t.prompt.instructions.rule}`)).toBe(true);
    }
    expect(STANDARD_PROMPT.style).toBeNull();
  });

  it("draws each theme in its default scheme, the one its theme.json lists first, so Crate stays the site's near-black (#507)", () => {
    expect(Object.fromEntries(THEMES.map((t) => [t.name, t.scheme]))).toEqual({
      plain: 'light', crate: 'dark', harvest: 'light', starship: 'dark', realm: 'light', sprawl: 'dark', frontier: 'light', overworld: 'dark',
    });
    expect(THEMES.find((t) => t.name === 'crate')!.tokens).toContain('--t-bg: #0f1115');
  });

  it('shows the scripted answers, in each voice the theme has', () => {
    expect(QUESTION).toBe(SCRIPTS[TOIL_PROJECT]!.risk!.label);
    for (const t of THEMES) expect(t.answer).toEqual(VOICED[TOIL_PROJECT]?.[t.name] ?? null);
    expect(THEMES.find((t) => t.name === 'plain')!.answer).toBeNull();
  });

  it('reads the checkbox rows from the themes doc and the start command from the README', () => {
    expect(CHECKBOXES.map((c) => c.name)).toEqual(['Themed wording', 'Themed agent voice']);
    expect(START).toBe('npx @imagile-dev/toil-ui');
  });

  it('draws a citation as a chip and escapes everything else', () => {
    expect(cited('<b>[[corp-jira:PAY-101]]</b> & [[github:imagile/payments-web#45]]')).toBe(
      '&lt;b&gt;<span class="cite"><span class="cite__src">Jira</span> <span class="cite__key">PAY-101</span></span>&lt;/b&gt; &amp; <span class="cite"><span class="cite__src">GitHub</span> <span class="cite__key">payments-web#45</span></span>',
    );
  });
});

describe('the controls the showcase\'s tour presses', () => {
  it('has the board heading on the Board tab, the Ask bar, the starter it asks, the agent switcher and the chat form', async () => {
    window.location.hash = `#/project/${TOIL_PROJECT}/board`;
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
    expect(document.querySelector('#board')).not.toBeNull();
    expect(document.querySelector('[data-ask-bar]')).not.toBeNull();
    const pane = await openChat(TOIL_PROJECT);
    expect(pane.getAttribute('role')).toBe('dialog');
    const starters = within(pane).getByRole('group', { name: 'Starter questions' });
    expect(within(starters).getAllByRole('button').some((b) => b.textContent?.startsWith('Are we going to finish the sprint?'))).toBe(true);
    expect([...pane.querySelectorAll('button')].some((b) => /change the (agent|AI helper)/.test(b.textContent ?? ''))).toBe(true);
    expect(pane.querySelector('form.ask-form input')).not.toBeNull();
  });
});
