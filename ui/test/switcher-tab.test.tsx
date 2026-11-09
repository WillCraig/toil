import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';

/** Switching Toil project keeps the tab being read; a page that isn't a tab lands on the first one. */
async function menuHrefs(hash: string): Promise<string[]> {
  window.location.hash = hash;
  render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
  await userEvent.click(await screen.findByRole('button', { name: /^Switch Toil project/ }, { timeout: 5000 }));
  const menu = await screen.findByRole('menu');
  return [...menu.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
}

describe('the Toil project switcher', () => {
  it('stays on Code reviews when it is the tab being read', async () => {
    const hrefs = await menuHrefs('#/project/card-payments/prs');
    const others = hrefs.filter((h) => h.startsWith('#/project/'));
    expect(others.length).toBeGreaterThan(0);
    for (const h of others) expect(h.endsWith('/prs')).toBe(true);
  }, 20_000);
});
