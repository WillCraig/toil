/**
 * Assigning work to an agent, in the views (#293): the Assign dialog, the
 * Agents sidebar's parts (./sidebar.tsx) with the tracker's inbox, the item page's
 * list, and each agent's assignments on the People view. The assignment's
 * own page is src/views/Assignment.tsx. Every one of them reads the same
 * AssignmentsApi from the toil project's data, and none of them can write to a
 * tracker: Apply, on the assignment page, asks the server to run a
 * proposal it already holds. The in-tray, the out-tray, and a third tray
 * marked "pending signature".
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Dialog, DialogTrigger, Heading, Input, Label, Modal, ModalOverlay, Radio, RadioGroup, TextField } from 'react-aria-components';
import { NavButton } from '../components/nav-button.tsx';
import { ItemLink } from '../components/items.tsx';
import { Card, CardGrid, Cluster, Stack } from '../components/layout.tsx';
import { useData } from '../data.ts';
import { boardHref, shortKey, sourceLabel, toilProjectHref } from '../format.ts';
import { Empty, EmptyLink } from '../components/empty.tsx';
import { Help, InfoTip } from '../components/help.tsx';
import { DisclosureBody, SummaryChevron } from '../components/disclosure.tsx';
import { ADAPTER_LABEL, addUp, usageParts } from '../model-usage.ts';
import type { PersonEntry } from '../model/people.ts';
import type { WorkItem } from '../toil.ts';
import { ADAPTER_NAME, MODES, allApplied, STATE_LABEL, modeInfo, renewRefusal, runMs, runText, type AssignAdapter, type Assignment, type AssignmentList, type AssignMode } from './model.ts';
import { useChatScope } from '../components/ask.tsx';
import { StaleChip, StaleNote } from '../components/stale.tsx';
import { usePlain } from '../plain-words.ts';
import './assign.css';
import { homeShort } from '../home-path.ts';
import { AgentMark } from '../components/agent-mark.tsx';

export const assignmentHref = (toilProject: string, id: string) => `${toilProjectHref(toilProject)}/assignment/${encodeURIComponent(id)}`;

const active = (a: Pick<Assignment, 'state' | 'waiting'>) => a.state === 'working' || (a.state === 'queued' && a.waiting === 'slot');
/** How often a view reads again while something is queued or working. */
export const POLL_MS = 2000;

/** The toil project's assignments, read again every couple of seconds while any is queued or working. */
export function useAssignments(toilProject: string): { list: AssignmentList | null; error: string | null; reload: () => void } {
  const { assignments: api } = useData();
  const [list, setList] = useState<AssignmentList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!api || api.disabled) return;
    let live = true;
    api.list(toilProject).then(
      (l) => {
        if (!live) return;
        setList(l);
        setError(null);
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [api, toilProject, tick]);
  const busy = list?.assignments.some(active) ?? false;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [busy, reload]);
  return { list, error, reload };
}

/** The state as a chip, worded and coloured by state; a finished assignment whose every proposal was applied says Applied. */
export function StateChip({ a }: { a: Pick<Assignment, 'state' | 'waiting'> & Partial<Pick<Assignment, 'proposals'>> }) {
  if (allApplied(a)) return <span className="assign-state assign-state--done assign-state--applied">Applied</span>;
  const words = a.state === 'queued' && a.waiting === 'start' ? 'Queued, waiting for Start' : STATE_LABEL[a.state];
  return <span className={`assign-state assign-state--${a.state}`}>{words}</span>;
}

/** What a run used, in a few words, from the meter's own adding-up. */
export function usageText(a: Pick<Assignment, 'usage'>): string {
  if (!a.usage) return 'usage not reported yet';
  if (!a.usage.records.length) return `${ADAPTER_LABEL[a.usage.adapter]} reported no usage`;
  const parts = usageParts(addUp(a.usage.records), a.usage.adapter).slice(0, 2);
  return `${a.usage.sample ? 'sample figures: ' : ''}${parts.join(', ')}`;
}

/** One assignment on its item's page: state, mode, adapter and run time; the usage is on the assignment's Run details. */
export function AssignmentCard({ a, now }: { a: Assignment; now: string }) {
  const plain = usePlain();
  const pending = a.proposals.filter((p) => p.status === 'pending').length;
  return (
    <Card className="assign-card">
      <Stack gap="xs">
        <Cluster className="assign-card__top">
          <StateChip a={a} />
          <span className="assign-mode">{a.rules?.length ? 'Fix with AI agent' : modeInfo(a.mode, plain.on).label}</span>
        </Cluster>
        {/* The card sits on its item's page, so it doesn't name the item again; what the run used is on its Run details (#657). */}
        <p className="note">
          {a.adapter ? ADAPTER_NAME[a.adapter] : 'No adapter chosen yet'} · {runText(a.ranMs ?? runMs(a, now))}
        </p>
        {a.state === 'needs-you' && (
          <p className="assign-needs">
            {[pending ? `${pending} ${pending === 1 ? 'proposal' : 'proposals'} to review` : '', a.questions.length ? `${a.questions.length} ${a.questions.length === 1 ? 'question' : 'questions'}` : '', a.stop?.reason === 'injection' ? 'stopped on a possible injection' : ''].filter(Boolean).join(', ')}
          </p>
        )}
        {a.stop && a.state === 'failed' && <p className="assign-stop">{a.stop.message}</p>}
        {a.stale && <StaleNote stale={a.stale} />}
        {a.renewedBy && (
          <p className="note">
            Renewed as a fresh assignment.{' '}
            <NavButton href={assignmentHref(a.toilProject, a.renewedBy)} kind="quiet" size="sm">
              Open it
            </NavButton>
          </p>
        )}
        <p>
          <NavButton href={assignmentHref(a.toilProject, a.id)} size="sm">
            Open the assignment<span className="sr-only"> on {a.itemTitle}</span>
          </NavButton>
        </p>
      </Stack>
    </Card>
  );
}

/**
 * The Assign dialog's form: the adapter, the mode, and for implement mode
 * the repository. With `start`, it starts an assignment the tracker queued,
 * whose item and mode are fixed.
 */
export function AssignForm({ item, list, start, close, onDone }: { item: Pick<WorkItem, 'id' | 'title'>; list: AssignmentList; start?: Assignment; close: () => void; onDone: (a: Assignment) => void }) {
  const { assignments: api, toilProject } = useData();
  const plain = usePlain();
  const usable = list.adapters.filter((a) => !a.problem);
  const [adapter, setAdapter] = useState<AssignAdapter | null>(start?.adapter ?? (usable.find((a) => a.name === list.preferred)?.name ?? usable[0]?.name ?? null));
  const [mode, setMode] = useState<AssignMode>(start?.mode ?? 'refine');
  const [repo, setRepo] = useState<string | null>(list.repos[0]?.name ?? null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const choice = list.adapters.find((a) => a.name === adapter);
  const implementOff = mode === 'implement' ? (choice?.implement ?? (list.repos.length ? null : `${toilProject.name} lists no repository with a local path, so implement mode has nothing to clone. Add one under Settings, Toil projects.`)) : null;
  const canSend = api && !api.disabled && adapter !== null && !choice?.problem && !implementOff && !busy && (mode !== 'implement' || repo !== null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSend || !api || !adapter) return;
    setBusy(true);
    setProblem(null);
    try {
      const a = start ? await api.start(start.id, adapter) : await api.assign({ toilProject: toilProject.name, item: item.id, mode, adapter, ...(mode === 'implement' && repo ? { repo } : {}) });
      onDone(a);
      close();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="assign-form" onSubmit={submit} noValidate>
      <Heading slot="title" level={2} id="assign-title">
        {start ? plain.pw('Start the assignment', 'Start the AI agent') : plain.pw('Assign to an agent', 'Ask an AI agent')}
      </Heading>
      <p className="note">
        <ItemLink id={item.id} /> {item.title}
      </p>
      <RadioGroup className="agent-adapters" value={adapter ?? ''} onChange={(v) => setAdapter(v as AssignAdapter)}>
        <Label>{plain.pw('Adapter', 'Which AI agent')}</Label>
        {list.adapters.map((a) => (
          <Radio key={a.name} value={a.name} className="agent-choice" isDisabled={a.problem !== null}>
            <strong>{a.label}</strong>
            <span className={a.problem ? 'agent-missing' : 'note'}>{a.problem ?? (a.implement ? plain.pw('Refine and investigate.', 'Tidy up and look into.') : plain.pw('Refine, investigate and implement.', 'Tidy up, look into and try a fix.'))}</span>
          </Radio>
        ))}
      </RadioGroup>
      {start ? (
        <p>
          {plain.pw('Mode', 'What it does')}: <strong>{modeInfo(start.mode, plain.on).label}</strong>, as the tracker asked ({start.trigger}). {modeInfo(start.mode, plain.on).does}
        </p>
      ) : (
        <RadioGroup className="agent-adapters" value={mode} onChange={(v) => setMode(v as AssignMode)}>
          <div className="edit-head">
            <Label className="agent-label">{plain.pw('Mode', 'What should it do?')}</Label>
            <Help topic="assignments" />
          </div>
          {MODES.map((m) => (
            <Radio key={m} value={m} className="agent-choice">
              <strong>{modeInfo(m, plain.on).label}</strong>
              <span className="note">
                {modeInfo(m, plain.on).does} {modeInfo(m, plain.on).changes}
              </span>
            </Radio>
          ))}
        </RadioGroup>
      )}
      {mode === 'implement' && list.repos.length > 0 && (
        <RadioGroup className="agent-adapters" value={repo ?? ''} onChange={setRepo}>
          <Label>Repository to clone</Label>
          {list.repos.map((r) => (
            <Radio key={r.name} value={r.name} className="agent-choice">
              <strong>{r.name}</strong>
              <span className="note any-break">{homeShort(r.path)}</span>
            </Radio>
          ))}
        </RadioGroup>
      )}
      {implementOff && <p className="failure">{implementOff}</p>}
      <p className="note">
        It runs on your own AI subscription, {list.settings.concurrent === 1 ? 'one at a time' : `${list.settings.concurrent} at a time`}, for up to {list.settings.timeLimitMinutes} minutes.
      </p>
      {list.settings.problem && <p className="failure">{list.settings.problem}</p>}
      {api?.disabled && <p className="failure">{api.disabled}</p>}
      {problem && (
        <p role="alert" className="failure">
          {problem}
        </p>
      )}
      <div className="assign-actions">
        <Button type="submit" className="btn btn--accent" isDisabled={!canSend}>
          <AgentMark />
          {busy ? plain.pw('Assigning…', 'Asking…') : start ? 'Start' : plain.pw('Assign', 'Ask the AI agent')}
        </Button>
        <Button className="btn" onPress={close}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The dialog around the form; it reads the toil project's adapters and repositories when it opens. */
export function AssignModal({ item, start, isOpen, onOpenChange, onDone }: { item: Pick<WorkItem, 'id' | 'title'>; start?: Assignment; isOpen?: boolean; onOpenChange?: (open: boolean) => void; onDone?: (a: Assignment) => void }) {
  const controlled = isOpen === undefined ? {} : { isOpen, ...(onOpenChange ? { onOpenChange } : {}) };
  const done = onDone ?? ((a: Assignment) => void (window.location.hash = assignmentHref(a.toilProject, a.id)));
  return (
    <ModalOverlay className="feedback-overlay" data-backdrop="" isDismissable {...controlled}>
      <Modal className="feedback-modal">
        <Dialog className="feedback-dialog" aria-labelledby="assign-title">
          {({ close }) => <AssignBody item={item} {...(start ? { start } : {})} close={close} onDone={done} />}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function AssignBody({ item, start, close, onDone }: { item: Pick<WorkItem, 'id' | 'title'>; start?: Assignment; close: () => void; onDone: (a: Assignment) => void }) {
  const { assignments: api, toilProject } = useData();
  const plain = usePlain();
  const [list, setList] = useState<AssignmentList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return void setProblem('This view has no agent assignments.');
    if (api.disabled) return void setProblem(api.disabled);
    let live = true;
    api.list(toilProject.name).then(
      (l) => live && setList(l),
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [api, toilProject.name]);
  if (list) return <AssignForm item={item} list={list} {...(start ? { start } : {})} close={close} onDone={onDone} />;
  return (
    <div className="assign-form">
      <Heading slot="title" level={2} id="assign-title">
        {plain.pw('Assign to an agent', 'Ask an AI agent')}
      </Heading>
      <p className={problem ? 'failure' : 'note'}>{problem ?? 'Reading the adapters on this machine…'}</p>
      <div className="assign-actions">
        <Button className="btn" onPress={close}>
          Close
        </Button>
      </div>
    </div>
  );
}

/** "Assign to agent" for one item, and the dialog it opens. Absent where nothing can be assigned. */
export function AssignButton({ item }: { item: Pick<WorkItem, 'id' | 'title'> }) {
  const { assignments: api } = useData();
  if (!api) return null;
  return (
    <DialogTrigger>
      <Button className="btn" data-assign-open="">
        <AgentMark />
        Assign to agent<span className="sr-only"> {item.id}</span>
      </Button>
      <AssignModal item={item} />
    </DialogTrigger>
  );
}

/** A ticket rule a "Fix with AI agent" is about (#657): its name and text, and toil's reason the item misses it. */
export interface RuleToFix {
  standard: string;
  rule: string;
  name: string;
  text: string | null;
  reason: string;
}

/** The item a fix is for: its tracker names who holds the text until a person applies the rewrite. */
type FixItem = Pick<WorkItem, 'id' | 'title' | 'source'>;

/**
 * "Fix with AI agent" on a thin or failed ticket-rule row (#657): a refine held
 * to that rule, or to every rule of one standard the item misses ("Fix all 3").
 * The agent suggests one rewrite and asks about what the item doesn't say;
 * nothing changes until a person applies the proposal. Where no AI agent can
 * run here, the dialog says so and links to setting one up, as Ask does,
 * rather than offering a button that can only fail.
 */
function FixRuleForm({ item, rules, list, close }: { item: FixItem; rules: readonly RuleToFix[]; list: AssignmentList; close: () => void }) {
  const { assignments: api, toilProject } = useData();
  const usable = list.adapters.filter((a) => !a.problem);
  const [adapter, setAdapter] = useState<AssignAdapter | null>(usable.find((a) => a.name === list.preferred)?.name ?? usable[0]?.name ?? null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const canSend = Boolean(api && !api.disabled && adapter && !busy);
  const one = rules.length === 1;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSend || !api || !adapter) return;
    setBusy(true);
    setProblem(null);
    try {
      const standard = one ? { standard: rules[0]!.standard, rule: rules[0]!.rule } : { standard: rules[0]!.standard, rules: rules.map((r) => r.rule) };
      const a = await api.assign({ toilProject: toilProject.name, item: item.id, mode: 'refine', adapter, standard });
      close();
      window.location.hash = assignmentHref(a.toilProject, a.id);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="assign-form" onSubmit={submit} noValidate data-fix-rule="">
      <Heading slot="title" level={2} id="assign-title">
        Fix with AI agent
      </Heading>
      <p className="note">
        <ItemLink id={item.id} /> {item.title}
      </p>
      <dl className="fix-rule">
        <dt>{one ? 'Ticket rule' : 'Ticket rules'}</dt>
        <dd>
          {rules.map((r) => (
            <p key={r.rule}>
              {/* The rule's own words are its explanation, so they sit in its (i), and the dialog leads with the name and the miss (#657). */}
              <strong>{r.name}</strong>
              {r.text && (
                <>
                  {' '}
                  <InfoTip label={r.name} tip={r.text} triggerProps={{ 'data-rule-text': r.rule }}>
                    <p>{r.text}</p>
                  </InfoTip>
                </>
              )}
            </p>
          ))}
        </dd>
        <dt>What's missing</dt>
        <dd>
          {rules.map((r) => (
            <p key={r.rule}>{r.reason}</p>
          ))}
        </dd>
      </dl>
      <p>
        An AI agent suggests a rewrite that meets {one ? 'the rule' : 'the rules'}. <strong>Nothing changes in {sourceLabel(item.source.area)} until you apply it.</strong>
      </p>
      {usable.length === 0 ? (
        <div className="agent-notice" data-no-agent="">
          <p>
            No AI agent is set up on this computer yet.{' '}
            <NavButton href="#/settings/agent" size="sm">
              Set up an AI agent
            </NavButton>
          </p>
          {list.adapters.some((a) => a.problem) && (
            <details>
              <summary>
                <SummaryChevron />
                Details for whoever sets it up
              </summary>
              <ul className="plain">
                {list.adapters.map((a) => (
                  <li key={a.name} className="note">
                    {a.label}: {a.problem}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ) : usable.length > 1 ? (
        <RadioGroup className="agent-adapters" value={adapter ?? ''} onChange={(v) => setAdapter(v as AssignAdapter)}>
          <Label>Which AI agent</Label>
          {usable.map((a) => (
            <Radio key={a.name} value={a.name} className="agent-choice">
              <strong>{a.label}</strong>
            </Radio>
          ))}
        </RadioGroup>
      ) : (
        <p className="note">It runs on {usable[0]!.label}, on your own AI subscription, for up to {list.settings.timeLimitMinutes} minutes.</p>
      )}
      {list.settings.problem && <p className="failure">{list.settings.problem}</p>}
      {api?.disabled && <p className="failure">{api.disabled}</p>}
      {problem && (
        <p role="alert" className="failure">
          {problem}
        </p>
      )}
      <div className="assign-actions">
        {usable.length > 0 && (
          <Button type="submit" className="btn btn--accent" isDisabled={!canSend}>
            <AgentMark />
            {busy ? 'Asking…' : 'Ask for a rewrite'}
          </Button>
        )}
        <Button className="btn" onPress={close}>
          {usable.length > 0 ? 'Cancel' : 'Close'}
        </Button>
      </div>
    </form>
  );
}

function FixRuleBody({ item, rules, close }: { item: FixItem; rules: readonly RuleToFix[]; close: () => void }) {
  const { assignments: api, toilProject } = useData();
  const [list, setList] = useState<AssignmentList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return void setProblem('This view has no AI agent assignments.');
    if (api.disabled) return void setProblem(api.disabled);
    let live = true;
    api.list(toilProject.name, { inbox: false }).then(
      (l) => live && setList(l),
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [api, toilProject.name]);
  if (list) return <FixRuleForm item={item} rules={rules} list={list} close={close} />;
  return (
    <div className="assign-form">
      <Heading slot="title" level={2} id="assign-title">
        Fix with AI agent
      </Heading>
      <p className={problem ? 'failure' : 'note'}>{problem ?? 'Reading the AI agents on this computer…'}</p>
      <div className="assign-actions">
        <Button className="btn" onPress={close}>
          Close
        </Button>
      </div>
    </div>
  );
}

/**
 * "Fix with AI agent" for ticket rules on one item, and the dialog it opens:
 * one rule, or "Fix all 3 with AI agent" for every rule of one standard the
 * item misses, which asks for one rewrite that meets them all. Absent where
 * nothing can be assigned.
 */
export function FixRuleButton({ item, rules, primary = false }: { item: FixItem; rules: readonly RuleToFix[]; primary?: boolean }) {
  const { assignments: api } = useData();
  if (!api || rules.length === 0) return null;
  const one = rules.length === 1;
  return (
    <DialogTrigger>
      <Button className={primary ? 'btn btn--accent btn--sm' : 'btn btn--sm'} data-fix-rule-open={one ? `${rules[0]!.standard}/${rules[0]!.rule}` : rules[0]!.standard}>
        <AgentMark />
        {one ? 'Fix with AI agent' : `Fix all ${rules.length} with AI agent`}
        <span className="sr-only">: {rules.map((r) => r.name).join(', ')}</span>
      </Button>
      <ModalOverlay className="feedback-overlay" data-backdrop="" isDismissable>
        <Modal className="feedback-modal">
          <Dialog className="feedback-dialog" aria-labelledby="assign-title">
            {({ close }) => <FixRuleBody item={item} rules={rules} close={close} />}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

/** One inbox entry: what the tracker asked for, and the Start a person presses. */
export function InboxRow({ a, onStarted }: { a: Assignment; onStarted: () => void }) {
  const plain = usePlain();
  const [open, setOpen] = useState(false);
  return (
    <li className="assign-inbox__row">
      <Cluster>
        <span>
          <ItemLink id={a.item} /> {a.itemTitle}: <strong>{modeInfo(a.mode, plain.on).label.toLowerCase()}</strong>
        </span>
        <Button className="btn btn--accent btn--small" onPress={() => setOpen(true)} data-inbox-start="">
          <AgentMark />
          Start<span className="sr-only"> {a.item}</span>…
        </Button>
      </Cluster>
      <AssignModal item={{ id: a.item, title: a.itemTitle }} start={a} isOpen={open} onOpenChange={setOpen} onDone={onStarted} />
    </li>
  );
}

/** How many at once and how long each: shown always, changed here where the server allows. */
export function Limits({ list, onSaved }: { list: AssignmentList; onSaved: () => void }) {
  const { assignments: api } = useData();
  const [concurrent, setConcurrent] = useState(String(list.settings.concurrent || 1));
  const [minutes, setMinutes] = useState(String(list.settings.timeLimitMinutes));
  const [said, setSaid] = useState<string | null>(null);
  if (!api?.saveSettings) return null;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.saveSettings!({ concurrent: Number(concurrent), timeLimitMinutes: Number(minutes) });
      setSaid('Saved. The next assignment runs on these limits.');
      onSaved();
    } catch (err) {
      setSaid(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <details className="assign-limits">
      <summary>Limits</summary>
      <form className="assign-limits__form" onSubmit={save}>
        <TextField className="field-text" value={concurrent} onChange={setConcurrent} inputMode="numeric">
          <Label>Assignments at once (1 to 3)</Label>
          <Input />
        </TextField>
        <TextField className="field-text" value={minutes} onChange={setMinutes} inputMode="numeric">
          <Label>Minutes each (1 to 240)</Label>
          <Input />
        </TextField>
        <Button type="submit" className="btn">
          Save the limits
        </Button>
        <p className="note" role="status">
          {said}
        </p>
      </form>
    </details>
  );
}

/** One session Renew all stale would touch (#305): what it is, and whether it renews or why it is skipped. */
interface Renewal {
  key: string;
  label: string;
  skip: string | null;
  run: () => Promise<unknown>;
}

/**
 * Renew all stale (#305): the list first, each stale session with whether it
 * renews or why it is skipped (working, waiting on you), then one press
 * renews the rest. The toil project's chat is on the list when it is stale.
 */
export function RenewAll({ list, onDone }: { list: AssignmentList; onDone: () => void }) {
  const plain = usePlain();
  const { assignments: api, toilProject } = useData();
  const chat = useChatScope();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string[] | null>(null);
  // The list the dialog shows is the one it opened on, so the result stays on screen once nothing is stale.
  const [shown, setShown] = useState<Renewal[] | null>(null);
  if (!api) return null;
  const renewChat = async () => {
    const why = await chat!.renew();
    if (why) throw new Error(why);
  };
  const rows: Renewal[] = [
    ...(chat?.session?.stale ? [{ key: 'chat', label: `The chat about ${toilProject.name}: ${chat.session.stale.text}`, skip: chat.session.stale.restart ?? (chat.busy ? 'It is answering a question now, and a renew never interrupts one.' : null), run: renewChat }] : []),
    ...list.assignments
      .filter((a) => a.stale)
      .map((a) => ({ key: a.id, label: `${modeInfo(a.mode, plain.on).label} ${a.item} on ${a.adapter ? ADAPTER_NAME[a.adapter] : 'no adapter'}, ${STATE_LABEL[a.state].toLowerCase()}: ${a.stale!.text}`, skip: renewRefusal(a), run: () => api.renew(a.id) })),
  ];
  if (!rows.length && !open) return null;
  const listed = shown ?? rows;
  const go = listed.filter((r) => !r.skip);
  const renewAll = async () => {
    setBusy(true);
    const out: string[] = [];
    for (const r of go) {
      try {
        await r.run();
        out.push(`Renewed: ${r.label}`);
      } catch (e) {
        out.push(`Not renewed: ${r.label}. ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setSaid(out);
    setBusy(false);
    onDone();
  };
  return (
    <>
      {rows.length > 0 && (
      <Cluster>
        <Button className="btn" onPress={() => (setSaid(null), setShown(rows), setOpen(true))} data-renew-all="">
          <AgentMark />
          {plain.pw('Renew all stale…', 'Restart out-of-date…')}
        </Button>
        <span className="note">
          <StaleChip /> {rows.length === 1 ? 'One session started' : `${rows.length} sessions started`} {plain.pw('on instructions that have changed since.', 'before an update.')}
        </span>
      </Cluster>
      )}
      <ModalOverlay className="feedback-overlay" data-backdrop="" isDismissable isOpen={open} onOpenChange={setOpen}>
        <Modal className="feedback-modal">
          <Dialog className="feedback-dialog" aria-labelledby="renew-title">
            {({ close }) => (
              <div className="assign-form">
                <Heading slot="title" level={2} id="renew-title">
                  {plain.pw('Renew stale sessions', 'Restart out-of-date sessions')}
                </Heading>
                <p className="note">Each renews as a fresh session on today's instructions, with what the old one left as context. The old one stays readable. Renew never interrupts a turn, and skips any session waiting on you. <Help topic="stale" /></p>
                <ul className="rows renew-list">
                  {listed.map((r) => (
                    <li key={r.key}>
                      <strong>{r.skip ? 'Skipped' : 'Renews'}</strong>: {r.label}
                      {r.skip && <span className="note"> {r.skip}</span>}
                    </li>
                  ))}
                </ul>
                {said && (
                  <ul className="rows" role="status" aria-label="What was renewed">
                    {said.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                )}
                <div className="assign-actions">
                  {!said && (
                    <Button className="btn btn--accent" onPress={() => void renewAll()} isDisabled={busy || !go.length} data-renew-confirm="">
                      {busy ? 'Renewing…' : go.length ? `Renew ${go.length}` : 'Nothing to renew'}
                    </Button>
                  )}
                  <Button className="btn" onPress={close}>
                    {said ? 'Close' : 'Cancel'}
                  </Button>
                </div>
              </div>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}

/** The item page's part: assign it, and what was assigned before. */
export function ItemAssignments({ item }: { item: WorkItem }) {
  const { toilProject, now, assignments: api } = useData();
  const { list, error } = useAssignments(toilProject.name);
  if (!api) return null;
  const mine = list?.assignments.filter((a) => a.item === item.id) ?? [];
  return (
    <Card as="section" className="panel item-agents" aria-labelledby="item-agents">
      {/* What an assignment does is an explanation, so it is the heading's (i), not a paragraph beside the button (#657). */}
      <h2>
        <span id="item-agents">AI agents</span> <Help topic="assignments" note="Refine, investigate or implement it with Claude, Copilot or Codex. Its proposals wait for you." />
      </h2>
      <Cluster>
        <AssignButton item={item} />
      </Cluster>
      {error && <p className="failure">{error}</p>}
      {mine.length > 0 && (
        <CardGrid min="sm" className="assign-lane" aria-label={`Assignments on ${shortKey(item)}`}>
          {mine.map((a) => (
            <li key={a.id}>
              <AssignmentCard a={a} now={now} />
            </li>
          ))}
        </CardGrid>
      )}
    </Card>
  );
}

/** The toil project agent an adapter's work belongs to, by name or by an id naming the adapter. */
export function agentFor(adapter: AssignAdapter, people: readonly PersonEntry[]): PersonEntry | null {
  const words = [adapter, ADAPTER_NAME[adapter].toLowerCase()];
  return people.find((p) => p.kind === 'agent' && (words.some((w) => p.name.toLowerCase().includes(w)) || Object.values(p.ids).some((id) => words.includes(id.toLowerCase())))) ?? null;
}

/** The People view's part: each adapter with assignments, as a teammate, under the toil project's agent of that name where there is one. */
export function AgentAssignments({ people }: { people: readonly PersonEntry[] }) {
  const plain = usePlain();
  const { toilProject, now, assignments: api } = useData();
  const { list } = useAssignments(toilProject.name);
  if (!api || !list) return null;
  const adapters = [...new Set(list.assignments.flatMap((a) => (a.adapter ? [a.adapter] : [])))].sort();
  return (
    <section className="people-section" aria-labelledby="agent-assignments">
      {/* What the section is lives in its heading's (i) (#657), not two lines under it. */}
      <h2>
        <span id="agent-assignments">{plain.pw("Agents' assignments", "AI agents' work")}</span>{' '}
        <InfoTip label="AI agents' work" tip={plain.pw("What each agent was assigned from Toil UI, as a teammate's plate: its own runs, not the pull requests above.", "What each AI agent was asked to do from Toil UI, as a teammate's plate: its own runs, not the code reviews above.")}>
          <p>{plain.pw("What each agent was assigned from Toil UI, as a teammate's plate: its own runs, not the pull requests above.", "What each AI agent was asked to do from Toil UI, as a teammate's plate: its own runs, not the code reviews above.")}</p>
        </InfoTip>
      </h2>
      {adapters.length ? (
        <CardGrid min="md" className="people-cards">
          {adapters.map((adapter) => {
            const who = agentFor(adapter, people);
            const mine = list.assignments.filter((a) => a.adapter === adapter);
            return (
              <li key={adapter}>
                <Card className="assign-agent">
                  <Stack gap="xs">
                    <h3>{who ? `${who.name} (${ADAPTER_NAME[adapter]})` : ADAPTER_NAME[adapter]}</h3>
                    <p className="note">{stateCounts(mine)}</p>
                    {mine.some((a) => a.stale) && (
                      <p className="note" data-stale="">
                        <StaleChip /> {mine.filter((a) => a.stale).length} started on instructions that have changed since.
                      </p>
                    )}
                    {/* One line per kind of work ("Tidy up · 8"), each opening to its runs: eight near-identical rows were a wall. */}
                    <ul className="assign-kinds">
                      {kindsOf(mine).map(([mode, runs]) => (
                        <li key={mode}>
                          <details className="assign-kind" data-assign-kind={mode}>
                            <summary>
                              <SummaryChevron />
                              <span>
                                {modeInfo(mode, plain.on).label} · {runs.length}
                              </span>
                              <span className="note">{stateCounts(runs)}</span>
                            </summary>
                            <DisclosureBody>
                              <ul className="rows">
                                {runs.map((a) => (
                                  <li key={a.id}>
                                    <StateChip a={a} /> {a.stale && <StaleChip />}{' '}
                                    <NavButton href={assignmentHref(a.toilProject, a.id)} kind="quiet" size="sm">
                                      {modeInfo(a.mode, plain.on).label}
                                    </NavButton>{' '}
                                    <ItemLink id={a.item} /> <span className="note">{runText(a.ranMs ?? runMs(a, now))}</span>
                                  </li>
                                ))}
                              </ul>
                            </DisclosureBody>
                          </details>
                        </li>
                      ))}
                    </ul>
                  </Stack>
                </Card>
              </li>
            );
          })}
        </CardGrid>
      ) : (
        <Empty message={`Nothing has been assigned to an agent in ${toilProject.name} yet.`} action={<EmptyLink href={boardHref(toilProject.name)}>Assign from the board</EmptyLink>} help="assignments" />
      )}
    </section>
  );
}

const STATE_ORDER = ['working', 'needs-you', 'queued', 'done', 'failed'] as const;

/** "1 working, 7 done": how many runs are in each state, in the order a person acts on them. */
export function stateCounts(runs: ReadonlyArray<Pick<Assignment, 'state'>>): string {
  return STATE_ORDER.map((s) => [s, runs.filter((a) => a.state === s).length] as const)
    .filter(([, n]) => n)
    .map(([s, n]) => `${n} ${STATE_LABEL[s].toLowerCase()}`)
    .join(', ');
}

/** An agent's runs by kind of work, in the order each kind first appears, so the newest kind leads as the list did. */
export function kindsOf<T extends Pick<Assignment, 'mode'>>(runs: readonly T[]): Array<[AssignMode, T[]]> {
  const kinds = new Map<AssignMode, T[]>();
  for (const a of runs) (kinds.get(a.mode) ?? kinds.set(a.mode, []).get(a.mode)!).push(a);
  return [...kinds.entries()];
}
