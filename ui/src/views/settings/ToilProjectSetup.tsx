/**
 * Toil projects (#253, item 4): what `toil projects` builds, from the browser.
 * The list and each toil project's areas come from `projects list` and `toil projects
 * show`; `projects check` checks one without contacting any service. The
 * forms create a toil project and add to one: a repository, an area's connection
 * and keys, a field alias, a person with the identity each system knows them
 * by, and the work-in-progress limit (#292). A toil project holds no secret and can't turn writes
 * on, and toil refuses, from here as over MCP, a link that would point a
 * toil project at a connection with writes on: a person makes that one on the CLI.
 */

import { useCallback, useEffect, useState } from 'react';
import { pairs, type AreaInfo, type ConfigApi, type ConnectionsData } from '../../config.ts';
import type { Envelope } from '../../toil.ts';
import { Card, CardGrid, Cluster, DataTable, Path, Stack, Url } from '../../components/layout.tsx';
import { RepoSetup } from './RepoSetup.tsx';
import { Help, useLandOn } from '../../components/help.tsx';
import { AreaField, ChangeForm, CheckField, OutcomeLine, SelectField, TextField, commandLine, failedOutcome, outcomeOf, type Outcome } from './parts.tsx';
import { Loader } from '../../moments/Moments.tsx';
import { isLensId, lensDef, LENSES, type LensId } from '../../../../src/core/brief/brief.ts';
import { analyzePrompt, AUDIENCES, type Audience, type ToilProjectAnalyze, type FocusSource } from '../../../../src/core/brief/prompt.ts';
import { analyzeSettings } from '../../../../src/core/brief/settings.ts';

interface ListedToilProject {
  name: string;
  description: string | null;
  source: string;
  file: string;
  shadowedBy: string | null;
  problems: number;
}

interface Shown {
  name: string;
  file: string;
  areas: Record<string, { connection: { value: string; source: string } | null; writes: boolean | null; env: string | null; inputs: Record<string, string>; error?: { message: string } }>;
  toilProject: { repos?: Array<{ name: string; path?: string; remotes: string[] }>; people?: Array<{ name: string; kind?: string; email?: string; ids?: Record<string, string> }>; wipLimit?: number };
}

type Loaded<T> = { ok: true; value: T } | { ok: false; message: string };
const fromEnvelope = <T,>(e: Envelope): Loaded<T> => (e.ok ? { ok: true, value: e.data as T } : { ok: false, message: `${e.error.message}${e.error.fix ? ` ${e.error.fix}` : ''}` });

/** An edit link's target (#346): one toil project, and the form for one of its sections. */
export type ToilProjectTarget = { toilProject: string; section: string | null };

/** The form each section's edit link lands on, by its heading's id. */
const SECTION_FORM: Record<string, string> = { sources: 'toil-project-form-sources', repos: 'toil-project-form-repos', fields: 'toil-project-form-fields', people: 'toil-project-form-people', wip: 'toil-project-form-wip', analyze: 'toil-project-form-analyze' };

/** `at`: a toil project's section to land on (#346); `toForm`: Create a toil project, which the first-run checklist opens (#416). */
export function ToilProjectSetup({ config, at, toForm = false }: { config: ConfigApi; at?: ToilProjectTarget; toForm?: boolean }) {
  const [list, setList] = useState<Loaded<{ toilProjects: ListedToilProject[]; places: { user: string } }> | null>(null);
  const [areas, setAreas] = useState<AreaInfo[]>([]);
  const [connections, setConnections] = useState<ConnectionsData['connections']>([]);
  const [selected, setSelected] = useState(at?.toilProject ?? '');
  // A later edit link on the same page (back and forward) chooses its toil project too.
  useEffect(() => {
    if (at?.toilProject) setSelected(at.toilProject);
  }, [at?.toilProject]);
  const reload = useCallback(async () => {
    try {
      setList(fromEnvelope(await config.run('projects list', {})));
    } catch (e) {
      setList({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }, [config]);
  useEffect(() => {
    void reload();
    config.areas().then(setAreas, () => setAreas([]));
    config.run('connections list', {}).then(
      (e) => e.ok && setConnections((e.data as ConnectionsData).connections),
      () => {},
    );
  }, [config, reload]);

  // The form takes focus once the list has loaded and the toil project is chosen; with no section, the toil project picker does.
  const found = Boolean(at && list?.ok && list.value.toilProjects.some((d) => d.name === at.toilProject));
  useLandOn(toForm ? 'toil-project-change' : at ? (found ? (SECTION_FORM[at.section ?? ''] ?? 'toil-project-change') : 'toil-project-change') : null, Boolean(list));
  if (!list) return <Loader size="panel" message="Reading your Toil projects with toil projects list…" />;
  if (!list.ok) {
    return (
      <div role="alert" className="failure">
        <p>
          <code>toil projects list</code> failed: {list.message}
        </p>
      </div>
    );
  }
  const toilProjects = list.value.toilProjects;
  const target = toilProjects.find((d) => d.name === selected)?.name ?? toilProjects[0]?.name ?? '';

  return (
    <>
      <RepoSetup config={config} areas={areas} onChanged={reload} />
      <Card as="section" className="panel" aria-labelledby="toil-project-list">
        <h2 id="toil-project-list">Your Toil projects</h2>
        <p className="lede">
          From <code>toil projects list</code>; yours are in <Path value={list.value.places.user} what="folder path" />. <Help topic="toil-project-list" />
        </p>
        {toilProjects.length === 0 ? (
          <p>toil sees no Toil projects yet. Create one below.</p>
        ) : (
          <CardGrid min="lg" className="conn-cards">
            {toilProjects.map((d) => (
              <li key={d.file}>
                <ToilProjectCard toilProject={d} config={config} />
              </li>
            ))}
          </CardGrid>
        )}
      </Card>
      <Card as="section" className="panel" aria-labelledby="toil-project-change">
        <h2 id="toil-project-change" tabIndex={-1}>
          Create or change a Toil project
        </h2>
        <p className="lede">
          Each form runs one <code>toil projects</code> command. <Help topic="toil-project-setup" />
        </p>
        {at && list.ok && !found && (
          <p role="status" className="failure">
            toil sees no Toil project named <code>{at.toilProject}</code>. It may have been removed or renamed; create it again below.
          </p>
        )}
        <InitForm config={config} onChanged={reload} />
        {toilProjects.length > 0 && (
          <>
            <SelectField label="Toil project to change" value={target} onChange={setSelected} options={toilProjects.map((d) => ({ value: d.name, label: `${d.name} (${d.source})` }))} hint="The forms below change this one." />
            <AddRepoForm config={config} toilProject={target} />
            <LinkForm config={config} toilProject={target} areas={areas} connections={connections} />
            <FieldForm config={config} toilProject={target} areas={areas} />
            <PersonForm config={config} toilProject={target} areas={areas} />
            <WipLimitForm config={config} toilProject={target} />
            <AnalyzeForm config={config} toilProject={target} />
          </>
        )}
      </Card>
    </>
  );
}

function ToilProjectCard({ toilProject: d, config }: { toilProject: ListedToilProject; config: ConfigApi }) {
  const [shown, setShown] = useState<Loaded<Shown> | null>(null);
  const [checked, setChecked] = useState<Outcome | null>(null);
  const [problems, setProblems] = useState<Array<{ level: string; path: string; message: string }>>([]);
  const titleId = `toil-project-card-${d.name}`;
  const show = async () => {
    if (shown) return setShown(null);
    try {
      setShown(fromEnvelope<Shown>(await config.run('projects show', { toilProject: d.name })));
    } catch (e) {
      setShown({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  };
  const check = async () => {
    setChecked(null);
    try {
      const e = await config.run('projects check', { toilProject: d.name });
      const data = e.ok ? (e.data as { ok: boolean; problems: Array<{ level: string; path: string; message: string }> }) : null;
      setProblems(data?.problems ?? []);
      setChecked(data && !data.ok ? { ok: false, message: `${d.name} has problems toil would refuse it for.`, fix: null } : outcomeOf(e, data?.problems.length ? `${d.name} checks out, with ${data.problems.length} warning${data.problems.length === 1 ? '' : 's'}.` : `${d.name} checks out: no problems.`));
    } catch (e) {
      setChecked(failedOutcome(e));
    }
  };
  return (
    <Card className="conn-card" aria-labelledby={titleId}>
      <div className="conn-head">
        <h3 id={titleId}>
          <code>{d.name}</code>
        </h3>
        <ul className="conn-tags" aria-label="About this Toil project">
          <li className="tag">{d.source}</li>
          {d.problems > 0 && <li className="tag tag--warn">{d.problems} problem{d.problems === 1 ? '' : 's'}</li>}
        </ul>
      </div>
      {d.description && <p>{d.description}</p>}
      <p className="note">
        <Path value={d.file} what={`${d.name}'s file path`} />
        {d.shadowedBy && <> (a Toil project of the same name in {d.shadowedBy} takes precedence)</>}
      </p>
      <Cluster className="conn-actions">
        <button type="button" className="btn" aria-expanded={shown !== null} onClick={show}>
          {shown ? 'Hide' : 'Show'}
        </button>
        <button type="button" className="btn" onClick={check}>
          Check
        </button>
      </Cluster>
      <OutcomeLine outcome={checked} />
      {problems.length > 0 && (
        <ul className="plain">
          {problems.map((p, i) => (
            <li key={i} className={p.level === 'error' ? 'failure' : 'note'}>
              {p.level}: <code>{p.path}</code> {p.message}
            </li>
          ))}
        </ul>
      )}
      {shown && !shown.ok && (
        <p role="alert" className="failure">
          <code>toil projects show {d.name}</code> failed: {shown.message}
        </p>
      )}
      {shown?.ok && <ShownToilProject shown={shown.value} />}
    </Card>
  );
}

function ShownToilProject({ shown }: { shown: Shown }) {
  const areas = Object.entries(shown.areas);
  const repos = shown.toilProject.repos ?? [];
  return (
    <Stack className="shown" gap="sm">
      <DataTable
        label={`What ${shown.name} gives each area`}
        caption={`What ${shown.name} gives each area`}
        rows={areas}
        rowKey={([area]) => area}
        columns={[
          { header: 'Area', label: 'Area', rowHeader: true, cell: ([area]) => area },
          { header: 'Connection', label: 'Connection', cell: ([, a]) => (a.error ? <span className="failure">{a.error.message}</span> : a.connection ? `${a.connection.value} (${a.connection.source})` : 'Your default') },
          { header: 'Writes', label: 'Writes', cell: ([, a]) => (a.writes === null ? '–' : a.writes ? 'On' : 'Off') },
          {
            header: 'Inputs',
            label: 'Inputs',
            cell: ([, a]) => (
              <>
                {Object.entries(a.inputs)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(', ') || 'None'}
                {a.env && <span className="note"> (environment {a.env})</span>}
              </>
            ),
          },
        ]}
      />
      <h4 className="shown-repos">People</h4>
      {shown.toilProject.people?.length ? (
        <ul className="plain">
          {shown.toilProject.people.map((p) => (
            <li key={p.name} className="any-break">
              {p.name}
              {p.kind === 'agent' && ' (agent)'}
              <span className="note">
                {' '}
                {Object.entries(p.ids ?? {})
                  .map(([area, id]) => `${area} ${id}`)
                  .join(', ') || 'no identities yet'}
                {p.email && `; email ${p.email}`}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">None yet.</p>
      )}
      <p className="note">Work-in-progress limit: {shown.toilProject.wipLimit === undefined ? 'none set' : `${shown.toilProject.wipLimit} per person`}.</p>
      <h4 className="shown-repos">Repositories</h4>
      {repos.length ? (
        <ul className="plain">
          {repos.map((r) => (
            <li key={r.name}>
              {r.name}
              {r.remotes[0] && (
                <>
                  {' '}
                  <Url value={r.remotes[0]} what={`${r.name}'s remote URL`} />
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">None yet.</p>
      )}
    </Stack>
  );
}

function InitForm({ config, onChanged }: { config: ConfigApi; onChanged: () => Promise<void> }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  return (
    <ChangeForm
      title="Create a Toil project"
      explain="Makes an empty Toil project for one body of work in your own folder (~/.toil/projects/<name>.json). Add its repositories and areas with the forms below. It refuses a name you already have."
      runs={commandLine('projects init', [name || '<name>', ...(description ? ['--description', '…'] : [])])}
      submit="Create Toil project"
      disabled={config.disabled}
      onSubmit={async () => {
        const e = await config.run('projects init', { name, ...(description ? { description } : {}) });
        const outcome = outcomeOf(e, `${name} was created.`);
        if (outcome.ok) {
          setName('');
          setDescription('');
          await onChanged();
        }
        return outcome;
      }}
    >
      <TextField label="Name" value={name} onChange={setName} required hint="Lowercase letters, digits and single hyphens, e.g. payments." />
      <TextField label="Description" value={description} onChange={setDescription} hint="One line saying what the body of work is." />
    </ChangeForm>
  );
}

function AddRepoForm({ config, toilProject }: { config: ConfigApi; toilProject: string }) {
  const [location, setLocation] = useState('');
  const [name, setName] = useState('');
  const [replace, setReplace] = useState(false);
  return (
    <ChangeForm
      titleId="toil-project-form-repos"
      title={`Add a repository to ${toilProject}`}
      explain="Records a repository by its remote URL, or by a folder on this machine (its git root and origin remote). Any credential in a remote is left out of the file. toil then picks this Toil project for calls made in that repository."
      runs={commandLine('projects add-repo', [toilProject, location || '<folder|remote>', ...(name ? ['--name', name] : []), ...(replace ? ['--replace'] : [])])}
      submit="Add repository"
      disabled={config.disabled}
      onSubmit={async () => outcomeOf(await config.run('projects add-repo', { toilProject, location, ...(name ? { name } : {}), ...(replace ? { replace } : {}) }), `The repository was added to ${toilProject}.`)}
    >
      <TextField label="Folder or remote URL" value={location} onChange={setLocation} required hint={<>e.g. <span className="any-break">https://git.imagile.dev/pay/payments-api.git</span></>} />
      <TextField label="Name in the Toil project" value={name} onChange={setName} hint="Defaults to the folder's or remote's last part." />
      <CheckField label="Replace a repository of that name" checked={replace} onChange={setReplace} />
    </ChangeForm>
  );
}

function LinkForm({ config, toilProject, areas, connections }: { config: ConfigApi; toilProject: string; areas: AreaInfo[]; connections: ConnectionsData['connections'] }) {
  const [area, setArea] = useState('');
  const [connection, setConnection] = useState('');
  const [set, setSet] = useState('');
  const [add, setAdd] = useState('');
  const [replace, setReplace] = useState(false);
  const names = areas.map((a) => a.name);
  const chosen = names.includes(area) ? area : (names.includes('jira') ? 'jira' : names[0] ?? '');
  const ofArea = connections.filter((c) => c.area === chosen);
  const args = [toilProject, chosen, ...(connection ? ['--connection', connection] : []), ...pairs(set).flatMap((p) => ['--set', p]), ...pairs(add).flatMap((p) => ['--add', p]), ...(replace ? ['--replace'] : [])];
  return (
    <ChangeForm
      titleId="toil-project-form-sources"
      title={`Link an area to ${toilProject}`}
      explain="Attaches an area to the Toil project: which of your connections its calls use (or your default), the keys it supplies to every call (project=PAY), and reference data lists (projects=FEES). toil refuses, from here, a link that would point the Toil project at a connection with writes on: a person makes that one with toil projects link in a terminal."
      runs={commandLine('projects link', args)}
      submit="Link area"
      disabled={config.disabled}
      onSubmit={async () =>
        outcomeOf(
          await config.run('projects link', { toilProject, area: chosen, ...(connection ? { connection } : {}), ...(pairs(set).length ? { set: pairs(set) } : {}), ...(pairs(add).length ? { add: pairs(add) } : {}), ...(replace ? { replace } : {}) }),
          `${chosen} was linked to ${toilProject}.`,
        )
      }
    >
      <SelectField label="Area" value={chosen} onChange={(v) => (setArea(v), setConnection(''))} options={names.map((n) => ({ value: n, label: n }))} />
      <SelectField label="Connection" value={connection} onChange={setConnection} options={[{ value: '', label: `Your ${chosen} default` }, ...ofArea.map((c) => ({ value: c.name, label: `${c.name}${c.writes ? ' (writes on)' : ''}` }))]} />
      <AreaField label="Keys to set, one key=value per line" value={set} onChange={setSet} hint="The area's context inputs (project=PAY, owner=imagile) are applied to calls; any other key is kept as reference data." />
      <AreaField label="Values to add to lists, one key=value per line" value={add} onChange={setAdd} hint="e.g. projects=FEES" />
      <CheckField label="Replace values already set" checked={replace} onChange={setReplace} />
    </ChangeForm>
  );
}

function PersonForm({ config, toilProject, areas }: { config: ConfigApi; toilProject: string; areas: AreaInfo[] }) {
  const [name, setName] = useState('');
  const [ids, setIds] = useState('');
  const [kind, setKind] = useState<'human' | 'agent'>('human');
  const [email, setEmail] = useState('');
  const [replace, setReplace] = useState(false);
  const list = pairs(ids);
  const args = [toilProject, name ? (/\s/.test(name) ? `"${name}"` : name) : '<name>', ...list.flatMap((p) => ['--id', p]), ...(kind === 'agent' ? ['--kind', 'agent'] : []), ...(email ? ['--email', email] : []), ...(replace ? ['--replace'] : [])];
  return (
    <ChangeForm
      titleId="toil-project-form-people"
      title={`Add a person to ${toilProject}`}
      explain={
        <>
          Says who someone is in each system, so the People view gathers their work from all of them: one area=identity per line, the user name, login or email that system shows. An agent is a person of kind agent. Their email is only compared, to suggest which accounts are theirs. Removing a person or an identity is a delete, made in a terminal with <code>toil projects person {toilProject} &lt;name&gt; --remove</code>.
        </>
      }
      runs={commandLine('projects person', args)}
      submit="Add person"
      disabled={config.disabled}
      onSubmit={async () => {
        const outcome = outcomeOf(
          await config.run('projects person', { toilProject, name, ...(list.length ? { id: list } : {}), ...(kind === 'agent' ? { kind } : {}), ...(email ? { email } : {}), ...(replace ? { replace } : {}) }),
          `${name} is in ${toilProject}'s people.`,
        );
        if (outcome.ok) {
          setName('');
          setIds('');
          setEmail('');
        }
        return outcome;
      }}
    >
      <TextField label="Name" value={name} onChange={setName} required hint="As the team writes it, e.g. Pat Example." />
      <AreaField label="Identities, one area=identity per line" value={ids} onChange={setIds} hint={<>e.g. jira=pat and github=pat-ex. Areas: {areas.map((a) => a.name).join(', ') || 'the ones toil has'}.</>} />
      <SelectField label="Kind" value={kind} onChange={(v) => setKind(v === 'agent' ? 'agent' : 'human')} options={[{ value: 'human', label: 'Person' }, { value: 'agent', label: 'Agent' }]} />
      <TextField label="Email" value={email} onChange={setEmail} hint="Optional, e.g. you@example.com. Compared only, to suggest matches." />
      <CheckField label="Replace an identity, kind or email already set" checked={replace} onChange={setReplace} />
    </ChangeForm>
  );
}

function WipLimitForm({ config, toilProject }: { config: ConfigApi; toilProject: string }) {
  const [limit, setLimit] = useState('');
  const [replace, setReplace] = useState(false);
  const n = Number(limit);
  return (
    <ChangeForm
      titleId="toil-project-form-wip"
      title={`Set ${toilProject}'s work-in-progress limit`}
      explain={
        <>
          How many items one person may have in progress at once, as the team agreed. The People view counts each person's work in progress against it, and names nobody else's. Clearing it is a delete, made in a terminal with <code>toil projects wip-limit {toilProject} --clear</code>.
        </>
      }
      runs={commandLine('projects wip-limit', [toilProject, limit || '<limit>', ...(replace ? ['--replace'] : [])])}
      submit="Set limit"
      disabled={config.disabled}
      onSubmit={async () => {
        if (!Number.isInteger(n) || n < 1) return { ok: false, message: 'The limit must be a whole number above 0.', fix: 'Type a number such as 3.' };
        return outcomeOf(await config.run('projects wip-limit', { toilProject, limit: n, ...(replace ? { replace } : {}) }), `${toilProject}'s limit is ${n} per person.`);
      }}
    >
      <TextField label="Limit" value={limit} onChange={setLimit} required hint="A whole number, e.g. 3." />
      <CheckField label="Replace a limit already set" checked={replace} onChange={setReplace} />
    </ChangeForm>
  );
}

/**
 * How Analyze briefs a toil project (#494): its goal, reader, lenses and focus,
 * saved with `toil projects analyze set`, and beside it the prompt as Analyze
 * will send it, composed by toil's own code as you type. Clearing a setting is
 * a delete, made in a terminal.
 */
function AnalyzeForm({ config, toilProject }: { config: ConfigApi; toilProject: string }) {
  type Loaded = { analyze: ToilProjectAnalyze | null; wipLimit: number | null; from: FocusSource; draft: Draft };
  const [shown, setShown] = useState<Loaded | { error: Outcome } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [replace, setReplace] = useState(false);
  useEffect(() => {
    let live = true;
    config.run('projects show', { toilProject }).then(
      (e) => {
        if (!live) return;
        if (!e.ok) return setShown({ error: outcomeOf(e, '') });
        const d = e.data as { source: string; file: string; adopted: boolean; repo?: string | null; toilProject: { analyze?: ToilProjectAnalyze; wipLimit?: number } };
        const a = d.toilProject.analyze ?? null;
        const first = draftOf(a, d.toilProject.wipLimit ?? null);
        setShown({ analyze: a, wipLimit: d.toilProject.wipLimit ?? null, from: { toilProject, file: d.file, source: d.source, adopted: d.adopted, repo: d.source === 'repo' ? d.file.replace(/\/\.toil\/toilProjects\/[^/]+$/, '') : null }, draft: first });
        setDraft(first);
      },
      (err: unknown) => live && setShown({ error: failedOutcome(err) }),
    );
    return () => {
      live = false;
    };
  }, [config, toilProject]);
  if (shown && 'error' in shown) {
    return (
      <section aria-labelledby="toil-project-form-analyze" className="change-form">
        <h3 id="toil-project-form-analyze">How Analyze briefs {toilProject}</h3>
        <OutcomeLine outcome={shown.error} />
      </section>
    );
  }
  const d = draft ?? draftOf(null, null);
  const set = (change: Partial<Draft>) => setDraft({ ...d, ...change });
  const ids = d.order.split(',').map((s) => s.trim()).filter(isLensId);
  // Only what changed from the toil project as loaded is sent, so a later save works and anything untouched keeps following the standard.
  const input = shown ? changedInput(toilProject, shown.draft, d, ids, replace) : { toilProject };
  const preview = shown ? analyzePrompt(analyzeSettings(draftAnalyze(d, ids), shown.wipLimit), shown.from, 'toil-ui') : null;
  return (
    <ChangeForm
      titleId="toil-project-form-analyze"
      title={`How Analyze briefs ${toilProject}`}
      explain={
        <>
          What Analyze looks for, and what the work is for; anything you leave follows the standard. <Help topic="analyze-settings" />
        </>
      }
      runs={commandLine('projects analyze set', inputArgs(input))}
      submit="Save Analyze settings"
      disabled={config.disabled ?? (shown ? null : 'Reading the Toil project…')}
      onSubmit={async () => (Object.keys(input).length <= 1 ? { ok: true, message: 'Nothing changed, so nothing was saved.', warnings: [] } : outcomeOf(await config.run('projects analyze set', input), `${toilProject}'s Analyze settings are saved.`))}
    >
      <TextField label="Goal of this work" value={d.goal} onChange={(goal) => set({ goal })} hint="One line. Analyze weighs everything against it." />
      <SelectField label="Written for" value={d.audience} onChange={(v) => set({ audience: AUDIENCES.includes(v as Audience) ? (v as Audience) : 'lead' })} options={[{ value: 'lead', label: 'A team lead' }, { value: 'engineer', label: 'An engineer on the team' }, { value: 'stakeholder', label: 'Someone outside the team' }]} />
      <TextField label="Lenses, most important first" value={d.order} onChange={(order) => set({ order })} hint={`Lens ids separated by commas: ${LENSES.map((l) => l.id).join(', ')}.`} />
      <details className="analyze-lenses">
        <summary>
          Lenses ({ids.filter((id) => !d.off.includes(id)).length} of {ids.length} on)
        </summary>
        {ids.map((id) => {
          const def = lensDef(id);
          return (
            <Cluster key={id}>
              <CheckField label={`${def.label}: ${def.test(Number(d.thresholds[id]) || def.threshold, shown?.wipLimit ?? null)}`} checked={!d.off.includes(id)} onChange={(on) => set({ off: on ? d.off.filter((o) => o !== id) : [...d.off, id] })} />
              {def.unit && <TextField label={`${def.label} after, in ${def.unit}`} value={d.thresholds[id] ?? ''} onChange={(v) => set({ thresholds: { ...d.thresholds, [id]: v } })} />}
            </Cluster>
          );
        })}
      </details>
      <AreaField label="Also watch for" value={d.watchFor} onChange={(watchFor) => set({ watchFor })} rows={2} hint="One line, up to 1000 characters." />
      <AreaField label="Leave out" value={d.leaveOut} onChange={(leaveOut) => set({ leaveOut })} rows={2} hint="One line. The briefing lists what this hid." />
      <CheckField label="Replace settings already there" checked={replace} onChange={setReplace} />
      {preview && (
        <details className="analyze-preview">
          <summary>The prompt Analyze will send</summary>
          <pre className="analyze-preview__text" tabIndex={0} aria-label="The prompt Analyze will send">
            {preview}
          </pre>
          <p className="note">After toil's rules and before your own instructions and voice from Settings → Agent.</p>
        </details>
      )}
    </ChangeForm>
  );
}

/** The form's fields, as text: what's loaded, and what's typed. */
interface Draft {
  goal: string;
  audience: Audience;
  order: string;
  off: LensId[];
  thresholds: Record<string, string>;
  watchFor: string;
  leaveOut: string;
}

function draftOf(a: ToilProjectAnalyze | null, wipLimit: number | null): Draft {
  const s = analyzeSettings(a ?? undefined, wipLimit);
  return {
    goal: a?.goal ?? '',
    audience: s.audience,
    order: s.settings.lenses.map((l) => l.id).join(', '),
    off: s.settings.lenses.filter((l) => !l.on).map((l) => l.id),
    thresholds: Object.fromEntries(s.settings.lenses.filter((l) => l.threshold !== null).map((l) => [l.id, String(l.threshold)])),
    watchFor: a?.watchFor ?? '',
    leaveOut: a?.leaveOut ?? '',
  };
}

/** The draft as a toil project would hold it, for the preview. */
function draftAnalyze(d: Draft, ids: LensId[]): ToilProjectAnalyze {
  return {
    ...(d.goal.trim() ? { goal: d.goal.trim() } : {}),
    audience: d.audience,
    lenses: ids.map((id) => ({ id, on: !d.off.includes(id), ...(lensDef(id).unit && Number(d.thresholds[id]) > 0 ? { threshold: Number(d.thresholds[id]) } : {}) })),
    ...(d.watchFor.trim() ? { watchFor: d.watchFor.trim() } : {}),
    ...(d.leaveOut.trim() ? { leaveOut: d.leaveOut.trim() } : {}),
  };
}

/** `projects analyze set`'s input: only what differs from the toil project as loaded. */
function changedInput(toilProject: string, was: Draft, d: Draft, ids: LensId[], replace: boolean): Record<string, unknown> {
  const lensesChanged = was.order !== d.order || was.off.join() !== d.off.join() || JSON.stringify(was.thresholds) !== JSON.stringify(d.thresholds);
  return {
    toilProject,
    ...(d.goal.trim() && d.goal !== was.goal ? { goal: d.goal.trim() } : {}),
    ...(d.audience !== was.audience ? { audience: d.audience } : {}),
    ...(lensesChanged
      ? {
          order: ids.join(','),
          on: ids.filter((id) => !d.off.includes(id) && was.off.includes(id)),
          off: ids.filter((id) => d.off.includes(id) && !was.off.includes(id)),
          threshold: ids.filter((id) => lensDef(id).unit && d.thresholds[id] && d.thresholds[id] !== was.thresholds[id]).map((id) => `${id}=${d.thresholds[id]}`),
        }
      : {}),
    ...(d.watchFor.trim() && d.watchFor !== was.watchFor ? { watchFor: d.watchFor.trim() } : {}),
    ...(d.leaveOut.trim() && d.leaveOut !== was.leaveOut ? { leaveOut: d.leaveOut.trim() } : {}),
    ...(replace ? { replace } : {}),
  };
}

/** The input as `toil projects analyze set`'s arguments, so the line under the form is the one Save runs. */
function inputArgs(input: Record<string, unknown>): string[] {
  const flag: Record<string, string> = { goal: '--goal', audience: '--audience', order: '--order', on: '--on', off: '--off', threshold: '--threshold', watchFor: '--watch-for', leaveOut: '--leave-out', replace: '--replace' };
  const out = [String(input.toilProject)];
  for (const [key, value] of Object.entries(input)) {
    if (key === 'toilProject' || !flag[key]) continue;
    if (value === true) out.push(flag[key]!);
    else if (Array.isArray(value)) for (const v of value) out.push(flag[key]!, String(v));
    else out.push(flag[key]!, String(value));
  }
  return out;
}

function FieldForm({ config, toilProject, areas }: { config: ConfigApi; toilProject: string; areas: AreaInfo[] }) {
  const [area, setArea] = useState('');
  const [alias, setAlias] = useState('');
  const [id, setId] = useState('');
  const [replace, setReplace] = useState(false);
  const names = areas.map((a) => a.name);
  const chosen = names.includes(area) ? area : (names.includes('jira') ? 'jira' : names[0] ?? '');
  return (
    <ChangeForm
      titleId="toil-project-form-fields"
      title={`Name a field in ${toilProject}`}
      explain="Gives one of the area's fields a friendly name in this Toil project (storyPoints for customfield_10002), so commands and Toil UI's work items use the name. The OWI fields estimate, priority, type, team and dueDate are pointed at a team's own field the same way."
      runs={commandLine('projects field', [toilProject, chosen, alias || '<alias>', id || '<field-id>', ...(replace ? ['--replace'] : [])])}
      submit="Name field"
      disabled={config.disabled}
      onSubmit={async () => outcomeOf(await config.run('projects field', { toilProject, area: chosen, alias, id, ...(replace ? { replace } : {}) }), `${alias} now names ${id} in ${toilProject}.`)}
    >
      <SelectField label="Area" value={chosen} onChange={setArea} options={names.map((n) => ({ value: n, label: n }))} />
      <TextField label="Alias" value={alias} onChange={setAlias} required hint="A camelCase name, e.g. storyPoints or estimate." />
      <TextField label="Field id" value={id} onChange={setId} required hint="The service's own id, e.g. customfield_10002." />
      <CheckField label="Point an existing alias at this field" checked={replace} onChange={setReplace} />
    </ChangeForm>
  );
}
