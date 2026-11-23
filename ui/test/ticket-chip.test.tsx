// @vitest-environment jsdom
/**
 * A ticket chip's cut title (#649) on the two branches no caller hits today: a chip with nowhere
 * to go opens inline, and a chip that is itself the link is that link. The citation callers pass
 * (`detail`) stays a tooltip link. Neither branch leaves the title only in a `title` tooltip.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { Change, WorkItem } from '../../src/core/owi/types.ts';
import { TicketChip } from '../src/components/items.tsx';
import { DataContext, type Data } from '../src/data.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { itemHref } from '../src/format.ts';
import type { ToilProjectData } from '../src/load.ts';

afterEach(cleanup);

const TITLE = 'Retry a timed-out authorization without charging the card twice';

/** The fields a chip reads. The citation branch also asks the type, the assignee and the estimate. */
const item = (id: string) => ({ id, title: TITLE, status: 'In progress', statusCategory: 'IN_PROGRESS', type: 'STORY', typeName: null, assignee: null, estimate: null, source: { area: 'jira', key: 'PAY/PAY-101', connection: 'jira', command: 'jira issue get' } }) as WorkItem;

function renderChip(id: string, item: WorkItem | undefined, pr: Change | undefined, detail = false) {
  const value: Data = {
    toilProject: { name: 'card-payments' } as ToilProjectData,
    byId: new Map(item ? [[id, item]] : []),
    prById: new Map(pr ? [[id, pr]] : []),
    agent: scriptedAgent(),
    now: FIXTURE_NOW,
  };
  render(
    <DataContext value={value}>
      <TicketChip id={id} detail={detail} />
    </DataContext>,
  );
}

describe('a ticket chip with no tooltip', () => {
  it('opens a chip with nowhere to go, and the title stays in the chip', async () => {
    const id = 'bitbucket:payments-core#311';
    renderChip(id, undefined, { id, title: TITLE, state: 'OPEN', url: null } as Change);
    const chip = document.querySelector('.ticket-chip')!;
    expect(chip.tagName).toBe('SPAN');
    expect(chip.getAttribute('data-truncate')).toBe('expand');
    expect(chip.querySelector('.ticket-chip__title')!.textContent).toBe(TITLE);
    const more = screen.getByRole('button', { name: /^More:/ });
    expect(more.textContent).toBe('More');
    expect(more.getAttribute('aria-label')!.startsWith('More')).toBe(true);
    await userEvent.click(more);
    expect(chip.getAttribute('data-truncate-open')).toBe('true');
    expect(screen.getByRole('button', { name: /^Less:/ }).textContent).toBe('Less');
    expect(chip.querySelector('.ticket-chip__title')!.textContent).toBe(TITLE);
    await userEvent.click(screen.getByRole('button', { name: /^Less:/ }));
    expect(chip.hasAttribute('data-truncate-open')).toBe(false);
  });

  it('is the link to its item when it has one and is not a citation', () => {
    const id = 'jira:PAY-101';
    renderChip(id, item(id), undefined);
    const chip = document.querySelector('a.ticket-chip')!;
    expect(chip.getAttribute('data-truncate')).toBe('detail');
    expect(chip.getAttribute('href')).toBe(itemHref('card-payments', id));
    expect(chip.querySelector('.ticket-chip__title')!.textContent).toBe(TITLE);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('stays a citation link when detail is set, which is what callers pass', () => {
    const id = 'jira:PAY-101';
    renderChip(
      id,
      item(id),
      undefined,
      true,
    );
    expect(document.querySelector('.ticket-chip')).toBeNull();
    expect(document.querySelector('a.cite-link')!.getAttribute('href')).toBe(itemHref('card-payments', id));
    expect(screen.queryByRole('button', { name: /^More:/ })).toBeNull();
  });
});
