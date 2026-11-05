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
export function SourceBadges({ sources, toilProject }: { sources: Array<{ area: string; connection: string | null }>; toilProject?: string }) {
  const edit = toilProject ? <EditLink href={toilProjectEditHref(toilProject, 'sources')} label={`Edit ${toilProject}'s sources`} /> : null;
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

/** In progress, blocked and waiting on review, as a strip of figures; with the sprint's days left when one runs. */
export function CountStrip({ preview, sprint = true }: { preview: ToilProjectPreview; sprint?: boolean }) {
  const s = preview.sprint;
  const { pw } = usePlain();
  return (
    <ul className="count-strip" aria-label="Counts">
      {sprint && s && <Count value={String(s.daysLeft)} label={`${s.daysLeft === 1 ? 'day' : 'days'} left`} />}
      <Count value={String(preview.inProgress)} label="in progress" />
      <Count value={String(preview.blocked)} label="blocked" tone={preview.blocked ? 'warn' : undefined} />
      <Count value={String(preview.awaitingReview)} label={preview.awaitingReview === 1 ? pw('PR waits on review', 'code review waiting') : pw('PRs wait on review', 'code reviews waiting')} />
    </ul>
  );
}

function Count({ value, label, tone }: { value: string; label: string; tone?: 'warn' | undefined }) {
  return (
    <li className={`count${tone ? ` count--${tone}` : ''}`}>
      <span className="count__value">{value}</span> <span className="count__label">{label}</span>
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
}: {
  field: 'name' | 'description';
  toilProject: string;
  value: string | null;
  config: ConfigApi | null;
  onSaved: (d: Described) => void;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
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
    if (editing) input.current?.select();
    else if (back.current) {
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
        {config && !config.disabled && (
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
