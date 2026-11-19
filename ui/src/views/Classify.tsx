/**
 * Sort work into categories (#566): the Board's third view, beside the Board
 * and "Ready to start?". It lists what needs a person, the unsure items and the
 * ones where a rule or signal and a label already on the item disagree, each
 * with the category toil would suggest and why, and a row of choices: the
 * scheme's categories by their plain names, then Unsure, as one segmented
 * control on a one-line row. Pressing a choice is the answer (K, F and U, or 1
 * to 9 for any other scheme, on a row): it is saved in the person's own record
 * at once, the row leaves the list and the line under the tabs offers Undo. The
 * tracker changes only when they apply it, on an approval card that shows every
 * change first. A suggestion is marked on its category and pressing it accepts it.
 *
 * "Ask your AI agent" gives the agent toil's own question for the unsure items
 * and shows what comes back as suggestions with the agent's reason and badge,
 * which a person accepts one by one or all together. The agent has no way to
 * apply anything. "How it's doing" is folded at the top. Nothing here is a
 * score of a person: the figures are about the categories. Fourteen decisions
 * that each took a meeting, in a column that takes a keystroke.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Select, SelectValue, Popover, ListBox, ListBoxItem } from 'react-aria-components';
import type { AgentChoice, ApplyWork } from '../classify-api.ts';
import { ApplyCard, byConnection } from '../components/classify-apply.tsx';
import { HowItsDoing } from '../components/classify-doing.tsx';
import { Empty, EmptyButton, EmptyLink, TrackerAction } from '../components/empty.tsx';
import { FilterBar } from '../components/filter-bar.tsx';
import { Help, InfoTip } from '../components/help.tsx';
import { ItemLink } from '../components/items.tsx';
import { useClassify } from '../classify-state.tsx';
import { useData } from '../data.ts';
import { toWhere } from '../filters.ts';
import { chartsHref, toilProjectHref } from '../format.ts';
import { useAddress, useWorkInsights } from '../insights-data.ts';
import { choiceForKey, choicesOf, sourcePhrase, workRead, type NeedsRow } from '../model/classify.ts';
import { usePlain } from '../plain-words.ts';
import { matches, matchesAny, typingIn } from '../shortcuts.ts';
import { useWords } from '../skins.tsx';
import { plainDates } from './charts/format.ts';
import '../components/classify.css';
import { AgentMark } from '../components/agent-mark.tsx';
import { NavButton } from '../components/nav-button.tsx';

/** The most items one question to the agent holds from this view: more than a person would sort in a sitting. */
export const ASK_AT_MOST = 100;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The key a press of this event means for a row's choices, or null: letters from the shortcut table, digits for the numbered schemes. */
export function pickKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | null {
  if (matches('classifyK', e)) return 'K';
  if (matches('classifyF', e)) return 'F';
  if (matches('classifyU', e)) return 'U';
  if (matchesAny('classifyDigit', e)) return e.key;
  return null;
}

/** Why an item is in the list, in sentences: said once, behind the row's (i), never printed on every row. */
function whyOf(row: NeedsRow, follow: number, name: (id: string | null) => string): string[] {
  const children = follow > 0 ? [`${plural(follow, 'item')} under it in this list ${follow === 1 ? 'follows' : 'follow'} its answer.`] : [];
  if (row.kind === 'unsure') return ['Nothing has settled this one: no label, rule or parent says what it is.', ...children];
  const now = row.carried!;
  const fresh = row.suggested!;
  return [`It says ${name(now.category)} (${sourcePhrase(now.source)}), but ${sourcePhrase(fresh.source)} says ${name(fresh.category)}: ${fresh.reason}`, ...children];
}

/** Why a row is on the list, said once in the header's (i) rather than on every row. */
const NEEDS_WHY = 'Each item here has no category yet: no label, rule or parent settles it, or a label and your rules disagree. Pick one, or press a marked suggestion to accept it. A follow count says how many other items take the same answer.';

/** The short tag beside a title, only where it says something: a disagreement, or how many rows follow this one's answer. */
function tagOf(row: NeedsRow, follow: number): string {
  return [row.kind === 'disagree' ? `${row.carried!.source === 'field' ? 'field' : 'label'} and rules disagree` : null, follow > 0 ? `${follow} follow` : null].filter(Boolean).join(' · ');
}

/** The row's one quiet (i): the reason it is here, the AI agent's reason when it suggested something, and "Not this" to dismiss that. */
function WhyTip({ row, follow, onDismiss }: { row: NeedsRow; follow: number; onDismiss: () => void }) {
  const ins = useWorkInsights();
  const { proposals } = useClassify();
  const proposal = proposals.get(row.item.id);
  const name = (id: string | null) => (id ? (ins.definitions[id]?.name ?? id) : 'Unsure');
  const sentences = whyOf(row, follow, name);
  const ai = proposal ? `Your AI agent suggests ${name(proposal.category)}: ${proposal.reason}` : null;
  return (
    <InfoTip label={`why ${row.item.source.key} needs an answer` } tip={[ai, ...sentences].filter(Boolean).join(' ')} placement="bottom end" triggerProps={{ 'data-why': row.item.id }}>
      {ai && <p data-proposal-reason="">{ai}</p>}
      {sentences.map((t) => (
        <p key={t}>{t}</p>
      ))}
      {proposal && (
        <p>
          <Button className="btn btn--small btn--quiet" onPress={onDismiss} data-dismiss-suggestion="">
            Not this
          </Button>
        </p>
      )}
    </InfoTip>
  );
}

/**
 * One item, one line: where it is and what it is called, the choices as one segmented control, and the (i). Pressing a
 * choice is the answer. A suggestion, the AI agent's or the rules' where they disagree with a label, is marked on its
 * category, and pressing the marked one accepts it. The choices are out of the tab order on purpose: the row is the
 * stop, K, F and U answer on it, Enter presses the marked one and the arrows move to the next row.
 */
function Row({ row, onAnswer, onAccept, follow }: { row: NeedsRow; onAnswer: (value: string) => void; onAccept: () => void; follow: number }) {
  const ins = useWorkInsights();
  const { proposals, dismiss } = useClassify();
  const choices = choicesOf(ins.scheme);
  const proposal = proposals.get(row.item.id);
  const marked = proposal ? { id: proposal.category, by: 'ai' as const } : row.kind === 'disagree' ? { id: row.suggested!.category ?? 'unsure', by: 'rules' as const } : null;
  const answer = (value: string) => (marked?.by === 'ai' && marked.id === value ? onAccept() : onAnswer(value));
  const tag = tagOf(row, follow);
  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (typingIn(e.target)) return;
    const down = matches('classifyNext', e);
    if (down || matches('classifyPrev', e)) {
      e.preventDefault();
      const to = down ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
      if (to instanceof HTMLElement) to.focus();
      return;
    }
    if (matches('classifyConfirm', e) && e.target === e.currentTarget && marked) {
      e.preventDefault();
      answer(marked.id);
      return;
    }
    const key = pickKey(e);
    const choice = key ? choiceForKey(choices, key) : undefined;
    if (choice) {
      e.preventDefault();
      answer(choice.id ?? 'unsure');
    }
  };
  return (
    <li className="sortrow" data-row={row.item.id} data-kind={row.kind} tabIndex={0} onKeyDown={onKeyDown} aria-label={`${row.item.source.key} ${row.item.title}`}>
      <div className="sortrow__what">
        <p className="sortrow__head" title={row.item.title} data-truncate="">
          <ItemLink id={row.item.id} withTitle />
        </p>
        {tag && (
          <span className="sortrow__tag note" data-tag="">
            {tag}
          </span>
        )}
      </div>
      <div className="sortrow__choices" role="group" aria-label={`Category for ${row.item.source.key}`}>
        {choices.map((c) => {
          const value = c.id ?? 'unsure';
          const isMarked = marked?.id === value;
          return (
            <Button key={value} className="sortrow__choice" excludeFromTabOrder onPress={() => answer(value)} data-choice={value} data-marked={isMarked ? marked!.by : undefined} {...(isMarked && marked!.by === 'ai' ? { 'data-proposal': row.item.id } : {})} aria-keyshortcuts={c.key}>
              {c.name} <kbd className="sortrow__key">{c.key}</kbd>
              {isMarked && (
                <>
                  <span className="sortrow__mark" aria-hidden="true">
                    {marked!.by === 'ai' ? 'AI' : 'Rules'}
                  </span>
                  <span className="sr-only"> ({marked!.by === 'ai' ? 'suggested by your AI agent' : 'suggested by the rules'})</span>
                </>
              )}
            </Button>
          );
        })}
      </div>
      {/* One (i) in the header says why rows are here (#657); a row keeps its own only for what is its alone: an AI agent's
          suggestion with its Not this, or a label and the rules that disagree. */}
      {(proposal || row.kind === 'disagree') && <WhyTip row={row} follow={follow} onDismiss={() => dismiss([row.item.id])} />}
    </li>
  );
}

export function Classify() {
  const { toilProject, now, sync } = useData();
  const plain = usePlain();
  const words = useWords();
  const ins = useWorkInsights();
  const { filters } = useAddress();
  const c = useClassify();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState<{ by: string; count: number; warnings: string[]; omitted: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentChoice[]>([]);
  const [adapter, setAdapter] = useState<string | undefined>(undefined);
  // The cards are a snapshot of what was decided when Review and apply was pressed, so the result stays on screen after Apply empties the waiting list.
  const [cards, setCards] = useState<Array<{ connection: string; work: ApplyWork }> | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const focusNext = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    c.api?.agents().then((a) => live && setAgents(a), () => live && setAgents([]));
    return () => {
      live = false;
    };
  }, [c.api]);

  const allowed = useMemo(() => {
    const where = toWhere(filters);
    return where.length === 0 ? null : new Set(ins.narrow(where).items.map((i) => i.id));
  }, [ins, filters]);
  const rows = c.needs.filter((r) => !allowed || allowed.has(r.item.id));
  const pending = c.pending.filter((p) => !allowed || allowed.has(p.item.id));
  // An answer on an epic is every task under it too, so a row says how many of the rows below it follow it.
  const followers = useMemo(() => {
    const byId = new Map(ins.items.map((i) => [i.id, i]));
    const inList = new Set(rows.map((r) => r.item.id));
    const out = new Map<string, number>();
    for (const r of rows) {
      const seen = new Set<string>([r.item.id]);
      for (let up = r.item.parent; up && !seen.has(up); up = byId.get(up)?.parent ?? null) {
        seen.add(up);
        if (inList.has(up)) out.set(up, (out.get(up) ?? 0) + 1);
      }
    }
    return out;
  }, [ins.items, c.needs, allowed]);
  const unsure = rows.filter((r) => r.kind === 'unsure' && !c.proposals.has(r.item.id));

  // After a row is answered it leaves the list, and focus goes to the row that took its place.
  useEffect(() => {
    const id = focusNext.current;
    if (!id) return;
    focusNext.current = null;
    const el = list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`) ?? list.current?.querySelector<HTMLElement>('[data-row]');
    el?.focus();
  }, [rows.length]);

  // Pressing a choice is the answer: it is recorded in the person's ledger at once, the row leaves the list, and the line under the tabs
  // offers Undo, which records the item back where it stood (and puts an unanswered one back in the list).
  const answer = async (r: NeedsRow, value: string) => {
    if (busy) return;
    const at = rows.findIndex((x) => x.item.id === r.item.id);
    focusNext.current = rows[at + 1]?.item.id ?? rows[at - 1]?.item.id ?? '';
    setBusy(true);
    try {
      await c.reclassify(r.item, value === 'unsure' ? null : value, '');
    } catch {
      focusNext.current = null;
    } finally {
      setBusy(false);
    }
  };

  // Accepting a suggestion records the person's yes in their ledger, so it waits like a pick and the row leaves the list; a failure is the notice.
  const acceptThese = async (ids: string[]) => {
    if (busy) return;
    const at = rows.findIndex((x) => x.item.id === ids[0]);
    focusNext.current = rows.find((x, i) => i !== at && !ids.includes(x.item.id) && i > at)?.item.id ?? rows.find((x) => !ids.includes(x.item.id))?.item.id ?? '';
    setBusy(true);
    try {
      await c.accept(ids);
    } catch {
      focusNext.current = null;
    } finally {
      setBusy(false);
    }
  };

  const ask = async () => {
    if (!c.api || asking) return;
    setAsking(true);
    setProblem(null);
    setAsked(null);
    try {
      const items = unsure.slice(0, ASK_AT_MOST).map((r) => r.item);
      const got = await c.api.ask(toilProject.name, items, adapter);
      c.setProposals(got.answers);
      setAsked({ by: got.by, count: got.answers.filter((a) => a.category !== 'unsure').length, warnings: got.warnings, omitted: got.omitted + Math.max(0, unsure.length - ASK_AT_MOST) });
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  };

  // A project whose work was never read has nothing to sort, which is not "everything is sorted" (principle 12).
  const read = workRead(ins.items, toilProject.readTargets);
  const partial = read.state === 'partial';
  const ready = agents.filter((a) => a.ready);
  const proposed = [...c.proposals.keys()].filter((id) => rows.some((r) => r.item.id === id));
  const review = () =>
    setCards(
      byConnection(pending.map((p) => p.item)).map((g) => ({ connection: g.connection, work: { items: g.items } })),
    );

  if (read.state === 'unread') {
    return (
      <>
        <div className="view-head">
          <p className="eyebrow">
            <NavButton href={toilProjectHref(toilProject.name)} kind="quiet" size="sm" className="eyebrow-btn">
            {toilProject.name}
          </NavButton>
          </p>
          <h1 tabIndex={-1} title={plain.title('Classify')}>
            {words('classify.title')}
          </h1>
        </div>
        <section aria-labelledby="needs-head" className="classify__rows" data-classify-unread="">
          <h2 id="needs-head">{words('classify.unread')}</h2>
          {read.failed.map((label) => (
            <p key={label} className="note">
              {label}: work items not read
            </p>
          ))}
          <Empty message={words('classify.unread.body')} action={<TrackerAction toilProject={toilProject.name} sync={sync} />} />
        </section>
      </>
    );
  }

  return (
    <>
      <div className="view-head">
        <p className="eyebrow">
          <a href={toilProjectHref(toilProject.name)}>{toilProject.name}</a>
        </p>
        <h1 tabIndex={-1} title={plain.title('Classify')}>
          {words('classify.title')}
        </h1>
        <p className="lede">
          Pick a category for each item, read {plainDates(now.slice(0, 10))}. <Help topic="classify" />
        </p>
        {ins.schemeNote && (
          <p role="note" className="failure">
            {ins.schemeNote}
          </p>
        )}
      </div>

      <FilterBar period={false} />

      <HowItsDoing agents={agents} adapter={adapter} />

      <section className="classify__bar" aria-label="Ask your AI agent">
        <Button className="btn" onPress={() => void ask()} isDisabled={asking || unsure.length === 0 || ready.length === 0 || !c.api} data-ask-agent="">
          <AgentMark />
          {asking ? 'Asking your AI agent…' : words('classify.ask')}
        </Button>
        {agents.length > 1 && (
          <Select className="classify__adapter" selectedKey={adapter ?? agents.find((a) => a.ready)?.name ?? null} onSelectionChange={(k) => setAdapter(String(k))} aria-label="Which AI agent">
            <Button className="btn btn--small">
              <SelectValue />
            </Button>
            <Popover className="popover">
              <ListBox className="menu">
                {agents.map((a) => (
                  <ListBoxItem key={a.name} id={a.name} className="menu-item" isDisabled={!a.ready} textValue={a.label}>
                    {a.label}
                    {a.problem ? ` (${a.problem})` : ''}
                  </ListBoxItem>
                ))}
              </ListBox>
            </Popover>
          </Select>
        )}
        <Help topic="classify-ask" {...(ready.length > 0 && unsure.length > 0 ? { note: `It reads ${plural(Math.min(unsure.length, ASK_AT_MOST), 'unsure item')} this time.` } : {})} />
        {(ready.length === 0 || unsure.length === 0) && (
          <p className="note">
            {ready.length === 0
              ? 'No AI agent is set up yet. Choose one under Settings, AI agent. You can sort these by hand.'
              : partial
                ? 'Nothing unsure in what was read to ask about.'
                : 'There is nothing unsure left to ask about.'}
          </p>
        )}
        {asked && (
          <p role="status" data-asked="">
            {asked.by || 'Your AI agent'} suggested a category for {plural(asked.count, 'item')}.{asked.omitted > 0 ? ` ${plural(asked.omitted, 'more item')} did not fit in one question; ask again after these.` : ''}
          </p>
        )}
        {asked?.warnings.map((w) => (
          <p key={w} className="note">
            {w}
          </p>
        ))}
        {problem && (
          <p className="failure" role="alert">
            {problem}
          </p>
        )}
        {proposed.length > 0 && (
          <Button className="btn btn--accent" onPress={() => void acceptThese(proposed)} isDisabled={busy} data-accept-all="">
            Accept all {proposed.length}
          </Button>
        )}
      </section>

      {(pending.length > 0 || cards) && (
        <section className="classify__pending" aria-label="Changes waiting for the tracker" data-pending="">
          <h2>{pending.length === 0 ? 'Nothing is waiting for the tracker' : `${plural(pending.length, 'change')} waiting for the tracker`}</h2>
          {pending.length === 0 && cards && <p className="note">{words('classify.allWritten')}</p>}
          {!cards ? (
            <Button className="btn btn--accent" onPress={review} isDisabled={busy} data-review-apply="">
              Review and apply
            </Button>
          ) : (
            <div className="classify__cards">
              {cards.map((g) => (
                <ApplyCard key={g.connection} connection={g.connection} work={g.work} onClose={() => setCards(null)} />
              ))}
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="needs-head" className="classify__rows">
        <div className="classify__rows-head">
          <h2 id="needs-head">{rows.length === 0 ? (partial ? 'Nothing in what was read needs an answer' : 'Nothing needs an answer') : `${plural(rows.length, 'item')} ${rows.length === 1 ? 'needs' : 'need'} an answer`}</h2>
          {rows.length > 0 && (
            <InfoTip label="why these items need an answer" tip={NEEDS_WHY} triggerProps={{ 'data-needs-why': '' }}>
              <p>{NEEDS_WHY}</p>
            </InfoTip>
          )}
          {rows.length > 0 && (
            <p className="note sortrows__legend" data-legend="">
              {choicesOf(ins.scheme).map((ch) => (
                <kbd key={ch.key} className="sortrow__key">
                  {ch.key}
                </kbd>
              ))}{' '}
              answer, Up and Down move
            </p>
          )}
        </div>
        {partial &&
          read.failed.map((label) => (
            <p key={label} className="note" data-classify-partial="">
              {label}: work items not read
            </p>
          ))}
        {rows.length === 0 ? (
          <Empty
            message={allowed ? 'No item matching these filters needs an answer.' : pending.length > 0 ? 'Every item has an answer. The changes above are what is left.' : partial ? 'Nothing in what was read needs an answer.' : 'Everything is sorted. Nothing here needs you.'}
            action={allowed ? <EmptyButton onPress={() => (window.location.hash = window.location.hash.split('?')[0]!)}>Show every item</EmptyButton> : pending.length > 0 ? <EmptyButton onPress={review} disabled={busy}>Review and apply</EmptyButton> : <EmptyLink href={chartsHref(toilProject.name, 'mix')}>See the work mix</EmptyLink>}
          />
        ) : (
          <ul className="sortrows plain" ref={list}>
            {rows.map((r) => (
              <Row key={r.item.id} row={r} follow={followers.get(r.item.id) ?? 0} onAnswer={(v) => void answer(r, v)} onAccept={() => void acceptThese([r.item.id])} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
