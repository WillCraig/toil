/**
 * The setup guide's panel (#561): a small chat beside the wizard's step, for
 * someone new to AI who wants to know what a box is asking for. It explains.
 * It never carries a secret: the question box is labelled so, a message that
 * looks like a token is refused here before anything is sent or kept (and
 * again at the client and the server, src/guide.ts), and the masked box that
 * takes a login is a different box in the step.
 *
 * A change the guide suggests comes back as a card with the command it would
 * run and a Run this button. That button runs the command through the wizard's
 * own config path (`config.run`, the allowlist Settings uses), after the page
 * checks the input once more; the guide has no way to run anything itself.
 * Wide, the panel sits beside the step; narrow, it folds behind "Ask the
 * guide" and starts closed. A help desk with a sign: bring no keys.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Agent, Answer, HistoryTurn } from '../agent.ts';
import { MAX_HISTORY_ANSWER, MAX_HISTORY_TURNS } from '../agent.ts';
import type { ConfigApi } from '../config.ts';
import { GUIDE_MAX, GUIDE_REFUSAL, guideInputProblem, guideLine, guideStarters, looksLikeSecret, type GuideState } from '../guide.ts';
import type { Proposal } from '../proposal.ts';
import { useTheme, useThemeChoiceContext, voiceOn } from '../theme-context.ts';
import { Copy, useMediaQuery } from './layout.tsx';
import { OutcomeLine, failedOutcome, outcomeOf, type Outcome } from '../views/settings/parts.tsx';
import './guide.css';

/** The widest a screen may be for the panel to fold; the layout's two columns start just above it. */
export const GUIDE_NARROW = '(max-width: 999px)';

interface Turn {
  id: number;
  question: string;
  answer: Answer | null;
  error: string | null;
  done: boolean;
}

const noop = () => undefined;
const textOf = (a: Answer) => a.parts.map((p) => p.text).join('\n\n');
const chatId = () => `guide-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** One suggested command: what it does, the line it would type, and Run this. */
function Suggestion({ proposal, config, onRan }: { proposal: Proposal; config: ConfigApi; onRan: () => void }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [running, setRunning] = useState(false);
  const command = proposal.command ?? '';
  const problem = guideInputProblem(command, proposal.input);
  const line = problem ? null : guideLine(command, proposal.input ?? {});
  const run = async () => {
    if (problem || !proposal.input) return;
    setRunning(true);
    try {
      const e = await config.run(command, proposal.input);
      const o = outcomeOf(e, 'Done.');
      setOutcome(o);
      if (o.ok) onRan();
    } catch (e) {
      setOutcome(failedOutcome(e));
    } finally {
      setRunning(false);
    }
  };
  return (
    <article className="guide__suggestion" aria-label={`Suggested: ${proposal.title}`} data-guide-suggestion="">
      <p className="proposal-kind">Suggested, not done yet</p>
      <h3>{proposal.title}</h3>
      {proposal.reason && <p>{proposal.reason}</p>}
      {line ? (
        <>
          <p className="guide__line">
            <code>{line}</code> <Copy value={line} what="command" />
          </p>
          <div className="setup__actions">
            <button type="button" className="btn btn--small" onClick={() => void run()} disabled={running || config.disabled !== null || outcome?.ok === true} data-guide-run="">
              {running ? 'Running…' : 'Run this'}
            </button>
            {config.disabled && <span className="note">{config.disabled}</span>}
          </div>
          <OutcomeLine outcome={outcome} />
        </>
      ) : (
        <p className="note">There is no command to run for this: {problem ?? 'it has no command line.'}</p>
      )}
      {proposal.note && <p className="note">{proposal.note}</p>}
    </article>
  );
}

export interface GuidePanelProps {
  guide: NonNullable<Agent['guide']>;
  config: ConfigApi | null;
  /** Where the person is and the non-secret facts so far, built by the wizard from a whitelist (src/guide.ts). */
  state: GuideState;
  /** A suggested command ran: the wizard reads connections and Toil projects again. */
  onRan?: () => void;
}

/** The guide itself: starters, a question box, the conversation. Mount it once per wizard visit and it keeps its chat across steps. */
export function GuideBody({ guide, config, state, onRan }: GuidePanelProps) {
  const theme = useTheme();
  const choice = useThemeChoiceContext();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [refused, setRefused] = useState(false);
  // Only the newest question stays open: asking another folds the earlier ones to their question line, and any of them opens again on a press.
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const chat = useRef(chatId());
  const next = useRef(1);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const running = turns.some((t) => !t.done);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    log.current?.scrollTo?.({ top: log.current.scrollHeight });
  }, [turns]);

  const update = (id: number, patch: Partial<Turn>) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const ask = async (raw: string) => {
    const message = raw.trim();
    if (!message || running) return;
    // The wall between the question box and the secret box: a message that looks like a token goes nowhere, and is cleared, not kept.
    if (looksLikeSecret(message) || message.length > GUIDE_MAX) {
      setText('');
      setRefused(true);
      return;
    }
    setRefused(false);
    setText('');
    const id = next.current++;
    const history: HistoryTurn[] = turns
      .flatMap((t) => (t.done && !t.error && t.answer?.parts.length ? [{ prompt: t.question, answer: textOf(t.answer).slice(0, MAX_HISTORY_ANSWER + 1) }] : []))
      .slice(-MAX_HISTORY_TURNS);
    const controller = new AbortController();
    abort.current = controller;
    setTurns((ts) => [...ts, { id, question: message, answer: null, error: null, done: false }]);
    setOpen(new Set([id]));
    try {
      for await (const partial of guide({ chat: chat.current, message, state }, history, controller.signal, { theme: theme.name, voice: voiceOn(theme, choice) })) {
        if (controller.signal.aborted) return;
        update(id, { answer: partial });
      }
      if (!controller.signal.aborted) update(id, { done: true });
    } catch (e) {
      if (controller.signal.aborted) return;
      update(id, { answer: null, error: e instanceof Error ? e.message : String(e), done: true });
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(text);
  };
  const stop = () => {
    abort.current?.abort();
    setTurns((ts) => ts.map((t) => (t.done ? t : { ...t, done: true })));
  };
  const starters = guideStarters(state.step, state.area);

  return (
    <div className="guide" data-guide="">
      <p className="note">The guide explains what each box asks for. It reads toil's own documentation, and it can only suggest changes: you press Run this.</p>
      {starters.length > 0 && (
        <div className="starters" role="group" aria-label="Questions to start with">
          {starters.map((q) => (
            <button key={q} type="button" className="btn btn--small starter" onClick={() => void ask(q)} disabled={running} data-guide-starter="">
              {q}
            </button>
          ))}
        </div>
      )}
      <div className="guide__log" ref={log} data-guide-log="">
        {turns.map((t) => (
          <details
            key={t.id}
            className="guide__turn"
            open={open.has(t.id)}
            onToggle={(e) => {
              const now = e.currentTarget.open;
              if (now !== open.has(t.id)) setOpen((o) => new Set(now ? [...o, t.id] : [...o].filter((x) => x !== t.id)));
            }}
            data-guide-turn=""
          >
            <summary className="guide__question">{t.question}</summary>
            {t.error ? (
              <p role="alert" className="failure">
                The guide couldn't answer: {t.error}
              </p>
            ) : (
              <>
                {t.answer?.parts.map((p, i) => (
                  <p key={i}>{p.text}</p>
                ))}
                {!t.done && (
                  <p role="status" className="note">
                    {t.answer?.activity?.phase === 'tool' ? 'Reading toil’s documentation…' : t.answer?.activity?.phase === 'writing' ? 'Writing…' : 'Thinking…'}
                  </p>
                )}
                {t.done && t.answer?.warnings?.map((w, i) => (
                  <p key={i} className="note">
                    {w}
                  </p>
                ))}
                {t.done && config && t.answer?.proposals.map((p) => <Suggestion key={p.id} proposal={p} config={config} onRan={onRan ?? noop} />)}
              </>
            )}
          </details>
        ))}
      </div>
      <form className="guide__ask" onSubmit={submit} aria-label="Ask the guide">
        <label htmlFor="guide-question">Ask a question (never paste a token here)</label>
        <textarea id="guide-question" rows={2} value={text} maxLength={GUIDE_MAX} onChange={(e) => (setText(e.target.value), refused && setRefused(false))} data-guide-input="" />
        {refused && (
          <p role="alert" className="failure" data-guide-refused="">
            {GUIDE_REFUSAL}
          </p>
        )}
        <div className="setup__actions">
          <button type="submit" className="btn btn--small" disabled={running || text.trim() === ''}>
            Ask
          </button>
          {running && (
            <button type="button" className="btn btn--small btn--quiet" onClick={stop}>
              Stop
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/**
 * The panel as the wizard shows it: beside the step on a wide screen, behind
 * "Ask the guide" on a narrow one, closed until the person opens it. The
 * chat is kept by the wizard mounting this once, so closing the fold or
 * moving to the next step loses nothing.
 */
export function GuidePanel(props: GuidePanelProps) {
  const narrow = useMediaQuery(GUIDE_NARROW);
  return narrow ? (
    <details className="guide-fold more" data-guide-fold="">
      <summary>Ask the guide</summary>
      <GuideBody {...props} />
    </details>
  ) : (
    <aside className="guide-side" aria-label="Guide" data-guide-side="">
      <h2>Ask the guide</h2>
      <GuideBody {...props} />
    </aside>
  );
}
