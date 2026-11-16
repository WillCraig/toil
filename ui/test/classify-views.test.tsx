// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import type { ClassifyApi, LedgerView } from '../src/classify-api.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureClassify, sampleLedgerLines, sampleRevision, standingOf } from '../src/fixtures/classify.ts';
import { SAMPLE_SCHEME_STATS } from '../src/fixtures/classify-stats.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { defaultScheme } from '../../src/core/classify/builtin.ts';
import { SAMPLE_TEAM } from '../src/fixtures/sample-team.ts';
import { needsAPerson } from '../src/model/classify.ts';
import type { WorkItem } from '../src/toil.ts';
import { ChatScope } from '../src/components/ask.tsx';
import { memoryAnalyses } from '../src/analyses.ts';
import { ClassifyProvider } from '../src/classify-state.tsx';
import { DataContext, type Data } from '../src/data.ts';
import type { ToilProjectData } from '../src/load.ts';
import { SkinProvider, skinsFor } from '../src/skins.tsx';
import { Classify } from '../src/views/Classify.tsx';
import { loaded } from './harness.ts';

/**
 * Sorting work into categories on the sample team (#566): the Classify view and its keys, the agent's answers as
 * suggestions, Apply's approval card in each state (sample, writes off, written), "How it's doing" with its dashes, the
 * tune flow with a worse revision, the reclassify popover with its undo, and the Classification editor. The sample's
 * ledger is scripted and in memory, so none of it needs a tracker or a disk.
 */

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

const TEAM = '#/project/sample-team';

function open(hash: string, classify: ClassifyApi = fixtureClassify(), extra: Partial<Parameters<typeof App>[0]> = {}) {
  window.location.hash = hash;
  return render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} classify={classify} now={FIXTURE_NOW} preview {...extra} />);
}
const until = <T extends Element>(selector: string) =>
  waitFor(() => {
    const el = document.querySelector<T>(selector);
    if (!el) throw new Error(`no ${selector} yet`);
    return el;
  });
// How it's doing shows a "not read yet" panel until the record loads, then a new
// one in its place. A slow runner can catch the first, which never fills, so wait
// for the panel whose summary (or, with `whole`, whose text) says what a test expects.
const doingWith = (expected: RegExp, whole = false) =>
  waitFor(() => {
    const el = document.querySelector<HTMLDetailsElement>('[data-how-its-doing]');
    const text = (whole ? el?.textContent : el?.querySelector('summary')?.textContent) ?? '';
    if (!el || !expected.test(text)) throw new Error(`How it's doing reads "${text}" so far`);
    return el;
  });
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-row]')];
const choiceButtons = (row: Element) => [...row.querySelectorAll<HTMLElement>('[data-choice]')];
const choiceIn = (row: Element, id: string) => row.querySelector<HTMLElement>(`[data-choice="${id}"]`)!;
/** A suggestion's marked choice on an item nothing in the list sits under: an answer on an epic is its tasks' answer too, which would empty the list. */
const leafProposal = () => [...document.querySelectorAll<HTMLElement>('[data-proposal]')].find((p) => !/follow/.test(p.closest('[data-row]')!.querySelector('[data-tag]')?.textContent ?? ''))!;
/** The reason an item is in the list, from the row's (i): it is said there once and printed nowhere else. */
const whyOf = async (row: Element) => {
  await userEvent.click(row.querySelector<HTMLElement>('[data-why]')!);
  const dialog = await screen.findByRole('dialog');
  const text = dialog.textContent!;
  const reason = dialog.querySelector('[data-proposal-reason]')?.textContent ?? null;
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  return { text, reason };
};
const press = async (name: string | RegExp) => act(async () => void fireEvent.click(await screen.findByRole('button', { name })));

describe('the Classify view', () => {
  it('is the Board\'s third view, named in plain words with toil\'s own term on hover, listing what needs a person', async () => {
    open(`${TEAM}/board/classify`);
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Sort work into categories' });
    expect(h1.getAttribute('title')).toBe('In toil: Classify');
    const views = screen.getByRole('navigation', { name: 'Board views' });
    expect(within(views).getAllByRole('link').map((l) => l.textContent)).toEqual(['Board', 'Ready to start?', 'Sort work into categories']);
    expect(within(views).getByRole('link', { name: 'Sort work into categories' }).getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    const first = rows()[0]!;
    expect(first.dataset.kind).toBe('unsure');
    // One line a row: the choices are one segmented control, and the reason is behind the row's (i), not printed on every row.
    expect(choiceButtons(first).map((b) => b.textContent)).toEqual(['Keep the lights on K', 'Feature F', 'Unsure U']);
    expect(document.body.textContent).not.toMatch(/Nothing has settled this one/);
    expect(within(first).queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect((await whyOf(first)).text).toMatch(/Nothing has settled this one: no label, rule or parent says what it is\./);
    // The page names no code and no path.
    expect(document.body.textContent).not.toMatch(/signal:|~\/\.toil|classify correct|TOIL_/);
  });

  it('is also reached by its short address, and is not mistaken for a person on the board', async () => {
    open(`${TEAM}/classify`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sort work into categories' })).toBeTruthy();
    cleanup();
    open(`${TEAM}/board/classify`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sort work into categories' })).toBeTruthy();
    expect(document.querySelector('#board-filter')).toBeNull();
  });

  it('answers on a press of K, F or U, with no Confirm: the row leaves, focus goes to the next row, and the line under the tabs says what changed with an undo', async () => {
    const api = fixtureClassify();
    const correct = vi.spyOn(api, 'correct');
    open(`${TEAM}/board/classify`, api);
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    const before = rows().length;
    // The last row is a task under the epic above it, so answering it settles only itself; answering the epic settles its tasks too.
    const all = rows();
    const last = all[all.length - 1]!;
    const id = last.dataset.row!;
    const nextId = all[all.length - 2]!.dataset.row!;
    last.focus();
    await act(async () => void fireEvent.keyDown(last, { key: 'f' }));
    await waitFor(() => expect(rows().length).toBe(before - 1));
    expect(correct).toHaveBeenCalledTimes(1);
    expect(correct.mock.calls[0]![1]).toMatchObject({ item: expect.objectContaining({ id }), to: 'feature', reason: '' });
    expect(document.querySelector(`[data-row="${CSS.escape(id)}"]`)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector(`[data-row="${CSS.escape(nextId)}"]`)));
    const notice = await until<HTMLElement>('[data-classify-notice="changed"]');
    expect(notice.textContent).toMatch(/^SHOP-\d+ is Feature\. Undo Dismiss$/);

    await act(async () => void fireEvent.click(within(notice).getByRole('button', { name: 'Undo' })));
    const back = await until<HTMLElement>('[data-classify-notice="reverted"]');
    expect(back.textContent).toMatch(/Changed back/);
    await waitFor(() => expect(rows().length).toBe(before));
    expect(document.querySelector(`[data-row="${CSS.escape(id)}"]`)).toBeTruthy();
  });

  it('keeps an item whose first answer was undone in the list after a reload, but not one Unsure was pressed on', async () => {
    const api = fixtureClassify();
    open(`${TEAM}/board/classify`, api);
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    const before = rows().length;
    const all = rows();
    const id = all[all.length - 1]!.dataset.row!;
    await act(async () => void fireEvent.keyDown(all[all.length - 1]!, { key: 'f' }));
    await waitFor(() => expect(rows().length).toBe(before - 1));
    await act(async () => void fireEvent.click(within(await until<HTMLElement>('[data-classify-notice="changed"]')).getByRole('button', { name: 'Undo' })));
    await waitFor(() => expect(rows().length).toBe(before));
    // Remounted: the list is read from the ledger alone, with no memory of the undo.
    cleanup();
    open(`${TEAM}/board/classify`, api);
    await waitFor(() => expect(rows().length).toBe(before));
    expect(document.querySelector(`[data-row="${CSS.escape(id)}"]`)).toBeTruthy();
    // Pressing Unsure on purpose settles it, and stays settled after a remount.
    const row = document.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`)!;
    await act(async () => void fireEvent.keyDown(row, { key: 'u' }));
    await waitFor(() => expect(rows().length).toBe(before - 1));
    cleanup();
    open(`${TEAM}/board/classify`, api);
    await waitFor(() => expect(rows().length).toBe(before - 1));
    expect(document.querySelector(`[data-row="${CSS.escape(id)}"]`)).toBeNull();
  });

  it('answers on a mouse press of a choice, and U records Unsure as the taking-back it is', async () => {
    const api = fixtureClassify();
    const correct = vi.spyOn(api, 'correct');
    open(`${TEAM}/board/classify`, api);
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    const all = rows();
    const before = all.length;
    const row = all[all.length - 1]!;
    await userEvent.click(choiceIn(row, 'ktlo'));
    await waitFor(() => expect(rows().length).toBe(before - 1));
    expect(correct.mock.calls[0]![1]).toMatchObject({ to: 'ktlo' });
    const next = rows()[rows().length - 1]!;
    next.focus();
    await act(async () => void fireEvent.keyDown(next, { key: 'u' }));
    await waitFor(() => expect(rows().length).toBe(before - 2));
    expect(correct.mock.calls[1]![1]).toMatchObject({ to: null });
  });

  it('moves between rows with the arrow keys, leaves Enter on a link alone, and does nothing on Enter where no suggestion is marked', async () => {
    const api = fixtureClassify();
    const correct = vi.spyOn(api, 'correct');
    open(`${TEAM}/board/classify`, api);
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    const [first, second] = rows();
    first!.focus();
    fireEvent.keyDown(first!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
    const before = rows().length;
    expect(fireEvent.keyDown(first!.querySelector('a')!, { key: 'Enter' })).toBe(true);
    await act(async () => void fireEvent.keyDown(first!, { key: 'Enter' }));
    expect(rows().length).toBe(before);
    expect(correct).not.toHaveBeenCalled();
  });

  it('does not take a key typed in a text field', async () => {
    const api = fixtureClassify();
    const correct = vi.spyOn(api, 'correct');
    open(`${TEAM}/board/classify`, api);
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    const first = rows()[0]!;
    const box = document.createElement('input');
    first.appendChild(box);
    fireEvent.keyDown(box, { key: 'f' });
    expect(correct).not.toHaveBeenCalled();
  });

  it('keeps the page quiet: one short lede, a compact legend of the keys, and a row that is an item, one segmented control and one (i)', async () => {
    open(`${TEAM}/board/classify`);
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    expect(document.querySelector('.lede')!.textContent!.length).toBeLessThan(80);
    expect(document.querySelector('[data-legend]')!.textContent).toMatch(/^K\s*F\s*U\s*answer, Up and Down move$/);
    expect(document.body.textContent).not.toMatch(/Pick a category for each row, then Confirm/);
    const row = rows()[0]!;
    expect(row.querySelectorAll('[data-choice]').length).toBe(3);
    expect(row.querySelectorAll('[data-why]').length).toBe(1);
    expect(row.querySelectorAll('p').length).toBe(1);
  });

  it('shows a short tag only where it says something: how many rows follow an epic, and where a label and the rules disagree', async () => {
    open(`${TEAM}/board/classify`);
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    const tags = [...document.querySelectorAll<HTMLElement>('[data-tag]')].map((t) => t.textContent!);
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t).toMatch(/^(\d+ follow|(label|field) and rules disagree)( · \d+ follow)?$/);
    const epic = rows().find((r) => r.querySelector('[data-tag]'))!;
    expect((await whyOf(epic)).text).toMatch(/under it in this list follows? its answer\./);
  });

  it('shows an empty state that says everything is sorted, with the way on', async () => {
    const api = fixtureClassify();
    const all = await api.ledger('sample-team');
    const waiting = needsAPerson(SAMPLE_TEAM.owi.items as WorkItem[], defaultScheme(), all.standing).map((r) => r.item.id);
    const everyone: LedgerView = { ...all, standing: { ...all.standing, ...Object.fromEntries(waiting.map((id) => [id, { category: 'feature', reason: null }])) } };
    open(`${TEAM}/board/classify`, { ...api, ledger: async () => everyone });
    expect(await screen.findByText(/Everything is sorted|Every item has an answer/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Nothing needs an answer' })).toBeTruthy();
  });
});

describe('the Classify view on work nobody read (principle 12)', () => {
  const ABSENCES = /Everything is sorted|Nothing here needs you|nothing unsure left|Nothing needs an answer|How it's doing|people agreed with/;
  const shell = async (change: (d: ToilProjectData) => ToilProjectData, sync?: () => void) => {
    const { data } = await loaded('sample-team');
    const toilProject = change(data);
    const d: Data = { toilProject, byId: new Map(toilProject.items.map((i) => [i.id, i])), prById: new Map(), agent: scriptedAgent(), now: FIXTURE_NOW, analyses: memoryAnalyses(), ...(sync ? { sync } : {}) };
    return render(
      <SkinProvider value={skinsFor('plain')}>
        <DataContext value={d}>
          <ChatScope>
            <ClassifyProvider>
              <Classify />
            </ClassifyProvider>
          </ChatScope>
        </DataContext>
      </SkinProvider>,
    );
  };

  it('says not read yet, with the action that reads it, and none of the absence sentences, when no items were read', async () => {
    let synced = 0;
    await shell((d) => ({ ...d, items: [], readTargets: [{ area: 'jira', label: 'jira', work: false, pullRequests: true }] }), () => synced++);
    expect(await screen.findByRole('heading', { name: 'Not read yet' })).toBeTruthy();
    expect(screen.getByText("This Toil project's work hasn't been read, so there is nothing to sort yet.")).toBeTruthy();
    expect(screen.getByText('jira: work items not read')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(synced).toBe(1);
    expect(document.body.textContent).not.toMatch(ABSENCES);
    expect(screen.queryByRole('button', { name: 'Ask your AI agent' })).toBeNull();
    expect(document.querySelector('[data-how-its-doing]')).toBeNull();
  });

  it('is also not read yet when items are empty with no failure recorded, and when every tracker failed', async () => {
    await shell((d) => ({ ...d, items: [] }));
    expect(await screen.findByRole('heading', { name: 'Not read yet' })).toBeTruthy();
    cleanup();
    await shell((d) => ({ ...d, readTargets: [{ area: 'jira', label: 'jira', work: false, pullRequests: true }] }));
    expect(await screen.findByRole('heading', { name: 'Not read yet' })).toBeTruthy();
  });

  it('names what could not be read when only some trackers failed, and never says everything is sorted', async () => {
    await shell((d) => ({ ...d, readTargets: [{ area: 'jira', label: 'jira', work: true, pullRequests: true }, { area: 'ado', label: 'ado web', work: false, pullRequests: true }] }));
    expect(await screen.findByRole('heading', { name: 'Nothing in what was read needs an answer' })).toBeTruthy();
    expect(screen.getByText('ado web: work items not read')).toBeTruthy();
    expect(screen.getByText('Nothing in what was read needs an answer.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Not read yet' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Everything is sorted|Nothing here needs you|nothing unsure left/);
  });

  it('keeps "Everything is sorted" where the work was read and nothing needs an answer', async () => {
    const api = fixtureClassify();
    const all = await api.ledger('sample-team');
    const waiting = needsAPerson(SAMPLE_TEAM.owi.items as WorkItem[], defaultScheme(), all.standing).map((r) => r.item.id);
    const everyone: LedgerView = { ...all, standing: { ...all.standing, ...Object.fromEntries(waiting.map((id) => [id, { category: 'feature', reason: null }])) } };
    open(`${TEAM}/board/classify`, { ...api, ledger: async () => everyone });
    expect(await screen.findByText(/Everything is sorted|Every item has an answer/)).toBeTruthy();
    expect(screen.queryByText(/Nothing in what was read/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/work items not read/);
  });
});

describe('the AI agent on the Classify view', () => {
  it('marks its answers on the choices with an AI badge and keeps the reason one press in, accepts by pressing the mark or all at once, and applies nothing', async () => {
    const api = fixtureClassify();
    const apply = vi.spyOn(api, 'apply');
    const correct = vi.spyOn(api, 'correct');
    open(`${TEAM}/board/classify`, api);
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    await press('Ask your AI agent');
    await until('[data-asked]');
    const proposals = [...document.querySelectorAll<HTMLElement>('[data-proposal]')];
    expect(proposals.length).toBeGreaterThan(3);
    // The suggested category is marked in the segmented control with a small AI badge; its reason is not printed on the row.
    expect(proposals[0]!.textContent).toMatch(/^.+ [KF1-9]AI \(suggested by your AI agent\)$/);
    expect(proposals[0]!.closest('[data-row]')!.textContent).not.toMatch(/suggests/);
    expect(document.querySelector('[data-accept]')).toBeNull();
    expect(document.querySelector('[data-asked]')!.textContent).toMatch(/a scripted sample, not a model suggested a category/);
    const total = rows().length;
    // The sample's ten corrections are decided here and not yet written there, so some changes are already waiting.
    const waiting = () => Number(/(\d+) changes? waiting for the tracker/.exec(document.querySelector('[data-pending] h2')!.textContent!)![1]);
    const already = waiting();

    const one = leafProposal();
    const first = one.closest<HTMLElement>('[data-row]')!.dataset.row!;
    const reason = (await whyOf(one.closest('[data-row]')!)).reason!.replace(/^Your AI agent suggests .+?: /, '');
    await act(async () => void fireEvent.click(one));
    await waitFor(() => expect(rows().length).toBe(total - 1));
    expect(waiting()).toBe(already + 1);
    // Accepting is the person's word, recorded as a pick is: with the agent's reason in it, and the same line offering to take it back.
    expect(correct).toHaveBeenCalledTimes(1);
    expect(correct.mock.calls[0]![1]).toMatchObject({ item: expect.objectContaining({ id: first }), reason: `Accepted the AI agent's suggestion: ${reason}` });
    expect((await until<HTMLElement>('[data-classify-notice="changed"]')).textContent).toMatch(/^SHOP-\d+ is (Feature|Keep the lights on)\. Undo Dismiss$/);

    const all = await screen.findByRole('button', { name: /Accept all \d+/ });
    const n = Number(/(\d+)/.exec(all.textContent!)![1]);
    await act(async () => void fireEvent.click(all));
    await waitFor(() => expect(waiting()).toBe(already + 1 + n));
    // Accept all is one correction per suggestion, by the route a pick takes: no route of its own.
    expect(correct).toHaveBeenCalledTimes(1 + n);
    expect(apply).not.toHaveBeenCalled();
    // Accept all is one change: one line, one Undo that takes every one of them back.
    const notice = await until<HTMLElement>('[data-classify-notice="accepted"]');
    expect(notice.textContent).toBe(`Accepted ${n}. Undo Dismiss`);
    await act(async () => void fireEvent.click(within(notice).getByRole('button', { name: 'Undo' })));
    await until('[data-classify-notice="reverted"]');
    await waitFor(() => expect(waiting()).toBe(already + 1));
    expect(correct).toHaveBeenCalledTimes(1 + n + n);
  });

  it('lets a person overrule a suggestion by pressing another choice, and dismiss one with Not this in the (i)', async () => {
    const api = fixtureClassify();
    const correct = vi.spyOn(api, 'correct');
    open(`${TEAM}/board/classify`, api);
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    await press('Ask your AI agent');
    await until('[data-asked]');
    const total = rows().length;
    const marked = leafProposal();
    const row = marked.closest<HTMLElement>('[data-row]')!;
    const other = choiceButtons(row).find((b) => !b.hasAttribute('data-marked') && b.dataset.choice !== 'unsure')!;
    await userEvent.click(other);
    await waitFor(() => expect(rows().length).toBe(total - 1));
    // An overruled suggestion is the person's own word, recorded as a pick: no "Accepted the AI agent's suggestion" in it.
    expect(correct.mock.calls[0]![1]).toMatchObject({ to: other.dataset.choice, reason: '' });

    const second = [...document.querySelectorAll<HTMLElement>('[data-proposal]')].find((p) => p !== marked && !/follow/.test(p.closest('[data-row]')!.querySelector('[data-tag]')?.textContent ?? ''))!;
    const rowB = second.closest<HTMLElement>('[data-row]')!;
    await userEvent.click(rowB.querySelector<HTMLElement>('[data-why]')!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Not this' }));
    await waitFor(() => expect(rowB.querySelector('[data-proposal]')).toBeNull());
    expect(document.body.contains(rowB)).toBe(true);
    expect(correct).toHaveBeenCalledTimes(1);
  });

  it('accepts the marked suggestion with Enter on its row', async () => {
    const api = fixtureClassify();
    const correct = vi.spyOn(api, 'correct');
    open(`${TEAM}/board/classify`, api);
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    await press('Ask your AI agent');
    await until('[data-asked]');
    const total = rows().length;
    const row = leafProposal().closest<HTMLElement>('[data-row]')!;
    row.focus();
    await act(async () => void fireEvent.keyDown(row, { key: 'Enter' }));
    await waitFor(() => expect(rows().length).toBe(total - 1));
    expect(correct.mock.calls[0]![1].reason).toMatch(/^Accepted the AI agent's suggestion: /);
  });

  it('keeps an accepted suggestion settled after Apply: the item is not asked about again and the count does not go back up', async () => {
    const api = fixtureClassify();
    let planned: WorkItem[] = [];
    const apply = vi.fn(async () => ({ outcomes: [{ connection: 'sample-jira', changed: planned.map((i) => ({ key: i.source.key, text: 'added label' })), unchanged: [], failed: [], refused: null }], recorded: { ok: true as const } }));
    open(`${TEAM}/board/classify`, {
      ...api,
      disabled: null,
      apply: apply as unknown as ClassifyApi['apply'],
      plan: async (p, w) => {
        planned = w.items;
        return { id: 'plan-1', groups: (await api.plan(p, w)).groups.map((g) => ({ ...g, writes: true })), notes: [] };
      },
    });
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    const total = rows().length;
    await press('Ask your AI agent');
    await until('[data-asked]');
    const proposal = leafProposal();
    const id = proposal.closest<HTMLElement>('[data-row]')!.dataset.row!;
    await act(async () => void fireEvent.click(proposal));
    await waitFor(() => expect(rows().length).toBe(total - 1));
    await press('Review and apply');
    const card = await until<HTMLElement>('[data-apply]');
    await waitFor(() => expect(card.querySelectorAll('[data-change]').length).toBeGreaterThan(0));
    await act(async () => void fireEvent.click(within(card).getByRole('button', { name: /^Apply \d+ changes?$/ })));
    await until('[data-outcome="done"]');
    await waitFor(() => expect(document.querySelector('[data-pending] h2')!.textContent).toBe('Nothing is waiting for the tracker'));
    // The tracker's label is not read back until the next sync, but the ledger holds the person's say, so the item stays answered.
    expect(rows().length).toBe(total - 1);
    expect(document.querySelector(`[data-row="${CSS.escape(id)}"]`)).toBeNull();
    expect(document.querySelector('#needs-head')!.textContent).toBe(`${total - 1} items need an answer`);
  });

  it('says when no AI agent is set up, and leaves the rows to be sorted by hand', async () => {
    const api = fixtureClassify();
    open(`${TEAM}/board/classify`, { ...api, agents: async () => [] });
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    expect((await screen.findAllByText(/No AI agent is set up yet/)).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Ask your AI agent' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the reason an answer was refused, and proposes nothing', async () => {
    const api = fixtureClassify();
    open(`${TEAM}/board/classify`, { ...api, ask: async () => { throw new Error("The AI agent's answer can't be used, so nothing was proposed."); } });
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    await press('Ask your AI agent');
    expect((await screen.findByRole('alert')).textContent).toMatch(/nothing was proposed/);
    expect(document.querySelector('[data-proposal]')).toBeNull();
  });
});

describe('Apply', () => {
  const accepted = async (api: ClassifyApi) => {
    open(`${TEAM}/board/classify`, api);
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    await press('Ask your AI agent');
    await until('[data-asked]');
    // Each suggestion is recorded one at a time, and one on an epic takes its tasks' rows away before theirs are recorded: wait for every one.
    const correct = vi.spyOn(api, 'correct');
    const all = await screen.findByRole('button', { name: /Accept all \d+/ });
    const n = Number(/(\d+)/.exec(all.textContent!)![1]);
    await act(async () => void fireEvent.click(all));
    await waitFor(() => expect(correct).toHaveBeenCalledTimes(n));
    await waitFor(() => expect(document.querySelector('[data-proposal]')).toBeNull());
    // Accepting everything empties the list, whose empty state offers the same press as the pending section does; both wait until the last is recorded.
    await waitFor(() => expect((screen.getAllByRole('button', { name: 'Review and apply' })[0] as HTMLButtonElement).disabled).toBe(false));
    await act(async () => void fireEvent.click(screen.getAllByRole('button', { name: 'Review and apply' })[0]!));
  };

  it("shows every change before anything is written: the item, the label from and to, and the command, and says a sample can't write", async () => {
    await accepted(fixtureClassify());
    const card = await until<HTMLElement>('[data-apply]');
    await waitFor(() => expect(card.querySelectorAll('[data-change]').length).toBeGreaterThan(3));
    // A compact table, one line an item: item, title, category, change. The sentence is said once, and every change is in the text.
    const first = card.querySelector<HTMLElement>('[data-change]')!;
    expect(within(card).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Item', 'Title', 'Category', 'Change']);
    const cells = [...first.children].map((c) => c.textContent!);
    expect(cells[0]).toMatch(/^SHOP-\d+$/);
    expect(cells[2]).toMatch(/^(Feature|Keep the lights on)$/);
    expect(cells[3]).toMatch(/^(\+ (feature|ktlo)|\w+ \u2192 (feature|ktlo))/);
    expect(card.textContent!.match(/Nothing is written until you press Apply\./g)).toHaveLength(1);
    expect(document.querySelector("[data-pending]")!.textContent!.match(/Nothing is written until you press Apply./g)).toHaveLength(1);
    expect(card.querySelector('.apply__command code')!.textContent).toMatch(/^toil jira issue categorize .*--allow-write$/);
    expect(card.querySelector('[data-sample-cannot-write]')!.textContent).toMatch(/This is sample data, so nothing here can be written/);
    expect((within(card).getByRole('button', { name: /^Apply \d+ changes$/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('folds a long list after ten changes with Show all, and shows every change once opened', async () => {
    await accepted(fixtureClassify());
    const card = await until<HTMLElement>('[data-apply]');
    const n = Number(/(\d+) changes? waiting/.exec(document.querySelector('[data-pending] h2')!.textContent!)![1]);
    expect(n).toBeGreaterThan(10);
    await waitFor(() => expect(card.querySelectorAll('[data-change]').length).toBe(10));
    await act(async () => void fireEvent.click(within(card).getByRole('button', { name: `Show all ${n}` })));
    expect(card.querySelectorAll('[data-change]').length).toBe(n);
    for (const row of card.querySelectorAll('[data-change]')) expect(row.children[3]!.textContent!.length).toBeGreaterThan(0);
  });

  it('says in plain words that changes are switched off for the connection, and where to switch them on', async () => {
    const api = fixtureClassify();
    const base = await api.plan('sample-team', { items: [] });
    await accepted({ ...api, disabled: null, plan: async (p, w) => ({ ...base, groups: (await api.plan(p, w)).groups.map((g) => ({ ...g, writes: false })) }) });
    const off = await until<HTMLElement>('[data-writes-off]');
    expect(off.textContent).toMatch(/Changes to sample-jira are switched off, so nothing can be written there yet\. Turn them on for sample-jira under Settings, Connections/);
    expect((screen.getByRole('button', { name: /^Apply \d+ changes$/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("applies on one press, reports each item's result, and a second press changes nothing more", async () => {
    const api = fixtureClassify();
    let planned: Array<{ source: { key: string } }> = [];
    const apply = vi.fn(async (_p: string, planId: string) => {
      expect(planId).toBe('plan-1');
      return {
        outcomes: [{ connection: 'sample-jira', changed: planned.slice(0, 1).map((i) => ({ key: i.source.key, text: 'added feature' })), unchanged: planned.slice(1).map((i) => i.source.key), failed: [{ key: 'SHOP-999', reason: 'Jira said no.' }], refused: null }],
        recorded: { ok: true as const },
      };
    });
    await accepted({
      ...api,
      disabled: null,
      apply: apply as unknown as ClassifyApi['apply'],
      plan: async (p, w) => {
        planned = w.items;
        return { id: 'plan-1', groups: (await api.plan(p, w)).groups.map((g) => ({ ...g, writes: true })), notes: [] };
      },
    });
    const card = await until<HTMLElement>('[data-apply]');
    await waitFor(() => expect(card.querySelectorAll('[data-change]').length).toBeGreaterThan(3));
    const button = within(card).getByRole('button', { name: /^Apply \d+ changes$/ });
    await act(async () => void fireEvent.click(button));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    const done = await until<HTMLElement>('[data-outcome="done"]');
    expect(done.textContent).toMatch(/1 changed, \d+ already as wanted, 1 failed\./);
    expect(done.textContent).toMatch(/SHOP-999 failed: Jira said no\./);
    // Decided and written: nothing waits for the tracker any more.
    await waitFor(() => expect(document.querySelector('[data-pending] h2')!.textContent).toBe('Nothing is waiting for the tracker'));
    // Nothing says "nothing is written" beside a result that says something was.
    expect(card.textContent).not.toMatch(/Nothing is written/);
    expect(document.querySelector('[data-pending]')!.textContent).not.toMatch(/Decided here, not yet written|Nothing is written/);
    // Failures stay pending, so the page does not claim everything was written.
    expect(screen.queryByRole('button', { name: 'Apply again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
  });

  it('says everything decided was written when nothing is waiting, and Check again makes a fresh plan instead of spending the old id', async () => {
    const api = fixtureClassify();
    let planned: WorkItem[] = [];
    let plans = 0;
    const apply = vi.fn(async (_p: string, planId: string) => {
      expect(planId).toBe('plan-1');
      return { outcomes: [{ connection: 'sample-jira', changed: planned.map((i) => ({ key: i.source.key, text: 'added feature' })), unchanged: [], failed: [], refused: null }], recorded: { ok: true as const } };
    });
    await accepted({
      ...api,
      disabled: null,
      apply: apply as unknown as ClassifyApi['apply'],
      plan: async (p, w) => {
        planned = w.items;
        plans += 1;
        return { id: `plan-${plans}`, groups: (await api.plan(p, w)).groups.map((g) => ({ ...g, writes: true })), notes: [] };
      },
    });
    const card = await until<HTMLElement>('[data-apply]');
    await waitFor(() => expect(card.querySelectorAll('[data-change]').length).toBeGreaterThan(3));
    await act(async () => void fireEvent.click(within(card).getByRole('button', { name: /^Apply \d+ changes$/ })));
    await until('[data-outcome="done"]');
    await waitFor(() => expect(document.querySelector('[data-pending] h2')!.textContent).toBe('Nothing is waiting for the tracker'));
    const section = document.querySelector('[data-pending]')!;
    expect(section.textContent).toMatch(/Everything decided here has been written to the tracker\./);
    expect(section.textContent).not.toMatch(/Decided here, not yet written|Nothing is written/);
    await press('Check again');
    await waitFor(() => expect(plans).toBe(2));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-outcome]')).toBeNull();
  });
});

describe("How it's doing", () => {
  it('opens on the figures, in plain words, and offers to improve the categories once there are ten corrections', async () => {
    open(`${TEAM}/board/classify`);
    const doing = await doingWith(/^How it's doing: people agreed with 55% of 22 checked$/);
    expect(doing.querySelector('[data-share="agreement"]')!.textContent).toBe('55%');
    expect(doing.querySelector('[data-overruled]')!.textContent).toBe('The bug or incident type was overruled 4 of 4 times, all to Feature.');
    expect(doing.textContent).not.toMatch(/signal:/);
    expect(doing.querySelector('[data-since-tune]')!.textContent).toBe('10 corrections since the categories were last improved.');
    expect(await within(doing).findByRole('button', { name: 'Improve with your AI agent' })).toBeTruthy();
  });

  it('shows every share nobody has read as a dash and says it is not read yet, never 0%', async () => {
    const api = fixtureClassify();
    const base = await api.ledger('sample-team');
    const empty: LedgerView = { ...base, stats: { ...SAMPLE_SCHEME_STATS, agreement: { ...SAMPLE_SCHEME_STATS.agreement, overall: null, checked: 0 }, sources: [{ source: 'parent', checked: 0, confirmed: 0, overruled: 0, overruledTo: {}, agreement: null }], sinceLastTune: 2 } };
    open(`${TEAM}/board/classify`, { ...api, ledger: async () => empty });
    const doing = await doingWith(/^How it's doing: nothing has been checked yet$/);
    expect(doing.querySelector('[data-share="agreement"]')!.textContent).toBe('—');
    expect(doing.querySelector('[data-share="source"]')!.textContent).toBe('—');
    expect(doing.textContent).toMatch(/Nobody has checked an answer yet, so there is no figure/);
    expect(doing.textContent).not.toMatch(/0%/);
    expect(within(doing).queryByRole('button', { name: 'Improve with your AI agent' })).toBeNull();
  });

  it('is a dash when the record could not be read at all', async () => {
    const api = fixtureClassify();
    const base = await api.ledger('sample-team');
    open(`${TEAM}/board/classify`, { ...api, ledger: async () => ({ ...base, stats: null, notes: ["The ledger couldn't be read, so how it's doing is not read yet: nope."] }) });
    // Before the record loads the panel already reads as a failed read, so wait for the
    // ledger's own note, which only the loaded view shows.
    const doing = await doingWith(/how it's doing is not read yet: nope\./, true);
    expect(doing.textContent).toMatch(/The record could not be read, so this is not read yet/);
    expect(doing.querySelector('[data-share="agreement"]')!.textContent).toBe('—');
    expect(doing.querySelector('summary')!.textContent).toBe("How it's doing: not read yet");
    expect(doing.querySelector('[data-since-tune]')!.textContent).toMatch(/not read yet/);
  });

  it("shows the agent's proposed changes beside the scores, and Use this version is a press that the sample refuses in words", async () => {
    open(`${TEAM}/board/classify`);
    const doing = await doingWith(/people agreed with/);
    await act(async () => void fireEvent.click(await within(doing).findByRole('button', { name: 'Improve with your AI agent' })));
    const tune = await until<HTMLElement>('[data-tune]');
    expect(tune.textContent).toMatch(/Adds the rule "new-exports": when its title contains export, the category is Feature\./);
    expect(tune.textContent).toMatch(/Adds the guidance: A bug fix that adds a new capability/);
    expect(tune.querySelector('[data-backtest]')!.textContent).toMatch(/Tried on 4 corrections it had not seen: today's categories agree with people on 1 \(25%\); this version on 3 \(75%\)\./);
    expect(tune.querySelector('[data-backtest="better"]')).toBeTruthy();
    expect(tune.querySelector('[data-sample-cannot-write]')!.textContent).toMatch(/sample data/);
    expect((within(tune).getByRole('button', { name: 'Use this version' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a revision that scores worse as worse, and applying one is the person-command path that saves a revision', async () => {
    const api = fixtureClassify();
    const scheme = defaultScheme();
    const applyRevision = vi.fn(async () => ({ revision: 2, kept: 'yours' as const, warnings: [] }));
    open(`${TEAM}/board/classify`, {
      ...api,
      disabled: null,
      tune: async () => ({ id: 'rev-1', by: 'a scripted sample', before: scheme, after: sampleRevision(scheme), changes: ['Adds the guidance: Be careful.'], backtest: { heldBack: 5, before: { agreed: 4, agreement: 0.8 }, after: { agreed: 2, agreement: 0.4 }, worse: true }, warnings: [] }),
      applyRevision,
    });
    const doing = await doingWith(/people agreed with/);
    await act(async () => void fireEvent.click(await within(doing).findByRole('button', { name: 'Improve with your AI agent' })));
    const tune = await until<HTMLElement>('[data-tune]');
    const score = tune.querySelector<HTMLElement>('[data-backtest="worse"]')!;
    expect(score.className).toContain('failure');
    expect(score.textContent).toMatch(/this version on 2 \(40%\)\. This version scores worse than today's, so it is not an improvement\./);
    expect(tune.textContent).toMatch(/These categories are built in, so using this version saves it as your own copy/);
    await act(async () => void fireEvent.click(within(tune).getByRole('button', { name: 'Use this version' })));
    await waitFor(() => expect(applyRevision).toHaveBeenCalledWith('rev-1'));
    expect((await until('[data-saved-revision]')).textContent).toBe('Saved as revision 2, kept as your own copy.');
  });
});

describe('changing a category from where it is shown', () => {
  const sampleItem = () => rows()[0]!.dataset.row!;

  it("opens a small form from the item page's chip with the plain names and Unsure, records the choice, and undoes it", async () => {
    const api = fixtureClassify();
    open(`${TEAM}/board/classify`, api);
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    const id = sampleItem();
    cleanup();
    open(`${TEAM}/item/${encodeURIComponent(id)}`, api);
    const chip = await until<HTMLButtonElement>('button.cat-chip--button');
    expect(chip.textContent).toBe('Unsure');
    await userEvent.click(chip);
    const form = await until<HTMLElement>('[data-reclassify-form]');
    expect(within(form).getAllByRole('radio').map((r) => r.closest('label')!.textContent)).toEqual(['Keep the lights on', 'Feature', 'Unsure']);
    expect((within(form).getByRole('radio', { name: 'Unsure' }) as HTMLInputElement).checked).toBe(true);
    expect(within(form).getByText(/saved in your own record on this computer\. The tracker changes only when you apply it/)).toBeTruthy();
    expect(within(form).getByRole('button', { name: 'Confirm' })).toBeTruthy();
    await userEvent.click(within(form).getByRole('radio', { name: 'Feature' }));
    await userEvent.type(within(form).getByRole('textbox', { name: /Why/ }), 'It adds a screen.');
    const change = within(form).getByRole('button', { name: 'Change' });
    await userEvent.click(change);
    await waitFor(() => expect(document.querySelector('[data-reclassify-form]')).toBeNull());
    await waitFor(() => expect(document.querySelector('button.cat-chip--button')!.textContent).toBe('Feature · person'));
    const notice = await until<HTMLElement>('[data-classify-notice="changed"]');
    await userEvent.click(within(notice).getByRole('button', { name: 'Undo' }));
    await until('[data-classify-notice="reverted"]');
    await waitFor(() => expect(document.querySelector('button.cat-chip--button')!.textContent).toMatch(/^(Unsure|Feature)/));
  });

  it('records the category an item already has as a confirmation', async () => {
    const api = fixtureClassify();
    const correct = vi.spyOn(api, 'correct');
    open(`${TEAM}/board/classify`, api);
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    cleanup();
    const settled = sampleLedgerLines().find((l) => l.kind === 'verdict' && l.category === 'feature' && l.source === 'parent' && !Object.hasOwn(standingOf(sampleLedgerLines()), l.item))!;
    open(`${TEAM}/item/${encodeURIComponent(settled.item)}`, api);
    const chip = await until<HTMLButtonElement>('button.cat-chip--button');
    expect(chip.textContent).toBe('Feature · rules');
    await userEvent.click(chip);
    const form = await until<HTMLElement>('[data-reclassify-form]');
    expect((within(form).getByRole('radio', { name: 'Feature' }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(within(form).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(correct).toHaveBeenCalledTimes(1));
    expect(correct.mock.calls[0]![1]).toMatchObject({ to: 'feature', reason: '', item: { id: settled.item } });
  });

  it('shows a refusal in the form and keeps it open, so nothing looks saved that was not', async () => {
    const api = fixtureClassify();
    open(`${TEAM}/board/classify`, api);
    await waitFor(() => expect(rows().length).toBeGreaterThan(5));
    const id = sampleItem();
    cleanup();
    open(`${TEAM}/item/${encodeURIComponent(id)}`, { ...api, correct: async () => { throw new Error('toil could not record the correction: the ledger is full.'); } });
    await userEvent.click(await until<HTMLButtonElement>('button.cat-chip--button'));
    const form = await until<HTMLElement>('[data-reclassify-form]');
    await userEvent.click(within(form).getByRole('radio', { name: 'Feature' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Change' }));
    expect((await within(form).findByRole('alert')).textContent).toMatch(/the ledger is full/);
    expect(document.querySelector('[data-reclassify-form]')).toBeTruthy();
  });

  it("offers Change its category… in a board card's menu, and keeps the card's own chip display-only", async () => {
    open(`${TEAM}/board`);
    const card = await until<HTMLElement>('.card-grip');
    expect(document.querySelector('.card button.cat-chip--button')).toBeNull();
    fireEvent.keyDown(card, { key: 'm' });
    const menu = await screen.findByRole('menu');
    await act(async () => void fireEvent.click(within(menu).getByRole('menuitem', { name: 'Change its category…' })));
    expect(await screen.findByRole('dialog', { name: /Change the category of/ })).toBeTruthy();
  });

  it('leaves the chip as it was, display-only, where there is no ledger to record in', async () => {
    window.location.hash = `${TEAM}/board/classify`;
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1, name: 'Sort work into categories' });
    expect(document.querySelector('button.cat-chip--button')).toBeNull();
  });
});

describe('the Classification editor', () => {
  const editor = '#/settings/projects/sample-team/classification';

  it('opens on one line that says what the Toil project sorts by, with each part a step in', async () => {
    open(editor);
    const section = await until<HTMLElement>('[data-classification-editor]');
    expect(section.querySelector('[data-classification-summary]')!.textContent).toMatch(/^Keep the lights on \/ Feature, no rules, signals on, revision 1\. Built in to toil\./);
    const parts = [...section.querySelectorAll('details > summary')].map((s) => s.textContent);
    expect(parts).toEqual(['Which categories this Toil project uses', 'Where each tool keeps the category', 'The categories (2)', 'Rules (0)', 'Guidance for the AI agent, and the built-in signals']);
    expect(section.textContent).not.toMatch(/~\/\.toil|\.json|toil classify/);
    expect(within(section).queryByRole('button', { name: /Save as revision 2/ })).toBeNull();
  });

  it('names each problem where it is and keeps Save off until toil would accept the draft, counting what a rule would catch', async () => {
    const api = fixtureClassify();
    const saveScheme = vi.fn(async () => ({ revision: 2, kept: 'yours' as const, warnings: [] }));
    open(editor, { ...api, disabled: null, saveScheme }, { config: { ...fixtureConfig(), disabled: null } as never });
    const section = await until<HTMLElement>('[data-classification-editor]');
    await act(async () => void fireEvent.click(within(section).getByRole('button', { name: 'Add a rule' })));
    const save = within(section).getByRole('button', { name: /Save as revision 2/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const problems = await until<HTMLElement>('[data-problems]');
    expect(problems.textContent).toMatch(/Rule 1/);

    const card = section.querySelector<HTMLElement>('[data-rule-card="0"]')!;
    const [name, , , , title] = [...card.querySelectorAll('input')] as HTMLInputElement[];
    await userEvent.type(name!, 'orders');
    await userEvent.type(title!, 'order');
    await waitFor(() => expect(document.querySelector('[data-problems]')).toBeNull());
    await waitFor(() => expect(card.querySelector('[data-rule-count]')!.textContent).toMatch(/Matches \d+ items? read from this Toil project\./));
    expect(Number(/Matches (\d+)/.exec(card.querySelector('[data-rule-count]')!.textContent!)![1])).toBeGreaterThan(0);
    expect(section.textContent).toMatch(/These categories are built in, so saving makes your own copy/);

    await waitFor(() => expect(save.disabled).toBe(false));
    await act(async () => void fireEvent.click(save));
    await waitFor(() => expect(saveScheme).toHaveBeenCalledTimes(1));
    const [project, scheme] = saveScheme.mock.calls[0] as unknown as [string, { rules: Array<{ id: string; when: { title: string[] }; then: string }> }];
    expect(project).toBe('sample-team');
    expect(scheme.rules).toEqual([{ id: 'orders', when: { title: ['order'] }, then: 'ktlo' }]);
    expect((await screen.findByText('Saved as revision 2, kept as your own copy.')).closest('[role="status"]')).toBeTruthy();
  });

  it("says in the sample that nothing can be saved, with Save off even for a valid change", async () => {
    open(editor);
    const section = await until<HTMLElement>('[data-classification-editor]');
    await act(async () => void fireEvent.click(within(section).getByRole('checkbox', { name: /built-in signals/ })));
    expect(section.querySelector('[data-sample-cannot-write]')!.textContent).toMatch(/sample data/);
    expect((within(section).getByRole('button', { name: /Save as revision 2/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the Classification editor, quieted', () => {
  const editor = '#/settings/projects/sample-team/classification';

  it('says where the category is kept in one line, with the rest in an (i), and uses the app\'s own field for each tracker', async () => {
    open(editor);
    const section = await until<HTMLElement>('[data-classification-editor]');
    const part = [...section.querySelectorAll('details')].find((d) => d.querySelector('summary')!.textContent === 'Where each tool keeps the category')!;
    const line = part.querySelector('.cedit__part > p')!;
    expect(line.textContent).toBe('The label is the record; a field, if you name one, mirrors it. ');
    expect(part.textContent).not.toMatch(/Toil never creates a field/);
    await userEvent.click(within(part as HTMLElement).getByRole('button', { name: /About where each tool keeps the category/ }));
    expect((await screen.findByRole('dialog')).textContent).toMatch(/Toil never creates a field, so an admin makes it first\./);
    await userEvent.keyboard('{Escape}');
    const inputs = [...part.querySelectorAll<HTMLInputElement>('.cedit__fields input')];
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input.closest('.field-text')).toBeTruthy();
      expect(input.labels![0]!.textContent).toMatch(/: field$/);
    }
  });

  it("lays Name, Short form and Label in the tracker in one row with What it means under them, and keeps the hints short", async () => {
    open(editor);
    const section = await until<HTMLElement>('[data-classification-editor]');
    const card = section.querySelector<HTMLElement>('[data-category-card="0"]')!;
    const row = card.querySelector<HTMLElement>('.cedit__row')!;
    expect([...row.querySelectorAll('label')].map((l) => l.textContent!.replace(/\..*$/, ''))).toEqual(['Name', 'Short form', 'Label in the tracker']);
    expect(row.querySelector('.field-text--area')).toBeNull();
    expect(card.querySelector('.field-text--area label')!.textContent).toBe('What it means');
    expect(card.querySelector('.field-text--area')!.parentElement).toBe(card);
    expect(card.textContent).toMatch(/The term of art, shown on hover\./);
    expect(card.textContent).toMatch(/One word, no spaces\./);
  });

  it("uses the app's checkbox for the built-in signals, not a bare native one", async () => {
    open(editor);
    const section = await until<HTMLElement>('[data-classification-editor]');
    const box = section.querySelector<HTMLElement>('[data-signals]')!;
    expect(box.classList.contains('check')).toBe(true);
    expect(box.querySelector('.box')).toBeTruthy();
    expect(box.querySelector('.box svg')).toBeTruthy();
    await userEvent.click(within(section).getByRole('checkbox', { name: /built-in signals/ }));
    expect(box.querySelector('.box svg')).toBeNull();
  });

  it('says the first rule that fits wins in one line, with the rest in an (i)', async () => {
    open(editor);
    const section = await until<HTMLElement>('[data-classification-editor]');
    const rules = [...section.querySelectorAll('details')].find((d) => d.querySelector('summary')!.textContent!.startsWith('Rules'))!;
    expect(rules.querySelector('.cedit__part > p')!.textContent).toBe('The first rule that fits wins. ');
  });
});

describe('Settings, General, Board', () => {
  it('keeps "Saved in this browser only." as the note and leaves the explanation to the (i)', async () => {
    window.location.hash = '#/settings/general';
    render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    const box = await screen.findByRole('checkbox', { name: 'Apply board moves when I drop a card' });
    const note = document.querySelector('.board-moves-setting .note')!;
    expect(note.textContent).toBe('Saved in this browser only. ');
    await userEvent.click(box);
    expect(note.textContent).toBe('Saved in this browser only. ');
    expect(document.querySelector('.board-moves-setting')!.textContent).not.toMatch(/stays a proposal|command to run yourself/);
    expect(document.querySelector('[data-help="board-moves"]')).toBeTruthy();
  });
});
