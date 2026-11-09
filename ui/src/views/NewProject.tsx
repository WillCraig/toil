/**
 * The New Toil project wizard (`#/new-project`): four short screens for the one
 * job of making a Toil project, in the setup wizard's own look (one card, a
 * line saying where you are, Back and one primary button that stays off with a
 * plain reason until the page is done, and a Not now on every optional page).
 * It is separate from the first-run wizard on purpose: someone who already has
 * their tools set up should not be dropped into "Step 5 of 7" to name a folder.
 * Name it, say where it lives, tick the tools it reads from, then one press
 * runs `projects init`, `projects add-repo` for each folder and `projects link`
 * for each tool (src/views/project-create.ts), all commands Settings already
 * runs, none with `--shared`. A folder that fails does not undo the project.
 * Nothing is written in any folder or repository. Where it is up to is held by
 * the page above, so a remount does not send it back to the first screen.
 */

import { useEffect, useRef, useState } from 'react';
import type { ConfigApi, ConnectionRow } from '../config.ts';
import { Card } from '../components/layout.tsx';
import { Help } from '../components/help.tsx';
import { Loader } from '../moments/Moments.tsx';
import { toilProjectEditHref, toilProjectHref } from '../format.ts';
import { locationKind, locationProblems, toolName } from '../setup.ts';
import { addRepos, createProject, linkTools, nameProblem, type Created, type RepoResult, type ToolLink } from './project-create.ts';
import { OutcomeLine, TextField, type Outcome } from './settings/parts.tsx';
import './setup.css';

/** Where the wizard lives, and what the Toil projects page, the checklist and the palette open. */
export const NEW_PROJECT_HREF = '#/new-project';

const STEPS = ['name', 'folders', 'tools', 'create'] as const;
type Step = (typeof STEPS)[number];

const TITLE: Record<Step, string> = { name: 'Name it', folders: 'Where does it live? (optional)', tools: 'Which tools does it use?', create: 'Create it' };
/** Each step as the primary button names the one it leads to: "Next: Folders". */
const SHORT: Record<Step, string> = { name: 'Name', folders: 'Folders', tools: 'Tools', create: 'Create it' };

/** Where the wizard is, for the page that holds it (src/local.tsx). Choices and typed words only: no secret passes through here. */
export interface NewProjectProgress {
  step: Step;
  name: string;
  description: string;
  rows: string[];
  foldersLater: boolean;
  /** The connections ticked, or null until the defaults were offered once. */
  picked: string[] | null;
  toolsLater: boolean;
}

export interface NewProjectProps {
  config: ConfigApi | null;
  keep?: { value: NewProjectProgress | null; save(progress: NewProjectProgress | null): void } | undefined;
}

interface ListedProject {
  name: string;
}

/** Toil refuses a link to a connection with writes on unless it is its tool's main one, so the wizard doesn't offer it. */
const linkable = (c: ConnectionRow) => !c.writes || c.isDefault;

/** The connection each area would use by default: its main one, else the first one a link may name. */
function defaultPicks(connections: ConnectionRow[]): string[] {
  const areas = [...new Set(connections.map((c) => c.area))];
  return areas.flatMap((a) => {
    const rows = connections.filter((c) => c.area === a);
    const one = rows.find((r) => r.isDefault) ?? rows.find(linkable);
    return one ? [one.name] : [];
  });
}

export function NewProject({ config, keep }: NewProjectProps) {
  const kept = keep?.value ?? null;
  const [step, setStep] = useState<Step>(kept?.step ?? 'name');
  const [name, setName] = useState(kept?.name ?? '');
  const [description, setDescription] = useState(kept?.description ?? '');
  const [rows, setRows] = useState<string[]>(kept?.rows ?? ['']);
  const [foldersLater, setFoldersLater] = useState(kept?.foldersLater ?? false);
  const [picked, setPicked] = useState<string[] | null>(kept?.picked ?? null);
  const [toolsLater, setToolsLater] = useState(kept?.toolsLater ?? false);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  /** Whether `connections list` was read: an unreadable list is unknown, not empty. */
  const [listed, setListed] = useState<boolean | null>(null);
  const [taken, setTaken] = useState<string[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [failure, setFailure] = useState<Outcome | null>(null);
  const [result, setResult] = useState<{ name: string; links: ToolLink[]; locations: string[]; repos: RepoResult[]; linked: Outcome } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const save = keep?.save;
  useEffect(() => save?.(result ? null : { step, name, description, rows, foldersLater, picked, toolsLater }), [save, result, step, name, description, rows, foldersLater, picked, toolsLater]);
  useEffect(() => heading.current?.focus(), [step, result !== null]);

  useEffect(() => {
    if (!config) return;
    let live = true;
    void Promise.all([config.run('connections list', {}).catch(() => null), config.run('projects list', {}).catch(() => null)]).then(([list, ps]) => {
      if (!live) return;
      setListed(Boolean(list?.ok));
      if (list?.ok) setConnections((list.data as { connections: ConnectionRow[] }).connections);
      if (ps?.ok) setTaken(((ps.data as { toilProjects?: ListedProject[] }).toilProjects ?? []).map((p) => p.name));
    });
    return () => {
      live = false;
    };
  }, [config]);
  // Each area's main connection starts ticked, once, the first time the list shows: nobody should have to find them again.
  useEffect(() => {
    if (picked === null && listed !== null) setPicked(defaultPicks(connections));
  }, [picked, listed, connections]);

  const filled = rows.map((r) => r.trim()).filter((r) => r !== '');
  const dupes = locationProblems(rows);
  const chosen = picked ?? [];
  const links: ToolLink[] = connections.filter((c) => chosen.includes(c.name)).map((c) => ({ area: c.area, connection: c.name }));
  const locations = foldersLater ? [] : filled;
  const toolLinks = toolsLater ? [] : links;
  const problem = nameProblem(name, taken);

  const toggleTool = (c: ConnectionRow) => {
    setToolsLater(false);
    setPicked((p) => {
      const now = p ?? [];
      // A Toil project reads one connection per tool, so ticking another of the same tool swaps it.
      return now.includes(c.name) ? now.filter((n) => n !== c.name) : [...now.filter((n) => connections.find((x) => x.name === n)?.area !== c.area), c.name];
    });
  };

  const off = config?.disabled ?? null;
  const stepDone: Record<Step, boolean> = {
    name: name !== '' && problem === null,
    folders: foldersLater || (filled.length > 0 && !dupes.some(Boolean)),
    tools: toolsLater || chosen.length > 0 || (listed === true && connections.length === 0),
    create: off === null && name !== '',
  };
  const WHY: Record<Step, string> = {
    name: problem ?? 'Name the Toil project first.',
    folders: dupes.some(Boolean) && !foldersLater ? 'Remove the repeated folder or address first.' : 'Enter a folder or address, or choose Not now, first.',
    tools: listed === null ? 'Reading your tools…' : 'Tick a tool, or choose Not now, first.',
    create: off !== null ? 'Changes are turned off, so nothing can be created.' : 'Name the Toil project first.',
  };
  const index = STEPS.indexOf(step);
  const busy = running !== null;
  const canNext = stepDone[step] && !busy;
  const whyNot = busy ? 'Waiting for this to finish…' : WHY[step];
  const next = () => {
    if (step === 'create') return void create();
    setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]!);
  };
  const back = () => {
    setFailure(null);
    setStep(STEPS[Math.max(index - 1, 0)]!);
  };

  const create = async () => {
    if (!config || !canNext) return;
    setFailure(null);
    setRunning(`Creating ${name}…`);
    let done: Created;
    try {
      done = await createProject(config, { name, description: description.trim(), locations, links: toolLinks }, setRunning);
    } finally {
      setRunning(null);
    }
    if (!done.created) return setFailure(done.outcome);
    setResult({ name, links: toolLinks, locations, repos: done.repos, linked: done.linked });
  };

  const retry = async () => {
    if (!config || !result) return;
    setRetrying(true);
    try {
      const again = await addRepos(config, result.name, result.repos.filter((r) => !r.ok).map((r) => r.location));
      const linked = result.linked.ok ? result.linked : await linkTools(config, result.name, result.links);
      setResult((cur) => (cur ? { ...cur, repos: cur.repos.map((r) => again.find((a) => a.location === r.location) ?? r), linked } : cur));
    } finally {
      setRetrying(false);
    }
  };

  const title = result ? `${result.name} was created` : TITLE[step];
  return (
    <div className="setup" data-new-project={result ? 'done' : step}>
      <div className="view-head">
        <p className="eyebrow">New Toil project</p>
        <p className="setup__progress" role="status">
          Step {index + 1} of {STEPS.length}
          <progress className="setup__bar" value={index + 1} max={STEPS.length} aria-label="New Toil project progress" />
        </p>
      </div>
      <Card as="section" className="panel setup__card" aria-labelledby="new-project-title">
        <div className="setup__title">
          <h1 id="new-project-title" tabIndex={-1} ref={heading} className="focus-quiet">
            {title}
          </h1>
          <Help topic="toil-project-setup" />
        </div>
        {!config ? (
          <p className="failure">This app can't change settings here, so a Toil project can't be created.</p>
        ) : result ? (
          <Result result={result} retrying={retrying} onRetry={() => void retry()} />
        ) : (
          <>
            {off && (
              <p className="config-off">
                <strong>Changes are turned off.</strong> {off}
              </p>
            )}
            {step === 'name' && (
              <>
                <p>A Toil project is one body of work, such as a product or a team's backlog: the tools it reads from and the repositories it covers.</p>
                <TextField label="Name" value={name} onChange={setName} required hint={problem ?? 'Lowercase letters, digits and single hyphens, e.g. payments.'} />
                <TextField label="What is it? (optional)" value={description} onChange={setDescription} />
              </>
            )}
            {step === 'folders' && (
              <>
                <fieldset className="repo-list" data-new-project-folders="">
                  <legend>Folders or repository addresses</legend>
                  {rows.map((value, i) => {
                    const kind = locationKind(value);
                    return (
                      <div key={i} className="repo-row">
                        <TextField
                          label={`Folder or address ${i + 1}`}
                          value={value}
                          onChange={(v) => (setFoldersLater(false), setRows((rs) => rs.map((r, j) => (j === i ? v : r))))}
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
                  <p className="note">Lets Toil work out which Toil project you are in from the folder you are working in. Nothing is written to that folder.</p>
                </fieldset>
                <Later checked={foldersLater} onChange={setFoldersLater} note="Carry on without folders. You can add them any time." />
              </>
            )}
            {step === 'tools' && (
              <>
                {listed === null ? (
                  <Loader size="panel" message="Reading your tools…" />
                ) : (
                  <fieldset className="setup__tools" data-new-project-tools="">
                    <legend>Tick the tool links this Toil project reads from.</legend>
                    {listed === false && (
                      <p role="alert" className="failure">
                        <span aria-label="not read yet">–</span> Your tool links couldn't be read, so none can be offered here. Choose Not now, then add them in Settings.
                      </p>
                    )}
                    {listed === true && connections.length === 0 && (
                      <p className="note">
                        You have no tool links yet. <a href="#/settings/connections/+add">Add one in Settings</a> any time.
                      </p>
                    )}
                    <ul className="plain">
                      {connections.map((c) => (
                        <li key={c.name} className="setup__tool">
                          <label>
                            <input type="checkbox" checked={chosen.includes(c.name) && !toolsLater} disabled={!linkable(c)} onChange={() => toggleTool(c)} data-new-project-tool={c.name} />
                            <span>
                              <strong>{toolName(c.area)}</strong>
                              <span className="note">
                                {c.name}
                                {c.isDefault ? ', the main one' : ''}
                                {c.writes ? ', changes allowed' : ', can only read'}
                              </span>
                              {!linkable(c) && (
                                <span className="tag" title="This link allows changes, so it can't be added from here. Link it yourself where you set up your tools.">
                                  Can't link here
                                </span>
                              )}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </fieldset>
                )}
                <Later checked={toolsLater} onChange={setToolsLater} note="Carry on without linking a tool. You can link them any time in Settings." />
              </>
            )}
            {step === 'create' && (
              <>
                <ul className="setup__summary" aria-label="What will be created" data-new-project-summary="">
                  <li>
                    Name: <strong>{name}</strong>
                  </li>
                  <li>{description.trim() ? `What it is: ${description.trim()}.` : 'No description.'}</li>
                  <li>{locations.length ? `Folders and addresses: ${locations.join(', ')}.` : 'No folders or addresses yet.'}</li>
                  <li>{toolLinks.length ? `Tools: ${toolLinks.map((l) => `${toolName(l.area)} through ${l.connection}`).join(', ')}.` : 'No tools linked yet.'}</li>
                </ul>
                <p className="note" data-new-project-writes="">
                  Creating it saves one small file of your own on this computer. Nothing is saved in any folder or repository you list, and each link keeps its own rule on whether it may make changes.
                </p>
                {running && (
                  <p role="status" className="note" data-new-project-progress="">
                    {running}
                  </p>
                )}
                <OutcomeLine outcome={failure} />
              </>
            )}
            <nav className="setup__nav" aria-label="New Toil project steps">
              {step !== 'name' && (
                <button type="button" className="btn" onClick={back} disabled={busy} data-new-project-back="">
                  Back
                </button>
              )}
              {!canNext && (
                <span id="new-project-next-why" className="note setup__why" role="status" data-new-project-why="">
                  {whyNot}
                </span>
              )}
              <button type="button" className="btn btn--accent" onClick={next} disabled={!canNext} aria-describedby={!canNext ? 'new-project-next-why' : undefined} data-new-project-next="">
                {step === 'create' ? (busy ? 'Creating…' : `Create ${name}`) : `Next: ${SHORT[STEPS[index + 1]!]}`}
              </button>
            </nav>
          </>
        )}
      </Card>
    </div>
  );
}

/** The Not now choice on an optional page, drawn like the setup wizard's. */
function Later({ checked, onChange, note }: { checked: boolean; onChange: (on: boolean) => void; note: string }) {
  return (
    <div className="setup__tool setup__later">
      <label>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-new-project-later="" />
        <span>
          <strong>Not now</strong>
          <span className="note">{note}</span>
        </span>
      </label>
    </div>
  );
}

function Result({ result, retrying, onRetry }: { result: { name: string; links: ToolLink[]; locations: string[]; repos: RepoResult[]; linked: Outcome }; retrying: boolean; onRetry: () => void }) {
  const failedRepos = result.repos.filter((r) => !r.ok);
  const needsRetry = failedRepos.length > 0 || !result.linked.ok;
  const jira = result.linked.ok && result.links.some((l) => l.area === 'jira');
  return (
    <>
      <ul className="setup__summary" aria-label="What was saved" data-new-project-saved="">
        <li>{result.name} was created.</li>
        {result.repos.filter((r) => r.ok).length > 0 && <li>Added: {result.repos.filter((r) => r.ok).map((r) => r.location).join(', ')}.</li>}
        {result.linked.ok && <li>{result.linked.message}</li>}
        <li className="note">Nothing in any repository or folder.</li>
      </ul>
      {needsRetry && (
        <div role="alert" className="failure" data-new-project-failures="">
          {failedRepos.length > 0 && (
            <>
              <p>
                {failedRepos.length} of {result.repos.length} folders or addresses were not added. {result.name} itself was created.
              </p>
              <ul className="plain">
                {failedRepos.map((r) => (
                  <li key={r.location}>
                    <code>{r.location}</code>: {r.message}
                  </li>
                ))}
              </ul>
            </>
          )}
          {!result.linked.ok && <p>Linking its tools failed: {result.linked.message}{result.linked.fix ? ` ${result.linked.fix}` : ''}</p>}
        </div>
      )}
      <div className="setup__actions">
        {needsRetry && (
          <button type="button" className="btn" onClick={onRetry} disabled={retrying} data-new-project-retry="">
            {retrying ? 'Retrying…' : failedRepos.length > 0 ? 'Retry the ones that failed' : 'Try linking again'}
          </button>
        )}
        <a className="btn btn--accent" href={toilProjectHref(result.name)} data-new-project-open="">
          Open {result.name}
        </a>
        {jira && (
          <a className="btn" href={toilProjectEditHref(result.name, 'fields')} data-new-project-fields="">
            Name your Jira fields
          </a>
        )}
      </div>
    </>
  );
}
