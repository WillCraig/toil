/**
 * The approval card for writing a category back to a tracker (#566): every
 * change first, one connection at a time. The item, the label from and to, and
 * the field from and to, then the one command that applies it, which is the one
 * place a command line is shown (an approval card is where the other proposals
 * show theirs). A press runs the tracker's own `categorize` through toil's write
 * gate: the connection's `writes` must be on, and the call carries `allowWrite`.
 * When writes are off the card says so in plain words and where to turn them on;
 * in a sample it shows everything and says the sample can't write. Each item's
 * result is reported (changed, already as wanted, or failed with the tracker's
 * own reason), and pressing again changes nothing, because `categorize` reads
 * each item before it writes. The change request that is read in full, once,
 * and then signed.
 */

import { noteApplied } from '../applied.ts';
import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import type { ApplyOutcome, ApplyPlan, ApplyResult, ApplyWork, PlanGroupView } from '../classify-api.ts';
import { useClassify } from '../classify-state.tsx';
import { useData } from '../data.ts';
import { useWorkInsights } from '../insights-data.ts';
import { commandLine } from '../proposal.ts';
import { useShell } from './proposal.tsx';
import { sourceLabel } from '../format.ts';
import { useWords } from '../skins.tsx';
import type { WorkItem } from '../toil.ts';
import { NavButton } from './nav-button.tsx';

/** Why a connection's changes can't be applied yet, in words, with where to put it right. */
export const WRITES_OFF = (connection: string) => `Changes to ${connection} are switched off, so nothing can be written there yet. Turn them on for ${connection} under Settings, Connections, then come back and apply.`;

const nameOf = (ins: ReturnType<typeof useWorkInsights>, id: string) => ins.definitions[id]?.name ?? id;

/** How many changes a card shows before the rest fold behind "Show all". Folded, never hidden: the count says how many more. */
export const SHOWN_AT_FIRST = 10;

/** What will be written to one item, in one cell: the label from and to ("+ ktlo", "feature → ktlo"), and the field from and to. Never behind a tooltip: this is what a person approves. */
function changeText(c: PlanGroupView['changes'][number]): string {
  const kept = c.labelsFrom.filter((l) => !c.labelsRemove.includes(l));
  const to = c.labelsAdd.length ? c.labelsAdd.join(', ') : kept.join(', ');
  const parts: string[] = [];
  if (c.labelsAdd.length + c.labelsRemove.length === 0) parts.push('label already right');
  else if (c.labelsFrom.length === 0) parts.push(`+ ${to}`);
  else parts.push(`${c.labelsFrom.join(', ')} → ${to || 'none'}`);
  if (c.field) parts.push(`field ${c.field.name}: ${c.field.from === undefined ? 'not read' : (c.field.from ?? 'empty')} → ${c.field.to}`);
  return parts.join(' · ');
}

/** One connection's changes as a compact table, a line each: item, title, category, change. Past ten it folds, with the count on the button. */
function Changes({ g, ins }: { g: PlanGroupView; ins: ReturnType<typeof useWorkInsights> }) {
  const [all, setAll] = useState(false);
  const shown = all ? g.changes : g.changes.slice(0, SHOWN_AT_FIRST);
  return (
    <>
      <table className="apply__table" data-changes="">
        <caption className="sr-only">Changes to {g.connection}</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Title</th>
            <th scope="col">Category</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => (
            <tr key={c.id} className="apply__change" data-change={c.id}>
              <th scope="row" className="apply__key">
                {c.key}
              </th>
              <td className="apply__title" title={c.title} data-truncate="">
                {c.title}
              </td>
              <td className="apply__category">{nameOf(ins, c.category)}</td>
              <td className="apply__what">{changeText(c)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {g.changes.length > SHOWN_AT_FIRST && (
        <div>
          <Button className="btn btn--small btn--quiet" onPress={() => setAll(!all)} data-show-all="">
            {all ? `Show the first ${SHOWN_AT_FIRST}` : `Show all ${g.changes.length}`}
          </Button>
        </div>
      )}
    </>
  );
}

function Outcome({ o }: { o: ApplyOutcome }) {
  if (o.refused) {
    return (
      <p className="failure" role="alert" data-outcome="refused">
        {o.connection}: {o.refused}
      </p>
    );
  }
  return (
    <div role="status" data-outcome="done" className="apply__outcome">
      <p>
        {o.changed.length} changed, {o.unchanged.length} already as wanted{o.failed.length ? `, ${o.failed.length} failed` : ''}.
      </p>
      <ul className="plain">
        {o.changed.map((c) => (
          <li key={c.key}>
            {c.key}: {c.text}.
          </li>
        ))}
        {o.unchanged.map((k) => (
          <li key={k} className="note">
            {k}: already as wanted.
          </li>
        ))}
        {o.failed.map((f) => (
          <li key={f.key} className="failure">
            {f.key} failed: {f.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The card for one connection: its decided items, the plan toil makes of them, and the press that applies it. `work` is
 * only this connection's items.
 */
export function ApplyCard({ connection, work, onClose }: { connection: string; work: ApplyWork; onClose: () => void }) {
  const { toilProject } = useData();
  const ins = useWorkInsights();
  const { api, applied } = useClassify();
  const shell = useShell();
  const words = useWords();
  const [plan, setPlan] = useState<ApplyPlan | { error: string } | null>(null);
  const [result, setResult] = useState<ApplyResult | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped by "Check again": a plan is good for one Apply, so checking again makes a fresh plan.
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    if (!api) return;
    api.plan(toilProject.name, work).then(
      (p) => live && setPlan(p),
      (e: unknown) => live && setPlan({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
    // The plan is read once per card, and again on Check again: the items it is about don't change while it is open.
  }, [api, toilProject.name, round]);
  const checkAgain = () => {
    setResult(null);
    setPlan(null);
    setRound((n) => n + 1);
  };
  const press = async () => {
    if (!api) return;
    setBusy(true);
    try {
      if (!plan || !('id' in plan)) return;
      const r = await api.apply(toilProject.name, plan.id);
      setResult(r);
      const byId = new Map(work.items.map((i) => [i.id, i]));
      const wanted = new Map((plan && 'groups' in plan ? plan.groups : []).flatMap((g) => g.changes.map((c) => [c.key, c.category] as const)));
      const done = r.outcomes.flatMap((o) => [...o.changed.map((c) => c.key), ...o.unchanged]).flatMap((key) => {
        const item = [...byId.values()].find((i) => i.source.key === key);
        const category = wanted.get(key);
        return item && category ? [{ id: item.id, category }] : [];
      });
      if (done.length) applied(done);
      // Each changed item is a change in the tracker the data on screen doesn't show yet (#657, round 4).
      const at = new Date().toISOString();
      for (const o of r.outcomes) for (const c of o.changed) noteApplied(`classify:${c.key}:${at}`, at);
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const disabled = api?.disabled ?? null;
  const groups = plan && 'groups' in plan ? plan.groups : [];
  const writesOff = groups.some((g) => g.writes === false);
  return (
    <section className="apply" aria-label={`Changes to ${connection}`} data-apply={connection}>
      <h3>Changes to {connection}</h3>
      {!plan && <p className="note">Working out the changes…</p>}
      {plan && 'error' in plan && (
        <p className="failure" role="alert">
          {plan.error}
        </p>
      )}
      {plan && 'groups' in plan && plan.groups.length === 0 && <p className="note">Nothing to change: the tracker already says what you decided.</p>}
      {groups.map((g) => {
        const line = commandLine({ command: g.command.name, input: g.command.input }, shell);
        return (
          <div key={`${g.area}:${g.connection}`} className="apply__group">
            <p className="note">
              {g.changes.length} {g.changes.length === 1 ? 'item' : 'items'} in {sourceLabel(g.area)}.
            </p>
            <Changes g={g} ins={ins} />
            {line.line && (
              <details className="apply__command">
                <summary>The command toil runs</summary>
                <pre className="command">
                  <code>{line.line}</code>
                </pre>
              </details>
            )}
          </div>
        );
      })}
      {plan && 'notes' in plan && plan.notes.map((n) => <p key={n} className="note">{n}</p>)}
      {writesOff && !disabled && (
        <p className="failure" role="note" data-writes-off="">
          {WRITES_OFF(connection)}{' '}
          <NavButton href="#/settings/connections" size="sm">
            Open Settings
          </NavButton>
        </p>
      )}
      {disabled && (
        <p className="note" role="note" data-sample-cannot-write="">
          {disabled}
        </p>
      )}
      {result && 'error' in result && (
        <p className="failure" role="alert">
          {result.error}
        </p>
      )}
      {result && 'outcomes' in result && result.outcomes.map((o) => <Outcome key={o.connection} o={o} />)}
      {result && 'recorded' in result && !result.recorded.ok && (
        <p className="failure" role="alert">
          The tracker was changed, but your record was not updated: {result.recorded.message}
        </p>
      )}
      {!result && groups.length > 0 && <p className="note">Nothing is written until you press Apply.</p>}
      <div className="apply__actions">
        {result && 'outcomes' in result ? (
          <Button className="btn btn--accent" onPress={checkAgain} isDisabled={busy} data-check-again="">
            {words('classify.checkAgain')}
          </Button>
        ) : (
          <Button className="btn btn--accent" onPress={press} isDisabled={busy || !plan || !('groups' in plan) || groups.length === 0 || Boolean(disabled) || writesOff} data-apply-press="">
            {busy ? 'Applying…' : `Apply ${groups.reduce((n, g) => n + g.changes.length, 0) || ''} ${groups.reduce((n, g) => n + g.changes.length, 0) === 1 ? 'change' : 'changes'}`.replace(/\s+/g, ' ')}
          </Button>
        )}
        <Button className="btn btn--quiet" onPress={onClose}>
          Close
        </Button>
      </div>
    </section>
  );
}

/** The decided items, grouped by the connection they live on: one card each. */
export function byConnection(items: WorkItem[]): Array<{ connection: string; items: WorkItem[] }> {
  const out = new Map<string, WorkItem[]>();
  for (const i of items) out.set(i.source.connection, [...(out.get(i.source.connection) ?? []), i]);
  return [...out].map(([connection, list]) => ({ connection, items: list }));
}
