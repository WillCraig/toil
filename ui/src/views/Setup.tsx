/**
 * The setup wizard (#561), for someone new to AI, toil and Toil UI: one
 * question a screen, seven screens, each with Back, Skip and Next and a line
 * saying where you are. The AI agent comes first and is optional: once one is
 * ready, every later step has a guide beside it that explains what the step
 * asks for (src/components/guide-panel.tsx), and with none the wizard is what
 * it always was, plus a small line offering one. It adds nothing of its own to configure. Every change
 * is a command Settings already runs through the server's allowlist:
 * `connections add` (whose masked secret fields go to toil's own login path and
 * the OS credential store, as in Settings, and nowhere else, never to the AI
 * helper), `connections test`, `projects init`, `projects add-repo` and
 * `projects link`, and the helper is the same Install dialog and Save the Agent
 * page has. The guide never sees a secret and runs nothing itself: a command it
 * suggests is run by a person pressing Run this, through the same allowlist.
 * Writes stay off, and the wizard says so. Progress lives in this
 * component's state only: close the tab and the choices go, the connections
 * already saved stay. The paperwork for a first day, minus the first day's paperwork.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { RadioGroup, Radio } from 'react-aria-components';
import type { AgentSettingsPanelProps } from '../agent-settings.tsx';
import type { Agent } from '../agent.ts';
import { GuidePanel } from '../components/guide-panel.tsx';
import { guideStateOf } from '../guide.ts';
import { InstallDialog, helperState, needsInstall, statusLines, STATE_WORD } from '../agent-install.tsx';
import { SAMPLE_ADAPTER_STATUS } from '../fixtures/agent-status.ts';
import { envOnly, type AreaInfo, type ConfigApi, type ConnectionRow, type ConnectionsData } from '../config.ts';
import type { AdapterStatus, AgentStatus } from '../server-client.ts';
import { Card } from '../components/layout.tsx';
import { Help } from '../components/help.tsx';
import { Loader } from '../moments/Moments.tsx';
import { deploymentOf, freeName, groupAreas, GUIDED_STEPS, locationKind, locationProblems, SETUP_STEPS, STEP_SHORT, STEP_TITLE, toolName, TOKEN_WORD, tokenStateOf, type SetupProgress, type SetupStep } from '../setup.ts';
import { LoginForm, NewConnectionForm } from './settings/Connections.tsx';
import { FieldsStep } from './settings/FindFields.tsx';
import { testSentence, type ConnectionTestData } from '../connection-test.ts';
import { ChangeForm, ChoiceRadios, OutcomeLine, SelectField, TextField, failedOutcome, outcomeOf, type Outcome } from './settings/parts.tsx';
import { addRepos, linkTools, withJiraKey, type RepoResult } from './project-create.ts';
import { JiraKeyField, NamedJiraLine, useNamedJira } from './jira-key.tsx';
import './setup.css';

/** Where the wizard lives, and what opens it from the first run, the palette and Settings. */
export const SETUP_HREF = '#/setup';

interface ListedProject {
  name: string;
  description: string | null;
}

/** The AI agent the person saved in the wizard, if any. */
type Chosen = string | null;

export interface SetupProps {
  config: ConfigApi | null;
  /** Toil UI's AI agent settings; absent in the preview, which shows the sample status and installs nothing. */
  agent?: AgentSettingsPanelProps | undefined;
  /** The setup guide's question, when this Toil UI has one: the server's, or the preview's scripted one. Absent: no guide, and no offer of one. */
  guide?: Agent['guide'] | undefined;
  /** The page's memory of where the wizard is, so a remount (a saved helper, a finished sync) doesn't send it back to Welcome. Absent: its own state only. */
  keep?: { value: SetupProgress | null; save(progress: SetupProgress | null): void } | undefined;
  onSync?: (() => void) | undefined;
}

/** Whether the saved choice names a helper that can start now: a chosen one that is installed with its program found. */
const helperReady = (status: AgentStatus | null): boolean => Boolean(status && status.settings.adapter !== 'none' && status.adapters.some((a) => a.name === status.settings.adapter && helperState(a) === 'ready'));

export function Setup({ config, agent, guide, keep, onSync }: SetupProps) {
  const [step, setStep] = useState<SetupStep>(keep?.value?.step ?? 'welcome');
  const [areas, setAreas] = useState<AreaInfo[] | null>(null);
  const [connections, setConnections] = useState<ConnectionsData['connections']>([]);
  /** Whether `connections list` was read: an unreadable list is unknown, not empty. */
  const [listed, setListed] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<ListedProject[]>([]);
  const [picked, setPicked] = useState<string[]>(keep?.value?.picked ?? []);
  const [areaAt, setAreaAt] = useState(keep?.value?.areaAt ?? 0);
  /** Connections saved in this run, by area. */
  const [made, setMade] = useState<Record<string, string>>(keep?.value?.made ?? {});
  const [project, setProject] = useState<string | null>(keep?.value?.project ?? null);
  const [fieldsNamed, setFieldsNamed] = useState(false);
  /** The optional steps answered "Not now". */
  const [skipped, setSkipped] = useState<SetupStep[]>(keep?.value?.skipped ?? []);
  const later = (which: SetupStep, on: boolean) => setSkipped((s) => (on ? (s.includes(which) ? s : [...s, which]) : s.filter((x) => x !== which)));
  /** Whether the page showing now says it is complete (a connection chosen, a Toil project made or chosen), and whether it is still working. Each page reports both, and resets them as it leaves. */
  const [pageDone, setPageDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [helper, setHelper] = useState<Chosen>(keep?.value?.helper ?? null);
  /** The non-secret settings the connection form would send now, for the guide: the form reports them, and holds the secret box to itself. */
  const [draft, setDraft] = useState<Record<string, string>>({});
  /** The step a person left to set up a helper from the offer, so Next takes them back to it. */
  const [returnTo, setReturnTo] = useState<SetupStep | null>(keep?.value?.returnTo ?? null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusProblem, setStatusProblem] = useState<string | null>(null);
  const client = agent?.client ?? null;
  const readStatus = useCallback(() => {
    client?.status().then(setStatus, (e: unknown) => setStatusProblem(e instanceof Error ? e.message : String(e)));
  }, [client]);
  useEffect(readStatus, [readStatus]);
  const heading = useRef<HTMLHeadingElement>(null);
  const save = keep?.save;
  useEffect(() => save?.({ step, picked, areaAt, made, project, helper, returnTo, skipped }), [save, step, picked, areaAt, made, project, helper, returnTo, skipped]);

  const reload = useCallback(async () => {
    if (!config) return;
    const [list, ps] = await Promise.all([config.run('connections list', {}).catch(() => null), config.run('projects list', {}).catch(() => null)]);
    setListed(Boolean(list?.ok));
    if (list?.ok) {
      setConnections((list.data as ConnectionsData).connections);
    }
    if (ps?.ok) setProjects((ps.data as { toilProjects: ListedProject[] }).toilProjects ?? []);
  }, [config]);
  useEffect(() => {
    if (!config) return;
    config.areas().then(setAreas, () => setAreas([]));
    void reload();
  }, [config, reload]);
  useEffect(() => heading.current?.focus(), [step, areaAt]);
  useEffect(() => setDraft({}), [step, areaAt]);
  // Tools already linked start ticked, once, the first time the list shows: nobody should have to find them again.
  const prefilled = useRef((keep?.value?.picked.length ?? 0) > 0 || (keep?.value?.skipped ?? []).includes('tools'));
  useEffect(() => {
    if (step !== 'tools' || prefilled.current || listed === null || !areas) return;
    prefilled.current = true;
    const linked = areas.map((a) => a.name).filter((n) => connections.some((c) => c.area === n));
    if (linked.length > 0) setPicked((p) => (p.length === 0 ? linked : p));
  }, [step, listed, areas, connections]);

  const index = SETUP_STEPS.indexOf(step);
  const next = () => {
    if (step === 'helper' && returnTo) {
      setStep(returnTo);
      return setReturnTo(null);
    }
    if (step === 'connect' && areaAt < picked.length - 1) return setAreaAt(areaAt + 1);
    if (step === 'tools' && picked.length === 0) return setStep('project');
    setAreaAt(0);
    setStep(SETUP_STEPS[Math.min(index + 1, SETUP_STEPS.length - 1)]!);
  };
  const back = () => {
    if (step === 'connect' && areaAt > 0) return setAreaAt(areaAt - 1);
    if (step === 'project' && picked.length === 0) return setStep('tools');
    if (step === 'project') setAreaAt(picked.length - 1);
    setStep(SETUP_STEPS[Math.max(index - 1, 0)]!);
  };

  // Next stays off until the page is completely done, and says what is missing. A page that is optional is done once "Not now" is chosen.
  const jiraConnection = made.jira ?? connections.find((c) => c.area === 'jira')?.name ?? null;
  const canNameFields = Boolean(jiraConnection && project);
  const savedHelper = client && status && helperReady(status) ? (status.adapters.find((a) => a.name === status.settings.adapter)?.label ?? null) : null;
  const helperLabel = skipped.includes('helper') ? null : (helper ?? savedHelper);
  const stepDone: Record<SetupStep, boolean> = {
    welcome: true,
    helper: skipped.includes('helper') || helperLabel !== null,
    tools: picked.length > 0 || skipped.includes('tools'),
    connect: Boolean(picked[areaAt] && made[picked[areaAt]!]) || pageDone,
    project: pageDone,
    fields: !canNameFields || fieldsNamed || skipped.includes('fields'),
    done: true,
  };
  const WHY: Record<SetupStep, string> = {
    welcome: '',
    helper: 'Choose an AI agent, or Not now, first.',
    tools: "Tick a tool, or choose I'll add tools later, first.",
    connect: 'Save the connection, or choose one you already have, first.',
    project: 'Choose a Toil project, create one, or choose Not now, first.',
    fields: 'Name the fields, or choose Not now, first.',
    done: '',
  };
  // With no configuration commands there is nothing to choose on the tools, project and fields pages, which say so; Back and Next still work.
  const canNext = (stepDone[step] || (!config && step !== 'helper')) && !busy;
  const whyNot = busy ? 'Waiting for this to finish…' : WHY[step];
  const leadsTo: SetupStep = step === 'helper' && returnTo ? returnTo : step === 'tools' && picked.length === 0 ? 'project' : SETUP_STEPS[Math.min(index + 1, SETUP_STEPS.length - 1)]!;
  const nextWord = step === 'connect' && areaAt < picked.length - 1 ? toolName(picked[areaAt + 1]!) : STEP_SHORT[leadsTo];
  const tools = areas ? groupAreas(areas) : null;
  const area = picked[areaAt];
  const sub = step === 'connect' && picked.length > 1 ? ` (${areaAt + 1} of ${picked.length})` : '';
  const title = step === 'connect' && area ? `Link ${toolName(area)}${sub}` : STEP_TITLE[step];
  // The preview has no helper to set up, so its scripted guide is ready; anywhere else a helper must be chosen and able to start.
  const ready = client ? helperReady(status) : guide !== undefined;
  const guided = guide !== undefined && GUIDED_STEPS.includes(step);
  return (
    <div className="setup" data-setup={step}>
      <div className="view-head">
        <p className="eyebrow">Setup</p>
        <p className="setup__progress" role="status">
          Step {index + 1} of {SETUP_STEPS.length}
          <progress className="setup__bar" value={index + 1} max={SETUP_STEPS.length} aria-label="Setup progress" />
        </p>
      </div>
      <div className="setup__layout" {...(guided && ready ? { 'data-guided': '' } : {})}>
      <Card as="section" className="panel setup__card" aria-labelledby="setup-title">
        <div className="setup__title">
          <h1 id="setup-title" tabIndex={-1} ref={heading} className="focus-quiet">
            {title}
          </h1>
          <Help topic="setup" />
        </div>
        {guided && !ready && (
          <p className="note setup__offer" data-setup-guide-offer="">
            Set up an AI agent to get explanations here.
            <button type="button" className="btn btn--small" onClick={() => (setReturnTo(step), setStep('helper'))}>
              Set up an AI agent
            </button>
          </p>
        )}
        {step === 'welcome' && <Welcome />}
        {step === 'tools' && (!config ? <NoConfig /> : !tools ? <Loader size="panel" message="Reading the tools toil knows about…" /> : <Tools tools={tools} connections={connections} picked={picked} onPick={(p) => (setPicked(p), p.length > 0 && later('tools', false))} later={skipped.includes('tools')} onLater={(on) => (later('tools', on), on && setPicked([]))} />)}
        {step === 'connect' && config && area && areas && (
          <ConnectOne key={area} config={config} areas={areas} area={area} rows={connections.filter((c) => c.area === area)} known={listed !== false} allNames={connections.map((c) => c.name)} made={made[area] ?? null} onMade={async (name) => (setMade((m) => ({ ...m, [area]: name })), reload())} onDraft={setDraft} onDone={setPageDone} onBusy={setBusy} />
        )}
        {step === 'project' && (config ? <ProjectStep config={config} projects={projects} made={made} existing={connections} picked={picked} chosen={project} onChosen={setProject} reload={reload} later={skipped.includes('project')} onLater={(on) => later('project', on)} onDone={setPageDone} onBusy={setBusy} /> : <NoConfig />)}
        {step === 'fields' && (config ? <FieldsStep onSaved={() => (setFieldsNamed(true), later('fields', false))} later={skipped.includes('fields')} onLater={(on) => later('fields', on)} onBusy={setBusy} config={config} made={made} existing={connections} project={project} projects={projects.map((p) => p.name)} /> : <NoConfig />)}
        {step === 'helper' && <HelperStep agent={agent} status={status} problem={statusProblem} onStatus={setStatus} refresh={readStatus} chosen={helperLabel} onChosen={setHelper} later={skipped.includes('helper')} onLater={(on) => later('helper', on)} onBusy={setBusy} />}
        {step === 'done' && <Done made={made} project={project} helper={helperLabel}onSync={onSync} onLeave={() => keep?.save(null)} />}
        <nav className="setup__nav" aria-label="Setup steps">
          {step !== 'welcome' && (
            <button type="button" className="btn" onClick={back} data-setup-back="">
              Back
            </button>
          )}
          {step !== 'done' && !canNext && step !== 'welcome' && (
            <span id="setup-next-why" className="note setup__why" role="status" data-setup-why="">
              {whyNot}
            </span>
          )}
          {step !== 'done' && (
            <button type="button" className="btn btn--accent" onClick={next} disabled={step !== 'welcome' && !canNext} aria-describedby={step !== 'welcome' && !canNext ? 'setup-next-why' : undefined} data-setup-next="">
              {step === 'welcome' ? 'Start' : `Next: ${nextWord}`}
            </button>
          )}
        </nav>
      </Card>
      {guided && ready && guide && <GuidePanel guide={guide} config={config} state={guideStateOf({ step, areas: picked, area: step === 'connect' ? area : undefined, draft, project })} onRan={() => void reload()} />}
      </div>
    </div>
  );
}

const NoConfig = () => <p className="failure">This app can't change settings here, so there is nothing to set up.</p>;

function Welcome() {
  return (
    <>
      <p>
        <strong>toil</strong> reads the tools your team already uses, such as Jira, GitHub and Azure DevOps, and gives you one picture of the work. <strong>Toil UI</strong> is this page: it shows that picture and lets an AI agent answer questions about it.
      </p>
      <p>This takes a few minutes. If you like, you can start by setting up an AI agent, which then explains each step beside it. Then you will link the tools you use and group them into a Toil project.</p>
      <p className="note" data-setup-promise="">
        Nothing is changed in your tools without you. Every link starts read-only, the optional steps have a Not now choice, and you can come back to this page from the command palette or from Settings.
      </p>
    </>
  );
}

function Tools({ tools, connections, picked, onPick, later, onLater }: { tools: ReturnType<typeof groupAreas>; connections: ConnectionsData['connections']; picked: string[]; onPick: (a: string[]) => void; later: boolean; onLater: (on: boolean) => void }) {
  // A tool picked in the collapsed list opens it, so nothing ticked is out of sight.
  const [moreOpen] = useState(() => tools.more.some((a) => picked.includes(a.name)));
  const toggle = (name: string) => onPick(picked.includes(name) ? picked.filter((p) => p !== name) : [...picked, name]);
  const row = (a: AreaInfo) => {
    const have = connections.filter((c) => c.area === a.name).map((c) => c.name);
    return (
      <li key={a.name} className="setup__tool">
        <label {...(a.description ? { title: a.description } : {})}>
          <input type="checkbox" checked={picked.includes(a.name)} onChange={() => toggle(a.name)} data-setup-tool={a.name} />
          <span>
            <strong>{toolName(a.name)}</strong>
            {have.length > 0 && <span className="tag tag--accent">Already linked: {have.join(', ')}</span>}
          </span>
        </label>
      </li>
    );
  };
  return (
    <fieldset className="setup__tools">
      <legend>Tick every tool you use. You can add more later in Settings.</legend>
      <ul className="plain">{tools.common.map(row)}</ul>
      {tools.more.length > 0 && (
        <details className="more" data-setup-more="" open={moreOpen}>
          <summary>More tools ({tools.more.length})</summary>
          <ul className="plain">{tools.more.map(row)}</ul>
        </details>
      )}
      <div className="setup__tool setup__later">
        <label>
          <input type="checkbox" checked={later} onChange={(e) => onLater(e.target.checked)} data-setup-later="" />
          <span>
            <strong>I'll add tools later</strong>
            <span className="note">Carry on without linking a tool now. You can add them any time in Settings.</span>
          </span>
        </label>
      </div>
    </fieldset>
  );
}

type Mode = 'use' | 'replace' | 'add';

/**
 * One tool's step: first what already exists, read from `connections list`
 * (which says where each value lives and never what it is), then one choice.
 * Use what is there, replace its saved token on purpose, or add another under a
 * name nothing has. Saving over a connection by accident is not on the menu:
 * the form refuses a name that is taken, and Replace has its own tick box.
 * `known` is false when the list could not be read, which is not the same as
 * there being none, so the screen says so.
 */
function ConnectOne({ config, areas, area, rows, known, allNames, made, onMade, onDraft, onDone, onBusy }: { config: ConfigApi; areas: AreaInfo[]; area: string; rows: ConnectionRow[]; known: boolean; allNames: string[]; made: string | null; onMade: (name: string) => Promise<void>; onDraft: (settings: Record<string, string>) => void; onDone: (done: boolean) => void; onBusy: (busy: boolean) => void }) {
  const info = areas.find((a) => a.name === area);
  const secretFields = info?.connection.filter((f) => f.secret) ?? [];
  const states = rows.map((r) => ({ row: r, token: tokenStateOf(info, r) }));
  const good = states.filter((s) => s.token !== 'missing');
  const [target, setTarget] = useState((rows.find((r) => r.isDefault) ?? rows[0])?.name ?? '');
  const [mode, setMode] = useState<Mode | null>(rows.length === 0 ? 'add' : good.length === 1 ? 'use' : null);
  const [tested, setTested] = useState<Outcome | null>(null);
  const [testing, setTesting] = useState(false);
  const current = rows.find((r) => r.name === target) ?? rows[0];
  const name = made ?? (mode === 'use' ? (current?.name ?? null) : null);
  // Using a connection that is already set up is a complete answer; testing it is optional, but Next waits for a test that is running.
  const usable = name !== null;
  useEffect(() => {
    onDone(usable);
    return () => onDone(false);
  }, [usable, onDone]);
  useEffect(() => {
    onBusy(testing);
    return () => onBusy(false);
  }, [testing, onBusy]);
  const test = async () => {
    if (!name) return;
    setTesting(true);
    setTested(null);
    try {
      const e = await config.run('connections test', { name });
      const d = e.ok ? (e.data as ConnectionTestData) : null;
      setTested(outcomeOf(e, d ? (d.live ? testSentence(d, toolName(area)) : `There is no live check for ${toolName(area)}; the settings are complete.`) : ''));
    } catch (e) {
      setTested(failedOutcome(e));
    } finally {
      setTesting(false);
    }
  };
  const canReplace = current !== undefined && !envOnly(current) && states.find((s) => s.row === current)?.token !== 'none';
  const modes = [
    ...(current ? [{ key: 'use', label: `Use ${current.name} (already set up)`, note: 'Keeps everything as it is and goes on to test it.' }] : []),
    ...(canReplace ? [{ key: 'replace', label: `Replace the saved token for ${current.name}`, note: 'Overwrites the token in the secure store on this computer. You confirm before anything is saved.' }] : []),
    ...(current ? [{ key: 'add', label: `Add another ${toolName(area)} connection`, note: 'Under a new name. Nothing existing is touched.' }] : []),
  ];
  return (
    <>
      {config.disabled && (
        <p className="config-off">
          <strong>Changes are turned off.</strong> {config.disabled}
        </p>
      )}
      {!known && (
        <p className="note" data-setup-unknown="">
          <span aria-label="not read yet">–</span> toil couldn't read your existing connections, so this page can't say whether you already have a {toolName(area)} one. A name that is already taken is refused when you save.
        </p>
      )}
      {rows.length > 0 && (
        <section aria-label={`Existing ${toolName(area)} connections`} data-setup-existing="">
          <p>
            You already have {rows.length} {toolName(area)} connection{rows.length === 1 ? '' : 's'}:
          </p>
          <ul className="plain setup__existing">
            {states.map(({ row, token }) => (
              <li key={row.name} data-existing={row.name}>
                <strong>{row.name}</strong>
                {row.isDefault && <span className="tag"> default</span>}
                {row.host && <span className="note"> {row.host}</span>}
                {info && deploymentOf(info, row) && <span className="note"> ({deploymentOf(info, row)})</span>}
                <span className="note" title="In toil: writes"> {row.writes ? 'writes allowed' : 'read only'}</span>
                <span className={`tag tag--${token}`} data-token={token}>
                  {' '}
                  token: {TOKEN_WORD[token]}
                </span>
                {envOnly(row) && <span className="note"> Set outside Toil UI, so it can't be changed here.</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {rows.length > 1 && (
        <SelectField label="Which one" value={current?.name ?? ''} onChange={setTarget} options={rows.map((r) => ({ value: r.name, label: r.name }))} />
      )}
      {rows.length > 0 && !made && <ChoiceRadios label="What would you like to do?" field="existing-mode" selected={mode} onChange={(k) => (setMode(k as Mode), setTested(null))} options={modes} />}
      {(name && (mode === 'use' || made)) ? (
        <div data-setup-linked={name}>
          <p>
            {made ? <>Saved as {made}. <strong>It can only read.</strong></> : <><strong>It can only read</strong> unless you turned writes on.</>} Changes to {toolName(area)} stay off until you turn them on yourself in Settings.
          </p>
          <div className="setup__actions">
            <button type="button" className="btn" onClick={test} disabled={testing} data-setup-test="">
              {testing ? 'Testing…' : 'Test the link'}
            </button>
          </div>
          <OutcomeLine outcome={tested} />
          {!made && canReplace && (
            <p className="note setup__login-help" data-setup-login-help="">
              If the test says the login is missing,
              <button type="button" className="btn btn--small" onClick={() => (setMode('replace'), setTested(null))}>
                Enter the login here
              </button>
            </p>
          )}
        </div>
      ) : mode === 'replace' && current ? (
        <div data-setup-replace={current.name}>
          <p>
            <strong>This replaces the token saved for {current.name}.</strong> The old token can't be recovered from toil.
          </p>
          <LoginForm
            connection={current}
            fields={secretFields}
            config={config}
            confirm={`Yes, replace the saved token for ${current.name}`}
            after={async (e, done) => {
              const o = outcomeOf(e, done);
              if (o.ok) await onMade(current.name);
              return o;
            }}
          />
        </div>
      ) : mode === 'add' ? (
        <>
          <p>
            Fill in where {toolName(area)} lives and your login. The login is typed into a masked box and goes straight to this computer's secure store through toil; it is never kept by this page, never shown again, and never seen by the AI agent or its guide. Changes to {toolName(area)} start <strong>off</strong>.
          </p>
          <h2 className="sr-only">Details for {toolName(area)}</h2>
          <NewConnectionForm areas={areas} config={config} area={area} title={`Link ${toolName(area)}`} suggest={{ name: freeName(area, allNames) }} existingNames={allNames} onAdded={onMade} onDraft={onDraft} />
        </>
      ) : null}
    </>
  );
}

/**
 * Makes a Toil project in the person's own home and records where its code
 * lives. `projects init <name>` writes one file, `<home>/.toil/projects/<name>.json`;
 * each `projects add-repo` adds a path inside that file, so toil can tell which
 * Toil project a folder belongs to. Nothing is written in any folder or
 * repository, and the wizard never passes `--shared`: that would write into a
 * repository, and it is a decision for a team, made on the Toil project page.
 */
function NewProject({ config, link, onChosen, reload, onCreated, jiraKey }: { config: ConfigApi; link: (name: string) => Promise<Outcome>; onChosen: (n: string | null) => void; reload: () => Promise<void>; onCreated: () => void; jiraKey: { value: string; onChange: (v: string) => void } | null }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rows, setRows] = useState<string[]>(['']);
  const [results, setResults] = useState<RepoResult[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const dupes = locationProblems(rows);
  const filled = rows.map((r) => r.trim()).filter((r) => r !== '');
  const retry = async () => {
    const again = await addRepos(config, saved ?? name, results.filter((r) => !r.ok).map((r) => r.location));
    setResults((cur) => cur.map((r) => again.find((a) => a.location === r.location) ?? r));
  };
  return (
    <>
      <h2 className="sr-only">A new Toil project</h2>
      <ChangeForm
        title="Create a Toil project"
        explain="Makes your own Toil project, links the tools you set up to it, and records the folders or repositories you give."
        submit="Create this Toil project"
        disabled={config.disabled}
        blockedBy={name === '' ? 'Name the Toil project first.' : dupes.some(Boolean) ? 'Remove the repeated folder or address first.' : null}
        onSubmit={async () => {
          const e = await config.run('projects init', { name, ...(description ? { description } : {}) });
          const created = outcomeOf(e, `${name} was created.`);
          if (!created.ok) return created;
          setSaved(name);
          const r = await addRepos(config, name, filled);
          setResults(r);
          const l = await link(name);
          onChosen(name);
          await reload();
          if (l.ok) onCreated();
          const bad = r.filter((x) => !x.ok);
          const prefix = `${name} was created.${bad.length ? ` ${bad.length} of ${r.length} folders or addresses were not added, listed below.` : ''}`;
          return l.ok ? { ...l, message: `${prefix} ${l.message}` } : { ...l, message: `${prefix} Linking failed: ${l.message}` };
        }}
      >
        <TextField label="Name" value={name} onChange={setName} required hint="Lowercase letters, digits and single hyphens, e.g. payments." />
        <TextField label="What is it? (optional)" value={description} onChange={setDescription} />
        <fieldset className="repo-list" data-setup-repos="">
          <legend>Folders or repository addresses (optional)</legend>
          {rows.map((value, i) => {
            const kind = locationKind(value);
            return (
              <div key={i} className="repo-row">
                <TextField
                  label={`Folder or address ${i + 1}`}
                  value={value}
                  onChange={(v) => setRows((rs) => rs.map((r, j) => (j === i ? v : r)))}
                  hint={dupes[i] ?? (kind === 'empty' ? undefined : kind === 'address' ? 'Read as a repository address.' : 'Read as a folder. This page cannot see your disk, so it is checked when it is used.')}
                />
                {rows.length > 1 && (
                  <button type="button" className="btn btn--small btn--quiet" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove folder or address ${i + 1}`}>
                    Remove
                  </button>
                )}
              </div>
            );
          })}
          <button type="button" className="btn btn--small" onClick={() => setRows((rs) => [...rs, ''])}>
            Add another
          </button>
          <p className="note" data-setup-repos-help="">
            Lets Toil work out which project you are in from the folder you are working in. Nothing is written to that folder.
          </p>
        </fieldset>
        {jiraKey && <JiraKeyField value={jiraKey.value} onChange={jiraKey.onChange} attr="data-setup-jira-key" />}
        <p className="note" data-setup-writes="">
          Creating it saves one small file of your own on this computer. Nothing is saved in any folder or repository you list; Toil only remembers where they are.
        </p>
      </ChangeForm>
      {saved && (
        <section data-setup-saved="" aria-label="What was saved">
          <h3>What was saved</h3>
          <ul className="plain">
            <li>{saved} was created.</li>
            <li className="note">Nothing in any repository or folder.</li>
          </ul>
          {results.length > 0 && (
            <ul className="plain" data-setup-repo-results="">
              {results.map((r) => (
                <li key={r.location} className={r.ok ? 'note' : 'failure'}>
                  <code>{r.location}</code>: {r.message}
                </li>
              ))}
            </ul>
          )}
          {results.some((r) => !r.ok) && (
            <button type="button" className="btn btn--small" onClick={retry} data-setup-retry="">
              Retry the ones that failed
            </button>
          )}
        </section>
      )}
    </>
  );
}

function ProjectStep({ config, projects, made, existing, picked, chosen, onChosen, reload, later, onLater, onDone, onBusy }: { config: ConfigApi; projects: ListedProject[]; made: Record<string, string>; existing: ConnectionsData['connections']; picked: string[]; chosen: string | null; onChosen: (n: string | null) => void; reload: () => Promise<void>; later: boolean; onLater: (on: boolean) => void; onDone: (done: boolean) => void; onBusy: (busy: boolean) => void }) {
  const [mode, setMode] = useState<string>(later ? '+later' : projects.length > 0 ? (chosen ?? projects[0]!.name) : '+new');
  const [linked, setLinked] = useState<Outcome | null>(null);
  const [linking, setLinking] = useState(false);
  const [created, setCreated] = useState(false);
  // A Toil project chosen on an earlier visit to this step is already linked as far as this page knows.
  const [before] = useState(chosen);
  const [jiraKey, setJiraKey] = useState('');
  // The connection each picked area would use: the one made here, else the first the person already had.
  const links = picked.flatMap((a) => {
    const c = made[a] ?? existing.find((e) => e.area === a)?.name;
    return c ? [{ area: a, connection: c }] : [];
  });
  const hasJira = links.some((l) => l.area === 'jira');
  // A Toil project that is already there is asked what it names: a key is typed only where it names none (`projects link` refuses a different one without --replace, and the refusal would drop the connection too), and a read that failed sends none.
  const existingMode = mode !== '+new' && mode !== '+later';
  const named = useNamedJira(config, existingMode && hasJira && before !== mode ? mode : null);
  const keyToSend = mode === '+new' ? jiraKey : named?.kind === 'none' ? jiraKey : '';
  const linkAll = (toilProject: string): Promise<Outcome> => linkTools(config, toilProject, withJiraKey(links, keyToSend));
  useEffect(() => {
    if (mode === '+later') onChosen(null);
    else if (mode !== '+new') onChosen(mode);
  }, [mode, onChosen]);
  // The page is done when it has a Toil project that is linked to the tools, or Not now.
  const done = mode === '+later' || (mode === '+new' ? created : links.length === 0 || linked?.ok === true || before === mode);
  useEffect(() => {
    onDone(done);
    return () => onDone(false);
  }, [done, onDone]);
  useEffect(() => {
    onBusy(linking);
    return () => onBusy(false);
  }, [linking, onBusy]);
  return (
    <>
      {config.disabled && (
        <p className="config-off">
          <strong>Changes are turned off.</strong> {config.disabled}
        </p>
      )}
      <p>A Toil project is one body of work, such as a product or a team's backlog: the tools it reads from and the repositories it covers.</p>
      <RadioGroup className="agent-adapters" value={mode} aria-label="Which Toil project" onChange={(v) => (setMode(v), setLinked(null), setCreated(false), onLater(v === '+later'), v === '+new' && onChosen(null))}>
        {projects.map((p) => (
          <Radio key={p.name} value={p.name} className="agent-choice">
            <strong>Use {p.name}</strong>
            {p.description && <span className="note">{p.description}</span>}
          </Radio>
        ))}
        <Radio value="+new" className="agent-choice">
          <strong>Create a new Toil project</strong>
        </Radio>
        <Radio value="+later" className="agent-choice">
          <strong>Not now</strong>
          <span className="note">Carry on without one. You can make one later.</span>
        </Radio>
      </RadioGroup>
      {mode === '+later' ? null : mode === '+new' ? (
        <NewProject config={config} link={linkAll} onChosen={onChosen} reload={reload} onCreated={() => setCreated(true)} jiraKey={hasJira ? { value: jiraKey, onChange: setJiraKey } : null} />
      ) : (
        <>
          {named?.kind === 'none' && <JiraKeyField value={jiraKey} onChange={(v) => (setJiraKey(v), setLinked(null))} attr="data-setup-jira-key" />}
          {named && <NamedJiraLine named={named} />}
          {links.length > 0 && (
            <div className="setup__actions">
              <button type="button" className="btn" data-setup-link="" onClick={async () => {
                  setLinking(true);
                  try {
                    setLinked(await linkAll(mode).catch(failedOutcome));
                  } finally {
                    setLinking(false);
                  }
                }} disabled={config.disabled !== null || linking}>
                Link {links.map((l) => toolName(l.area)).join(', ')} to {mode}
              </button>
            </div>
          )}
          <OutcomeLine outcome={linked} />
        </>
      )}
    </>
  );
}

/**
 * The AI agent step, first after the welcome so that the guide can explain the
 * rest. For someone who has never used one: what it is, that it only reads and
 * suggests, and that it runs on the subscription they already have, so no key is
 * stored here. The status is the wizard's own (it also decides whether a guide
 * shows), so Install and Save here and the guide beside later steps agree.
 */
function HelperStep({ agent, status, problem: statusProblem, onStatus, refresh, chosen: savedLabel, onChosen, later, onLater, onBusy }: { agent: AgentSettingsPanelProps | undefined; status: AgentStatus | null; problem: string | null; onStatus: (s: AgentStatus) => void; refresh: () => void; chosen: Chosen; onChosen: (c: Chosen) => void; later: boolean; onLater: (on: boolean) => void; onBusy: (busy: boolean) => void }) {
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState<AdapterStatus | null>(null);
  /** The preview has nothing to save, so a helper chosen there is only remembered by the page. */
  const [previewPick, setPreviewPick] = useState<string | null>(null);
  const client = agent?.client ?? null;
  const problem = saveProblem ?? statusProblem;
  const adapters = client ? (status?.adapters ?? null) : SAMPLE_ADAPTER_STATUS;
  useEffect(() => {
    onBusy(saving);
    return () => onBusy(false);
  }, [saving, onBusy]);
  // What is selected: Not now, else the helper already saved (so coming back shows what is true), else nothing yet.
  const savedName = client ? (status && status.settings.adapter !== 'none' ? status.settings.adapter : '') : (previewPick ?? '');
  const value = later ? '__later' : savedName;
  const choose = async (name: string) => {
    onLater(false);
    setSaveProblem(null);
    if (!client) {
      setPreviewPick(name);
      return onChosen(SAMPLE_ADAPTER_STATUS.find((a) => a.name === name)?.label ?? name);
    }
    if (!status) return;
    const s = status.settings;
    const picked = name as Exclude<typeof s.adapter, 'none'>;
    // Choosing one is saving it: there is no second press.
    setSaving(true);
    try {
      const next = await client.save({ ...s, adapter: picked, model: s.models[picked] ?? null, cliPath: s.cliPaths[picked] ?? null, endpoint: picked === 'claude' ? s.endpoint : null });
      onStatus(next);
      agent?.onChange?.(next);
      onChosen(next.adapters.find((a) => a.name === picked)?.label ?? picked);
    } catch (e) {
      setSaveProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const notNow = () => {
    onLater(true);
    onChosen(null);
    setPreviewPick(null);
  };
  // Said from what the wizard kept, so it is still there after a saved helper remounts the App.
  const saved = !later && savedLabel ? `Saved: ${savedLabel} will answer your questions, and explain the next steps beside them.` : '';
  return (
    <>
      <p>
        An <strong>AI agent</strong> is a program on your computer that can read and write plain sentences, such as Claude, GitHub Copilot or Codex. You may already use one. Set one up now and it can explain each of the next steps, right beside the form, in plain words.
      </p>
      <ul className="plain" data-setup-helper-facts="">
        <li>It only reads and suggests. It can't change anything: a change it suggests waits for you to press Run this.</li>
        <li>It uses the subscription you already have and signs in the way it already does, so Toil UI stores no key.</li>
        <li>It never sees your login. A token goes only in the masked box in the step, never to the agent.</li>
      </ul>
      <p className="note" data-setup-optional="">
        This is optional. Everything else works without one, and you can add it later under Settings, AI agent.
      </p>
      {problem && (
        <p role="alert" className="failure">
          {problem}
        </p>
      )}
      {adapters === null ? (
        !problem && <p className="note">Looking for AI agents on this computer…</p>
      ) : (
        <fieldset className="setup__helpers" data-setup-helpers="">
          <legend>Which AI agent should answer?</legend>
          <ul className="plain">
            {adapters.map((a) => {
              const state = helperState(a);
              return (
                <li key={a.name} className="setup__helper" data-adapter={a.name} data-state={state}>
                  <label className="setup__helper-choice">
                    <input type="radio" name="setup-helper" value={a.name} checked={value === a.name} disabled={state !== 'ready' || saving} onChange={() => void choose(a.name)} />
                    <span>
                      <strong>{a.label}</strong>
                      <span className={state === 'ready' ? 'agent-pick__ready' : 'note'}> {STATE_WORD[state]}</span>
                    </span>
                  </label>
                  {state !== 'ready' && (
                    <p className="note" data-needs-fix={state === 'fix' ? '' : undefined}>
                      {state === 'fix' ? `${a.cli.problem ?? 'Its command-line program was not found.'}${a.cli.fix ? ` ${a.cli.fix}` : ''} ` : ''}
                      It has to be installed and signed in before you can choose it.
                    </p>
                  )}
                  {needsInstall(a) && (
                    <button type="button" className="btn btn--small" onClick={() => setInstalling(a)} data-install={a.name}>
                      Install {a.label}
                    </button>
                  )}
                  <details className="agent-details">
                    <summary>Details for whoever sets it up</summary>
                    {statusLines(a).map((line, i) => (
                      <p key={i} className="note">
                        {line}
                      </p>
                    ))}
                  </details>
                </li>
              );
            })}
            <li className="setup__helper">
              <label className="setup__helper-choice">
                <input type="radio" name="setup-helper" value="__later" checked={value === '__later'} onChange={notNow} disabled={saving} />
                <span>
                  <strong>Not now</strong>
                  <span className="note"> Carry on without an agent.</span>
                </span>
              </label>
            </li>
          </ul>
          <p role="status" className="note">
            {saving ? 'Saving your choice…' : saved}
          </p>
        </fieldset>
      )}
      {installing && <InstallDialog adapter={installing} plan={installing.install} client={client} onClose={() => setInstalling(null)} onInstalled={() => refresh()} />}
    </>
  );
}

function Done({ made, project, helper, onSync, onLeave }: { made: Record<string, string>; project: string | null; helper: Chosen; onSync: (() => void) | undefined; onLeave: () => void }) {
  const names = Object.entries(made);
  return (
    <>
      <ul className="setup__summary" aria-label="What was set up">
        <li>{names.length ? `Linked: ${names.map(([a, n]) => `${toolName(a)} (${n}), read-only`).join(', ')}.` : 'No new tool links this time.'}</li>
        <li>{project ? `Toil project: ${project}.` : 'No Toil project chosen yet.'}</li>
        <li>{helper ? `AI agent: ${helper}.` : 'No AI agent, which is fine.'}</li>
      </ul>
      <p className="note">Nothing in your tools was changed, and changes stay off until you turn them on.</p>
      <div className="setup__actions">
        {onSync && (
          <button type="button" className="btn btn--accent" onClick={onSync} data-setup-sync="">
            Sync now
          </button>
        )}
        <a className="btn" href="#/" onClick={onLeave}>
          Open your Toil projects
        </a>
        <a className="btn" href="#/settings/connections" onClick={onLeave}>
          Settings
        </a>
      </div>
      <p className="note">Sync reads each Toil project once and keeps a copy on this computer, so the pages open instantly.</p>
    </>
  );
}
