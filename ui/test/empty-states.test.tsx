import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ChatScope } from '../src/components/ask.tsx';
import { DataContext, type Data } from '../src/data.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { memoryAnalyses } from '../src/analyses.ts';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import type { ToilProjectData } from '../src/load.ts';
import { SkinProvider, skinsFor } from '../src/skins.tsx';
import { CommandCenter } from '../src/views/CommandCenter.tsx';
import { Dashboard } from '../src/views/Dashboard.tsx';
import { ItemView } from '../src/views/Item.tsx';
import { People } from '../src/views/People.tsx';
import { PullRequests } from '../src/views/PullRequests.tsx';
import { loaded } from './harness.ts';

/**
 * Empty states that act (#417, principle 11): every empty panel offers the
 * action that fills it. Two checks: every view draws its empty panels through
 * `Empty`, whose action is required, and an empty toil project's views, rendered,
 * show an action or a link (never only an (i)) in every empty panel.
 */

const src = join(import.meta.dirname, '..', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));

/**
 * Where the theme's slot may be used directly, beside the slot itself and its skins (src/skins*): `Empty`, and the chat's welcome,
 * whose starter questions and question box sit right under it and are what fill it.
 */
const SLOT_USERS = new Set([join('components', 'empty.tsx'), join('components', 'ask.tsx')]);

describe('every empty panel', () => {
  it('goes through Empty, which requires an action', () => {
    const direct = files(src)
      .map((f) => relative(src, f))
      .filter((f) => !SLOT_USERS.has(f) && !f.startsWith('skins') && !f.startsWith('fixtures'))
      .filter((f) => /\bEmptyState\b/.test(readFileSync(join(src, f), 'utf8')));
    expect(direct).toEqual([]);
  });

  // An empty toil project: the sample's card-payments with every item, pull request, build and deployment taken away.
  const empty = async (): Promise<ToilProjectData> => {
    const { data } = await loaded('card-payments');
    return { ...data, items: [], pullRequests: [], changes: [], deployments: [], people: [], codeowners: {} };
  };
  const shell = (toilProject: ToilProjectData, theme: string, children: ReactNode, sync?: () => void) => {
    const data: Data = { toilProject, byId: new Map(), prById: new Map(), agent: scriptedAgent(), now: FIXTURE_NOW, analyses: memoryAnalyses(), ...(sync ? { sync } : {}) };
    return render(
      <SkinProvider value={skinsFor(theme)}>
        <DataContext value={data}>
          <ChatScope>{children}</ChatScope>
        </DataContext>
      </SkinProvider>,
    );
  };
  /** Every empty panel on the page, and the ones with no action or link of their own (an (i) doesn't count). */
  const idle = () => {
    const panels = [...document.querySelectorAll('.skin-empty')];
    return { panels, idle: panels.filter((p) => ![...p.querySelectorAll('a[href], button')].some((b) => !b.closest('[data-help]') && !b.hasAttribute('data-help'))).map((p) => p.textContent) };
  };

  const VIEWS: Array<[string, () => ReactNode, number]> = [
    ['the Board tab', () => <Dashboard tab="board" />, 2],
    ['the Dependencies tab', () => <Dashboard tab="dependencies" />, 1],
    ['the Analyses tab', () => <Dashboard tab="analyses" />, 1],
    ['the Pull requests tab', () => <PullRequests />, 1],
    ['the People tab', () => <People />, 1],
    ['the Command Center', () => <CommandCenter />, 1],
    ['an item it does not have', () => <ItemView id="corp-jira:PAY-999" />, 1],
  ];
  for (const theme of ['plain', 'crate', 'harvest']) {
    it.each(VIEWS)(`in ${theme}, %s offers an action in each empty panel`, async (_, view, at) => {
      shell(await empty(), theme, view());
      await waitFor(() => expect(idle().panels.length).toBeGreaterThanOrEqual(at));
      expect(idle().idle).toEqual([]);
    });
  }

  it("offers Sync now where the page can sync, and the Toil project's setup where it can't", async () => {
    const d = await empty();
    let synced = 0;
    const { unmount } = shell(d, 'plain', <PullRequests />, () => synced++);
    await userEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(synced).toBe(1);
    unmount();
    shell(d, 'plain', <PullRequests />);
    expect((await screen.findByRole('link', { name: /Add a repository/ })).getAttribute('href')).toBe('#/settings/projects/card-payments/repos');
  });

  it('points a missing pipeline at Toil project setup, at its sources', async () => {
    shell(await empty(), 'plain', <Dashboard tab="board" />);
    expect((await screen.findByRole('link', { name: /Link a pipeline/ })).getAttribute('href')).toBe('#/settings/projects/card-payments/sources');
    expect(screen.getByRole('link', { name: /Add an environment/ }).getAttribute('href')).toBe('#/settings/projects/card-payments/sources');
  });
});
