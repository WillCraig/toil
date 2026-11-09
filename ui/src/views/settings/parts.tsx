/**
 * Pieces the settings pages share: the outcome of one toil call (a status
 * line, or an alert with toil's message and fix), the form every change is
 * made through (what it does, the command it runs, and the one button that
 * runs it), and the labelled fields inside it. Native form controls
 * throughout: each is accessible as it comes, and every theme styles them.
 */

import { useId, useState, type ClipboardEvent, type FormEvent, type ReactNode } from 'react';
import { checkSecret, type SecretCheck, type SecretRules } from '../../../../src/core/secret-input.ts';
import type { Need, Problem } from '../../../../src/core/connection-form.ts';
import { RadioGroup, Radio } from 'react-aria-components';
import type { Envelope } from '../../toil.ts';

export type Outcome = { ok: true; message: string; warnings: string[] } | { ok: false; message: string; fix: string | null };

export function outcomeOf(envelope: Envelope, done: string): Outcome {
  if (envelope.ok) return { ok: true, message: done, warnings: (envelope.meta.warnings ?? []).map((w) => w.message) };
  return { ok: false, message: envelope.error.message, fix: envelope.error.fix ?? null };
}

export function failedOutcome(e: unknown): Outcome {
  return { ok: false, message: e instanceof Error ? e.message : String(e), fix: null };
}

export function OutcomeLine({ outcome }: { outcome: Outcome | null }) {
  // The live region is always there, so a screen reader hears the outcome when it fills in.
  if (!outcome) return <div role="status" className="outcome-line" />;
  if (outcome.ok) {
    return (
      <div role="status" className="outcome-line outcome-line--ok">
        <p>{outcome.message}</p>
        {outcome.warnings.length > 0 && (
          <ul className="plain">
            {outcome.warnings.map((w, i) => (
              <li key={i} className="note">
                {w}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div role="alert" className="outcome-line outcome-line--failed failure">
      <p>{outcome.message}</p>
      {outcome.fix && <p className="note">Fix: {outcome.fix}</p>}
    </div>
  );
}

/** `toil connections writes 'corp-jira' on`, for the line saying what a form runs. Shown, never run by a shell. */
export function commandLine(command: string, args: string[] = []): string {
  return ['toil', command, ...args].join(' ');
}

/**
 * One change: a heading, what it does in plain words, the command it runs,
 * its fields, and one submit button. `disabled` says why it can't run (the
 * preview), beside the button.
 */
export function ChangeForm({
  title,
  explain,
  submit,
  disabled,
  onSubmit,
  children,
  danger = false,
  titleId,
  blockedBy = null,
  onBlocked,
  quietTitle = false,
}: {
  /** The heading only repeats the section it sits in: it stays for screen readers and for a link to land on, but isn't drawn. */
  quietTitle?: boolean;
  /** Why Save can't run yet, in one line ("Choose Cloud or Data Center first"). The button stays and says so; pressing it points at what's missing. */
  blockedBy?: string | null;
  onBlocked?: () => void;
  /** The heading's id, for a form an edit link lands on (#346); it then takes focus there. */
  titleId?: string;
  title: string;
  explain: ReactNode;
  submit: string;
  disabled: string | null;
  onSubmit: () => Promise<Outcome>;
  children?: ReactNode;
  danger?: boolean;
}) {
  const own = useId();
  const id = titleId ?? own;
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const handle = async (e: FormEvent) => {
    e.preventDefault();
    if (disabled || busy) return;
    if (blockedBy) return onBlocked?.();
    setBusy(true);
    setOutcome(null);
    try {
      setOutcome(await onSubmit());
    } catch (err) {
      setOutcome(failedOutcome(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="change" aria-labelledby={titleId ?? `${id}-title`} onSubmit={handle} noValidate>
      <h3 id={titleId ?? `${id}-title`} tabIndex={titleId ? -1 : undefined} className={quietTitle ? 'sr-only' : undefined}>
        {title}
      </h3>
      <p className="explain">{explain}</p>
      {children}
      <div className="change-actions">
        <button type="submit" className={`btn ${danger ? 'btn--danger' : 'btn--accent'}`} disabled={disabled !== null || busy} aria-disabled={blockedBy ? true : undefined} data-blocked={blockedBy ? '' : undefined} aria-describedby={disabled ? `${id}-off` : blockedBy ? `${id}-blocked` : undefined}>
          {busy ? 'Running…' : submit}
        </button>
        {blockedBy && !disabled && (
          <span id={`${id}-blocked`} className="note" aria-live="polite">
            {blockedBy}
          </span>
        )}
        {disabled && (
          <span id={`${id}-off`} className="note">
            Turned off: {disabled}
          </span>
        )}
      </div>
      <OutcomeLine outcome={outcome} />
    </form>
  );
}

export function NeedBadge({ need }: { need: Need }) {
  if (need === 'hidden') return null;
  return <span className={`need need--${need}`}> {need}</span>;
}

/** The long vendor sentence, one press away: the label stays short (principle 11). */
export function Info({ label, text }: { label: string; text: string | null }) {
  if (!text) return null;
  return (
    <details className="info">
      <summary aria-label={`About ${label}`}>
        <span aria-hidden="true">i</span>
      </summary>
      <p className="note info__text">{text}</p>
    </details>
  );
}

/** What a form says under a field: a note, a warning or an error, each with its fix, and a Switch when the fix is a choice. */
export function Problems({ problems, onSwitch }: { problems: Problem[]; onSwitch?: ((p: Problem) => void) | undefined }) {
  if (problems.length === 0) return null;
  return (
    <ul className="plain problems">
      {problems.map((p, i) => (
        <li key={i} className={`note problem problem--${p.level}${p.level === 'error' ? ' failure' : ''}`} role={p.level === 'error' ? 'alert' : undefined}>
          {p.message}
          {p.fix && <> {p.fix}</>}
          {(p.switchTo || p.switchToken) && onSwitch && (
            <>
              {' '}
              <button type="button" className="btn btn--small btn--quiet" onClick={() => onSwitch(p)}>
                Switch
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  type = 'text',
  required = false,
  autoComplete = 'off',
  placeholder,
  need,
  info,
  problems,
  onSwitch,
  onBlur,
  field,
  affix,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  type?: 'text' | 'password' | 'url';
  required?: boolean;
  autoComplete?: string;
  placeholder?: string | undefined;
  /** The live "required" / "optional" badge, which replaces the plain "(required)". */
  need?: Need | undefined;
  info?: string | null | undefined;
  problems?: Problem[] | undefined;
  onSwitch?: ((p: Problem) => void) | undefined;
  onBlur?: (() => void) | undefined;
  /** The setting this is, so a form can move focus to it. */
  field?: string | undefined;
  /** Fixed text around the box (`https://` and `.atlassian.net`). */
  affix?: { before?: string; after?: string } | undefined;
}) {
  const id = useId();
  const hasHint = Boolean(hint) || (problems?.length ?? 0) > 0;
  const input = (
    <input
      id={id}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      aria-describedby={hasHint ? `${id}-hint` : undefined}
      required={need === undefined ? required : need === 'required'}
      autoComplete={autoComplete}
      spellCheck={false}
      placeholder={placeholder}
      data-field={field}
    />
  );
  return (
    <div className="field-row">
      <div className="field-row__head">
        <label htmlFor={id}>
          {label}
          {need ? <NeedBadge need={need} /> : required && <span className="req"> (required)</span>}
        </label>
        {info !== undefined && <Info label={label} text={info} />}
      </div>
      {affix ? (
        <div className="affix">
          {affix.before && <span aria-hidden="true">{affix.before}</span>}
          {input}
          {affix.after && <span aria-hidden="true">{affix.after}</span>}
        </div>
      ) : (
        input
      )}
      {hasHint && (
        <div id={`${id}-hint`}>
          {hint && <p className="note">{hint}</p>}
          {problems && <Problems problems={problems} onSwitch={onSwitch} />}
        </div>
      )}
    </div>
  );
}

/** Radio buttons for a choice the person makes: the options, one selected or none yet. */
export function ChoiceRadios({
  label,
  options,
  selected,
  onChange,
  need,
  hint,
  field,
}: {
  label: string;
  options: Array<{ key: string; label: string; note?: string | undefined }>;
  selected: string | null;
  onChange: (key: string) => void;
  need?: Need | undefined;
  hint?: ReactNode;
  field?: string | undefined;
}) {
  return (
    <RadioGroup className="agent-adapters" value={selected} aria-label={label} onChange={onChange} isRequired={need === 'required'} data-field={field}>
      <span className="agent-label">
        {label}
        {need && <NeedBadge need={need} />}
      </span>
      {options.map((o) => (
        <Radio key={o.key} value={o.key} className="agent-choice">
          <strong>{o.label}</strong>
          {o.note && <span className="note">{o.note}</span>}
        </Radio>
      ))}
      {hint && <p className="note">{hint}</p>}
    </RadioGroup>
  );
}

export function AreaField({ label, value, onChange, hint, rows = 3 }: { label: string; value: string; onChange: (v: string) => void; hint?: ReactNode; rows?: number }) {
  const id = useId();
  return (
    <div className="field-row">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} spellCheck={false} />
      {hint && (
        <p id={`${id}-hint`} className="note">
          {hint}
        </p>
      )}
    </div>
  );
}

export function SelectField({ label, value, onChange, options, hint }: { label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="field-row">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && (
        <p id={`${id}-hint`} className="note">
          {hint}
        </p>
      )}
    </div>
  );
}

export function CheckField({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="field-row field-row--check">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-hint` : undefined} />
      <label htmlFor={id}>{label}</label>
      {hint && (
        <p id={`${id}-hint`} className="note">
          {hint}
        </p>
      )}
    </div>
  );
}

/** What a secret field's live note says: the length, what trimming removes, or what an empty one means. Never any of the value. */
export function secretNote(check: SecretCheck): string {
  if (check.status === 'empty') return check.empty === 'keep' ? 'Empty: the current secret is kept' : check.empty === 'required' ? 'Empty: this one is required' : 'Empty: none is stored';
  if (check.status === 'refused') return `${check.message} ${check.fix}`;
  return `${check.length} character${check.length === 1 ? '' : 's'}${check.removed ? ` (removed ${check.removed})` : ''}`;
}

/** A wrapper's question as a form asks it: the terminal's words, without the terminal's [Y/n]. */
export const wrapperQuestion = (check: SecretCheck): string | null => (check.status === 'ok' && check.wrapper ? check.wrapper.question.replace(/ \[Y\/n\]$/, '') : null);

/**
 * The checks a form runs on submit (#358), with the terminal's words: a refused
 * or empty required secret stops the request, and so does a wrapper the person
 * hasn't decided about yet. Null means send it.
 */
export function secretRefusal(name: string, check: SecretCheck, kept: boolean): Outcome | null {
  if (check.status === 'refused') return { ok: false, message: `${name}: ${check.message}`, fix: check.fix };
  if (check.status === 'empty' && check.empty === 'required') return { ok: false, message: `${name}: ${check.message}`, fix: check.fix };
  const question = wrapperQuestion(check);
  if (question && !kept) return { ok: false, message: `${name}: ${question}`, fix: `Choose Remove it or Keep it under ${name}, then save again.` };
  return null;
}

/**
 * A password field for a secret, with a live note under it saying how many
 * characters arrived (#358), checked by `checkSecret()`, the function toil's
 * terminal uses, so both say the same. The value is never shown: there is no
 * Show toggle. A browser drops line breaks from a pasted password, so a paste
 * that has them is kept as it came, for the check to refuse one in the middle
 * rather than silently join two lines. `asking` shows the wrapper question with
 * Remove it and Keep it.
 */
export function SecretField({ label, value, onChange, rules, asking, kept, onKeep, hint, need, info, problems, onSwitch, onBlur, field }: { need?: Need | undefined; info?: string | null | undefined; problems?: Problem[] | undefined; onSwitch?: ((p: Problem) => void) | undefined; onBlur?: (() => void) | undefined; field?: string | undefined; label: string; value: string; onChange: (v: string) => void; rules: SecretRules; asking: boolean; kept: boolean; onKeep: () => void; hint?: ReactNode }) {
  const id = useId();
  const check = checkSecret(value, rules);
  const question = wrapperQuestion(check);
  const paste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (!/[\r\n]/.test(text)) return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    onChange(el.value.slice(0, start) + text + el.value.slice(end));
  };
  return (
    <div className="field-row">
      <div className="field-row__head">
        <label htmlFor={id}>
          {label}
          {need ? <NeedBadge need={need} /> : rules.empty === 'required' && <span className="req"> (required)</span>}
        </label>
        {info !== undefined && <Info label={label} text={info} />}
      </div>
      <input id={id} type="password" value={value} onChange={(e) => onChange(e.target.value)} onPaste={paste} onBlur={onBlur} data-field={field} aria-describedby={`${id}-count${hint ? ` ${id}-hint` : ''}`} required={rules.empty === 'required'} autoComplete="new-password" spellCheck={false} />
      <p id={`${id}-count`} className={`note${check.status === 'refused' ? ' failure' : ''}`} aria-live="polite">
        {secretNote(check)}
      </p>
      {problems && <Problems problems={problems} onSwitch={onSwitch} />}
      {asking && question && !kept && (
        <div className="secret-ask" role="group" aria-label={`${label}: ${question}`}>
          <p>{question}</p>
          <div className="change-actions">
            <button type="button" className="btn btn--small" onClick={() => check.status === 'ok' && check.wrapper && onChange(check.wrapper.without)}>
              Remove it
            </button>
            <button type="button" className="btn btn--small btn--quiet" onClick={onKeep}>
              Keep it
            </button>
          </div>
        </div>
      )}
      {hint && (
        <p id={`${id}-hint`} className="note">
          {hint}
        </p>
      )}
    </div>
  );
}
