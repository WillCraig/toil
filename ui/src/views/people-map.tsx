/**
 * Mapping an account to a person (#561): the "Map" action on an account the
 * Toil project doesn't map, and "Save to this repository" for the people
 * once they are right. Both run toil's own commands through the config path
 * (`projects person`, `projects people save`), each behind the same rules as
 * typed by hand; this file decides nothing a command doesn't. It offers a
 * likely person from toil's own matcher (src/core/people-match.ts), never
 * applies one, and asks for an identity only in the sources the Toil project
 * uses. A GitHub login with no owner used to be a dead end with a command to
 * type; it is now a form with a button, which is also what the org chart
 * lacked.
 */

import { useId, useMemo, useState } from 'react';
import { suggestPeople } from '../../../src/core/people-match.ts';
import { Cluster, Stack } from '../components/layout.tsx';
import { useData } from '../data.ts';
import { sourceLabel } from '../format.ts';
import type { Identity } from '../model/people.ts';
import type { ToilProjectData } from '../load.ts';
import './settings.css';
import { failedOutcome, OutcomeLine, outcomeOf, SelectField, TextField, type Outcome } from './settings/parts.tsx';

/** The sources whose accounts a person can have, in the order the views name them. */
const SOURCES = ['github', 'jira', 'ado', 'bitbucket'] as const;

/** The sources this Toil project reads or already names people in: no field for a system it never touches. */
export function sourcesOf(toilProject: Pick<ToilProjectData, 'items' | 'pullRequests' | 'people' | 'readiness'>, also: readonly string[] = []): string[] {
  const used = new Set<string>([
    ...(toilProject.readiness?.sources ?? []),
    ...toilProject.items.map((i) => i.source.area),
    ...toilProject.pullRequests.map((c) => c.source.area),
    ...toilProject.people.flatMap((p) => Object.keys(p.ids)),
    ...also,
  ]);
  return SOURCES.filter((s) => used.has(s));
}

const WHY = { email: 'it has their email', name: "it is shown with their name", login: 'its id reads as their name' } as const;
const NEW ='\u0000new';

/** Why a change can't be made from here, or null when it can. */
function useOff(): string | null {
  const { config } = useData();
  return !config ? "This view can't change Toil projects here. Match people across tools in Settings, Toil projects." : config.disabled;
}

/** A "Map" button on an account's card, opening the form in place. */
export function MapIdentity({ account }: { account: Identity }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <div className="map-identity">
      <button type="button" className="btn" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}>
        {open ? 'Close' : 'Map'}
        <span className="sr-only"> {account.id}</span>
      </button>
      {open && (
        <div id={panel}>
          <MapForm account={account} />
        </div>
      )}
    </div>
  );
}

function MapForm({ account }: { account: Identity }) {
  const { toilProject, config, refresh } = useData();
  const off = useOff();
  const offId = useId();
  const entries = toilProject.people;
  const sources = useMemo(() => sourcesOf(toilProject, [account.area]), [toilProject, account.area]);
  // toil's matcher on this one account: a person it fits, shown as the starting choice and never applied.
  const likely = useMemo(() => suggestPeople(toilProject.name, entries, [account]).suggestions[0], [toilProject.name, entries, account]);
  const [who, setWho] = useState(likely?.person ?? (entries.length ? entries[0]!.name : NEW));
  const [name, setName] = useState(account.name ?? account.id);
  const [kind, setKind] = useState<'human' | 'agent'>('human');
  const [email, setEmail] = useState(account.email ?? '');
  const person = entries.find((p) => p.name === who);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const value = (area: string) => typed[area] ?? (area === account.area ? account.id : (person?.ids[area] ?? ''));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const target = person ? person.name : name.trim();
  const ids = sources.flatMap((a) => (value(a).trim() !== '' && person?.ids[a]?.toLowerCase() !== value(a).trim().toLowerCase() ? [`${a}=${value(a).trim()}`] : []));
  const input = { toilProject: toilProject.name, name: target, ...(ids.length ? { id: ids } : {}), ...(!person && kind === 'agent' ? { kind } : {}), ...(!person && email.trim() ? { email: email.trim() } : {}) };

  const save = async () => {
    if (!config || off || busy) return;
    if (!target) return setOutcome({ ok: false, message: 'Say who this is: choose a person, or type a name for a new one.', fix: null });
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(outcomeOf(await config.run('projects person', input), `${account.id} is mapped to ${target} in ${toilProject.name}'s people.`));
    } catch (e) {
      setOutcome(failedOutcome(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="sm" className="map-form">
      <p className="note">
        {sourceLabel(account.area)} <strong>{account.id}</strong>
        {account.name && account.name !== account.id ? ` (${account.name})` : ''} isn't mapped to anyone in {toilProject.name}'s people.
        {likely && <> Probably {likely.person}: {WHY[likely.reason]}.</>}
      </p>
      <SelectField
        label="This account is"
        value={who}
        onChange={setWho}
        options={[...entries.map((p) => ({ value: p.name, label: `${p.name}${p.kind === 'agent' ? ' (agent)' : ''}` })), { value: NEW, label: 'A new person or AI agent' }]}
      />
      {!person && (
        <>
          <TextField label="Name" value={name} onChange={setName} required hint="As the team writes it, e.g. Pat Example." />
          <SelectField label="Kind" value={kind} onChange={(v) => setKind(v === 'agent' ? 'agent' : 'human')} options={[{ value: 'human', label: 'Person' }, { value: 'agent', label: 'AI agent' }]} />
          <TextField label="Email" value={email} onChange={setEmail} hint="Optional. Only compared, to suggest which accounts are theirs." />
        </>
      )}
      <fieldset className="map-ids">
        <legend>Identities in each system</legend>
        {sources.map((a) => (
          <TextField key={a} label={`${sourceLabel(a)}`} value={value(a)} onChange={(v) => setTyped({ ...typed, [a]: v })} hint={a === account.area ? 'The account you are mapping.' : person?.ids[a] ? 'Already set; change it in Settings, Toil projects.' : 'Optional.'} />
        ))}
      </fieldset>
      <Cluster>
        <button type="button" className="btn btn--accent" onClick={save} disabled={off !== null || busy || outcome?.ok === true} aria-describedby={off ? offId : undefined}>
          {busy ? 'Running…' : person ? `Map to ${person.name}` : 'Add them'}
        </button>
        {off && (
          <span id={offId} className="note">
            Turned off: {off}
          </span>
        )}
      </Cluster>
      <OutcomeLine outcome={outcome} />
      {outcome?.ok && (
        <>
          <Cluster>
            {refresh && (
              <button type="button" className="btn" onClick={refresh}>
                Reload the Toil project
              </button>
            )}
          </Cluster>
          <SaveToRepo />
        </>
      )}
    </Stack>
  );
}

/**
 * Writes the people into the repository's `.toil/projects` file. Said in
 * plain words first, because it changes a file the person will commit: which
 * file, what goes in it, what doesn't, and that nothing is committed.
 */
export function SaveToRepo() {
  const { toilProject, config } = useData();
  const off = useOff();
  const offId = useId();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [replace, setReplace] = useState(false);
  const run = async () => {
    if (!config || off || busy) return;
    setBusy(true);
    setOutcome(null);
    try {
      const e = await config.run('projects people save', { toilProject: toilProject.name, ...(replace ? { replace } : {}) });
      const d = (e.ok ? e.data : null) as { file?: string; created?: boolean; changed?: boolean; added?: string[]; updated?: string[] } | null;
      const said = d?.created ? `Saved ${d.added?.length ?? 0} people to the repository.` : d?.changed === false ? 'The repository already has these people. Nothing changed.' : `Updated the repository's people: ${d?.added?.length ?? 0} added, ${d?.updated?.length ?? 0} changed.`;
      setOutcome(outcomeOf(e, `${said} Nothing was committed: it goes in with your next change.`));
    } catch (err) {
      setOutcome(failedOutcome(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="xs" className="save-to-repo">
      <Cluster>
        <button type="button" className="btn" onClick={run} disabled={off !== null || busy} aria-describedby={off ? offId : undefined}>
          {busy ? 'Saving…' : 'Save to this repository'}
        </button>
        {off && (
          <span id={offId} className="note">
            Turned off: {off}
          </span>
        )}
      </Cluster>
      <details>
        <summary>What does this change?</summary>
        <p className="note">
          Saves the people (names, kinds, emails and the login or id each system shows) into this Toil project's copy in the repository Toil UI was started in, so teammates who get it share the mapping. No password or token is ever in it. If a copy already exists only its people change, and people only it lists are kept. Nothing is committed for you.
        </p>
        <label className="map-replace">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Take mine where the repository lists the same person differently
        </label>
      </details>
      <OutcomeLine outcome={outcome} />
    </Stack>
  );
}
