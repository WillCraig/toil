/**
 * The parts a toil project's card and its dashboard's header share (#342): its
 * sources as badges, the strip of counts, the small burn-up, and its name and
 * description, each edited in place. An edit runs `toil projects describe`
 * through the settings pages' path (src/config.ts), so it goes through toil's
 * own checks and lands in toil's audit log as `caller: "toil-ui"`. Toil UI
 * never writes the toil project file itself. Amendments are accepted at the
 * counter, in pencil, and countersigned by the clerk who keeps the ledger.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ConfigApi } from '../config.ts';
import { toilProjectEditHref, sourceLabel as label } from '../format.ts';
import { EditLink } from './help.tsx';
import { matches } from '../shortcuts.ts';
import type { ToilProjectPreview, PreviewSprint } from '../model/preview.ts';
import { usePlain } from '../plain-words.ts';
import './toil-project-head.css';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The areas a toil project reads, as badges, each with the connection it uses. With
 * `toil project`, a pencil after them opens that toil project's sources in Toil project setup (#346).
 */
export function SourceBadges({ sources, toilProject, bare = false }: { sources: Array<{ area: string; connection: string | null }>; toilProject?: string; bare?: boolean }) {
  const edit = toilProject && !bare ? <EditLink href={toilProjectEditHref(toilProject, 'sources')} label={`Edit ${toilProject}'s sources`} /> : null;
  if (!sources.length)
    return (
      <p className="note">
        No sources linked yet. {edit}
      </p>
    );
  return (
    <div className="source-badges">
      <ul className="badges" aria-label="Sources">
        {sources.map((s) => (
          <li key={s.area} className="badge" title={s.connection ? `${label(s.area)}, connection ${s.connection}` : `${label(s.area)}, your default connection`}>
            {label(s.area)}
            {s.connection && <span className="sr-only">, connection {s.connection}</span>}
          </li>
        ))}
      </ul>
      {edit}
    </div>
  );
}

/**
 * In progress, blocked and waiting on review, as a strip of figures; with the sprint's days left when one runs.
 * `read` is false when nothing has been read for this Toil project yet (it has never synced): its figures are
 * unknown, not zero, so each shows a dash (principle 12).
 */
export function CountStrip({ preview, sprint = true, read = true }: { preview: ToilProjectPreview; sprint?: boolean; read?: boolean }) {
  const s = preview.sprint;
  const { pw } = usePlain();
  const figure = (n: number) => (read ? String(n) : null);
  return (
    <ul className="count-strip" aria-label="Counts">
      {sprint && s && read && <Count value={String(s.daysLeft)} label={`${s.daysLeft === 1 ? 'day' : 'days'} left`} />}
      <Count value={figure(preview.inProgress)} label="in progress" />
      <Count value={figure(preview.blocked)} label="blocked" tone={read && preview.blocked ? 'warn' : undefined} />
      <Count value={figure(preview.awaitingReview)} label={preview.awaitingReview === 1 && read ? pw('PR waits on review', 'code review waiting') : pw('PRs wait on review', 'code reviews waiting')} />
    </ul>
  );
}

/** A figure, or null for one nobody has read yet: shown as a dash and said as "not read yet", never as 0. */
function Count({ value, label, tone }: { value: string | null; label: string; tone?: 'warn' | undefined }) {
  return (
    <li className={`count${tone ? ` count--${tone}` : ''}${value === null ? ' count--unknown' : ''}`}>
      {value === null ? (
        <>
          <span className="count__value" aria-hidden="true">
            –
          </span>
          <span className="sr-only">not read yet, </span>
        </>
      ) : (
        <span className="count__value">{value}</span>
      )}{' '}
      <span className="count__label">{label}</span>
    </li>
  );
}

/**
 * A burn-up the size of a word: scope and done points by day. It is drawn
 * for the eye only; its label says the same in words.
 */
export function MiniBurnup({ sprint }: { sprint: PreviewSprint }) {
  const days = sprint.burn;
  const top = Math.max(1, ...days.map((d) => d.scope));
  const span = Math.max(1, days.length - 1 + sprint.ahead);
  const x = (i: number) => (100 * i) / span;
  const y = (v: number) => 28 - (26 * v) / top;
  const line = (pick: (d: { scope: number; done: number }) => number) => days.map((d, i) => `${x(i).toFixed(1)},${y(pick(d)).toFixed(1)}`).join(' ');
  return (
    <svg className="mini-burnup" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={`Burn-up: ${sprint.done} of ${sprint.scope} points done`}>
      {days.length > 1 && (
        <>
          <polyline className="mini-burnup__scope" points={line((d) => d.scope)} vectorEffect="non-scaling-stroke" />
          <polyline className="mini-burnup__done" points={line((d) => d.done)} vectorEffect="non-scaling-stroke" />
        </>
      )}
    </svg>
  );
}

/**
 * A week of something, one point a day, as a small line with its total beside
 * it and the figures in words for a screen reader. Null counts are unknown, so
 * they draw a dash and no line (principle 12), never a flat zero.
 */
export function Trend({ label, days }: { label: string; days: number[] | null }) {
  if (days === null) {
    return (
      <li className="trend trend--unknown">
        <span className="trend__label">{label}</span>
        <span className="trend__total" aria-label={`${label}: not read yet`}>
          –
        </span>
      </li>
    );
  }
  const total = days.reduce((a, b) => a + b, 0);
  const top = Math.max(1, ...days);
  const x = (i: number) => (100 * i) / Math.max(1, days.length - 1);
  const y = (v: number) => 18 - (16 * v) / top;
  return (
    <li className="trend">
      <span className="trend__label">{label}</span>
      <span className="trend__total">{total}</span>
      <svg className="trend__line" viewBox="0 0 100 20" preserveAspectRatio="none" role="img" aria-label={`${label}, past ${days.length} days, oldest first: ${days.join(', ')}. ${total} in all.`}>
        <polyline points={days.map((d, i) => `${x(i).toFixed(1)},${y(d).toFixed(1)}`).join(' ')} vectorEffect="non-scaling-stroke" />
      </svg>
    </li>
  );
}

/** The sprint in one line: its name, the days left, and the points done. */
export function SprintLine({ sprint }: { sprint: PreviewSprint }) {
  return (
    <p className="sprint-line">
      <span className="sprint-line__name">{sprint.name}</span>{' '}
      <span className="note">
        {plural(sprint.daysLeft, 'working day')} left of {sprint.daysTotal}, {sprint.done} of {plural(sprint.scope, 'point')} done
      </span>
    </p>
  );
}

export type Described = { name: string; description: string | null; renamed: { from: string; to: string } | null };

/** The name and description edited together: one form, one Save, one `projects describe` call holding only what changed. */
export function EditDetails({ toilProject, name, description, config, onSaved, onClose }: { toilProject: string; name: string; description: string | null; config: ConfigApi | null; onSaved: (d: Described) => void; onClose: () => void }) {
  const [nameText, setName] = useState(name);
  const [descText, setDesc] = useState(description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fix: string | null } | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => first.current?.select(), []);
  const submit = async () => {
    if (!config || busy) return;
    const input: Record<string, unknown> = { toilProject };
    if (nameText.trim() !== name) input.name = nameText.trim();
    if (descText.trim() !== (description ?? '')) input.description = descText.trim();
    if (Object.keys(input).length === 1) return onClose();
    setBusy(true);
    setError(null);
    try {
      const env = await config.run('projects describe', input);
      if (!env.ok) return setError({ message: env.error.message, fix: env.error.fix ?? null });
      const data = env.data as { name: string; description: string | null; renamed: { from: string; to: string } | null };
      onClose();
      onSaved({ name: data.name, description: data.description ?? null, renamed: data.renamed ? { from: data.renamed.from, to: data.renamed.to } : null });
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e), fix: null });
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (matches('editCancel', e)) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <form
      className="edit-details"
      aria-label={`Edit ${toilProject}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={`${id}-name`}>Name</label>
      <input ref={first} id={`${id}-name`} className="edit-field" value={nameText} disabled={busy} maxLength={64} autoComplete="off" aria-invalid={error ? true : undefined} onChange={(e) => setName(e.target.value)} onKeyDown={onKey} />
      <span className="edit-hint note">Lowercase letters, digits and hyphens.</span>
      <label htmlFor={`${id}-desc`}>Description</label>
      <input id={`${id}-desc`} className="edit-field" value={descText} disabled={busy} maxLength={300} spellCheck autoComplete="off" onChange={(e) => setDesc(e.target.value)} onKeyDown={onKey} />
      {error && (
        <span role="alert" className="edit-error failure">
          {error.message}
          {error.fix && <span className="note"> Fix: {error.fix}</span>}
        </span>
      )}
      <span className="edit-details__actions">
        <button type="submit" className="btn btn--accent btn--small" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn--small" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </span>
    </form>
  );
}

/**
 * The name or the description, with a pencil beside it that opens an inline
 * field. Enter saves through `toil projects describe`, Escape cancels, and a
 * refusal shows toil's message and fix under the field, which stays open.
 * Without a config path that may change anything (the preview), there's no
 * pencil.
 */
export function Editable({
  field,
  toilProject,
  value,
  config,
  onSaved,
  children,
  open,
  onOpenChange,
  bare = false,
}: {
  field: 'name' | 'description';
  toilProject: string;
  value: string | null;
  config: ConfigApi | null;
  onSaved: (d: Described) => void;
  children: ReactNode;
  /** Open or closed from outside (a card's menu says Edit); absent, the pencil beside it decides. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** No pencil: something else opens the field. */
  bare?: boolean;
}) {
  const [inner, setInner] = useState(false);
  const editing = open ?? inner;
  const setEditing = (next: boolean) => (onOpenChange ? onOpenChange(next) : setInner(next));
  const [text, setText] = useState(value ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fix: string | null } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const pencil = useRef<HTMLButtonElement>(null);
  const back = useRef(false);
  const id = useId();
  const { pw } = usePlain();
  const what = field === 'name' ? `Rename ${toilProject}` : value ? `Edit ${toilProject}'s description` : `Add a description to ${toilProject}`;

  useEffect(() => {
    if (editing) {
      setText(value ?? '');
      const t = setTimeout(() => input.current?.select(), 0);
      return () => clearTimeout(t);
    }
    if (back.current) {
      back.current = false;
      pencil.current?.focus();
    }
  }, [editing]);

  const close = () => {
    back.current = true;
    setEditing(false);
    setError(null);
  };
  const save = async () => {
    if (!config || busy) return;
    const next = text.trim();
    if (next === (value ?? '')) return close();
    setBusy(true);
    setError(null);
    try {
      const env = await config.run('projects describe', { toilProject, [field]: next });
      if (!env.ok) {
        setError({ message: env.error.message, fix: env.error.fix ?? null });
        return;
      }
      const data = env.data as { name: string; description: string | null; renamed: { from: string; to: string } | null };
      back.current = field === 'description';
      setEditing(false);
      onSaved({ name: data.name, description: data.description ?? null, renamed: data.renamed ? { from: data.renamed.from, to: data.renamed.to } : null });
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e), fix: null });
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (matches('editSave', e)) {
      e.preventDefault();
      void save();
    } else if (matches('editCancel', e)) {
      e.preventDefault();
      e.stopPropagation();
      setText(value ?? '');
      close();
    }
  };

  if (!editing || !config || config.disabled) {
    return (
      <span className={`editable editable--${field}`}>
        {children}
        {config && !config.disabled && !bare && (
          <button
            ref={pencil}
            type="button"
            className="btn btn--small edit-pencil"
            data-edit=""
            aria-label={what}
            title={what}
            onClick={() => {
              setText(value ?? '');
              setEditing(true);
            }}
          >
            <span aria-hidden="true">✎</span>
          </button>
        )}
      </span>
    );
  }
  return (
    <span className={`editable editable--${field} editable--open`}>
      <label className="sr-only" htmlFor={id}>
        {field === 'name' ? `New name for ${toilProject}` : `Description of ${toilProject}`}
      </label>
      <input
        ref={input}
        id={id}
        className="edit-field"
        value={text}
        disabled={busy}
        maxLength={field === 'name' ? 64 : 300}
        spellCheck={field === 'description'}
        autoComplete="off"
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
        aria-invalid={error ? true : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <span id={`${id}-hint`} className="edit-hint note">
        {busy ? pw('Saving through toil projects describe…', 'Saving…') : field === 'name' ? pw('Enter renames it with toil projects describe; Escape cancels. Lowercase letters, digits and hyphens.', 'Enter renames it; Escape cancels. Lowercase letters, digits and hyphens.') : pw('Enter saves it with toil projects describe; Escape cancels.', 'Enter saves it; Escape cancels.')}
      </span>
      {error && (
        <span id={`${id}-error`} role="alert" className="edit-error failure">
          {error.message}
          {error.fix && <span className="note"> Fix: {error.fix}</span>}
        </span>
      )}
    </span>
  );
}
