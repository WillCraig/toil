/**
 * Ask with training wheels (#552): what the chat shows before the first
 * question and under every answer, for someone who has never asked an AI
 * anything. The guided start is a few plain questions grouped by what they are
 * for, beside a "Before you ask" panel: one line saying it reads what your
 * connections can read and changes nothing, and a button for what it can see
 * and cannot do. Under an answer, "How sure
 * is this?" is a word and one sentence worked out by code (src/model/
 * confidence.ts), with one line for the time and the usage, and "What it
 * looked at" (the items it cited as links) and the usage breakdown one step
 * in; the first answer of a conversation says nothing was changed. Everything here is a view of what the agent
 * already does; none of it asks the model for anything. The terms of use, for
 * once, are shorter than the thing they govern.
 */

import { useState } from 'react';
import { Button } from 'react-aria-components';
import { useData } from '../data.ts';
import { sourceLabel } from '../format.ts';
import { GROUPS, PANEL_WORDS, QUESTIONS, questionFor, type GuidedQuestion } from '../guided-questions.ts';
import type { Panel } from '../load.ts';
import type { Answer } from '../agent.ts';
import { ageHoursOf, howSure, type Level } from '../model/confidence.ts';
import { usePlain } from '../plain-words.ts';
import { Help } from './help.tsx';
import { TicketChip } from './items.tsx';
import { UsageBreakdown, UsageNotices, usageLine } from './usage.tsx';
import type { AnswerUsage } from '../model-usage.ts';
import './guided.css';

/** Below this width the questions come first and "Before you ask" folds to a line, so a phone opens on something to press. */
export const PHONE = '(max-width: 699px)';

const list = (parts: string[]) => (parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the AI is given, counted from the Toil project on screen: the saved copy's items, code reviews, builds and deployments. */
export function seenCounts(d: { items: unknown[]; pullRequests?: unknown[]; changes: Array<{ kind: string }>; deployments: unknown[] }): string[] {
  const builds = d.changes.filter((c) => c.kind === 'build').length;
  return [plural(d.items.length, 'item'), plural((d.pullRequests ?? []).length, 'pull request'), plural(builds, 'build'), plural(d.deployments.length, 'deployment')];
}

/** What the AI can see and what it can't do: the part of "Before you ask" one press further in. Who answers is the header's to say, and what it costs is the usage line's. */
function BeforeBody() {
  const { toilProject } = useData();
  const plain = usePlain();
  const systems = [...new Set(toilProject.sources.map((s) => sourceLabel(s.area)))];
  return (
    <dl className="guided-before__list">
      <div>
        <dt>What the AI can see</dt>
        <dd>
          <p>{plain.text("This Toil project's saved work:")}</p>
          <ul data-seen="">
            {seenCounts(toilProject).map((c) => (
              <li key={c}>{plain.text(c)}</li>
            ))}
          </ul>
          <p className="note">When the saved copy is not enough, it looks things up live in {systems.length ? list(systems) : 'your tools'}, read-only.</p>
        </dd>
      </div>
      <div>
        <dt>What it can&apos;t do</dt>
        <dd>
          <ul>
            <li>Change anything in {systems.length ? list(systems) : 'your tools'}</li>
            <li>See email or chat</li>
            <li>Read anything your connections can&apos;t already read</li>
          </ul>
        </dd>
      </div>
    </dl>
  );
}

/**
 * "Before you ask": one line, at every width, and a button that opens the rest.
 * The line says the two things that matter most, so a closed panel is never an
 * empty one.
 */
export function BeforeYouAsk() {
  const [open, setOpen] = useState(false);
  return (
    <aside className="guided-before" aria-labelledby="guided-before-h" data-before-you-ask="">
      <h3 id="guided-before-h">Before you ask</h3>
      <div className="guided-before__bar">
        <p>It reads what your connections can read, saved and live. It changes nothing.</p>
        <Button className="btn" aria-expanded={open} aria-controls="guided-before-body" onPress={() => setOpen(!open)} data-before-toggle="">
          What AI can see
        </Button>
      </div>
      {open && (
        <div id="guided-before-body">
          <BeforeBody />
        </div>
      )}
    </aside>
  );
}

/** The chat's empty state: the question to answer, the questions to start from, and what the AI can and can't do. */
export function GuidedStart({ noAgent, notice, details, link, busy, onPick }: { noAgent: boolean; notice?: string; details?: string; link?: string; busy: boolean; onPick: (q: GuidedQuestion, text: string) => void }) {
  const { toilProject } = useData();
  const plain = usePlain();
  return (
    <div className="guided" data-guided-start="">
      <div className="guided__main">
        <h3 className="guided__title">{`What would you like to know about ${toilProject.name}?`}</h3>
        {notice && (
          <div className="agent-notice guided__notice" data-no-agent="">
            <p>
              {plain.text(notice)} <a href="#/settings/agent">{link ?? plain.pw('Set up an agent', 'Set up an AI agent')}</a>
            </p>
            {details && (
              <details>
                <summary>Details for whoever sets it up</summary>
                <p className="note">{details}</p>
              </details>
            )}
          </div>
        )}
        <div className="guided__groups" role="group" aria-label="Starter questions">
          {GROUPS.map((g) => (
            <section key={g.id} aria-labelledby={`guided-g-${g.id}`}>
              <h4 id={`guided-g-${g.id}`}>{g.title}</h4>
              <ul>
                {g.questions.map((id) => {
                  const q = QUESTIONS[id];
                  const text = plain.text(q.text);
                  return (
                    <li key={id} title={`Good for ${plain.text(q.good)}`}>
                      <Button className="guided-q" isDisabled={busy || noAgent} onPress={() => onPick(q, text)} data-question={id}>
                        <span className="guided-q__text">{text}</span>
                        {q.note && <span className="guided-q__good">{q.note}</span>}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
      <BeforeYouAsk />
    </div>
  );
}

/** Three dots, filled for as many as the level earns: a shape beside the word, so the level never rests on colour alone. */
function Dots({ level }: { level: Level }) {
  const filled = level === 'high' ? 3 : level === 'medium' ? 2 : 1;
  return (
    <svg className="sure__dots" viewBox="0 0 30 10" width="30" height="10" aria-hidden="true" focusable="false">
      {[0, 1, 2].map((i) => (
        <circle key={i} cx={5 + i * 10} cy="5" r="3.4" fill={i < filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" />
      ))}
    </svg>
  );
}

/**
 * Under a finished answer: how sure it is, in a word and a sentence, then one
 * line for how long it took and what it used, which opens to what it looked at
 * and the usage breakdown. A question from the guided start is checked against
 * the panels it needs and the items it needs a field of; a typed one, or
 * Analyze, against every read and the Toil project's items, which are the
 * generic checks. `safe` adds that nothing was changed, said once a
 * conversation rather than under every answer.
 */
export function AnswerChecks({ answer, prompt, analyze, ms, safe }: { answer: Answer; prompt: string; analyze?: boolean; ms?: number; safe?: boolean }) {
  const { toilProject, now, viewedAt } = useData();
  const plain = usePlain();
  const q = analyze ? QUESTIONS.briefing : questionFor(prompt, plain.text);
  const panels = (q?.needs ?? (Object.keys(toilProject.calls ?? {}) as Panel[])).filter((p) => toilProject.calls?.[p]?.some((c) => !c.ok));
  const lack = q?.lack;
  const among = lack ? toilProject.items.filter(lack.among) : [];
  const sure = howSure({
    failed: panels.map((p) => plain.text(PANEL_WORDS[p])),
    ageHours: ageHoursOf(now, viewedAt ?? new Date().toISOString()),
    items: q?.base === 'pullRequests' ? (toilProject.pullRequests ?? []).length : toilProject.items.length,
    scoped: !!q?.needs,
    unverified: answer.unverified?.length ? { count: answer.unverified.length, of: answer.citations.length } : null,
    noun: q?.base === 'pullRequests' ? plain.pw('pull request', 'code review') : undefined,
    lacking: lack ? { what: lack.what, count: among.filter(lack.lacks).length, of: among.length } : null,
  });
  const usage: AnswerUsage | undefined = answer.usage;
  const line = ['What it looked at', ...(ms !== undefined ? [`${Math.max(1, Math.round(ms / 1000))} s`] : []), ...(usage ? [usageLine(usage)] : [])].join(' · ');
  return (
    <div className="ask-sure" data-how-sure="">
      <p className="ask-sure__sure">
        <strong>How sure is this?</strong> <Help topic="status" />{' '}
        <span className={`sure sure--${sure.level}`} data-sure={sure.level}>
          <Dots level={sure.level} />
          <strong>{sure.word}</strong>
        </span>{' '}
        {sure.because}
      </p>
      <details className="ask-sure__more" data-answer-more="">
        <summary>{line}</summary>
        {answer.citations.length ? (
          <ul className="ask-sure__chips" data-looked-at="">
            {answer.citations.map((id) => (
              <li key={id}>
                <TicketChip id={id} detail />
              </li>
            ))}
          </ul>
        ) : (
          <p className="note">It named no items.</p>
        )}
        {usage && (
          <div className="usage-footer" role="group" aria-label="What this answer used" data-usage-footer="">
            <UsageBreakdown usage={usage} />
          </div>
        )}
      </details>
      {usage && <UsageNotices usage={usage} />}
      {safe && <p className="note ask-sure__safe">Suggestions only. Nothing was changed.</p>}
    </div>
  );
}
