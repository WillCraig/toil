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
import { testSentence, type ConnectionTestData } from '../../connection-test.ts';
import { areaLabel, toolName } from '../../setup.ts';
import { connectionEnvVar, envOnly, type AreaInfo, type ConfigApi, type ConnectionRow, type ConnectionsData } from '../../config.ts';
import type { Envelope } from '../../toil.ts';
import { Card, CardGrid } from '../../components/layout.tsx';
import { Help, useLandOn } from '../../components/help.tsx';
import { ChangeForm, ChoiceRadios, CheckField, OutcomeLine, SecretField, SelectField, TextField, failedOutcome, outcomeOf, secretRefusal, type Outcome } from './parts.tsx';
import { afterChoice, chosen, emptyState, initialState, needOf, reportOf, selectedOption, shownOptions, submission, type FormField, type FormState, type Problem } from '../../../../src/core/connection-form.ts';
import { ScopesDisclosure, TokenKindRadios } from './Scopes.tsx';
import { checkSecret, type SecretRules } from '../../../../src/core/secret-input.ts';
import { Loader } from '../../moments/Moments.tsx';

/** The keys of a connection's settings, grouped under where each one comes from. */
function groupBySource(values: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, source] of Object.entries(values)) (out[SOURCE_WORD[source] ?? source] ??= []).push(key);
  return out;
}

const SOURCE_WORD: Record<string, string> = { env: "Set outside Toil UI, so it can't be changed here", ci: "Set outside Toil UI, so it can't be changed here", file: 'Saved on this computer', store: 'Saved on this computer', defaults: 'Built-in default' };

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
  if (!list) return <Loader size="panel" message="Reading your connections…" />;
  if (!list.ok) {
    return (
      <div role="alert" className="failure">
        <p>
          Your connections didn't load: {list.message}
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
          Each one is a link to a tool, such as Jira or GitHub. <Help topic="connections" />
        </p>
        {at && !data.connections.some((c) => c.name === at) && (
          <p role="status" className="failure">
            There is no connection named {at}. It may have been removed or renamed; add it again below.
          </p>
        )}
        {data.connections.length === 0 ? (
          <p>No connections yet. Add one below.</p>
        ) : (
          <CardGrid min="lg" className="conn-cards">
            {data.connections.map((c) => (
              <li key={c.name}>
                <ConnectionCard connection={c} areas={areas ?? []} config={config} siblings={data.connections.filter((x) => x.area === c.area).length} onChanged={reload} />
              </li>
            ))}
          </CardGrid>
        )}
      </Card>
      <AddConnection areas={areas} config={config} onChanged={reload} startOpen={toForm} existingNames={data.connections.map((c) => c.name)} />
    </>
  );
}

type Action = 'test' | 'default' | 'writes' | 'login' | 'remove';

function ConnectionCard({ connection: c, areas, config, siblings, onChanged }: { connection: ConnectionRow; areas: AreaInfo[]; config: ConfigApi; /** How many connections this tool has: the Default badge only means something when there is a choice. */ siblings: number; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState<Action | null>(null);
  const [tested, setTested] = useState<Outcome | null>(null);
  const [testing, setTesting] = useState(false);
  const readOnly = envOnly(c);
  const titleId = `conn-${c.name}`;
  const secretFields = areas.find((a) => a.name === c.area)?.connection.filter((f) => f.secret) ?? [];
  /** Where each of the login's own keys comes from, so the card says so in one line and the rest sits one step in. */
  const secrets = Object.entries(c.values).filter(([k]) => secretFields.some((f) => f.name === k));
  // What Test does: the Test button's hover, not a line repeated on every card.
  const testTitle = `Asks ${toolName(c.area)} one quick question to check the login works. It changes nothing.`;

  const test = async () => {
    setTesting(true);
    setTested(null);
    try {
      const envelope = await config.run('connections test', { name: c.name });
      const data = envelope.ok ? (envelope.data as ConnectionTestData) : null;
      const done = data
        ? data.live
          ? testSentence(data, c.name)
          : `There is no live check for ${toolName(c.area)} connections, so nothing was sent; the settings are complete and the login was read.`
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
          {c.name}
        </h3>
        <ul className="conn-tags" aria-label="About this connection">
          {c.name !== c.area && <li className="tag">{areaLabel(c.area)}</li>}
          {c.isDefault && siblings > 1 && <li className="tag tag--accent">Default</li>}
          <li className={`tag ${c.writes ? 'tag--warn' : ''}`} title="Whether Toil may change things in this tool through this connection">
            {c.writes ? 'Writes allowed' : 'Read only'}
          </li>
          {readOnly && <li className="tag">Set outside Toil UI</li>}
        </ul>
      </div>
      <dl className="facts">
        <div>
          <dt>Host</dt>
          <dd>{c.host ?? 'None set'}</dd>
        </div>
        {secrets.length > 0 && (
          <div>
            <dt>Login</dt>
            <dd>{secrets.map(([k, s]) => (secrets.length > 1 ? `${k}: ` : '') + (SOURCE_WORD[s] ?? s)).join(', ')}</dd>
          </div>
        )}
      </dl>
      {Object.keys(c.values).length > 0 && (
        <details className="conn-sources">
          <summary>Where its settings come from</summary>
          <dl className="conn-sources__list">
            {Object.entries(groupBySource(c.values)).map(([source, keys]) => (
              <div key={source}>
                <dt>{SOURCE_WORD[source] ?? source}</dt>
                <dd>{keys.join(', ')}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {readOnly && (
        <p className="note">
          This connection is set outside Toil UI, so it can't be changed here. Testing it changes nothing.
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
              {c.writes ? 'Make read only' : 'Allow writes'}
            </button>
            {secretFields.length > 0 && (
              <button type="button" className="btn" aria-expanded={open === 'login'} onClick={() => toggle('login')}>
                Update login
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
          title={`Make ${c.name} the ${toolName(c.area)} default`}
          explain={`${toolName(c.area)} uses it when nothing else names a connection, including a Toil project that names none. The previous default stays as it is, just no longer the default.`}
          submit="Make default"
          disabled={config.disabled}
          onSubmit={async () => after(await config.run('connections default', { name: c.name }), `${c.name} is now the ${toolName(c.area)} default.`)}
        />
      )}
      {open === 'writes' && <WritesForm connection={c} config={config} after={after} />}
      {open === 'login' && <LoginForm connection={c} fields={secretFields} config={config} after={after} />}
      {open === 'remove' && (
        <ChangeForm
          title={`Remove ${c.name}`}
          explain={`Removes ${c.name} from this computer and deletes its saved login, unless another connection uses it. A Toil project that names it stops working until it names another. This can't be undone here: adding it again means typing the login again.`}
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
  const [typed, setTyped] = useState('');
  if (c.writes) {
    return (
      <ChangeForm
        title={`Make ${c.name} read only`}
        explain={`Nothing can change ${toolName(c.area)} through ${c.name} any more. Reading carries on as before.`}
        submit="Make read only"
        disabled={config.disabled}
        onSubmit={async () => after(await config.run('connections writes', { name: c.name, state: 'off' }), `${c.name} is read only.`)}
      />
    );
  }
  return (
    <ChangeForm
      title={`Allow writes for ${c.name}`}
      explain={`Allowing writes lets Toil update things in ${toolName(c.area)} through ${c.name}, but only when a change is asked for and approved. Toil UI itself never changes ${toolName(c.area)}: what an AI agent suggests is a change for you to approve. To allow writes, type the connection's name below; it only works if it matches.`}
      submit="Allow writes"
      danger
      disabled={config.disabled}
      onSubmit={async () => {
        const answer = typed;
        setTyped('');
        return after(await config.run('connections writes', { name: c.name, state: 'on' }, { answers: { 'confirm-name': answer } }), `Writes are allowed for ${c.name}.`);
      }}
    >
      <TextField label={`Type ${c.name} to allow writes`} value={typed} onChange={setTyped} required />
    </ChangeForm>
  );
}

export function LoginForm({ connection: c, fields, config, after, confirm }: { connection: ConnectionRow; fields: AreaInfo['connection']; config: ConfigApi; after: (e: Envelope, done: string) => Promise<Outcome>; /** Words for a tick the person must make before Save can run: for a replacement the wizard names. */ confirm?: string }) {
  const [sure, setSure] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const secrets = useSecretChoices();
  // An empty field keeps the secret the config file points at, as the CLI's login does; one it has no secret for stays unset.
  const kept = (f: AreaInfo['connection'][number]) => c.values[f.name] === 'store' || c.values[f.name] === 'file';
  const rules = (f: AreaInfo['connection'][number]): SecretRules => ({ password: f.password, empty: kept(f) ? 'keep' : 'skip' });
  return (
    <ChangeForm
      title={`Update ${c.name}'s login`}
      explain={`Saves what you type in this computer's secure store, checks it can be read back, and only then switches ${c.name} to it and deletes the old one. A field left empty keeps what is there. Toil UI doesn't keep what you type: it goes straight to Toil, and the fields are cleared.`}
      submit="Save securely"
      disabled={config.disabled}
      blockedBy={confirm && !sure ? 'Tick the box to confirm the replacement first.' : null}
      onSubmit={async () => {
        const refused = secrets.refusal(fields.map((f) => [f.name, values[f.name] ?? '', rules(f)]));
        if (refused) return refused;
        // Every field shown is answered, an empty one with '': toil keeps that secret as it is, as on the CLI.
        const typed = Object.fromEntries(fields.map((f) => [f.name, values[f.name] ?? '']));
        const answers = secrets.answers();
        setValues({});
        secrets.reset();
        return after(await config.run('connections login', { name: c.name }, { secrets: typed, answers }), `${c.name}'s login was updated.`);
      }}
    >
      {confirm && <CheckField label={confirm} checked={sure} onChange={setSure} />}
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


function AddConnection({ areas, config, onChanged, existingNames, startOpen }: { areas: AreaInfo[] | null; config: ConfigApi; onChanged: () => Promise<void>; existingNames: string[]; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  // A link to the form while this page is already open (the address changes, the page doesn't remount) opens it too.
  useEffect(() => {
    if (startOpen) setOpen(true);
  }, [startOpen]);
  const withFields = (areas ?? []).filter((a) => a.connection.length > 0);
  if (areas === null) return null;
  if (withFields.length === 0) {
    return (
      <Card as="section" className="panel" aria-labelledby="conn-add">
        <h2 id="conn-add">Add a connection</h2>
        <p>This version of Toil can't add connections from this page.</p>
      </Card>
    );
  }
  if (!open) {
    return (
      <div className="panel-actions">
        <button type="button" id="conn-add" className="btn btn--accent" onClick={() => setOpen(true)} data-add-connection="">
          Add a connection
        </button>
      </div>
    );
  }
  return (
    <Card as="section" className="panel" aria-labelledby="conn-add">
      <h2 id="conn-add">Add a connection</h2>
      <NewConnectionForm
        areas={withFields}
        config={config}
        onAdded={async () => {
          await onChanged();
          setOpen(false);
        }}
        existingNames={existingNames}
      />
    </Card>
  );
}

/**
 * The form `toil connections add` is from the page, in Settings and in the
 * setup wizard. What it asks, what it requires and when Save is allowed are
 * all `src/core/connection-form.ts`, derived from the area itself: leading
 * radio choices (Cloud or Data Center, GitHub.com or Enterprise Server), the
 * address made from them, fields that only apply to one choice appearing only
 * for it, and a live "required" or "optional" on each. With `area`, it adds a
 * connection to that area only, and `suggest` fills the name and settings in
 * (Set up this repo offers a base URL on the toil project's host); the person
 * can change any of them before saving. `existingNames` are the connections
 * that already exist: a name taken is refused here, and replacing one is a
 * different, explicit action.
 */
export function NewConnectionForm({
  areas,
  config,
  onAdded,
  area: fixed,
  suggest,
  title = 'A new connection',
  existingNames = [],
  onDraft,
}: {
  areas: AreaInfo[];
  config: ConfigApi;
  onAdded: (name: string) => Promise<void>;
  area?: string;
  suggest?: { name?: string; values?: Record<string, string> };
  title?: string;
  existingNames?: string[];
  /** Told the settings the form would send as they change: the non-secret ones only (src/core/connection-form.ts `submission`), for the wizard's guide (#561). */
  onDraft?: (settings: Record<string, string>) => void;
}) {
  const withFields = areas.filter((a) => a.connection.length > 0 && (fixed === undefined || a.name === fixed));
  const [area, setArea] = useState(fixed ?? '');
  const chosenArea = withFields.find((a) => a.name === area) ?? withFields[0];
  const [form, setForm] = useState<FormState>(() => (chosenArea ? initialState(chosenArea, suggest) : emptyState(suggest?.name)));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [pressed, setPressed] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const secretChoices = useSecretChoices();
  if (!chosenArea) return <p className="note">This version of Toil can't say what a {toolName(fixed ?? '')} connection holds, so it can't be added from this page.</p>;

  const fields = chosenArea.connection;
  const kinds = chosenArea.scopes?.kinds ?? [];
  const state: FormState = { ...form, tokenKind: form.tokenKind ?? kinds[0]?.id ?? null };
  const envVars = () => [`${connectionEnvVar(state.name || '<name>', 'area')}=${chosenArea.name}`, ...fields.map((g) => connectionEnvVar(state.name || '<name>', g.name))];
  const rulesFor = (f: FormField): SecretRules => ({ password: f.password, empty: needOf(chosenArea, f, state) === 'required' ? 'required' : 'skip', envVars: envVars() });
  const report = reportOf(chosenArea, state, existingNames, rulesFor);
  const sent = submission(chosenArea, report);
  const touch = (name: string) => setTouched((t) => (t[name] ? t : { ...t, [name]: true }));
  const shown = (name: string): Problem[] => (touched[name] || pressed ? (report.problems[name] ?? []) : []);
  const setText = (name: string, v: string) => setForm((s) => ({ ...s, text: { ...s.text, [name]: v } }));
  const setSecret = (name: string, v: string) => {
    setForm((s) => ({ ...s, secrets: { ...s.secrets, [name]: v } }));
    secretChoices.changed(name);
  };

  const pick = (name: string, index: number) => {
    touch(name);
    const { state: next, notes: cleared } = afterChoice(chosenArea, state, name, index);
    // An address typed for one choice means nothing under another: start it over rather than carry it across.
    for (const f of fields) {
      if (f.name === name || !f.choices?.options.some((o) => o.when)) continue;
      const before = selectedOption(chosenArea, f, state)?.index;
      if (before !== undefined && before !== selectedOption(chosenArea, f, next)?.index) delete next.text[f.name];
    }
    setForm(next);
    setNotes(cleared);
  };
  const onSwitch = (p: Problem) => {
    if (p.switchTo) pick(p.switchTo.field, p.switchTo.index);
    if (p.switchToken) setForm((s) => ({ ...s, tokenKind: p.switchToken! }));
  };
  const focusFirstMissing = () => {
    setPressed(true);
    const target = report.blockers[0]?.field;
    queueMicrotask(() => {
      const el = target ? document.querySelector<HTMLElement>(`[data-field="${target}"]`) : null;
      (el?.matches('input,select,textarea') ? el : el?.querySelector<HTMLElement>('input,[role="radio"]'))?.focus();
    });
  };

  const secretFields = fields.filter((f) => f.secret && report.needs[f.name] !== 'hidden');
  const settings = fields.filter((f) => !f.secret && report.needs[f.name] !== 'hidden');
  const lead = settings.filter((f) => f.choices?.required);
  const ready = chosen(chosenArea, state);
  const main = settings.filter((f) => !f.choices?.required && (report.needs[f.name] === 'required' || f.choices));
  const optional = settings.filter((f) => !f.choices?.required && !main.includes(f));
  const labelOf = (f: FormField) => (f.name === 'baseUrl' ? 'Address' : f.name);

  const choiceField = (f: FormField) => {
    const options = shownOptions(chosenArea, f, state);
    const sel = selectedOption(chosenArea, f, state);
    const need = report.needs[f.name]!;
    const compose = sel?.option.compose;
    const box = sel && sel.option.value === null && (
      <TextField
        field={f.name}
        label={compose?.label ?? labelOf(f)}
        value={form.text[f.name] ?? ''}
        onChange={(v) => setText(f.name, v)}
        onBlur={() => touch(f.name)}
        need={need}
        info={f.description}
        placeholder={compose?.placeholder ?? sel.option.placeholder}
        problems={shown(f.name)}
        onSwitch={onSwitch}
        affix={compose ? { before: compose.prefix, after: compose.suffix ?? '' } : undefined}
        hint={compose && report.settings[f.name] ? <>Address: <code>{report.settings[f.name]}</code></> : undefined}
      />
    );
    return (
      <div key={f.name} className="choice-field" data-choice={f.name}>
        {(options.length > 1 || f.choices?.required) && (
          <ChoiceRadios
            label={f.choices?.question ?? labelOf(f)}
            field={f.name}
            need={f.choices?.required ? 'required' : undefined}
            selected={sel ? String(sel.index) : null}
            onChange={(k) => pick(f.name, Number(k))}
            options={options.map(({ option, index }) => ({ key: String(index), label: option.label }))}
          />
        )}
        {f.choices?.required ? null : box || (sel && <p className="note">Uses <code>{sel.option.value}</code>.</p>)}
      </div>
    );
  };

  const plainField = (f: FormField) => (
    <TextField key={f.name} field={f.name} label={f.name} value={form.text[f.name] ?? ''} onChange={(v) => setText(f.name, v)} onBlur={() => touch(f.name)} need={report.needs[f.name]} info={f.description} placeholder={f.default ?? undefined} problems={shown(f.name)} onSwitch={onSwitch} />
  );

  return (
    <>
    {onDraft && <DraftReporter settings={sent} onDraft={onDraft} />}
    <ChangeForm
      title={title}
      explain={
        <>
          The login is saved in this computer's secure store, never in a file. The first connection to a tool becomes its main one. Writes start off.
        </>
      }
      submit="Save connection"
      disabled={config.disabled}
      blockedBy={report.blockers[0]?.reason ?? null}
      onBlocked={focusFirstMissing}
      onSubmit={async () => {
        const answers: Record<string, string> = { confirm: 'y' };
        // Only what applies is sent; every other setting is answered empty, which saves nothing for it.
        for (const f of fields.filter((g) => !g.secret)) answers[`setting:${f.name}`] = sent[f.name] ?? '';
        const refused = secretChoices.refusal(secretFields.map((f) => [f.name, form.secrets[f.name] ?? '', rulesFor(f)]));
        if (refused) return refused;
        Object.assign(answers, secretChoices.answers());
        const typed = Object.fromEntries(fields.filter((f) => f.secret).map((f) => [f.name, report.needs[f.name] === 'hidden' ? '' : (form.secrets[f.name] ?? '')]));
        const name = state.name;
        setForm((s) => ({ ...s, secrets: {} }));
        secretChoices.reset();
        const envelope = await config.run('connections add', { name, area: chosenArea.name }, { answers, secrets: typed });
        const outcome = outcomeOf(envelope, `${name} was added.`);
        if (outcome.ok) {
          setForm(emptyState());
          setTouched({});
          setPressed(false);
          setNotes([]);
          await onAdded(name);
        }
        return outcome;
      }}
    >
      <TextField field="name" label="Name" value={form.name} onChange={(v) => setForm((s) => ({ ...s, name: v }))} onBlur={() => touch('name')} need="required" hint="Lowercase letters, digits and single hyphens, e.g. corp-jira." problems={shown('name')} />
      {fixed === undefined && (
        <SelectField
          label="Tool"
          value={chosenArea.name}
          onChange={(v) => {
            setArea(v);
            setForm((s) => ({ ...emptyState(s.name) }));
            setTouched({});
            setNotes([]);
            secretChoices.reset();
          }}
          options={withFields.map((a) => ({ value: a.name, label: areaLabel(a.name) }))}
          hint={chosenArea.description}
        />
      )}
      {lead.map(choiceField)}
      {notes.length > 0 && (
        <ul className="plain" role="status" data-cleared="">
          {notes.map((n) => (
            <li key={n} className="note">
              {n}
            </li>
          ))}
        </ul>
      )}
      {ready && (
        <>
          {main.map((f) => (f.choices ? choiceField(f) : plainField(f)))}
          {kinds.length > 1 && chosenArea.scopes && <TokenKindRadios scopes={chosenArea.scopes} kindId={state.tokenKind ?? kinds[0]!.id} onKind={(id) => setForm((s) => ({ ...s, tokenKind: id }))} />}
          {secretFields.map((f) => (
            <SecretField
              key={f.name}
              field={f.name}
              label={`${f.name}${f.password ? ', a password' : ''}`}
              info={f.description}
              need={report.needs[f.name]}
              value={form.secrets[f.name] ?? ''}
              onChange={(v) => setSecret(f.name, v)}
              onBlur={() => touch(f.name)}
              rules={rulesFor(f)}
              asking={secretChoices.asking}
              kept={secretChoices.kept(f.name)}
              onKeep={() => secretChoices.keep(f.name)}
              problems={shown(f.name)}
              onSwitch={onSwitch}
              hint="Saved in this computer's secure store; never shown again."
            />
          ))}
          {chosenArea.scopes && <ScopesDisclosure scopes={chosenArea.scopes} kindId={state.tokenKind ?? kinds[0]!.id} />}
          {optional.length > 0 && (
            <details className="more">
              <summary>Optional settings ({optional.length})</summary>
              {optional.map(plainField)}
            </details>
          )}
        </>
      )}
    </ChangeForm>
    </>
  );
}

/** Says what the form would send, as it changes. Renders nothing: it only carries the non-secret settings out, which are everything it is given. */
function DraftReporter({ settings, onDraft }: { settings: Record<string, string>; onDraft: (settings: Record<string, string>) => void }) {
  const key = JSON.stringify(settings);
  useEffect(() => onDraft(JSON.parse(key) as Record<string, string>), [key, onDraft]);
  return null;
}
