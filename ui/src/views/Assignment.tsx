/**
 * One agent assignment (#293): its state and why, the report with the
 * server's citation checks, the questions, the branch implement mode made,
 * every proposal with a diff of what it would change, the record of what
 * the run started on, and the whole transcript. Apply asks the server to
 * run the proposal it stored when the run ended, through toil's write gate
 * (the connection's `writes`, and this press as the call's allow-write);
 * nothing else here can change a tracker. The case file, with the
 * signature line at the bottom of every page.
 */

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from 'react-aria-components';
import { usePlain } from '../plain-words.ts';
import { AssignModal, StateChip, assignmentHref, usageText, POLL_MS } from '../assign/views.tsx';
import { ADAPTER_NAME, applyResultText, liveLine, modeInfo, noteRepeatsQuestion, richText, renewRefusal, runMs, runText, writesOffText, type AssignedProposal, type Assignment, type AssignmentRecord, type DiffRow } from '../assign/model.ts';
import { lineDiff, sideOf } from '../assign/line-diff.ts';
import { againText, askRecheck, askedAt, firstShowing, passedText, rulesAgain } from '../assign/recheck.ts';
import { noteApplied } from '../applied.ts';
import { StaleNote } from '../components/stale.tsx';
import { AnswerText, ItemLink } from '../components/items.tsx';
import { Card, Cluster, DataTable, Path, Scroller } from '../components/layout.tsx';
import { ProposalCard } from '../components/proposal.tsx';
import { UsageFooter } from '../components/usage.tsx';
import { useData } from '../data.ts';
import { Empty, EmptyLink } from '../components/empty.tsx';
import { AGENT_SETTINGS_HREF, dateTime, shortKey, sourceLabel, timeOnDay, toilProjectHref } from '../format.ts';
import { EditLink, Help } from '../components/help.tsx';
import { Unread } from '../components/unread.tsx';
import { SummaryChevron } from '../components/disclosure.tsx';
import { ExternalIcon } from '../components/icons.tsx';
import { fieldName, readiness, withRules } from '../model/readiness.ts';
import { AgentMark } from '../components/agent-mark.tsx';
import { NavButton } from '../components/nav-button.tsx';

const when = (iso: string | null) => (iso ? dateTime(iso) : 'not yet');

export function AssignmentView({ id }: { id: string }) {
  const { toilProject, assignments: api, now, byId } = useData();
  const plain = usePlain();
  const [record, setRecord] = useState<AssignmentRecord | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!api) return;
    let live = true;
    api.get(id).then(
      (r) => live && (setRecord(r), setProblem(null)),
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [api, id, tick]);
  const running = record?.state === 'working' || (record?.state === 'queued' && record.waiting === 'slot');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [running, reload]);

  if (!api || (problem && !record)) {
    return (
      <>
        <h1 tabIndex={-1}>No such assignment</h1>
        <Empty message={problem ?? 'This view has no agent assignments.'} action={<EmptyLink href={toilProjectHref(toilProject.name)}>Back to {toilProject.name}</EmptyLink>} />
      </>
    );
  }
  if (!record) return <p className="note">Reading the assignment…</p>;

  // `what` is the line to show once the call returns: a fixed sentence, or one read from the assignment it returned.
  const act = async (what: string | ((after: Assignment) => string), run: () => Promise<Assignment>) => {
    setBusy(true);
    setSaid(null);
    try {
      const after = await run();
      setSaid(typeof what === 'string' ? what : what(after));
    } catch (e) {
      setSaid(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      reload();
    }
  };
  const a = record;
  const waitingStart = a.state === 'queued' && a.waiting === 'start';
  // What leads the head: a proposal waits and none was applied, so nothing has changed and the next step is the reader's.
  const open = a.proposals.filter((p) => p.status === 'pending');
  const appliedOnes = a.proposals.filter((p) => p.status === 'applied');
  const waitsOnYou = open.length > 0 && appliedOnes.length === 0;
  // Every proposal applied: the change is made, and the page says so rather than how to make it.
  const everyApplied = a.proposals.length > 0 && appliedOnes.length === a.proposals.length;
  const inRun = a.state === 'working' || a.state === 'queued';

  // A refine or a rule fix ends in the change to review, so its proposals lead, above the questions and what the agent said; elsewhere the report leads.
  const proposalsFirst = a.mode === 'refine' || Boolean(a.rules?.length);
  const area = byId.get(a.item)?.source.area;
  const tracker = area ? sourceLabel(area) : 'the tracker';
  // A refine or a rule fix ends in proposals to apply, so Mark reviewed sits below them rather than beside the page's first step.
  const markReviewed = (
    <Button className="btn" onPress={() => act('Marked reviewed.', () => api.finish(a.id))} isDisabled={busy}>
      Mark reviewed
    </Button>
  );
  const nameOf = (id: string) => {
    const it = byId.get(id);
    return it ? `${sourceLabel(it.source.area)} ${shortKey(it)}` : id;
  };
  const proposals = a.proposals.length > 0 && (
    <section className="proposals" aria-labelledby="assign-proposals">
      <h2 id="assign-proposals">Proposals</h2>
      <p className="note" data-proposals-lede="">
        {/* Before anything is applied the head already says nothing has changed; once all is applied, the lede says where the change went; only a page part-way through needs the reminder. */}
        {everyApplied ? (appliedOnes.length === 1 ? `The applied change is in ${tracker}.` : `The applied changes are in ${tracker}.`) : `Each change the agent proposes.${waitsOnYou || open.length === 0 ? '' : ` Nothing changes in ${tracker} until you press Apply.`}`} <Help topic="proposal" note="Apply runs its toil command through the write gate: the connection needs writes on, and this press is the call's allow-write." />
      </p>
      {a.proposals.map((p) => (
        <AssignedCard
          key={p.id}
          // A note that only asks a QUESTION: line again is said once, on the Questions card below (#657, round 5).
          p={noteRepeatsQuestion(p.note, a.questions) ? { ...p, note: null } : p}
          tracker={tracker}
          quiet={Boolean(a.rules?.length)}
          busy={busy}
          onApply={() =>
            act(
              (after) => {
                const done = after.proposals.find((x) => x.id === p.id);
                if (done?.status === 'applied' && done.outcome?.ok) noteApplied(`assignment:${a.id}/${p.id}`, done.outcome.at);
                return applyResultText(after, p.id, p.title);
              },
              () => api.apply(a.id, p.id),
            )
          }
          onDismiss={() => act(`Dismissed: ${p.title}.`, () => api.dismiss(a.id, p.id))}
          recheck={a.rules?.length && p.id === appliedOnes[0]?.id ? <CheckAgain a={a} /> : null}
        />
      ))}
    </section>
  );

  return (
    <>
      <div className="view-head">
        <p className="eyebrow">
          <NavButton href={toilProjectHref(a.toilProject)} kind="quiet" size="sm" className="eyebrow-btn">
            {a.toilProject}
          </NavButton>{' '}
          · Agent assignment
        </p>
        <h1 tabIndex={-1}>
          {a.rules?.length ? 'Fix with AI agent' : modeInfo(a.mode, plain.on).label}: {a.itemTitle}
        </h1>
        {a.rules?.length ? (
          <p data-assignment-rule="">
            To meet {a.rules.length === 1 ? 'the ticket rule' : 'the ticket rules'}{' '}
            {a.rules.map((r, i) => (
              <Fragment key={r.rule}>
                {i > 0 && (i === a.rules!.length - 1 ? ' and ' : ', ')}
                <strong>{r.name}</strong>
              </Fragment>
            ))}
            .
          </p>
        ) : null}
        {waitsOnYou && (
          <p className="assign-lead" data-assignment-lead="">
            Nothing has changed yet. Review {open.length === 1 ? 'the proposal below and apply it' : 'the proposals below and apply the ones you want'}.
          </p>
        )}
        <p className="item-meta">
          <StateChip a={a} /> <ItemLink id={a.item} /> · {a.adapter ? ADAPTER_NAME[a.adapter] : 'no adapter chosen yet'} <EditLink href={AGENT_SETTINGS_HREF} label="Edit the agent settings" /> · {a.origin === 'tracker' ? `queued by the tracker (${a.trigger})` : 'started by you'}
        </p>
        <details className="assign-run" data-assignment-run="">
          <summary>
            <SummaryChevron />
            Run details
          </summary>
          <p className="note">
            Created {when(a.createdAt)}; started {when(a.startedAt)}; {a.endedAt ? `ended ${when(a.endedAt)}` : 'still going'}; ran {runText(a.ranMs ?? runMs(a, now))}; {usageText(a)}. {modeInfo(a.mode, plain.on).changes}
          </p>
          {a.stale && (
            <p className="note" data-stale-why="">
              Out of date: {a.stale.text}.
            </p>
          )}
        </details>
      </div>

      {a.stop && (
        <p role="note" className={a.stop.reason === 'injection' ? 'assign-warn' : 'failure'}>
          {a.stop.message} {a.stop.fix}
        </p>
      )}

      {a.stale && (
        <div className="stale-block">
          <StaleNote stale={a.stale} />
          <p className="note">{renewRefusal(a) ?? "Renew starts it again as a fresh assignment on today's instructions, with what this run left as context. This one stays as it is."}</p>
        </div>
      )}
      {a.renews && (
        <p className="note">
          This renews an earlier assignment on the same item, which started on older instructions; what it left was in this run's prompt.{' '}
          <NavButton href={assignmentHref(a.toilProject, a.renews)} kind="quiet" size="sm">
            Open the earlier one
          </NavButton>
        </p>
      )}
      {a.renewedBy && (
        <p className="note">
          Renewed as a fresh assignment on today's instructions.{' '}
          <NavButton href={assignmentHref(a.toilProject, a.renewedBy)} kind="quiet" size="sm">
            Open it
          </NavButton>
        </p>
      )}

      <Cluster className="assign-actions">
        {a.stale && !renewRefusal(a) && (
          <Button
            className="btn btn--accent"
            onPress={() =>
              act('Renewed.', async () => {
                const fresh = await api.renew(a.id);
                window.location.hash = assignmentHref(fresh.toilProject, fresh.id);
                return fresh;
              })
            }
            isDisabled={busy}
            data-renew=""
          >
            <AgentMark />
            Renew
          </Button>
        )}
        {waitingStart && (
          <Button className="btn btn--accent" onPress={() => setStarting(true)} isDisabled={busy}>
            Start…
          </Button>
        )}
        {(a.state === 'queued' || a.state === 'working') && (
          <Button className="btn" onPress={() => act(a.state === 'working' ? 'Stopping it.' : 'Taken off the queue.', () => api.cancel(a.id))} isDisabled={busy}>
            {a.state === 'working' ? 'Stop' : 'Take off the queue'}
          </Button>
        )}
        {a.state === 'needs-you' && !proposalsFirst && markReviewed}
        <span className="note" role="status">
          {said ?? ''}
        </span>
      </Cluster>
      {waitingStart && <AssignModal item={{ id: a.item, title: a.itemTitle }} start={a} isOpen={starting} onOpenChange={setStarting} onDone={reload} />}

      {a.state === 'working' && (
        <p className="assign-live" role="status" aria-live="polite" data-assignment-live="">
          {liveLine(a, nameOf, (id) => byId.get(id)?.parent ?? null)}
        </p>
      )}

      {proposalsFirst && proposals}
      {proposalsFirst && a.state === 'needs-you' && <Cluster className="assign-actions assign-actions--after">{markReviewed}</Cluster>}

      {a.questions.length > 0 && everyApplied ? (
        // Once every change is in, the questions are no longer the reader's next step, only what the team still owes an answer on.
        <ul className="rows assign-confirm" data-still-to-confirm="">
          {a.questions.map((q, i) => (
            <li key={i} className="note">
              Still to confirm with the team: {q}
            </li>
          ))}
        </ul>
      ) : a.questions.length > 0 && (
        <Card as="section" className="panel" aria-labelledby="assign-questions">
          <h2 id="assign-questions">Questions for you</h2>
          <ul className="rows">
            {a.questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
          <p className="note">{proposalsFirst ? `Answer these in ${tracker}, then ask for a new rewrite.` : `Answer these in ${tracker}, then assign it again.`}</p>
        </Card>
      )}

      {a.report && (
        <Card as="section" className="panel" aria-labelledby="assign-report">
          <h2 id="assign-report">{a.mode === 'investigate' ? 'Report' : 'What the agent said'}</h2>
          {(a.report.warnings.length > 0 || a.report.unverified.length > 0) && (
            <div className="answer-checks" role="note">
              {a.report.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}
          {a.report.parts.map((p, i) => (
            <AnswerText key={i} text={p.text} chips />
          ))}
          {a.usage && <UsageFooter usage={a.usage} />}
        </Card>
      )}

      {a.branch && (
        <Card as="section" className="panel" aria-labelledby="assign-branch">
          <h2 id="assign-branch">Branch {a.branch.name}</h2>
          <p>
            In a clone of {a.branch.repo} at <Path value={a.branch.folder} what="folder" />, {a.branch.onBranch ? `on ${a.branch.name}` : `not on ${a.branch.name}`}, with {a.branch.files.length === 1 ? 'one changed file' : `${a.branch.files.length} changed files`}, staged and not committed.
          </p>
          {a.branch.files.length > 0 && (
            <ul className="rows">
              {a.branch.files.map((f) => (
                <li key={`${f.status}:${f.path}`}>
                  <code>{f.path}</code> <span className="note">{f.status}</span>
                  {a.branch?.hidden?.includes(f.path) && <span className="assign-stop"> not in the diff below</span>}
                </li>
              ))}
            </ul>
          )}
          {a.branch.diff && (
            <Scroller label="The staged diff">
              <pre className="assign-diff">
                <code>{a.branch.diff}</code>
              </pre>
            </Scroller>
          )}
        </Card>
      )}

      {!proposalsFirst && proposals}

      {/* While it runs, the live line is the page's one focus; the evidence opens once the run has ended. */}
      {a.startedOn && !inRun && (
        <details className="assign-record">
          <summary>What this run started on</summary>
          <dl className="fields">
            <dt>toil</dt>
            <dd>{a.startedOn.toil}</dd>
            <dt>Toil UI</dt>
            <dd>{a.startedOn.toilUi}</dd>
            <dt>Adapter</dt>
            <dd>
              {ADAPTER_NAME[a.startedOn.adapter]}, {a.startedOn.model ?? "the CLI's default model"}
            </dd>
            <dt>Skills</dt>
            <dd>{a.startedOn.skills.length ? a.startedOn.skills.join(', ') : 'none: Toil UI gives an assigned agent its tools and prompt only'}</dd>
            <dt>Tools</dt>
            <dd className="any-break">{a.startedOn.tools.join(', ')}</dd>
            <dt>Toil project</dt>
            <dd className="any-break">
              {a.startedOn.toilProject.name}, <code>{a.startedOn.toilProject.fingerprint ?? 'unread'}</code>
            </dd>
            <dt>Item</dt>
            <dd className="any-break">
              {a.startedOn.item.id}, updated {a.startedOn.item.updated ? dateTime(a.startedOn.item.updated) : 'at an unknown time'}, <code>{a.startedOn.item.fingerprint}</code>
            </dd>
            <dt>Prompt</dt>
            <dd className="any-break">
              <code>{a.startedOn.prompt}</code>
            </dd>
            <dt>Install fingerprint</dt>
            <dd className="any-break">
              {a.startedOn.fingerprint ? (
                <>
                  toil {a.startedOn.fingerprint.toil.version} at {a.startedOn.fingerprint.toil.commit?.slice(0, 7) ?? 'an unrecorded commit'}, Toil UI {a.startedOn.fingerprint.toilUi.version} at {a.startedOn.fingerprint.toilUi.commit?.slice(0, 7) ?? 'an unrecorded commit'}; skills{' '}
                  {Object.entries(a.startedOn.fingerprint.skills)
                    .map(([area, hash]) => `${area} ${hash.slice(0, 12)}`)
                    .join(', ') || 'none'}
                  ; Toil project <code>{a.startedOn.fingerprint.toilProject?.slice(0, 12) ?? 'unread'}</code>; prompts <code>{a.startedOn.fingerprint.prompts.slice(0, 12)}</code>
                </>
              ) : (
                'not recorded: this run started before Toil UI recorded one, so it is never called stale'
              )}
            </dd>
          </dl>
          <p className="note">Fingerprints are SHA-256 of what the run read, so a later look can tell whether the item, the Toil project or the prompt has changed since.</p>
        </details>
      )}

      {a.transcript.length > 0 && !inRun && (
      <details className="assign-transcript">
        <summary>Transcript ({a.transcript.length === 1 ? '1 line' : `${a.transcript.length} lines`})</summary>
        <ol className="assign-lines">
          {a.transcript.map((t, i) => (
            <li key={i} className={`assign-line assign-line--${t.kind}`}>
              <p>
                <span className="note">{dateTime(t.at)}</span> <strong>{t.title}</strong>
              </p>
              {t.detail && (
                <pre className="assign-detail">
                  <code>{t.detail}</code>
                </pre>
              )}
            </li>
          ))}
        </ol>
      </details>
      )}
    </>
  );
}

const STATUS_WORD: Record<AssignedProposal['status'], string> = {
  pending: 'Proposed change, not applied',
  applied: 'Applied',
  failed: 'Not applied',
  dismissed: 'Dismissed',
};

/** One proposal with its diff, what came of it, and Apply and Dismiss while it waits. */
function AssignedCard({ p, tracker, quiet, busy, onApply, onDismiss, recheck }: { p: AssignedProposal; tracker: string; /** A rule fix: the agent's paragraph above already says why, so the card doesn't repeat it. */ quiet: boolean; busy: boolean; onApply: () => void; onDismiss: () => void; /** Once applied: Sync and check again, for a rule fix. */ recheck?: ReactNode }) {
  const { toilProject, byId, viewedAt } = useData();
  const item = byId.get(p.item);
  // "at 22:39 UTC" on the day it was applied, "on 17 Nov 2026, 22:39 UTC" after.
  const appliedAt = p.outcome ? timeOnDay(p.outcome.at, viewedAt ?? new Date().toISOString()) : '';
  const open = p.status === 'pending' || p.status === 'failed';
  const area = byId.get(p.item)?.source.area ?? null;
  // Once applied, the table is a record of what it was and what it became, not a choice still to make.
  const applied = p.status === 'applied';
  const writesOff = writesOffText(p.outcome, area ? sourceLabel(area) : tracker);
  return (
    <ProposalCard
      // The agent's note was advice for the person about to apply it; once applied, it no longer is.
      proposal={applied ? { ...p, note: null } : p}
      kind={STATUS_WORD[p.status]}
      hideReason={quiet}
      applied={applied}
      lead={
        p.diff.length > 0 ? (
          <DataTable
            className="assign-diff-table"
            label={`What ${p.title} changes`}
            caption="What it changes"
            rows={p.diff}
            rowKey={(r) => r.field}
            columns={[
              { header: 'Field', label: 'Field', rowHeader: true, className: 'assign-diff-field', cell: (r) => <FieldName field={r.field} name={fieldName(r.field, toilProject.readiness, area)} /> },
              { header: applied ? 'Before' : 'Now', label: applied ? 'Before' : 'Now', className: 'assign-diff-value', cell: (r) => (r.before === null ? <Unread className="note" titled /> : r.before === '' ? <span className="note">empty</span> : <DiffSide row={r} side="before" applied={applied} />) },
              { header: applied ? 'After' : 'Proposed', label: applied ? 'After' : 'Proposed', className: 'assign-diff-value', cell: (r) => (r.before === null || r.before === '' ? <span className="assign-after">{richText(r.after)}</span> : <DiffSide row={r} side="after" applied={applied} />) },
            ]}
          />
        ) : null
      }
      actions={
        open ? (
          <>
            {p.command && p.input && (
              <Button className="btn btn--accent" onPress={onApply} isDisabled={busy}>
                Apply<span className="sr-only"> {p.title}</span>
              </Button>
            )}
            <Button className="btn btn--quiet" onPress={onDismiss} isDisabled={busy}>
              Dismiss<span className="sr-only"> {p.title}</span>
            </Button>
          </>
        ) : null
      }
    >
      {p.outcome && writesOff ? (
        <>
          <p className="failure" role="status" data-writes-off="">
            {writesOff}
          </p>
          <details className="proposal-command" data-outcome-details="">
            <summary>
              <SummaryChevron />
              Details
            </summary>
            <p className="note">What toil said, {dateTime(p.outcome.at)}:</p>
            <pre className="command">
              <code>{p.outcome.message}</code>
            </pre>
          </details>
        </>
      ) : applied && p.outcome?.ok ? (
        <p className="note" role="status" data-applied-line="">
          Applied to {item ? `${sourceLabel(item.source.area)} ${shortKey(item)}` : tracker} {appliedAt.includes(',') ? 'on' : 'at'} {appliedAt}.
          {item?.url && (
            <>
              {' '}
              <a className="btn btn--secondary btn--sm item-open" href={item.url} target="_blank" rel="noopener noreferrer">
                Open in {sourceLabel(item.source.area)} <ExternalIcon size={14} className="icon--external-link" />
                <span className="sr-only"> (opens a new tab)</span>
              </a>
            </>
          )}
        </p>
      ) : (
        p.outcome && (
          <p className={p.outcome.ok ? 'note' : 'failure'} role="status">
            {dateTime(p.outcome.at)}: {p.outcome.message}
          </p>
        )
      )}
      {applied && recheck}
    </ProposalCard>
  );
}

/**
 * One column of a field's diff, line by line (#657, round 4): lines the
 * proposal keeps read plainly in both columns; a line it removes is struck
 * through in Now (muted, not struck, once applied, when it is a record); a
 * line it adds is emphasised in Proposed. Each marked line says so to a
 * screen reader, which can't see a strike.
 */
function DiffSide({ row, side, applied }: { row: DiffRow; side: 'before' | 'after'; applied: boolean }) {
  const lines = sideOf(lineDiff(richText(row.before ?? ''), richText(row.after)), side);
  return (
    <span className="assign-lines-diff" data-diff-side={side}>
      {lines.map((l, i) => (
        <span key={i} className={`diff-line diff-line--${l.kind === 'del' && applied ? 'was' : l.kind}`} data-diff={l.kind}>
          {l.kind === 'del' && l.text.trim() && <span className="sr-only">{applied ? 'Was: ' : 'Removed: '}</span>}
          {l.kind === 'add' && l.text.trim() && <span className="sr-only">Added: </span>}
          {l.text || '\u00a0'}
        </span>
      ))}
    </span>
  );
}

/**
 * Sync and check again (#657, round 4), on a rule fix's applied card: syncs
 * the Toil project, since nothing reads one item into the cache on its own,
 * then shows each rule on what that sync read. Nothing is said about a rule
 * until a reading newer than the press is on screen (principle 12).
 */
function CheckAgain({ a }: { a: Assignment }) {
  const { sync, rules, now, toilProject, byId } = useData();
  const [, setPressed] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const at = a.rules?.length ? askedAt(a.id) : undefined;
  const fresh = at !== undefined && Date.parse(now) > Date.parse(at);
  const again = fresh && a.rules?.length ? rulesAgain(a.rules, rules?.reading, a.item) : null;
  // The sync remounts the page at its top, so the result is brought to the button once, where the press was made (round 5).
  useEffect(() => {
    if (again && at !== undefined && firstShowing(a.id, at)) box.current?.scrollIntoView?.({ block: 'center' });
  }, [again, at, a.id]);
  if (!sync || !a.rules?.length) return null;
  const item = byId.get(a.item);
  // The verdict on the same reading, so "ready to start" is said only when it is (principle 12).
  const after = again && item ? readiness({ item, settings: withRules(toilProject.readiness, rules?.reading), byId }) : null;
  const passed = again ? passedText(again, item ? shortKey(item) : a.item, after) : null;
  const press = () => {
    askRecheck(a.id, now);
    setPressed((n) => n + 1);
    sync();
  };
  return (
    <div className="check-again" data-check-again="" ref={box}>
      <Cluster>
        <Button className="btn" onPress={press} isDisabled={at !== undefined && !fresh}>
          Sync and check again
        </Button>
        <span className={passed ? 'check-again--pass' : 'note'} role="status" data-again-result={passed ? 'pass' : undefined}>
          {at !== undefined && !fresh
            ? 'Syncing, then checking the rule again. The Sync panel says how it is going.'
            : fresh && rules?.reading.state === 'failed'
              ? null
              : fresh && !again
                ? 'Checking the rule on the new reading…'
                : passed
                  ? passed
                  : again
                    ? `Read ${dateTime(now)}.`
                    : 'Reads the Toil project again, then checks the rule on what it read.'}
        </span>
      </Cluster>
      {fresh && rules?.reading.state === 'failed' && <p className="failure">toil couldn't check the ticket rules: {rules.reading.message}</p>}
      {again && !passed && (
        <ul className="rows check-again__rules">
          {again.map((r) => (
            <li key={r.name} className={r.state === 'pass' ? 'check-again--pass' : r.state === 'missing' ? 'check-again--missing' : undefined} data-again={r.state}>
              {againText(r)}
            </li>
          ))}
        </ul>
      )}
      {passed && <p className="note">Read {dateTime(now)}.</p>}
    </div>
  );
}

/** A field by its plain name where one is known, with the tracker's own id one hover away; the id itself where none is. */
function FieldName({ field, name }: { field: string; name: string | null }) {
  return name ? <span title={`In the tracker: ${field}`}>{name}</span> : <code>{field}</code>;
}
