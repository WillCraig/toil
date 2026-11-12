// @vitest-environment jsdom
// Each tab is opened in turn, as a tab would be in a review meeting: briefly, and to confirm it exists.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { CANNED, fixtureExecute } from '../src/fixtures/execute.ts';
import type { WorkItem } from '../src/toil.ts';
import { columnSteps, dropVerdict } from '../src/views/Board.tsx';
import { item, open, panel, tabs, metric, resetBrowserState } from './views-kit.tsx';

beforeEach(resetBrowserState);

describe('the views on a dashboard (#252, #253)', () => {
  it('flags each card that needs attention on the board, counts them on its tab, and filters to them (#394)', async () => {
    await open('#/project/card-payments/board');
    const board = panel('Sprint 42 board');
    const cards = () => within(board).getAllByRole('listitem').filter((li) => li.classList.contains('card'));
    const flagged = () => cards().filter((li) => li.classList.contains('card--attention'));
    const keys = () => flagged().map((li) => within(li).getAllByRole('link')[0]!.textContent).sort();
    expect(keys()).toEqual(['PAY-101', 'PAY-102', 'PAY-103', 'PAY-104']);
    expect(flagged()[0]!.querySelector('.card-flag')!.textContent).toBe('Needs attention');
    expect(within(tabs('card-payments')).getByRole('link', { name: 'Board, 4 items need attention' })).toBeTruthy();
    expect(cards().length).toBeGreaterThan(4);
    await userEvent.click(within(board).getByRole('checkbox', { name: 'Needs attention only (4)' }));
    expect(cards()).toHaveLength(4);
    expect(keys()).toEqual(['PAY-101', 'PAY-102', 'PAY-103', 'PAY-104']);
  });

  it('puts each sprint item on the board under its status category, with its own status word and insights', async () => {
    await open('#/project/settlement/board');
    const board = panel('Sprint 42 board');
    const col = (name: string) => within(board).getByRole('region', { name: new RegExp(`^${name}`) });
    const cards = (region: HTMLElement) => within(region).getAllByRole('listitem').filter((li) => li.classList.contains('card'));
    expect(cards(col('To do')).map((c) => within(c).getAllByRole('link')[0]!.textContent)).toEqual(['2303', '2306']);
    const card = cards(col('In progress')).find((li) => li.textContent?.includes('2304'))!;
    // The column already says In progress, so the card's own status word is not followed by it again.
    expect(card.textContent).toContain('Active');
    expect(card.textContent).not.toContain('Active · In progress');
    expect(card.textContent).toContain('M. Lind');
    // The source and the estimate share a line; each insight is an icon with its word kept as text and tooltip.
    expect(card.querySelector('.card-meta .field')!.textContent).toMatch(/^Azure DevOps · /);
    const aging = within(card).getByText('Open a long time').closest('li')!;
    expect(aging.getAttribute('title')).toBe('Open a long time');
    expect(aging.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('carries no buttons on its cards: the whole card is the handle, named by its key and title', async () => {
    await open('#/project/card-payments/board');
    const board = panel('Sprint 42 board');
    const cards = within(board).getAllByRole('listitem').filter((li) => li.classList.contains('card'));
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(within(c).queryAllByRole('button')).toEqual([]);
    const grip = within(board).getByRole('group', { name: 'PAY-102 Store tokens in the vault' });
    expect(grip.tabIndex).toBe(0);
    expect(grip.getAttribute('aria-roledescription')).toBe('draggable card');
    expect(grip.getAttribute('aria-keyshortcuts')).toBe('M ContextMenu');
    expect(document.getElementById(grip.getAttribute('aria-describedby')!)!.textContent).toMatch(/press Space or Enter.*arrow keys.*Escape to cancel.*Press M or the Menu key/);
  });

  it('opens the item on a click anywhere on the card', async () => {
    await open('#/project/card-payments/board');
    const grip = within(panel('Sprint 42 board')).getByRole('group', { name: 'PAY-102 Store tokens in the vault' });
    await userEvent.click(within(grip).getByText('Store tokens in the vault'));
    await waitFor(() => expect(window.location.hash).toBe(item('card-payments', 'corp-jira:PAY-102')));
  });

  it("turns a move from the card's context menu into a proposal card naming the toil command, and changes nothing", async () => {
    const fixture = fixtureExecute();
    await open('#/project/card-payments/board', { execute: fixture.execute });
    const before = fixture.calls.length;
    const board = panel('Sprint 42 board');
    const grip = within(board).getByRole('group', { name: 'PAY-102 Store tokens in the vault' });
    fireEvent.contextMenu(grip);
    const menu = await screen.findByRole('menu', { name: 'PAY-102 Store tokens in the vault' });
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Open', 'In progress', 'Done']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'In progress' }));
    expect(screen.queryByRole('menu')).toBeNull();
    const card = within(board).getByRole('article', { name: 'Proposal: Move PAY-102 to In progress' });
    expect(card.textContent).toContain("toil jira issue transition 'PAY-102' --toil-project 'card-payments' --transition 'In Progress' --allow-write");
    expect(screen.getByText(/Proposed: Move PAY-102 to In progress. Nothing has changed/)).toBeTruthy();
    // The card is still where Jira says it is, and nothing was asked of toil.
    expect(within(within(board).getByRole('region', { name: /^To do/ })).getByText('Store tokens in the vault')).toBeTruthy();
    expect(fixture.calls.length).toBe(before);
  });

  it('opens the same menu with M on the focused card, and only on the card itself', async () => {
    await open('#/project/card-payments/board');
    const board = panel('Sprint 42 board');
    const grip = within(board).getByRole('group', { name: 'PAY-102 Store tokens in the vault' });
    within(grip).getByRole('link', { name: 'PAY-102' }).focus();
    await userEvent.keyboard('m');
    expect(screen.queryByRole('menu')).toBeNull();
    grip.focus();
    await userEvent.keyboard('m');
    const menu = await screen.findByRole('menu', { name: 'PAY-102 Store tokens in the vault' });
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Done' }));
    expect(await within(board).findByRole('article', { name: 'Proposal: Move PAY-102 to Done' })).toBeTruthy();
    // The menu hands focus back to the card it came from.
    await waitFor(() => expect(document.activeElement).toBe(grip));
  });

  it('steps a lifted card a whole column per arrow key, in board order, whichever way the columns lie', () => {
    const order = ['TODO', 'IN_PROGRESS', 'DONE'] as const;
    // Side by side, as on a wide screen.
    const rects = new Map(order.map((c, i) => [c, { left: i * 300, top: 100, width: 280, height: 600, right: i * 300 + 280, bottom: 700 }]));
    const step = columnSteps([...order], () => 'TODO');
    const press = (code: string, over: string | null) => {
      const event = new KeyboardEvent('keydown', { code, cancelable: true });
      const at = step(event, { active: 'x', currentCoordinates: { x: 0, y: 0 }, context: { collisionRect: { width: 240, height: 120 }, droppableRects: rects, over: over ? { id: over } : null } } as never);
      return { at, prevented: event.defaultPrevented };
    };
    expect(press('ArrowRight', null)).toEqual({ at: { x: 320, y: 148 }, prevented: true });
    expect(press('ArrowDown', 'IN_PROGRESS').at).toEqual({ x: 620, y: 148 });
    expect(press('ArrowRight', 'DONE').at).toEqual({ x: 620, y: 148 });
    expect(press('ArrowLeft', 'IN_PROGRESS').at).toEqual({ x: 20, y: 148 });
    expect(press('ArrowUp', 'TODO').at).toEqual({ x: 20, y: 148 });
    // Any other key is left to dnd-kit: Space and Enter drop, Escape cancels.
    expect(press('Space', 'TODO')).toEqual({ at: undefined, prevented: false });
  });

  // #393: the drop worked, but nothing on screen moved during a drag and the proposal landed out of view.
  it('shows a lifted card as a copy that says what a drop would do, leaving a placeholder in its column', async () => {
    await open('#/project/card-payments/board');
    const board = panel('Sprint 42 board');
    const grip = within(board).getByRole('group', { name: 'PAY-102 Store tokens in the vault' });
    expect(document.querySelector('[data-drag-overlay]')).toBeNull();
    grip.focus();
    await userEvent.keyboard('[Space]');
    const overlay = await waitFor(() => document.querySelector<HTMLElement>('[data-drag-overlay]')!);
    expect(overlay.textContent).toContain('Store tokens in the vault');
    // Only for the eye: the announcements speak for it, and it holds no second link to the item.
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.querySelector('a')).toBeNull();
    expect(grip.closest('li')!.classList).toContain('card--dragging');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('[data-drag-overlay]')).toBeNull());
    expect(grip.closest('li')!.classList).not.toContain('card--dragging');
  });

  it('says on the dragged copy whether a column would take the card, and why not', () => {
    const card = { statusCategory: 'TODO' } as WorkItem;
    expect(dropVerdict(card, 'IN_PROGRESS')).toEqual({ ok: true, text: 'Drop to propose: In progress' });
    expect(dropVerdict(card, 'TODO')).toEqual({ ok: false, text: 'Already in To do: nothing to propose' });
    expect(dropVerdict(card, 'UNKNOWN')).toEqual({ ok: false, text: 'Unknown is no status to move to' });
    expect(dropVerdict(card, null)).toEqual({ ok: false, text: 'Not over a column' });
  });

  it('puts a proposed move where it was made: a ghost in the target column, with Undo and the way to apply it', async () => {
    await open('#/project/card-payments/board');
    const board = panel('Sprint 42 board');
    const col = (name: string) => within(board).getByRole('region', { name: new RegExp(`^${name}`) });
    const grip = within(board).getByRole('group', { name: 'PAY-102 Store tokens in the vault' });
    fireEvent.contextMenu(grip);
    await userEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'In progress' }));
    const ghost = within(col('In progress')).getByRole('listitem', { name: 'Proposed move, not applied: PAY-102 Store tokens in the vault' });
    expect(ghost.textContent).toContain('From To do.');
    // The ghost is not the card: the card stays in To do, and In progress still counts its own two.
    expect(within(col('To do')).getByRole('group', { name: 'PAY-102 Store tokens in the vault' })).toBe(grip);
    expect(col('In progress').querySelector('h3 .count')!.textContent).toBe('2');
    // How to apply goes to the proposal under the board, which has the command.
    await userEvent.click(within(ghost).getByRole('button', { name: 'How to apply the move of PAY-102 to In progress' }));
    expect(document.activeElement!.querySelector('[aria-label="Proposal: Move PAY-102 to In progress"]')).not.toBeNull();
    await userEvent.click(within(ghost).getByRole('button', { name: 'Undo the proposed move of PAY-102' }));
    expect(within(col('In progress')).queryByRole('listitem', { name: /^Proposed move/ })).toBeNull();
    expect(within(board).queryByRole('article', { name: 'Proposal: Move PAY-102 to In progress' })).toBeNull();
    expect(screen.getByText('Took back the proposed move of PAY-102. Nothing proposed.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(grip));
  });

  it('keeps a card that is not on a GitHub project board from being dragged, says why, and leaves the others draggable', async () => {
    // One board item loses its project item id, as an issue the board doesn't hold would have none.
    const canned = CANNED.map((c) => (c.command === 'github project items' ? { ...c, data: (c.data as Array<Record<string, unknown>>).map((b) => ((b.content as { number?: number } | undefined)?.number === 43 ? { ...b, id: 0 } : b)) } : c));
    await open('#/project/checkout-web/board', { execute: fixtureExecute(canned).execute });
    const board = await screen.findByRole('region', { name: /board/i });
    const grips = Array.from(board.querySelectorAll<HTMLElement>('.card-grip[data-item]'));
    const github = grips.filter((g) => g.dataset.item!.startsWith('github:'));
    expect(github.length).toBeGreaterThan(0);
    const off = github.filter((g) => g.hasAttribute('data-immovable'));
    const on = github.filter((g) => !g.hasAttribute('data-immovable'));
    expect(off).toHaveLength(1);
    expect(on.length).toBeGreaterThan(0);
    for (const g of on) expect(g.getAttribute('aria-roledescription')).toBe('draggable card');
    // Every card the board refuses to drag names its reason where a screen reader gets it, and offers no move in its menu.
    for (const g of off) {
      expect(g.getAttribute('aria-roledescription')).toBeNull();
      expect(document.getElementById(g.getAttribute('aria-describedby')!)!.textContent).toMatch(/isn't on a GitHub project board/);
      fireEvent.contextMenu(g);
      const menu = await screen.findByRole('menu');
      expect(within(menu).getAllByRole('menuitem', { name: /To do|In progress|Done/ }).every((m) => m.getAttribute('aria-disabled') === 'true')).toBe(true);
      await userEvent.keyboard('{Escape}');
    }
  });

  it('draws the metrics as sparklines, each opening its full chart, which lists what it could not compute (#394)', async () => {
    await open('#/project/checkout-web');
    const strip = screen.getByRole('region', { name: 'Metrics' });
    expect(within(strip).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Points done 1 of 11 points, show the full chart',
      'Finished 0.4 a week, show the full chart',
      'Time to finish 0 items timed, show the full chart',
      'Work getting old 0 in progress, show the full chart',
      'Review wait 2 working days, 3 open, show the full chart',
    ]);
    let dialog = await metric(/^Finished /);
    expect(within(dialog).getAllByRole('img').length).toBeGreaterThan(0);
    expect(dialog.textContent).toContain('3 finished in 6 weeks');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = await metric(/^Time to finish /);
    expect(dialog.textContent).toContain('No finished item here has a cycle time the data can show.');
    expect(dialog.textContent).toContain('Unknown: Never recorded as In progress before Done.');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = await metric(/^Work getting old /);
    expect(dialog.textContent).toContain('Unknown: No move into In progress recorded.');
  });

  it('draws the dependency graph, and lists every link in words', async () => {
    await open('#/project/card-payments/dependencies');
    const graph = panel('What blocks what');
    await waitFor(() => expect(graph.querySelector('.react-flow')).not.toBeNull());
    expect([...graph.querySelectorAll(':scope > ul.rows > li')].map((li) => li.textContent)).toEqual([
      'Jira PAY-101 Tokenise card numbers at the edge blocks Jira PAY-102 Store tokens in the vault (blocks)',
      'Jira PAY-102 Store tokens in the vault blocks Jira PAY-103 Charge a stored token (blocks)',
      'Jira PAY-103 Charge a stored token relates to Jira PAY-107 Retry declined charges once (relates to)',
    ]);
  });

  it('draws the blocker Gantt, with its key and every bar and arrow in a table (#396)', async () => {
    await open('#/project/card-payments/dependencies');
    const gantt = panel('Blocker timeline');
    const svg = gantt.querySelector('svg.gantt')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Blocker timeline for Sprint 42: 3 items and 2 waits-on arrows. Critical chain: PAY-101 blocks PAY-102 blocks PAY-103, 16 points. The table lists every bar and arrow.');
    expect(svg.querySelectorAll('.gantt-seg--blocked')).toHaveLength(2);
    expect(svg.querySelectorAll('.gantt-seg--checks')).toHaveLength(1);
    expect(svg.querySelectorAll('.gantt-arrow--chain')).toHaveLength(2);
    expect(svg.querySelector('.gantt-today')).not.toBeNull();
    expect(within(gantt).getByRole('list', { name: 'Key' }).textContent).toMatch(/In progress.*Blocked.*Checks failing.*Waits on.*Critical chain.*Today/);
    const table = within(gantt).getByRole('table', { name: 'Every bar and waits-on arrow in the blocker timeline' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getByRole('rowheader').querySelector('.l-table__value')!.textContent)).toEqual(['Jira PAY-101 Tokenise card numbers at the edge', 'Jira PAY-102 Store tokens in the vault', 'Jira PAY-103 Charge a stored token']);
    expect(rows[1]!.textContent).toContain('(estimated)');
    expect(rows[2]!.textContent).toContain('PAY-102, critical chain');
    expect(gantt.textContent).toContain('Blocked time is estimated');
  });

  it('says so when a Toil project has no links to draw', async () => {
    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme: 'plain' }));
    await open('#/project/checkout-web/dependencies');
    await waitFor(() => expect(panel('What blocks what').textContent).toContain("No links between this Toil project's items."));
  });

  it("charts the sprint's burn-up with its figures in a table", async () => {
    await open('#/project/settlement');
    const sprint = await metric(/^Points done /);
    expect(sprint.querySelector('svg.chart title')!.textContent).toBe('Sprint 42 burn-up: 1 of 16 points done after 9 days, with 3 days to go. Scope grew from 11 to 16 points.');
    expect(within(sprint).getByRole('table', { name: 'Sprint 42 burn-up by day' })).toBeTruthy();
  });
});
