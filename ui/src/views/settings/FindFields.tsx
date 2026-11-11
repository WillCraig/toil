/**
 * Find the fields (#561): Jira keeps story points and sprints in custom fields
 * whose ids nobody remembers, and a Toil project can only name what it is told.
 * This reads a few issues with `toil jira field discover` (one of each type, or
 * the issues you name), shows the custom fields that hold a value, and names the
 * ticked ones in the Toil project with `toil projects field`, one call per name,
 * each shown first and each with its own result. The read changes nothing in
 * Jira; naming a field only writes the Toil project's file. Only the fields toil
 * is sure of start ticked. It also saves the Jira project key it sampled from,
 * with `toil projects link`, when the Toil project names none. The same component is the wizard's optional step and
 * the box in Settings, Toil projects. A treasure map where X marks the custom field.
 */

import { useEffect, useMemo, useState } from 'react';
import { RadioGroup, Radio } from 'react-aria-components';
import type { ConfigApi, ConnectionRow } from '../../config.ts';
import { fieldCommands, type FieldPick, type OwiGuess } from '../../../../src/core/field-discovery.ts';
import { DataTable } from '../../components/layout.tsx';
import { Loader } from '../../moments/Moments.tsx';
import { Info, OutcomeLine, SelectField, TextField, failedOutcome, outcomeOf, type Outcome } from './parts.tsx';
import { JIRA_KEY_LABEL, namedJiraProject } from '../project-create.ts';
import './find-fields.css';

/** `jira field discover`'s data, as this page reads it. */
export interface Discovered {
  deployment: string;
  mode: 'sample' | 'issues';
  project: string | null;
  issueTypes: Array<{ name: string; sampled: string[] | null; status: 'sampled' | 'no-sample'; fields: string[] | null }>;
  fields: Array<{ id: string; name: string; schema: { type: string; custom?: string } | null; example: string; issueTypes: string[]; alias: string; owi: OwiGuess | null; note?: string }>;
  commands: string[];
}

const OWI_WORD: Record<OwiGuess['field'], string> = { estimate: 'Story points', iteration: 'Sprint', team: 'Team', dueDate: 'Due date', priority: 'Priority', type: 'Type' };
const ALIAS = /^[a-z][A-Za-z0-9]*$/;

type Reading = { kind: 'idle' } | { kind: 'reading' } | { kind: 'read'; data: Discovered; warnings: string[]; key: string } | { kind: 'failed'; outcome: Outcome };
/** One call the save runs: a name for a field (`projects field`), or the Jira project key the person typed (`projects link`). */
type Planned = { command: 'projects field' | 'projects link'; input: Record<string, unknown>; line: string };
type Result = { line: string; /** What the person sees for it: the name being given. */ label: string; ok: boolean; message: string; fix: string | null };

export interface FindFieldsProps {
  config: ConfigApi;
  /** The Toil projects the names can go in. */
  toilProjects: string[];
  /** The one to use, when the page already knows (the wizard's, the one being edited). */
  toilProject: string | null;
  /** The Jira connections there are. */
  connections: Array<Pick<ConnectionRow, 'name' | 'area'>>;
  /** The connection to read through, when the page already knows. */
  connection?: string | null;
  titleId?: string;
  /** Told when the names are saved, which is what turns the wizard's Next on. */
  onSaved?: (() => void) | undefined;
  /** Told while it is reading or naming, so the wizard keeps Next off until it finishes. */
  onBusy?: ((busy: boolean) => void) | undefined;
}

export function FindFields({ config, toilProjects, toilProject, connections, connection = null, titleId, onSaved, onBusy }: FindFieldsProps) {
  const jira = connections.filter((c) => c.area === 'jira').map((c) => c.name);
  const [project, setProject] = useState(toilProject ?? toilProjects[0] ?? '');
  const [conn, setConn] = useState(connection ?? jira[0] ?? '');
  useEffect(() => {
    if (toilProject) setProject(toilProject);
  }, [toilProject]);
  useEffect(() => {
    if (connection) setConn(connection);
  }, [connection]);
  const [how, setHow] = useState<'auto' | 'keys'>('auto');
  const [jiraProject, setJiraProject] = useState('');
  /** The Jira project the Toil project names: its key, '' for a per-repository map, null for none (a reading that found none), or undefined while that is not read. Unknown is not none. */
  const [named, setNamed] = useState<string | null | undefined>(undefined);
  const [keys, setKeys] = useState('');
  const [reading, setReading] = useState<Reading>({ kind: 'idle' });
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Result[] | null>(null);
  const [saved, setSaved] = useState<{ file: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const working = saving || reading.kind === 'reading';
  useEffect(() => {
    onBusy?.(working);
    return () => onBusy?.(false);
  }, [working, onBusy]);

  // The Jira project the Toil project already names is the one to sample, until the person types another.
  useEffect(() => {
    if (!project) return;
    let live = true;
    setNamed(undefined);
    config.run('projects show', { toilProject: project }).then(
      (e) => {
        // The raw section decides, not the resolved input: a per-repository map that matches no repository resolves to nothing, and still names a project.
        const n = e.ok ? namedJiraProject(e.data) : undefined;
        if (!live) return;
        setNamed(n === undefined ? undefined : n.kind === 'none' ? null : n.kind === 'key' ? n.key : '');
        if (n?.kind === 'key') setJiraProject((now) => now || n.key);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [config, project]);

  const issueKeys = keys.split(/[\s,]+/).filter(Boolean);
  const ready = how === 'auto' ? jiraProject.trim() !== '' : issueKeys.length > 0;

  const read = async () => {
    setReading({ kind: 'reading' });
    setResults(null);
    setSaved(null);
    try {
      const e = await config.run('jira field discover', { ...(conn ? { connection: conn } : {}), ...(how === 'auto' ? { project: jiraProject.trim(), perType: 1 } : { issue: issueKeys }) });
      if (!e.ok) return setReading({ kind: 'failed', outcome: outcomeOf(e, '') });
      const data = e.data as Discovered;
      // Only what toil is sure of starts ticked; the rest is the person's call.
      setTicked(Object.fromEntries(data.fields.map((f) => [f.id, f.owi?.confidence === 'high'])));
      setAliases(Object.fromEntries(data.fields.map((f) => [f.id, f.alias])));
      setReading({ kind: 'read', data, warnings: (e.meta.warnings ?? []).map((w) => w.message), key: how === 'auto' ? jiraProject.trim() : '' });
    } catch (err) {
      setReading({ kind: 'failed', outcome: failedOutcome(err) });
    }
  };

  const data = reading.kind === 'read' ? reading.data : null;
  const picks: FieldPick[] = useMemo(() => (data ? data.fields.filter((f) => ticked[f.id]).map((f) => ({ id: f.id, alias: aliases[f.id] ?? f.alias, ...(f.owi ? { owi: f.owi.field } : {}) })) : []), [data, ticked, aliases]);
  const badAlias = picks.find((p) => !ALIAS.test(p.alias));
  // The key the sample was read from is saved too (never one edited after the read), but only where the Toil project names none: a key it already has is never changed from here.
  const typedKey = reading.kind === 'read' ? reading.key : '';
  const saveKey = project !== '' && typedKey !== '' && named === null;
  const commands: Planned[] = project
    ? [
        ...fieldCommands(project, 'jira', picks).map((c): Planned => ({ command: 'projects field', input: c.input, line: c.line })),
        ...(saveKey ? [{ command: 'projects link' as const, input: { toilProject: project, area: 'jira', set: [`project=${typedKey}`] }, line: `toil projects link ${project} jira --set project=${typedKey}` }] : []),
      ]
    : [];

  const run = async (list: Planned[], earlier: Result[]) => {
    setSaving(true);
    const out: Result[] = [...earlier];
    let file: string | null = saved?.file ?? null;
    for (const c of list) {
      let r: Result;
      try {
        const e = await config.run(c.command, c.input);
        r = e.ok ? { line: c.line, label: labelOf(c), ok: true, message: 'Saved.', fix: null } : { line: c.line, label: labelOf(c), ok: false, message: e.error.message, fix: e.error.fix ?? null };
        if (e.ok && typeof (e.data as { file?: unknown } | null)?.file === 'string') file = (e.data as { file: string }).file;
      } catch (err) {
        r = { line: c.line, label: labelOf(c), ok: false, message: err instanceof Error ? err.message : String(err), fix: null };
      }
      out.push(r);
      setResults([...out]);
    }
    setSaved({ file });
    setSaving(false);
    if (out.length > 0 && out.every((r) => r.ok)) onSaved?.();
  };
  const labelOf = (c: Planned) => (c.command === 'projects link' ? JIRA_KEY_LABEL : String((c.input as { alias?: unknown }).alias ?? 'a field'));
  const failed = results?.filter((r) => !r.ok) ?? [];
  const retry = () => void run(commands.filter((c) => failed.some((f) => f.line === c.line)), (results ?? []).filter((r) => r.ok));

  return (
    <section className="find-fields" aria-label="Find the fields">
      {titleId && (
        <h3 id={titleId} tabIndex={-1}>
          Find the fields
        </h3>
      )}
      <p className="explain">
        Jira keeps story points and sprints in custom fields. Toil reads a few issues and shows the custom fields that hold a value, so you can name them without looking anything up. This only reads Jira, and changes nothing in it.
      </p>
      {jira.length === 0 ? (
        <p className="note">There is no Jira connection yet. Link Jira first, then come back.</p>
      ) : toilProjects.length === 0 ? (
        <p className="note">There is no Toil project to name fields in yet. Create one first.</p>
      ) : (
        <>
          {!toilProject && toilProjects.length > 1 && <SelectField label="Name the fields in" value={project} onChange={setProject} options={toilProjects.map((n) => ({ value: n, label: n }))} />}
          {!connection && jira.length > 1 && <SelectField label="Read from" value={conn} onChange={setConn} options={jira.map((n) => ({ value: n, label: n }))} />}
          <RadioGroup className="agent-adapters" value={how} aria-label="Which issues to read" onChange={(v) => setHow(v === 'keys' ? 'keys' : 'auto')}>
            <Radio value="auto" className="agent-choice">
              <strong>Sample one of each type automatically</strong>
              <span className="note">The most recently updated issue of each type in a Jira project.</span>
            </Radio>
            <Radio value="keys" className="agent-choice">
              <strong>Use issues I pick</strong>
              <span className="note">Paste issue keys, such as PAY-123.</span>
            </Radio>
          </RadioGroup>
          {how === 'auto' ? (
            <TextField label="Jira project key" value={jiraProject} onChange={setJiraProject} required hint={jiraProject.trim() === '' ? 'Type the key of a Jira project, such as PAY, before you press Read the fields. toil needs it to find sample issues. Filled in from the Toil project when it names one.' : 'Filled in from the Toil project when it names one.'} />
          ) : (
            <TextField label="Issue keys" value={keys} onChange={setKeys} hint="Separated by spaces or commas, up to 20." />
          )}
          <div className="setup__actions">
            <button type="button" className="btn btn--accent" onClick={() => void read()} disabled={!ready || reading.kind === 'reading'} data-find-read="">
              {reading.kind === 'reading' ? 'Reading…' : 'Read the fields'}
            </button>
          </div>
          {reading.kind === 'reading' && <Loader size="panel" message={how === 'auto' ? `Reading one issue of each type in ${jiraProject.trim()}…` : `Reading ${issueKeys.length} issue${issueKeys.length === 1 ? '' : 's'}…`} />}
          {reading.kind === 'failed' && <OutcomeLine outcome={reading.outcome} />}
          {data && reading.kind === 'read' && (
            <>
              {reading.warnings.map((w, i) => (
                <p key={i} className="note" role="status">
                  {w}
                </p>
              ))}
              {data.fields.length === 0 && data.issueTypes.every((t) => t.status === 'sampled') && <p>No custom fields hold a value on what toil read.</p>}
              {data.issueTypes.map((t) => (
                <TypeTable key={t.name} type={t} data={data} ticked={ticked} aliases={aliases} onTick={(fid, on) => setTicked((s) => ({ ...s, [fid]: on }))} onAlias={(fid, v) => setAliases((s) => ({ ...s, [fid]: v }))} />
              ))}
              {data.fields.length > 0 && (
                <div className="find-fields__save">
                  <p className="note">{picks.length === 0 ? 'Tick the fields to name.' : `${picks.length} field${picks.length === 1 ? '' : 's'} ticked. Only the ones toil is sure of start ticked.`}</p>
                  {saveKey && (
                    <p className="note" data-find-key="">
                      {project} names no Jira project yet, so naming the fields also saves {typedKey} as its {JIRA_KEY_LABEL}. Toil UI reads Jira issues from it.
                    </p>
                  )}
                  {badAlias && (
                    <p className="failure" role="alert">
                      A name is a camelCase word, such as storyPoints: change “{badAlias.alias}”.
                    </p>
                  )}
                  <div className="setup__actions">
                    <button type="button" className="btn btn--accent" onClick={() => void run(commands, [])} disabled={picks.length === 0 || Boolean(badAlias) || saving || config.disabled !== null} data-find-save="">
                      {saving ? 'Naming…' : 'Name these fields'}
                    </button>
                    {config.disabled && <span className="note">Turned off: {config.disabled}</span>}
                  </div>
                </div>
              )}
              {results && (
                <ul className="plain find-fields__results" aria-label="What happened to each name">
                  {results.map((r) => (
                    <li key={r.line} className={r.ok ? 'any-break' : 'failure any-break'}>
                      {r.label}: {r.ok ? 'saved' : `failed. ${r.message}${r.fix ? ` Fix: ${r.fix}` : ''}`}
                    </li>
                  ))}
                </ul>
              )}
              {saved && !saving && (
                <p role="status" className="find-fields__done" data-find-done="">
                  {results!.filter((r) => r.ok).length} of {results!.length} saved. Nothing was changed in Jira.
                  {failed.length > 0 && (
                    <>
                      {' '}
                      <button type="button" className="btn" onClick={retry} data-find-retry="">
                        Try the failed ones again
                      </button>
                    </>
                  )}
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function TypeTable({ type, data, ticked, aliases, onTick, onAlias }: { type: Discovered['issueTypes'][number]; data: Discovered; ticked: Record<string, boolean>; aliases: Record<string, string>; onTick: (id: string, on: boolean) => void; onAlias: (id: string, v: string) => void }) {
  const rows = data.fields.filter((f) => type.fields?.includes(f.id));
  return (
    <div className="find-fields__type">
      <h4>{type.name}</h4>
      {type.status === 'no-sample' ? (
        <p className="note">No {type.name} issue was found to read, so toil can't say which fields it uses.</p>
      ) : rows.length === 0 ? (
        <p className="note">No custom field holds a value on {type.sampled?.join(', ')}.</p>
      ) : (
        <DataTable
          label={`Custom fields on ${type.name}`}
          caption={`Custom fields that hold a value on ${type.name}, read from ${type.sampled?.join(', ')}`}
          rows={rows}
          rowKey={(f) => f.id}
          columns={[
            { header: 'Name it', label: 'Name it', cell: (f) => <input type="checkbox" checked={ticked[f.id] ?? false} onChange={(e) => onTick(f.id, e.target.checked)} aria-label={`Name ${f.name} in the Toil project`} /> },
            {
              header: 'Field',
              label: 'Field',
              rowHeader: true,
              cell: (f) => (
                <>
                  {f.name} <code>{f.id}</code>
                </>
              ),
            },
            { header: 'Example', label: 'Example', cell: (f) => <span className="any-break">{f.example}</span> },
            {
              header: 'What toil thinks it is',
              label: 'What toil thinks it is',
              cell: (f) =>
                f.owi ? (
                  <>
                    {OWI_WORD[f.owi.field]}, {f.owi.confidence === 'high' ? 'sure' : 'probably'}
                    <Info label={`why toil thinks ${f.name} is ${OWI_WORD[f.owi.field]}`} text={f.owi.why} />
                  </>
                ) : (
                  <>
                    –{f.note && <Info label={`${f.name}`} text={f.note} />}
                  </>
                ),
            },
            { header: 'Its name in toil', label: 'Its name in toil', cell: (f) => <input type="text" className="find-fields__alias" value={aliases[f.id] ?? f.alias} onChange={(e) => onAlias(f.id, e.target.value)} aria-label={`Name for ${f.name} in toil`} autoComplete="off" spellCheck={false} /> },
          ]}
        />
      )}
    </div>
  );
}

/**
 * The setup wizard's optional step: the Jira connection and Toil project the
 * person just linked or chose, so there is nothing to type but the Jira project
 * key. Optional: the page offers a Not now choice that counts as done, and the
 * wizard's Next waits for one of the two.
 */
export function FieldsStep({ config, made, existing, project, projects, onSaved, later, onLater, onBusy }: { onSaved?: (() => void) | undefined; later: boolean; onLater: (on: boolean) => void; onBusy?: ((busy: boolean) => void) | undefined; config: ConfigApi; made: Record<string, string>; existing: Array<Pick<ConnectionRow, 'name' | 'area'>>; project: string | null; projects: string[] }) {
  const connection = made.jira ?? existing.find((c) => c.area === 'jira')?.name ?? null;
  const [choice, setChoice] = useState<'name' | 'later'>(later ? 'later' : 'name');
  return (
    <>
      <p>
        <strong>Recommended.</strong> Naming your story points and sprint fields is what lets the sprint card and burn-up show real numbers. It takes two presses: <strong>Read the fields</strong>, then <strong>Name these fields</strong>.
      </p>
      {!connection ? (
        <p className="note" data-find-none="">
          Jira isn't linked, so there is nothing to read here. Carry on.
        </p>
      ) : !project ? (
        <p className="note" data-find-none="">
          There is no Toil project to name the fields in yet. Carry on, or go Back to choose or create one.
        </p>
      ) : (
        <>
          <RadioGroup className="agent-adapters" value={choice} aria-label="Name your Jira fields now?" onChange={(v) => (setChoice(v === 'later' ? 'later' : 'name'), onLater(v === 'later'))}>
            <Radio value="name" className="agent-choice">
              <strong>Name my Jira fields now</strong>
            </Radio>
            <Radio value="later" className="agent-choice">
              <strong>Not now</strong>
              <span className="note">Do it later under Settings, Toil projects.</span>
            </Radio>
          </RadioGroup>
          {choice === 'name' && <FindFields config={config} toilProjects={projects.includes(project) ? projects : [project, ...projects]} toilProject={project} connections={[{ name: connection, area: 'jira' }]} connection={connection} onSaved={onSaved} onBusy={onBusy} />}
        </>
      )}
    </>
  );
}
