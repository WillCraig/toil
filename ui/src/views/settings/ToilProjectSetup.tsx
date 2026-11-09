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
import { Card, CardGrid, Cluster, DataTable, Stack, Url } from '../../components/layout.tsx';
import { RepoSetup } from './RepoSetup.tsx';
import { FindFields } from './FindFields.tsx';
import { toilProjectEditHref } from '../../format.ts';
import { areaLabel, toolName } from '../../setup.ts';
import { CardMenu } from '../../components/card-menu.tsx';
import { usePlain } from '../../plain-words.ts';
import { ArchiveNoticeLine, ArchivedDisclosure, type ArchiveNotice } from '../../components/archive.tsx';
import { Help, useLandOn } from '../../components/help.tsx';
import { AreaField, ChangeForm, CheckField, Info, OutcomeLine, SelectField, TextField, failedOutcome, outcomeOf, type Outcome } from './parts.tsx';
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
const SECTION_FORM: Record<string, string> = { sources: 'toil-project-form-sources', repos: 'toil-project-form-repos', fields: 'toil-project-form-fields', 'find-fields': 'toil-project-form-find-fields', people: 'toil-project-form-people', wip: 'toil-project-form-wip', analyze: 'toil-project-form-analyze' };

/** `at`: a toil project's section to land on (#346); `toForm`: Create a toil project, which the first-run checklist opens (#416). */
export function ToilProjectSetup({ config, at, toForm = false }: { config: ConfigApi; at?: ToilProjectTarget; toForm?: boolean }) {
  const [list, setList] = useState<Loaded<{ toilProjects: ListedToilProject[]; places: { user: string } }> | null>(null);
  // The archived ones (#561): null when they could not be read, which is not none and draws nothing.
  const [archived, setArchived] = useState<Array<{ name: string; description: string | null }> | null>(null);
  const [notice, setNotice] = useState<ArchiveNotice | null>(null);
  const [areas, setAreas] = useState<AreaInfo[]>([]);
  const [connections, setConnections] = useState<ConnectionsData['connections']>([]);
  const reload = useCallback(async () => {
    try {
      setList(fromEnvelope(await config.run('projects list', {})));
    } catch (e) {
      setList({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
    try {
      const gone = await config.run('projects list', { archived: true });
      setArchived(gone.ok ? (gone.data as { toilProjects: Array<{ name: string; description: string | null }> }).toilProjects.map((d) => ({ name: d.name, description: d.description ?? null })) : null);
    } catch {
      setArchived(null);
    }
  }, [config]);
  /** Archives or unarchives through toil's own command, then reads both lists again. */
  const archive = async (name: string, putAway: boolean) => {
    try {
      const env = await config.run(putAway ? 'projects archive' : 'projects unarchive', { toilProject: name });
      setNotice(env.ok ? { kind: putAway ? 'archived' : 'unarchived', name } : { kind: 'failed', name, message: `${env.error.message}${env.error.fix ? ` ${env.error.fix}` : ''}` });
      if (env.ok) await reload();
    } catch (e) {
      setNotice({ kind: 'failed', name, message: e instanceof Error ? e.message : String(e) });
    }
  };
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
  if (!list) return <Loader size="panel" message="Reading your Toil projects…" />;
  if (!list.ok) {
    return (
      <div role="alert" className="failure">
        <p>
          Your Toil projects didn't load: {list.message}
        </p>
      </div>
    );
  }
  const toilProjects = list.value.toilProjects;

  // One Toil project's own page: its sources and everything else you can change about it (#561).
  if (at) {
    return <EditToilProject config={config} name={at.toilProject} section={at.section} toilProjects={toilProjects} found={found} areas={areas} connections={connections} />;
  }

  return (
    <>
      <Card as="section" className="panel" aria-labelledby="toil-project-list">
        <div className="view-head__row">
          <h2 id="toil-project-list">Your Toil projects</h2>
          {toilProjects.length > 0 && (
            <a className="btn" href="#/new-project" data-new-toil-project="">
              New Toil project
            </a>
          )}
        </div>
        <p className="lede">
          Each one covers a body of work: its repositories, tools and people. <Help topic="toil-project-list" />
        </p>
        {notice && <ArchiveNoticeLine notice={notice} onUndo={(name, putAway) => void archive(name, putAway)} onDismiss={() => setNotice(null)} />}
        {toilProjects.length === 0 ? (
          <p>
            No Toil projects yet. <a className="btn btn--accent" href="#/new-project" data-new-toil-project="">New Toil project</a>
          </p>
        ) : (
          <CardGrid min="lg" className="conn-cards">
            {toilProjects.map((d) => (
              <li key={d.file}>
                <ToilProjectCard toilProject={d} config={config} {...(!config.disabled && d.source === 'user' ? { onArchive: (name: string) => void archive(name, true) } : {})} />
              </li>
            ))}
          </CardGrid>
        )}
        <ArchivedDisclosure archived={archived} onUnarchive={config.disabled ? null : (name) => void archive(name, false)} />
      </Card>
      <RepoSetup config={config} areas={areas} onChanged={reload} />
    </>
  );
}

const GROUPS: Array<{ id: string; label: string; sections: string[] }> = [
  { id: 'sources', label: 'Sources', sections: ['sources', 'repos'] },
  { id: 'fields', label: 'Field names', sections: ['fields', 'find-fields'] },
  { id: 'people', label: 'People', sections: ['people'] },
  { id: 'wip', label: 'Work in progress limit', sections: ['wip'] },
  { id: 'analyze', label: 'How Analyze briefs', sections: ['analyze'] },
];

/** The edit page for one Toil project: its sources first, every other change one section further in (principle 11). */
function EditToilProject({ config, name, section, toilProjects, found, areas, connections }: { config: ConfigApi; name: string; section: string | null; toilProjects: ListedToilProject[]; found: boolean; areas: AreaInfo[]; connections: ConnectionsData['connections'] }) {
  const { pw } = usePlain();
  const first = GROUPS.find((g) => section && g.sections.includes(section))?.id ?? 'sources';
  const [open, setOpen] = useState<string>(first);
  useEffect(() => setOpen(first), [first]);
  const here = toilProjects.find((d) => d.name === name);
  return (
    <>
      <p className="note">
        <a href="#/settings/projects" className="back-link">← All Toil projects</a>
      </p>
      <Card as="section" className="panel" aria-labelledby="toil-project-change">
        <h2 id="toil-project-change" tabIndex={-1}>
          Edit {name}
        </h2>
        {here?.description && <p className="lede">{here.description}</p>}
        {!found ? (
          <p role="status" className="failure">
            There is no Toil project named {name}. It may have been removed or renamed; <a href="#/new-project">create it again</a>.
          </p>
        ) : (
          GROUPS.map((g) => (
            <details key={g.id} className="edit-group" data-edit-group={g.id} open={open === g.id} onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; setOpen((cur) => (o ? g.id : cur === g.id ? '' : cur)); }}>
              <summary>{g.id === 'analyze' ? pw('How Analyze briefs', 'How briefings are made') : g.label}</summary>
              {open === g.id && g.id === 'sources' && (
                <>
                  <AddRepoForm config={config} toilProject={name} />
                  <LinkForm config={config} toilProject={name} areas={areas} connections={connections} />
                </>
              )}
              {open === g.id && g.id === 'fields' && (
                <>
                  <FieldForm config={config} toilProject={name} areas={areas} />
                  <FindFields config={config} toilProjects={toilProjects.map((d) => d.name)} toilProject={name} connections={connections} titleId="toil-project-form-find-fields" />
                </>
              )}
              {open === g.id && g.id === 'people' && (
                <>
                  <PersonForm config={config} toilProject={name} areas={areas} />
                  <PeopleSaveForm config={config} toilProject={name} />
                </>
              )}
              {open === g.id && g.id === 'wip' && <WipLimitForm config={config} toilProject={name} />}
              {open === g.id && g.id === 'analyze' && <AnalyzeForm config={config} toilProject={name} />}
            </details>
          ))
        )}
      </Card>
    </>
  );
}

function ToilProjectCard({ toilProject: d, config, onArchive }: { toilProject: ListedToilProject; config: ConfigApi; onArchive?: (name: string) => void }) {
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
      <CardMenu
        name={d.name}
        items={[
          { id: 'show', label: shown ? 'Hide details' : 'Show details' },
          { id: 'check', label: 'Check' },
          ...(onArchive ? [{ id: 'archive', label: 'Archive', separated: true }] : []),
        ]}
        onAction={(id) => (id === 'show' ? void show() : id === 'check' ? void check() : id === 'archive' && onArchive?.(d.name))}
      />
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
      {d.shadowedBy && <p className="note">Another Toil project with the same name takes precedence.</p>}
      <Cluster className="conn-actions">
        <a className="btn btn--accent" href={toilProjectEditHref(d.name, 'sources')} data-edit-toil-project="">
          Edit
        </a>
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
          {d.name} couldn't be read: {shown.message}
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
        label={`What ${shown.name} gives each tool`}
        caption={`What ${shown.name} gives each tool`}
        rows={areas}
        rowKey={([area]) => area}
        columns={[
          { header: 'Tool', label: 'Tool', rowHeader: true, cell: ([area]) => toolName(area) },
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
              {p.kind === 'agent' && ' (AI agent)'}
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

function AddRepoForm({ config, toilProject }: { config: ConfigApi; toilProject: string }) {
  const [location, setLocation] = useState('');
  const [name, setName] = useState('');
  const [replace, setReplace] = useState(false);
  return (
    <ChangeForm
      titleId="toil-project-form-repos"
      title={`Add a repository to ${toilProject}`}
      explain="Adds a repository by its web address, or by a folder on this computer. Any password in an address is left out. Toil then uses this Toil project when you work in that repository."
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
  return (
    <ChangeForm
      titleId="toil-project-form-sources"
      title={`Link a tool to ${toilProject}`}
      explain="Attaches an area to the Toil project: which of your connections its calls use (or your default), the keys it supplies to every call (project=PAY), and reference data lists (projects=FEES). A link to a connection that allows writes can't be made from here; that is left to you in a terminal, so nothing can start changing your tools by accident."
      submit="Link tool"
      disabled={config.disabled}
      onSubmit={async () =>
        outcomeOf(
          await config.run('projects link', { toilProject, area: chosen, ...(connection ? { connection } : {}), ...(pairs(set).length ? { set: pairs(set) } : {}), ...(pairs(add).length ? { add: pairs(add) } : {}), ...(replace ? { replace } : {}) }),
          `${chosen} was linked to ${toilProject}.`,
        )
      }
    >
      <SelectField label="Tool" value={chosen} onChange={(v) => (setArea(v), setConnection(''))} options={names.map((n) => ({ value: n, label: areaLabel(n) }))} />
      <SelectField label="Connection" value={connection} onChange={setConnection} options={[{ value: '', label: `Your ${chosen} default` }, ...ofArea.map((c) => ({ value: c.name, label: `${c.name}${c.writes ? ' (writes on)' : ''}` }))]} />
      <AreaField label="Settings for every call, one key=value per line" value={set} onChange={setSet} hint="The area's context inputs (project=PAY, owner=imagile) are applied to calls; any other key is kept as reference data." />
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
  return (
    <ChangeForm
      titleId="toil-project-form-people"
      title={`Add a person to ${toilProject}`}
      explain={
        <>
          Says who someone is in each system, so the People view gathers their work from all of them: one area=identity per line, the user name, login or email that system shows. An AI agent counts as a person too. Their email is only compared, to suggest which accounts are theirs. Toil UI can't remove a person yet.
        </>
      }
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
      <AreaField label="Accounts, one tool=account per line" value={ids} onChange={setIds} hint={<>e.g. jira=pat and github=pat-ex. Tools: {areas.map((a) => a.name).join(', ') || 'the ones you have'}.</>} />
      <SelectField label="Kind" value={kind} onChange={(v) => setKind(v === 'agent' ? 'agent' : 'human')} options={[{ value: 'human', label: 'Person' }, { value: 'agent', label: 'AI agent' }]} />
      <TextField label="Email" value={email} onChange={setEmail} hint="Optional, e.g. you@example.com. Compared only, to suggest matches." />
      <CheckField label="Replace an identity, kind or email already set" checked={replace} onChange={setReplace} />
    </ChangeForm>
  );
}

function PeopleSaveForm({ config, toilProject }: { config: ConfigApi; toilProject: string }) {
  const [replace, setReplace] = useState(false);
  return (
    <ChangeForm
      titleId="toil-project-form-people-save"
      title={`Save ${toilProject}'s people to a repository`}
      explain={
        <>
          Saves the people (names, kinds, emails and the login or id each system shows, never a password) into this Toil project's copy in the repository Toil UI was started in, so teammates who get it share the mapping. If a copy exists only its people change, and people only it lists are kept. Nothing is committed: it goes in with your next change.
        </>
      }
      submit="Save to this repository"
      disabled={config.disabled}
      onSubmit={async () => {
        const e = await config.run('projects people save', { toilProject, ...(replace ? { replace } : {}) });
        const d = (e.ok ? e.data : null) as { file?: string; created?: boolean; changed?: boolean; added?: string[]; updated?: string[] } | null;
        const said = d?.created ? `Saved ${d.added?.length ?? 0} people to the repository.` : d?.changed === false ? 'The repository already has these people. Nothing changed.' : `Updated the repository's people: ${d?.added?.length ?? 0} added, ${d?.updated?.length ?? 0} changed.`;
        return outcomeOf(e, `${said} Nothing was committed.`);
      }}
    >
      <CheckField label="Take mine where the file lists the same person differently" checked={replace} onChange={setReplace} />
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
          How many items one person may have in progress at once, as the team agreed. The People view counts each person's work in progress against it, and names nobody else's. Toil UI can't clear a limit yet.
        </>
      }
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
  const { pw } = usePlain();
  const heading = `${pw('How Analyze briefs', 'How briefings are made for')} ${toilProject}`;
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
        <h3 id="toil-project-form-analyze" className="sr-only">{heading}</h3>
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
      title={heading}
      quietTitle
      explain={
        <>
          What {pw('Analyze looks for', 'a briefing looks for')}, and what the work is for; anything you leave follows the{' '}
          <span className="nowrap">
            standard. <Help topic="analyze-settings" />
          </span>
        </>
      }
      submit="Save"
      disabled={config.disabled ?? (shown ? null : 'Reading the Toil project…')}
      onSubmit={async () => (Object.keys(input).length <= 1 ? { ok: true, message: 'Nothing changed, so nothing was saved.', warnings: [] } : outcomeOf(await config.run('projects analyze set', input), `How briefings are made for ${toilProject} is saved.`))}
    >
      <TextField label="Goal of this work" value={d.goal} onChange={(goal) => set({ goal })} hint={pw('One line. Analyze weighs everything against it.', 'One line. Everything in a briefing is weighed against it.')} />
      <SelectField label="Written for" value={d.audience} onChange={(v) => set({ audience: AUDIENCES.includes(v as Audience) ? (v as Audience) : 'lead' })} options={[{ value: 'lead', label: 'A team lead' }, { value: 'engineer', label: 'An engineer on the team' }, { value: 'stakeholder', label: 'Someone outside the team' }]} />
      <details className="analyze-lenses">
        <summary>
          What it looks for ({ids.filter((id) => !d.off.includes(id)).length} of {ids.length} on)
        </summary>
        {/* The order can only be set here, as names in a line, so the box stays, one step in and plainly labelled. */}
        <TextField label="Order, most important first" value={d.order} onChange={(order) => set({ order })} hint={`Names separated by commas: ${LENSES.map((l) => l.id).join(', ')}.`} />
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
          <summary>{pw('The prompt Analyze will send', 'The instructions the agent will get')}</summary>
          <pre className="analyze-preview__text" tabIndex={0} aria-label={pw('The prompt Analyze will send', 'The instructions the agent will get')}>
            {preview}
          </pre>
          <p className="note">After toil's rules and before your own instructions and voice from Settings, AI agent.</p>
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
      explain={
        <>
          Gives a tool's field a friendly name in this Toil project.{' '}
          <span className="nowrap">
            <Info label="naming a field" text="For example, call the field customfield_10002 storyPoints. Work items use the name. Estimate, priority, type, team and due date are pointed at your team's own field the same way. A name is one word, in camelCase." />
          </span>{' '}
          Don't know the id? <a href={toilProjectEditHref(toilProject, 'find-fields')}>Find the fields</a>.
        </>
      }
      submit="Name field"
      disabled={config.disabled}
      onSubmit={async () => outcomeOf(await config.run('projects field', { toilProject, area: chosen, alias, id, ...(replace ? { replace } : {}) }), `${alias} now names ${id} in ${toilProject}.`)}
    >
      <SelectField label="Tool" value={chosen} onChange={setArea} options={names.map((n) => ({ value: n, label: areaLabel(n) }))} />
      <TextField label="Name" value={alias} onChange={setAlias} required hint="One word, e.g. storyPoints." />
      <TextField label="Field id" value={id} onChange={setId} required hint="The tool's own id, e.g. customfield_10002." />
      <CheckField label="Point an existing alias at this field" checked={replace} onChange={setReplace} />
    </ChangeForm>
  );
}
