/**
 * Connections (#253, item 4): what `toil connections` manages, from the
 * browser. Each connection says its area, host, whether it's the area's
 * default, whether writes are on, and where each value comes from; each action
 * says what it does and which toil command it runs. A connection made by env
 * vars alone is shown read-only with where it came from, since no command can
 * change a variable. Secrets are typed into password fields that go straight
 * to toil's login path, and are cleared once the call is made.
 */

import { useCallback, useEffect, useState } from 'react';
import { connectionEnvVar, envOnly, envPrefix, type AreaInfo, type ConfigApi, type ConnectionRow, type ConnectionsData } from '../../config.ts';
import type { Envelope } from '../../toil.ts';
import { Card, CardGrid, Path } from '../../components/layout.tsx';
import { Help, useLandOn } from '../../components/help.tsx';
import { ChangeForm, OutcomeLine, SecretField, SelectField, TextField, commandLine, failedOutcome, outcomeOf, secretRefusal, type Outcome } from './parts.tsx';
import { checkSecret, type SecretRules } from '../../../../src/core/secret-input.ts';
import { Loader } from '../../moments/Moments.tsx';
import { usePlain } from '../../plain-words.ts';

const SOURCE_WORD: Record<string, string> = { env: 'env var', ci: 'CI variable', file: 'config file', store: 'credential store', defaults: 'area defaults' };

type Loaded = { ok: true; data: ConnectionsData; warnings: string[] } | { ok: false; message: string };

function loadedFrom(envelope: Envelope): Loaded {
  if (!envelope.ok) return { ok: false, message: `${envelope.error.message}${envelope.error.fix ? ` ${envelope.error.fix}` : ''}` };
  return { ok: true, data: envelope.data as ConnectionsData, warnings: (envelope.meta.warnings ?? []).map((w) => w.message) };
}

/** `at`: a connection's card to land on (#346); `toForm`: the add form, which the first-run checklist opens (#416). */
export function Connections({ config, at, toForm = false }: { config: ConfigApi; at?: string; toForm?: boolean }) {
  const [list, setList] = useState<Loaded | null>(null);
  const [areas, setAreas] = useState<AreaInfo[] | null>(null);
  const reload = useCallback(async () => {
    try {
      setList(loadedFrom(await config.run('connections list', {})));
    } catch (e) {
      setList({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }, [config]);
  useEffect(() => {
    void reload();
    config.areas().then(setAreas, () => setAreas([]));
  }, [config, reload]);

  // An edit link names a connection (#346): its card takes focus once the list has loaded.
  useLandOn(toForm ? 'conn-add' : at ? `conn-${at}` : null, Boolean(list));
  if (!list) return <Loader size="panel" message="Reading your connections with toil connections list…" />;
  if (!list.ok) {
    return (
      <div role="alert" className="failure">
        <p>
          <code>toil connections list</code> failed: {list.message}
        </p>
      </div>
    );
  }
  const { data } = list;
  return (
    <>
      <Card as="section" className="panel" aria-labelledby="conn-list">
        <h2 id="conn-list">Your connections</h2>
        <p className="lede">
          From <code>toil connections list</code>. Changes are written to <Path value={data.configFile} what="config file path" />. <Help topic="connections" />
        </p>
        {at && !data.connections.some((c) => c.name === at) && (
          <p role="status" className="failure">
            toil has no connection named <code>{at}</code>. It may have been removed or renamed; add it again below.
          </p>
        )}
        {data.connections.length === 0 ? (
          <p>toil has no connections yet. Add one below.</p>
        ) : (
          <CardGrid min="lg" className="conn-cards">
            {data.connections.map((c) => (
              <li key={c.name}>
                <ConnectionCard connection={c} areas={areas ?? []} config={config} configFile={data.configFile} onChanged={reload} />
              </li>
            ))}
          </CardGrid>
        )}
      </Card>
      <AddConnection areas={areas} config={config} onChanged={reload} />
    </>
  );
}

type Action = 'test' | 'default' | 'writes' | 'login' | 'remove';

function ConnectionCard({ connection: c, areas, config, configFile, onChanged }: { connection: ConnectionRow; areas: AreaInfo[]; config: ConfigApi; configFile: string; onChanged: () => Promise<void> }) {
  const plain = usePlain();
  const [open, setOpen] = useState<Action | null>(null);
  const [tested, setTested] = useState<Outcome | null>(null);
  const [testing, setTesting] = useState(false);
  const readOnly = envOnly(c);
  const titleId = `conn-${c.name}`;
  const secretFields = areas.find((a) => a.name === c.area)?.connection.filter((f) => f.secret) ?? [];
  // What Test does and the command it runs: the Test button's hover, not a line repeated on every card.
  const testTitle = plain.on ? `Asks ${c.area} one quick question to check the login works. It changes nothing. Command: ${commandLine('connections test', [c.name])}` : `Sends ${c.area}'s one cheap authenticated read, as a real command would, and changes nothing. Command: ${commandLine('connections test', [c.name])}`;

  const test = async () => {
    setTesting(true);
    setTested(null);
    try {
      const envelope = await config.run('connections test', { name: c.name });
      const data = envelope.ok ? (envelope.data as { live: boolean; authenticated: boolean; request: string | null }) : null;
      const done = data
        ? data.live
          ? `${c.name} answered ${data.request ?? 'its check'}${data.authenticated ? ', so its credential works.' : ', but that read needs no credential, so it shows only that the host answers.'}`
          : `toil has no live check for ${c.area} connections, so nothing was sent; the settings are complete and the secret was read.`
        : '';
      setTested(outcomeOf(envelope, done));
    } catch (e) {
      setTested(failedOutcome(e));
    } finally {
      setTesting(false);
    }
  };

  const toggle = (a: Action) => setOpen((o) => (o === a ? null : a));
  const after = async (envelope: Envelope, done: string) => {
    const outcome = outcomeOf(envelope, done);
    if (outcome.ok) await onChanged();
    return outcome;
  };

  return (
    <Card className="conn-card" aria-labelledby={titleId}>
      <div className="conn-head">
        <h3 id={titleId} tabIndex={-1}>
          <code>{c.name}</code>
        </h3>
        <ul className="conn-tags" aria-label="About this connection">
          <li className="tag">{c.area}</li>
          {c.isDefault && <li className="tag tag--accent">{plain.pw(`${c.area}'s default`, `Main ${c.area} connection`)}</li>}
          <li className={`tag ${c.writes ? 'tag--warn' : ''}`} title={plain.title(`Writes ${c.writes ? 'on' : 'off'}`)}>
            {plain.on ? (c.writes ? 'Changes allowed' : 'Changes off') : `Writes ${c.writes ? 'on' : 'off'}`}
          </li>
          {readOnly && <li className="tag">Set by env vars</li>}
        </ul>
      </div>
      <dl className="facts">
        <div>
          <dt>Host</dt>
          <dd>{c.host ?? 'None set'}</dd>
        </div>
        <div>
          <dt>Values from</dt>
          <dd>
            {Object.keys(c.values).length === 0
              ? 'Nothing beyond its area'
              : Object.entries(c.values)
                  .map(([k, s]) => `${k}: ${SOURCE_WORD[s] ?? s}`)
                  .join(', ')}
          </dd>
        </div>
      </dl>
      {readOnly && (
        <p className="note">
          Made by env vars alone (<code>{envPrefix(c.name)}*</code>, or {c.area}'s own <code>TOIL_{c.area.toUpperCase().replace(/-/g, '_')}_*</code> and CI variables), not by <code>{configFile}</code>. toil's commands can't change a variable, so this connection is read-only here: change the variables where they're set. Testing it changes nothing.
        </p>
      )}
      <div className="conn-actions">
        <button type="button" className="btn" onClick={test} disabled={testing} title={testTitle}>
          {testing ? 'Testing…' : 'Test'}
        </button>
        {!readOnly && (
          <>
            {!c.isDefault && (
              <button type="button" className="btn" aria-expanded={open === 'default'} onClick={() => toggle('default')}>
                Make default
              </button>
            )}
            <button type="button" className="btn" aria-expanded={open === 'writes'} onClick={() => toggle('writes')}>
              {plain.on ? (c.writes ? 'Stop changes' : 'Allow changes') : c.writes ? 'Turn writes off' : 'Turn writes on'}
            </button>
            {secretFields.length > 0 && (
              <button type="button" className="btn" aria-expanded={open === 'login'} onClick={() => toggle('login')}>
                {plain.pw('Replace secret', 'Update login')}
              </button>
            )}
            <button type="button" className="btn" aria-expanded={open === 'remove'} onClick={() => toggle('remove')}>
              Remove
            </button>
          </>
        )}
      </div>
      <OutcomeLine outcome={tested} />
      {open === 'default' && (
        <ChangeForm
          title={`Make ${c.name} the ${c.area} default`}
          explain={`${c.area} commands use it when a call names no connection and its Toil project names none. The previous default stays as it is, just no longer the default.`}
          runs={commandLine('connections default', [c.name])}
          submit="Make default"
          disabled={config.disabled}
          onSubmit={async () => after(await config.run('connections default', { name: c.name }), `${c.name} is now the ${c.area} default.`)}
        />
      )}
      {open === 'writes' && <WritesForm connection={c} config={config} after={after} />}
      {open === 'login' && <LoginForm connection={c} fields={secretFields} config={config} after={after} />}
      {open === 'remove' && (
        <ChangeForm
          title={`Remove ${c.name}`}
          explain={`Takes ${c.name} out of ${configFile} and deletes its secrets from the OS credential store, unless another connection uses them. A Toil project that names it then fails until it names another. This can't be undone here: adding it again means typing its secret again.`}
          runs={commandLine('connections remove', [c.name])}
          submit={`Remove ${c.name}`}
          danger
          disabled={config.disabled}
          onSubmit={async () => after(await config.run('connections remove', { name: c.name }), `${c.name} was removed.`)}
        />
      )}
    </Card>
  );
}

function WritesForm({ connection: c, config, after }: { connection: ConnectionRow; config: ConfigApi; after: (e: Envelope, done: string) => Promise<Outcome> }) {
  const plain = usePlain();
  const [typed, setTyped] = useState('');
  if (c.writes) {
    return (
      <ChangeForm
        title={plain.pw(`Turn writes off for ${c.name}`, `Stop changes for ${c.name}`)}
        explain={plain.pw(`Commands can no longer change anything in ${c.area} through ${c.name}, even with --allow-write. Reads carry on as before.`, `Nothing can change ${c.area} through ${c.name} any more, even when a command asks to. Reading carries on as before.`)}
        runs={commandLine('connections writes', [c.name, 'off'])}
        submit={plain.pw('Turn writes off', 'Stop changes')}
        disabled={config.disabled}
        onSubmit={async () => after(await config.run('connections writes', { name: c.name, state: 'off' }), `Writes are off for ${c.name}.`)}
      />
    );
  }
  return (
    <ChangeForm
      title={plain.pw(`Turn writes on for ${c.name}`, `Allow changes for ${c.name}`)}
      explain={
        plain.on ? (
          <>
            Allowing changes lets toil commands update things in {c.area} through {c.name}, but only when each command also asks to (<code>--allow-write</code>). Toil UI itself never changes {c.area}: what an AI helper suggests is a command for you to run. toil asks you to type the connection's name to allow changes, here as on the terminal, and allows them only if it matches.
          </>
        ) : (
        <>
          Writes let commands change data in {c.area} through {c.name} when a call also passes <code>--allow-write</code>. Toil UI itself never writes to {c.area}: its proposals are commands for you to run. toil asks you to type the connection's name to turn writes on, here as on the terminal, and turns them on only if it matches.
        </>
        )
      }
      runs={commandLine('connections writes', [c.name, 'on'])}
      submit={plain.pw('Turn writes on', 'Allow changes')}
      danger
      disabled={config.disabled}
      onSubmit={async () => {
        const answer = typed;
        setTyped('');
        return after(await config.run('connections writes', { name: c.name, state: 'on' }, { answers: { 'confirm-name': answer } }), `Writes are on for ${c.name}.`);
      }}
    >
      <TextField label={plain.pw(`Type ${c.name} to turn them on`, `Type ${c.name} to allow changes`)} value={typed} onChange={setTyped} required />
    </ChangeForm>
  );
}

function LoginForm({ connection: c, fields, config, after }: { connection: ConnectionRow; fields: AreaInfo['connection']; config: ConfigApi; after: (e: Envelope, done: string) => Promise<Outcome> }) {
  const plain = usePlain();
  const [values, setValues] = useState<Record<string, string>>({});
  const secrets = useSecretChoices();
  // An empty field keeps the secret the config file points at, as the CLI's login does; one it has no secret for stays unset.
  const kept = (f: AreaInfo['connection'][number]) => c.values[f.name] === 'store' || c.values[f.name] === 'file';
  const rules = (f: AreaInfo['connection'][number]): SecretRules => ({ password: f.password, empty: kept(f) ? 'keep' : 'skip' });
  return (
    <ChangeForm
      title={plain.pw(`Replace ${c.name}'s secret`, `Update ${c.name}'s login`)}
      explain={plain.pw(`Stores what you type in the OS credential store, reads it back to check, and only then points ${c.name} at it and deletes the old one. A field left empty keeps its secret as it is. Toil UI doesn't keep what you type: it goes to toil in one request, and the fields are cleared.`, `Saves what you type in this computer's secure store, checks it can be read back, and only then switches ${c.name} to it and deletes the old one. A field left empty keeps what is there. Toil UI doesn't keep what you type: it goes straight to toil, and the fields are cleared.`)}
      runs={commandLine('connections login', [c.name])}
      submit={plain.pw('Save to the credential store', 'Save securely')}
      disabled={config.disabled}
      onSubmit={async () => {
        const refused = secrets.refusal(fields.map((f) => [f.name, values[f.name] ?? '', rules(f)]));
        if (refused) return refused;
        // Every field shown is answered, an empty one with '': toil keeps that secret as it is, as on the CLI.
        const typed = Object.fromEntries(fields.map((f) => [f.name, values[f.name] ?? '']));
        const answers = secrets.answers();
        setValues({});
        secrets.reset();
        return after(await config.run('connections login', { name: c.name }, { secrets: typed, answers }), `${c.name}'s secret was replaced in the credential store.`);
      }}
    >
      {fields.map((f) => (
        <SecretField key={f.name} label={`${f.name}${f.description ? ` (${f.description})` : ''}`} value={values[f.name] ?? ''} onChange={(v) => { setValues((s) => ({ ...s, [f.name]: v })); secrets.changed(f.name); }} rules={rules(f)} asking={secrets.asking} kept={secrets.kept(f.name)} onKeep={() => secrets.keep(f.name)} />
      ))}
    </ChangeForm>
  );
}

/**
 * A form's decisions about its secrets' wrappers (#358): which ones the person
 * chose to keep as typed (sent as `unwrap:<key>` = n), and whether a submit has
 * asked. Changing a field forgets its choice, since it's a different value now.
 */
function useSecretChoices() {
  const [kept, setKept] = useState<Record<string, boolean>>({});
  const [asking, setAsking] = useState(false);
  return {
    asking,
    kept: (name: string) => kept[name] === true,
    keep: (name: string) => setKept((k) => ({ ...k, [name]: true })),
    changed: (name: string) => setKept((k) => (k[name] ? { ...k, [name]: false } : k)),
    reset: () => {
      setKept({});
      setAsking(false);
    },
    /** The first secret the submit checks stop, or null to send. */
    refusal: (fields: Array<[string, string, SecretRules]>): Outcome | null => {
      for (const [name, value, rules] of fields) {
        const refused = secretRefusal(name, checkSecret(value, rules), kept[name] === true);
        if (refused) {
          setAsking(true);
          return refused;
        }
      }
      return null;
    },
    answers: (): Record<string, string> => Object.fromEntries(Object.keys(kept).filter((k) => kept[k]).map((k) => [`unwrap:${k}`, 'n'])),
  };
}

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function AddConnection({ areas, config, onChanged }: { areas: AreaInfo[] | null; config: ConfigApi; onChanged: () => Promise<void> }) {
  const withFields = (areas ?? []).filter((a) => a.connection.length > 0);
  if (areas === null) return null;
  if (withFields.length === 0) {
    return (
      <Card as="section" className="panel" aria-labelledby="conn-add">
        <h2 id="conn-add">Add a connection</h2>
        <p>The toil this server runs doesn't say what each area's connection holds, so the page can't ask for it. Add one with <code>toil connections add</code> in a terminal.</p>
      </Card>
    );
  }
  return (
    <Card as="section" className="panel" aria-labelledby="conn-add">
      <h2 id="conn-add">Add a connection</h2>
      <NewConnectionForm areas={withFields} config={config} onAdded={onChanged} />
    </Card>
  );
}

/**
 * The form `toil connections add` is from the page. With `area`, it adds a
 * connection to that area only, and `suggest` fills the name and settings in
 * (Set up this repo offers a base URL on the toil project's host); the person can
 * change any of them before saving.
 */
export function NewConnectionForm({
  areas,
  config,
  onAdded,
  area: fixed,
  suggest,
  title = 'A new connection',
}: {
  areas: AreaInfo[];
  config: ConfigApi;
  onAdded: (name: string) => Promise<void>;
  area?: string;
  suggest?: { name?: string; values?: Record<string, string> };
  title?: string;
}) {
  const withFields = areas.filter((a) => a.connection.length > 0 && (fixed === undefined || a.name === fixed));
  const [name, setName] = useState(suggest?.name ?? '');
  const [area, setArea] = useState(fixed ?? '');
  const [values, setValues] = useState<Record<string, string>>(suggest?.values ?? {});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const choices = useSecretChoices();
  const rulesFor = (f: AreaInfo['connection'][number]): SecretRules => ({ password: f.password, empty: f.required ? 'required' : 'skip', envVars: [`${connectionEnvVar(name || '<name>', 'area')}=${chosen?.name ?? '<area>'}`, ...fields.map((g) => connectionEnvVar(name || '<name>', g.name))] });
  const chosen = withFields.find((a) => a.name === area) ?? withFields[0];
  const fields = chosen?.connection ?? [];
  const settings = fields.filter((f) => !f.secret);
  const required = settings.filter((f) => f.required);
  const optional = settings.filter((f) => !f.required);
  const secretFields = fields.filter((f) => f.secret);
  const label = (f: AreaInfo['connection'][number]) => `${f.name}${f.description ? ` (${f.description})` : ''}`;
  if (!chosen) return <p className="note">The toil this server runs doesn't say what a {fixed} connection holds. Add one with <code>toil connections add</code> in a terminal.</p>;
  const review = [
    `area ${chosen.name}`,
    ...settings.filter((f) => (values[f.name] ?? '') !== '').map((f) => `${f.name} ${values[f.name]}`),
    ...secretFields.filter((f) => (secrets[f.name] ?? '') !== '').map((f) => `${f.name} to the OS credential store`),
  ].join(', ');

  return (
    <ChangeForm
      title={title}
      explain={
        <>
          Asks for what <code>toil connections add</code> asks on a terminal. The settings go into your config file and each secret into the OS credential store, never the file. The first connection to an area becomes its default. Writes start off.
        </>
      }
      runs={commandLine('connections add', [name || '<name>', '--area', chosen.name])}
      submit="Save connection"
      disabled={config.disabled}
      onSubmit={async () => {
        if (!NAME.test(name)) return { ok: false, message: `"${name}" isn't a valid connection name.`, fix: 'Use lowercase letters, digits and single hyphens, starting with a letter, e.g. corp-jira.' };
        const answers: Record<string, string> = { confirm: 'y' };
        for (const f of settings) answers[`setting:${f.name}`] = values[f.name] ?? '';
        const refused = choices.refusal(secretFields.map((f) => [f.name, secrets[f.name] ?? '', rulesFor(f)]));
        if (refused) return refused;
        Object.assign(answers, choices.answers());
        // Every secret field shown is answered, an empty one with '', so toil skips an empty optional one as the CLI does.
        const typed = Object.fromEntries(secretFields.map((f) => [f.name, secrets[f.name] ?? '']));
        setSecrets({});
        choices.reset();
        const envelope = await config.run('connections add', { name, area: chosen.name }, { answers, secrets: typed });
        const outcome = outcomeOf(envelope, `${name} was added.`);
        if (outcome.ok) {
          setName('');
          setValues({});
          await onAdded(name);
        }
        return outcome;
      }}
    >
      <TextField label="Name" value={name} onChange={setName} required hint="Lowercase letters, digits and single hyphens, e.g. corp-jira." />
      {fixed === undefined && (
        <SelectField
          label="Area"
          value={chosen.name}
          onChange={(v) => {
            setArea(v);
            setValues({});
            setSecrets({});
            choices.reset();
          }}
          options={withFields.map((a) => ({ value: a.name, label: a.name }))}
          hint={chosen.description}
        />
      )}
      {required.map((f) => (
        <TextField key={f.name} label={label(f)} value={values[f.name] ?? ''} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} required placeholder={f.default ?? undefined} />
      ))}
      {secretFields.map((f) => (
        <SecretField
          key={f.name}
          label={`${label(f)}${f.password ? ', a password' : ''}`}
          value={secrets[f.name] ?? ''}
          onChange={(v) => {
            setSecrets((s) => ({ ...s, [f.name]: v }));
            choices.changed(f.name);
          }}
          rules={rulesFor(f)}
          asking={choices.asking}
          kept={choices.kept(f.name)}
          onKeep={() => choices.keep(f.name)}
          hint="Goes to the OS credential store; never shown again, and never in the config file."
        />
      ))}
      {optional.length > 0 && (
        <details className="more">
          <summary>Optional settings ({optional.length})</summary>
          {optional.map((f) => (
            <TextField key={f.name} label={label(f)} value={values[f.name] ?? ''} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} placeholder={f.default ?? undefined} hint={f.default ? `Left empty, it stays ${f.default}.` : undefined} />
          ))}
        </details>
      )}
      <p className="note">Saves: {review}.</p>
    </ChangeForm>
  );
}
