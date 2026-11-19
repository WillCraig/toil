// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { fixtureClassify } from '../src/fixtures/classify.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { CANNED, FIXTURE_NOW, fixtureExecute, type Canned } from '../src/fixtures/execute.ts';
import type { ClassifyApi } from '../src/classify-api.ts';
import type { MoveOutcome } from '../src/board-api.ts';
import { resetBoardMoves, setBoardMoves } from '../src/board-moves.ts';
import { appliesItself, boardBlock, canMove, dropRefusal, proposeMove } from '../src/model/board.ts';
import { commandLine } from '../src/proposal.ts';
import { TOIL_PROJECTS, showData } from '../src/fixtures/toil-projects.ts';
import { GITHUB_ISSUES } from '../src/fixtures/work.ts';
import { dropVerdict } from '../src/views/Board.tsx';
import type { WorkItem } from '../src/toil.ts';

/**
 * What a drop does (a person moved a card): with "Apply board moves when I drop a card" on, the default, the move is made
 * through the server and toil; every other case is the proposal it always was, with the line saying why. A drop and the
 * card's menu are one code path (`move` in Board.tsx), and the menu is how these tests make it, since jsdom has no layout
 * for a pointer to drag across.
 */

beforeEach(() => {
  localStorage.clear();
  resetBoardMoves();
});
afterEach(cleanup);

const PAY = 'corp-jira:PAY-102';

/** A ClassifyApi that can apply a move, whatever the sample's script says; `moveItem` is the spy. */
function api(moveItem: ClassifyApi['moveItem'], movesDisabled: string | null = null): ClassifyApi {
  return { ...fixtureClassify(), movesDisabled, ...(moveItem ? { moveItem } : {}) };
}

async function openBoard(classify: ClassifyApi | undefined) {
  window.location.hash = '#/project/card-payments/board';
  render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview {...(classify ? { classify } : {})} />);
  const board = await screen.findByRole('region', { name: 'Sprint board' });
  return {
    board,
    col: (name: string) => within(board).getByRole('region', { name: new RegExp(`^${name}`) }),
    grip: () => within(board).getByRole('group', { name: 'PAY-102 Store tokens in the vault' }),
  };
}

/** Moves PAY-102 from its card's menu, as a drop on the column would. */
async function drop(grip: HTMLElement, to: 'In progress' | 'Done' | 'To do') {
  fireEvent.contextMenu(grip);
  const menu = await screen.findByRole('menu', { name: 'PAY-102 Store tokens in the vault' });
  await userEvent.click(within(menu).getByRole('menuitem', { name: to }));
}

const inColumn = (col: HTMLElement) => within(col).queryByRole('group', { name: 'PAY-102 Store tokens in the vault' }) !== null;

describe('the setting', () => {
  it('is on until a person turns it off, and is remembered in this browser', async () => {
    window.location.hash = '#/settings/general';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    const box = await screen.findByRole('checkbox', { name: 'Apply board moves when I drop a card' });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(localStorage.getItem('toil-ui.board-moves')).toBeNull();
    await userEvent.click(box);
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(localStorage.getItem('toil-ui.board-moves')).toBe('off');
    // A fresh read of storage, as a reload would make.
    resetBoardMoves();
    cleanup();
    window.location.hash = '#/settings/general';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    expect(((await screen.findByRole('checkbox', { name: 'Apply board moves when I drop a card' })) as HTMLInputElement).checked).toBe(false);
  });

  it('explains itself in an (i) beside it, with a Read more link to the docs', async () => {
    window.location.hash = '#/settings/general';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('checkbox', { name: 'Apply board moves when I drop a card' });
    await userEvent.click(document.querySelector<HTMLElement>('[data-help="board-moves"]')!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Dropping a card on another column makes the move through toil/);
    expect(within(dialog).getByRole('link', { name: /Read more/ }).getAttribute('href')).toBe('https://imagile-dev.github.io/toil/docs/ui/#board-moves');
  });
});

describe('a drop with the setting on', () => {
  it('moves the card at once, sends only the Toil project, the item and the column, and says so with an Undo that sends the reverse', async () => {
    let finish!: (o: MoveOutcome) => void;
    const moveItem = vi.fn<NonNullable<ClassifyApi['moveItem']>>().mockImplementationOnce(() => new Promise<MoveOutcome>((r) => (finish = r)));
    const { board, col, grip } = await openBoard(api(moveItem));
    await drop(grip(), 'In progress');
    expect(moveItem).toHaveBeenCalledTimes(1);
    expect(moveItem).toHaveBeenCalledWith('card-payments', PAY, 'IN_PROGRESS');
    // In its new column before the tracker has answered, quietly marked as moving; no proposal and no ghost.
    expect(inColumn(col('In progress'))).toBe(true);
    expect(inColumn(col('To do'))).toBe(false);
    expect(within(board.parentElement!).getByText('Moving…')).toBeTruthy();
    expect(within(board).queryByRole('article')).toBeNull();
    expect(document.querySelector('[data-proposed-ghost]')).toBeNull();
    await act(async () => finish({ status: 'applied', transition: 'Start progress', toStatus: 'In Progress' }));
    const line = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-board-notice="moved"]');
      if (!el) throw new Error('no notice yet');
      return el;
    });
    expect(line.textContent).toContain('with the transition Start progress');
    expect(line.textContent).toContain('Moved PAY-102 to In progress');
    expect(screen.queryByText('Moving…')).toBeNull();
    expect(inColumn(col('In progress'))).toBe(true);
    // The Undo is the reverse move, by the same route.
    moveItem.mockResolvedValueOnce({ status: 'applied', transition: 'Stop progress', toStatus: 'To Do' });
    await userEvent.click(screen.getByRole('button', { name: 'Undo the move of PAY-102' }));
    await waitFor(() => expect(moveItem).toHaveBeenLastCalledWith('card-payments', PAY, 'TODO'));
    await waitFor(() => expect(inColumn(col('To do'))).toBe(true));
    expect(inColumn(col('In progress'))).toBe(false);
    expect(moveItem).toHaveBeenCalledTimes(2);
  });

  it('cannot be moved again, or opened in its menu, while its first move is in flight, and a settled move is never put back as moving', async () => {
    let finish!: (o: MoveOutcome) => void;
    const moveItem = vi.fn<NonNullable<ClassifyApi['moveItem']>>().mockImplementationOnce(() => new Promise<MoveOutcome>((r) => (finish = r)));
    const { board, grip } = await openBoard(api(moveItem));
    await drop(grip(), 'In progress');
    expect(screen.getByText('Moving…')).toBeTruthy();
    // The card's menu stays shut and the card cannot be picked up while it moves.
    fireEvent.contextMenu(grip());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(within(board).getByRole('group', { name: 'PAY-102 Store tokens in the vault' }).getAttribute('aria-disabled')).toBe('true');
    expect(moveItem).toHaveBeenCalledTimes(1);
    await act(async () => finish({ status: 'applied', transition: 'Start progress', toStatus: 'In Progress' }));
    await waitFor(() => expect(screen.queryByText('Moving…')).toBeNull());
    // Settled: the menu opens again.
    fireEvent.contextMenu(grip());
    expect(await screen.findByRole('menu', { name: 'PAY-102 Store tokens in the vault' })).toBeTruthy();
  });

  it('says GitHub may close the issue after a move to Done, and says "Reopened and moved" after a reopen', async () => {
    const moveItem = vi.fn<NonNullable<ClassifyApi['moveItem']>>().mockResolvedValueOnce({ status: 'applied', transition: null, toStatus: 'Done', mayClose: true });
    const { grip } = await openBoard(api(moveItem));
    await drop(grip(), 'Done');
    const line = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-board-notice="moved"]');
      if (!el) throw new Error('no notice yet');
      return el;
    });
    expect(line.textContent).toContain('Moved PAY-102 to Done. GitHub may close the issue, since its project workflow does.');
    // Undo is the reverse move, and the server reopens the issue first.
    moveItem.mockResolvedValueOnce({ status: 'applied', transition: null, toStatus: 'Todo', reopened: true });
    await userEvent.click(screen.getByRole('button', { name: 'Undo the move of PAY-102' }));
    await waitFor(() => expect(document.querySelector('[data-board-notice="moved"]')!.textContent).toContain('Reopened and moved PAY-102 to To do.'));
    expect(document.querySelector('[data-board-notice="moved"]')!.textContent).not.toContain('may close');
  });

  it("sends the card back and says in toil's own words why, when toil refuses; the message stays until dismissed", async () => {
    const moveItem = vi.fn<NonNullable<ClassifyApi['moveItem']>>().mockRejectedValue(new Error("Changes to corp-jira are switched off, so PAY-102 wasn't changed. Turn writes on for corp-jira under Settings, Connections."));
    const { col, grip } = await openBoard(api(moveItem));
    await drop(grip(), 'Done');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/PAY-102 was not moved to Done.*switched off.*Settings, Connections/);
    expect(inColumn(col('To do'))).toBe(true);
    expect(inColumn(col('Done'))).toBe(false);
    expect(screen.queryByText('Moving…')).toBeNull();
    // Nothing else on screen takes it away.
    await userEvent.click(within(col('To do')).getAllByRole('link')[0]!).catch(() => undefined);
    expect(screen.getByRole('alert')).toBeTruthy();
    await userEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Dismiss this message' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("shows the proposal with the moves toil offers when more than one transition leads there, and sends nothing more", async () => {
    const moveItem = vi.fn<NonNullable<ClassifyApi['moveItem']>>().mockResolvedValue({ status: 'proposal', why: 'choices', reason: '"start" is ambiguous for PAY-102 (Story, now To Do): more than one move leads into its status category: In Progress, In Review.', detail: 'PAY-102 offers: In Progress; In Review. Pass one of them with --to <status>.' });
    const { board, col, grip } = await openBoard(api(moveItem));
    await drop(grip(), 'In progress');
    const card = await within(board).findByRole('article', { name: 'Proposal: Move PAY-102 to In progress' });
    expect(card.querySelector('[data-proposal-why]')!.textContent).toMatch(/ambiguous for PAY-102/);
    expect(card.textContent).toContain('In Progress; In Review');
    expect(within(card).queryByRole('button', { name: /^Apply/ })).toBeNull();
    // The card went back to the column the tracker still has it in.
    expect(inColumn(col('To do'))).toBe(true);
    expect(moveItem).toHaveBeenCalledTimes(1);
  });

  it('leaves a connection with writes off as a proposal that says so', async () => {
    const moveItem = vi.fn<NonNullable<ClassifyApi['moveItem']>>().mockResolvedValue({ status: 'proposal', why: 'writes-off', reason: 'Changes to corp-jira are switched off, so this move was not applied. Turn them on under Settings, Connections, or apply the proposal yourself.' });
    const { board, col, grip } = await openBoard(api(moveItem));
    await drop(grip(), 'In progress');
    const card = await within(board).findByRole('article', { name: 'Proposal: Move PAY-102 to In progress' });
    expect(card.querySelector('[data-proposal-why]')!.textContent).toMatch(/switched off/);
    expect(inColumn(col('To do'))).toBe(true);
  });
});

describe('a drop that stays a proposal', () => {
  it('in the sample sends nothing, never moves the card, and says the sample cannot write', async () => {
    const moveItem = vi.fn<NonNullable<ClassifyApi['moveItem']>>();
    const { board, col, grip } = await openBoard(api(moveItem, "This is sample data, so nothing here can be written."));
    await drop(grip(), 'In progress');
    const card = within(board).getByRole('article', { name: 'Proposal: Move PAY-102 to In progress' });
    expect(card.querySelector('[data-proposal-why]')!.textContent).toMatch(/sample data/);
    // The ghost says in plain words that the sample saves nothing, with Undo only: nobody can apply a move in the sample.
    const ghost = document.querySelector<HTMLElement>('[data-proposed-ghost]')!;
    expect(ghost.querySelector('[data-ghost-note]')!.textContent).toBe("Sample data: this move isn't saved.");
    expect(ghost.textContent).not.toMatch(/toil|apply/i);
    expect(within(ghost).getByRole('button', { name: 'Undo the proposed move of PAY-102' })).toBeTruthy();
    expect(within(ghost).queryByRole('button', { name: /How to apply/ })).toBeNull();
    // No primary action: the sample has nothing to apply it to.
    expect(within(card).queryByRole('button', { name: /^Apply/ })).toBeNull();
    expect(inColumn(col('To do'))).toBe(true);
    expect(screen.queryByText('Moving…')).toBeNull();
    expect(moveItem).not.toHaveBeenCalled();
  });

  it('with the setting off sends nothing and is the card it always was: the reason, an Apply, the command a step further in', async () => {
    setBoardMoves(false);
    const moveItem = vi.fn<NonNullable<ClassifyApi['moveItem']>>().mockResolvedValue({ status: 'applied', transition: 'Start progress', toStatus: 'In Progress' });
    const { board, col, grip } = await openBoard(api(moveItem));
    await drop(grip(), 'In progress');
    const card = within(board).getByRole('article', { name: 'Proposal: Move PAY-102 to In progress' });
    expect(card.querySelector('[data-proposal-why]')!.textContent).toMatch(/off in Settings, General/);
    // With real data the ghost says only that it is not applied; the reason is the proposal's line, said once.
    const ghost = document.querySelector<HTMLElement>('[data-proposed-ghost]')!;
    expect(ghost.querySelector('[data-ghost-note]')!.textContent).toBe('From To do. Not applied yet.');
    expect(within(ghost).getByRole('button', { name: /^How to apply the move of PAY-102/ })).toBeTruthy();
    expect(moveItem).not.toHaveBeenCalled();
    expect(inColumn(col('To do'))).toBe(true);
    // The command is behind "Show the command", still in the page for whoever opens it.
    const details = card.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')!.textContent).toBe('Show the command');
    expect(details.textContent).toContain("toil jira issue transition 'PAY-102' --toil-project 'card-payments' --to 'start' --allow-write");
    expect(within(details as HTMLElement).getByRole('button', { name: 'Copy command' })).toBeTruthy();
    expect(within(card).getByRole('radio', { name: 'PowerShell' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    // A press on Apply is the same move, by the same route.
    await userEvent.click(within(card).getByRole('button', { name: 'Apply: Move PAY-102 to In progress' }));
    await waitFor(() => expect(moveItem).toHaveBeenCalledWith('card-payments', PAY, 'IN_PROGRESS'));
    await waitFor(() => expect(inColumn(col('In progress'))).toBe(true));
    expect(within(board).queryByRole('article', { name: /^Proposal/ })).toBeNull();
  });

  it("where a view has no server to ask, is the proposal, and says it can't change the tracker", async () => {
    const { board, col, grip } = await openBoard(undefined);
    await drop(grip(), 'In progress');
    const card = within(board).getByRole('article', { name: 'Proposal: Move PAY-102 to In progress' });
    expect(card.querySelector('[data-proposal-why]')!.textContent).toMatch(/can't change your tracker/);
    expect(inColumn(col('To do'))).toBe(true);
  });

  it('says on the dragged copy whether a drop moves the card or proposes the move', () => {
    const card = { statusCategory: 'TODO' } as WorkItem;
    expect(dropVerdict(card, 'DONE', true, true)).toEqual({ ok: true, text: 'Drop to move: Done' });
    expect(dropVerdict(card, 'DONE', true, false)).toEqual({ ok: true, text: 'Drop to propose: Done' });
    expect(dropVerdict(card, 'TODO', true, true).ok).toBe(false);
    // A lane is a grouping, not a status: a drop in another lane is refused whatever the setting says.
    expect(dropVerdict(card, 'DONE', false, true)).toEqual({ ok: false, text: 'Another lane: a lane is a grouping, nothing to change' });
  });

  it('applies a GitHub issue itself, and leaves a draft on a project board, which has no issue number, to its command', () => {
    const of = (area: string, key = 'x') => ({ source: { area, key } }) as unknown as WorkItem;
    expect(appliesItself(of('jira'))).toBe(true);
    expect(appliesItself(of('ado'))).toBe(true);
    expect(appliesItself(of('github', 'acme/shop#7'))).toBe(true);
    expect(appliesItself(of('github', 'acme/draft/PVTI_abc12345'))).toBe(false);
    expect(appliesItself(of('confluence'))).toBe(false);
  });

  it('lets every GitHub card be picked up: on a board by its Status, off one by open and closed', () => {
    const of = (native: Record<string, unknown>) => ({ source: { area: 'github', key: 'acme/shop#7' }, native }) as unknown as WorkItem;
    expect(canMove(of({ 'github project items': { id: 'PVTI_abc12345' } }))).toEqual({ ok: true });
    expect(canMove(of({}))).toEqual({ ok: true });
  });
});

/**
 * A GitHub card with the Toil project naming no project board (the fixture's checkout-web, with the board taken out of its
 * file and its issues read the way the loader reads a plain repository), so In progress is a column nothing can fill.
 */
function noBoardCanned(): Canned[] {
  const file = TOIL_PROJECTS.find((d) => d.name === 'checkout-web')!;
  const shown = showData({ ...file, github: { ...(file.github as Record<string, unknown>), projects: [] } });
  return [
    ...CANNED.filter((c) => !(c.command === 'projects show' && c.input.toilProject === 'checkout-web') && c.command !== 'github project items'),
    { command: 'projects show', input: { toilProject: 'checkout-web' }, data: shown, toilProject: 'checkout-web' },
    { command: 'github issue list', input: { toilProject: 'checkout-web', owner: 'imagile', repo: 'payments-web', state: 'all' }, data: GITHUB_ISSUES, toilProject: 'checkout-web', area: 'github' },
  ];
}

async function openCheckout(classify: ClassifyApi | undefined, canned?: Canned[]) {
  window.location.hash = '#/project/checkout-web/board';
  render(<App execute={fixtureExecute(canned).execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview {...(classify ? { classify } : {})} />);
  const first = await waitFor(
    () => {
      const el = document.querySelector<HTMLElement>('.board section.column--todo .card-grip[data-item^="github"]');
      if (!el) throw new Error('no GitHub card in To do yet');
      return el;
    },
    { timeout: 8000 },
  );
  const todo = () => document.querySelector<HTMLElement>('.board section.column--todo')!;
  return { first, todo, col: (name: string) => within(document.querySelector<HTMLElement>('.board')!).getByRole('region', { name: new RegExp(`^${name}`) }) };
}

async function dropGrip(grip: HTMLElement, to: 'In progress' | 'Done' | 'To do') {
  fireEvent.contextMenu(grip);
  const menu = await screen.findByRole('menu');
  await userEvent.click(within(menu).getByRole('menuitem', { name: to }));
}

describe('a GitHub card dropped where no project board gives it a place', () => {
  it('case 1: In progress with no board named sends the card back, says what is missing and where to name it, and shows no ghost and no proposal', async () => {
    const moveItem = vi.fn<NonNullable<ClassifyApi['moveItem']>>();
    const { first, todo } = await openCheckout(api(moveItem), noBoardCanned());
    const id = first.dataset.item!;
    await dropGrip(first, 'In progress');
    const alert = await screen.findByRole('alert');
    expect(alert.querySelector('[data-blocked-reason]')!.textContent).toBe("GitHub issues are only open or closed, so In progress needs a project board. This Toil project doesn't name one.");
    expect(alert.textContent).toMatch(/wasn't moved to In progress/);
    expect(alert.querySelector('[data-blocked-next]')!.textContent).toMatch(/Create a project board on GitHub if there is none, name it in the Toil project, then add the issue to it\./);
    const link = within(alert).getByRole('link', { name: 'Name a project board in this Toil project' });
    expect(link.getAttribute('href')).toBe('#/settings/projects/checkout-web/sources');
    // The command is a step further in, as it is typed, with the number left for the person.
    const details = alert.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('toil projects link checkout-web github --add projects=<number>');
    // The card never left its column; there is no ghost and no proposal; the server was never asked.
    expect(todo().querySelector(`.card-grip[data-item="${CSS.escape(id)}"]`)).toBeTruthy();
    expect(document.querySelector('[data-proposed-ghost]')).toBeNull();
    expect(screen.queryByRole('article', { name: /^Proposal/ })).toBeNull();
    expect(screen.queryByText('Moving…')).toBeNull();
    expect(moveItem).not.toHaveBeenCalled();
    // It stays until it is dismissed.
    await userEvent.click(within(alert).getByRole('button', { name: 'Dismiss this message' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the same with the setting off, since no command could make the move either way', async () => {
    setBoardMoves(false);
    const moveItem = vi.fn<NonNullable<ClassifyApi['moveItem']>>();
    const { first } = await openCheckout(api(moveItem), noBoardCanned());
    await dropGrip(first, 'In progress');
    expect((await screen.findByRole('alert')).textContent).toMatch(/only open or closed/);
    expect(screen.queryByRole('article', { name: /^Proposal/ })).toBeNull();
    expect(document.querySelector('[data-proposed-ghost]')).toBeNull();
  });

  it('says it where a view has no server to ask, rather than leaving a ghost', async () => {
    const { first } = await openCheckout(undefined, noBoardCanned());
    await dropGrip(first, 'In progress');
    expect((await screen.findByRole('alert')).textContent).toMatch(/only open or closed/);
    expect(document.querySelector('[data-proposed-ghost]')).toBeNull();
  });

  it('case 2: a card that is not on its board is a proposal with Add to the board and move; one press is one call, and says it added and moved', async () => {
    const moveItem = vi
      .fn<NonNullable<ClassifyApi['moveItem']>>()
      .mockResolvedValueOnce({
        status: 'proposal',
        why: 'not-on-board',
        reason: 'imagile/payments-web#9 isn\'t on the project board "Roadmap" (project 7). Add it there, then move it.',
        board: { project: 7, title: 'Roadmap', url: 'https://ghe.imagile.dev/orgs/imagile/projects/7' },
        add: { project: 7, number: 9, status: 'In Progress', canApply: true },
      })
      .mockResolvedValueOnce({ status: 'applied', transition: null, toStatus: 'In Progress', added: true });
    const { first, col } = await openCheckout(api(moveItem));
    const id = first.dataset.item!;
    await dropGrip(first, 'In progress');
    const card = await screen.findByRole('article', { name: /^Proposal: Move .* to In progress$/ });
    expect(card.querySelector('[data-proposal-why]')!.textContent).toMatch(/isn't on the project board "Roadmap" \(project 7\)\. Add it there, then move it\./);
    expect(within(card).getByRole('link', { name: /Open the project board/ }).getAttribute('href')).toBe('https://ghe.imagile.dev/orgs/imagile/projects/7');
    expect(moveItem).toHaveBeenCalledTimes(1);
    expect(moveItem).toHaveBeenLastCalledWith('checkout-web', id, 'IN_PROGRESS');
    // Under Show the command, the two commands that work, in order: add by number, then the Status by number.
    const shown = card.querySelector('details')!.textContent!;
    expect(shown).toMatch(/toil github project add '7' '\d+' --toil-project 'checkout-web' --owner 'imagile' --repo 'payments-web' --allow-write/);
    expect(shown).toMatch(/toil github project status '7' '\d+' --toil-project 'checkout-web' --owner 'imagile' --repo 'payments-web' --to 'In Progress' --allow-write/);
    expect(shown.indexOf('project add')).toBeLessThan(shown.indexOf('project status'));
    // Pressing the button is the same move with the add asked for, and nothing else is sent.
    await userEvent.click(within(card).getByRole('button', { name: /^Add to the board and move: / }));
    await waitFor(() => expect(moveItem).toHaveBeenCalledTimes(2));
    expect(moveItem).toHaveBeenLastCalledWith('checkout-web', id, 'IN_PROGRESS', { addToBoard: true });
    const line = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-board-notice="moved"]');
      if (!el) throw new Error('no notice yet');
      return el;
    });
    expect(line.textContent).toMatch(/^Added .* to the board and moved it to In progress\./);
    expect(col('In progress').querySelector(`.card-grip[data-item="${CSS.escape(id)}"]`)).toBeTruthy();
    expect(screen.queryByRole('article', { name: /^Proposal/ })).toBeNull();
  });

  it('case 2 without the means: no button when the app cannot add, and the reason is on the card', async () => {
    const moveItem = vi.fn<NonNullable<ClassifyApi['moveItem']>>().mockResolvedValue({
      status: 'proposal',
      why: 'not-on-board',
      reason: "imagile/payments-web#9 isn't on the project board project 7. Add it there, then move it.",
      detail: "Changes to github are switched off, so toil can't add it for you. Turn them on under Settings, Connections, or run the commands yourself.",
      add: { project: 7, number: 9, status: 'In Progress', canApply: false },
    });
    const { first } = await openCheckout(api(moveItem));
    await dropGrip(first, 'In progress');
    const card = await screen.findByRole('article', { name: /^Proposal: Move .* to In progress$/ });
    expect(within(card).queryByRole('button', { name: /^Add to the board and move/ })).toBeNull();
    expect(card.textContent).toContain('switched off');
  });

  it("case 3: a board that couldn't be read is said so, with toil's message and the connection to check, and never as not being on the board", async () => {
    const moveItem = vi.fn<NonNullable<ClassifyApi['moveItem']>>().mockResolvedValue({
      status: 'blocked',
      why: 'board-unread',
      reason: "The project board 7 couldn't be read, so toil can't tell where imagile/payments-web#9 stands on it: The GitHub token can't change items of project 7.",
      next: { text: 'Give the token access to Projects. A classic token needs read:project.', link: { kind: 'connection', name: 'github', label: 'Check the github connection' } },
    });
    const { first, todo } = await openCheckout(api(moveItem));
    const id = first.dataset.item!;
    await dropGrip(first, 'In progress');
    const alert = await screen.findByRole('alert');
    expect(alert.querySelector('[data-blocked-reason]')!.textContent).toMatch(/^The project board 7 couldn't be read, so toil can't tell where .* stands on it: The GitHub token can't change items of project 7\.$/);
    expect(alert.textContent).not.toMatch(/isn't on/);
    expect(alert.querySelector('[data-blocked-next]')!.textContent).toContain('A classic token needs read:project.');
    expect(within(alert).getByRole('link', { name: 'Check the github connection' }).getAttribute('href')).toBe('#/settings/connections/github');
    expect(todo().querySelector(`.card-grip[data-item="${CSS.escape(id)}"]`)).toBeTruthy();
    expect(document.querySelector('[data-proposed-ghost]')).toBeNull();
    expect(screen.queryByRole('article', { name: /^Proposal/ })).toBeNull();
  });

  it('case 5: a closed pull request asked to leave Done is a notice with the next step, not a proposal', async () => {
    const moveItem = vi.fn<NonNullable<ClassifyApi['moveItem']>>().mockResolvedValue({
      status: 'blocked',
      why: 'closed',
      reason: 'imagile/payments-web#9 is a closed pull request, and a closed pull request stays in Done whatever its Status says.',
      next: { text: 'Reopen it on GitHub first, then move it.' },
    });
    const { first } = await openCheckout(api(moveItem));
    await dropGrip(first, 'In progress');
    const alert = await screen.findByRole('alert');
    expect(alert.querySelector('[data-blocked-reason]')!.textContent).toMatch(/stays in Done whatever its Status says\.$/);
    expect(alert.querySelector('[data-blocked-next]')!.textContent).toBe('Reopen it on GitHub first, then move it.');
    expect(screen.queryByRole('article', { name: /^Proposal/ })).toBeNull();
  });
});

describe('what the page knows before a drop', () => {
  const issue = (statusCategory: string, key = 'acme/shop#7') => ({ source: { area: 'github', key, connection: 'github' }, statusCategory, native: {} }) as unknown as WorkItem;

  it('says In progress needs a project board when the Toil project names none, and only then', () => {
    const none = { projects: [], unread: [] };
    expect(boardBlock(issue('TODO'), 'IN_PROGRESS', none, 'card-payments')).toMatchObject({ why: 'no-board', reason: expect.stringContaining('In progress needs a project board'), next: { template: 'toil projects link card-payments github --add projects=<number>' } });
    // To do and Done are open and closed: no board needed.
    expect(boardBlock(issue('TODO'), 'DONE', none, 'card-payments')).toBeNull();
    expect(boardBlock(issue('DONE'), 'TODO', none, 'card-payments')).toBeNull();
    // A board is named, or the data doesn't say, or it is not a GitHub issue: the server decides.
    expect(boardBlock(issue('TODO'), 'IN_PROGRESS', { projects: [3], unread: [] }, 'card-payments')).toBeNull();
    expect(boardBlock(issue('TODO'), 'IN_PROGRESS', undefined, 'card-payments')).toBeNull();
    expect(boardBlock(issue('TODO'), 'IN_PROGRESS', null, 'card-payments')).toBeNull();
    expect(boardBlock({ ...issue('TODO'), source: { area: 'jira', key: 'PAY-1', connection: 'jira' } } as unknown as WorkItem, 'IN_PROGRESS', none, 'card-payments')).toBeNull();
  });

  it('hints on the column, and on the copy under the pointer, while a card that has no In progress is dragged', () => {
    const none = { projects: [], unread: [] };
    expect(dropRefusal(issue('TODO'), 'IN_PROGRESS', none)).toBe('Needs a project board to go here');
    expect(dropRefusal(issue('TODO'), 'DONE', none)).toBeNull();
    expect(dropRefusal(issue('TODO'), 'IN_PROGRESS', { projects: [3], unread: [] })).toBeNull();
    expect(dropVerdict(issue('TODO') as WorkItem, 'IN_PROGRESS', true, true, 'Needs a project board to go here')).toEqual({ ok: false, text: 'Needs a project board to go here' });
  });

  it('proposes putting a card that has no record on a named board there first, then setting its Status: two writes, in that order', () => {
    const item = { ...issue('TODO'), id: 'github:acme/shop#7', typeName: null, status: 'open', url: null } as unknown as WorkItem;
    const p = proposeMove(item, 'IN_PROGRESS', [item], 'card-payments', { projects: [3], unread: [] }, { project: 3, number: 7, status: 'In Progress', canApply: true })!;
    expect(p).toMatchObject({ command: 'github project add', input: { toilProject: 'card-payments', owner: 'acme', repo: 'shop', project: 3, number: 7 }, then: { command: 'github project status', input: { toilProject: 'card-payments', owner: 'acme', repo: 'shop', project: 3, number: 7, to: 'In Progress' } } });
    expect(commandLine(p, 'posix').line).toBe("toil github project add '3' '7' --toil-project 'card-payments' --owner 'acme' --repo 'shop' --allow-write");
    expect(commandLine(p.then!, 'posix').line).toBe("toil github project status '3' '7' --toil-project 'card-payments' --owner 'acme' --repo 'shop' --to 'In Progress' --allow-write");
    // Several boards, or one that wasn't read: no command is guessed.
    expect(proposeMove(item, 'IN_PROGRESS', [item], 'card-payments', { projects: [3, 5], unread: [] })).toMatchObject({ command: null });
    expect(proposeMove(item, 'IN_PROGRESS', [item], 'card-payments', { projects: [3], unread: [3] })).toMatchObject({ command: null });
  });
});
