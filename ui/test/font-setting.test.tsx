import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { resetFont } from '../src/fonts.ts';

/** Settings, General, Font: the theme's own first, a curated set after, applied over the theme and kept in this browser. */

beforeEach(() => {
  localStorage.clear();
  resetFont();
  window.history.replaceState(null, '', '/?theme=plain');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('style');
  resetFont();
  window.history.replaceState(null, '', '/');
});

describe('the Font control', () => {
  it("lists the theme's own first, applies a pick over the theme, and keeps it in this browser", async () => {
    window.location.hash = '#/settings/appearance';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
    const card = await screen.findByRole('region', { name: 'Theme' });
    const button = within(card).getByRole('button', { name: /Font/ });
    expect(button.textContent).toContain("The theme's own");
    await userEvent.click(button);
    const options = await screen.findAllByRole('option');
    expect(options[0]!.textContent).toBe("The theme's own");
    expect(options.length).toBeGreaterThan(5);
    await userEvent.click(screen.getByRole('option', { name: 'Garamond' }));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--font-body')).toContain("'EB Garamond'"));
    expect(document.documentElement.dataset.theme).toBe('plain');
    expect(localStorage.getItem('toil-ui.font')).toBe('garamond');
    expect(within(card).getByRole('button', { name: /Font/ }).textContent).toContain('Garamond');
  });

  it('leaves no Plain words switch beside it', async () => {
    window.location.hash = '#/settings/appearance';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('region', { name: 'Theme' });
    expect(screen.queryByRole('region', { name: 'Plain words' })).toBeNull();
  });
});
