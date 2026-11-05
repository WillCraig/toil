/**
 * The readiness gate's pieces (#307): the verdict chip, the five rows, why an
 * item isn't ready, and the item page's panel. The item page and the Command Center
 * both draw from here, over src/model/readiness.ts, so a verdict reads the
 * same wherever it shows. A rubber stamp, but one that says which box it
 * stamped and why.
 */

import { useState } from 'react';
import { Button } from 'react-aria-components';
import { useData } from '../data.ts';
import { dateTime } from '../format.ts';
import { usePlain } from '../plain-words.ts';
import { liveWorkflow, readiness, VERDICT_LABEL, VERDICT_PLAIN, workflowRead, type LiveWorkflow, type Readiness, type Row, type Verdict } from '../model/readiness.ts';
import { CALL_OPTIONS, type WorkItem } from '../toil.ts';
import { Cited } from './items.tsx';
import { Card } from './layout.tsx';
import '../views/readiness.css';

const MARK: Record<Row['state'], string> = { pass: '✓', thin: '!', fail: '✕' };
const STATE_WORD: Record<Row['state'], string> = { pass: 'Passes', thin: 'Thin', fail: 'Fails' };

const VERDICT_MARK: Record<Verdict, string> = { ready: '✓', thin: '!', blocked: '✕' };

/** The verdict as a chip: a mark and a word, so it reads the same in a theme whose colours don't tell the three apart. */
export function VerdictChip({ verdict }: { verdict: Verdict }) {
  const plain = usePlain();
  return (
    <span className={`verdict verdict--${verdict}`} title={plain.on && verdict === 'thin' ? plain.title('Thin') : undefined}>
      <span aria-hidden="true">{VERDICT_MARK[verdict]}</span> {(plain.on ? VERDICT_PLAIN : VERDICT_LABEL)[verdict]}
    </span>
  );
}

/** The five rows, each with its state in words as well as a mark, its reason and where it came from. */
export function ReadinessRows({ readiness }: { readiness: Readiness }) {
  return (
    <ul className="rows readiness-rows">
      {readiness.rows.map((r) => (
        <li key={r.check} className={`readiness-row readiness-row--${r.state}`}>
          <span className="readiness-mark" aria-hidden="true">
            {MARK[r.state]}
          </span>
          <span>
            <strong>{r.label}</strong> <span className="readiness-state">{STATE_WORD[r.state]}</span>: <Cited text={r.reason} />{' '}
            <span className="field">
              Source: <code>{r.source}</code>
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Why an item isn't ready, in one line: the rows that don't pass, worst first. */
export function WhyNot({ readiness }: { readiness: Readiness }) {
  if (!readiness.why.length) return <span className="field">Every check passes.</span>;
  return (
    <ul className="why-not">
      {readiness.why.map((r) => (
        <li key={r.check}>
          <strong>{r.label}:</strong> <Cited text={r.reason} />
        </li>
      ))}
    </ul>
  );
}

/** What the verdict means for starting the item, in the words the item page shows under it. */
const MEANING: Record<Verdict, string> = {
  ready: 'Every check passes: an agent can start on it.',
  thin: 'Something is missing. A person can still decide to start it on its own, but the Command Center never slates it.',
  blocked: "It can't be worked on as it is, so it is never started.",
};

/**
 * The item page's readiness panel: the verdict, its rows, and the one live
 * read that can settle the done-state check, made only when a person presses
 * for it. Nothing here asks a model.
 */
export function ReadinessPanel({ item }: { item: WorkItem }) {
  const { toilProject, byId, execute } = useData();
  const settings = toilProject.readiness;
  const [live, setLive] = useState<{ result: LiveWorkflow; at: string } | null>(null);
  const [reading, setReading] = useState(false);
  const r = readiness({ item, settings, byId, ...(live ? { live: live.result } : {}) });
  const read = item.statusCategory === 'DONE' ? null : workflowRead(item);
  const check = async () => {
    if (!execute || !read) return;
    setReading(true);
    const env = await execute(read.command, { toilProject: toilProject.name, ...read.input }, CALL_OPTIONS);
    setLive({ result: liveWorkflow(item, read.command, env.ok ? env.data : null, env.ok ? undefined : `${env.error.message}${env.error.fix ? ` ${env.error.fix}` : ''}`), at: new Date().toISOString() });
    setReading(false);
  };
  return (
    <Card as="section" className="panel readiness-panel" aria-labelledby="readiness">
      <h2 id="readiness">Ready for an agent?</h2>
      <p className="readiness-verdict">
        <VerdictChip verdict={r.verdict} /> {MEANING[r.verdict]}
      </p>
      <ReadinessRows readiness={r} />
      {read && execute && (
        <p className="readiness-live">
          <Button className="btn btn--small" onPress={check} isDisabled={reading}>
            {reading ? 'Reading the workflow…' : live ? 'Read the workflow again' : 'Check the workflow live'}
          </Button>{' '}
          <span className="field" aria-live="polite">
            {live ? `Read live ${dateTime(live.at)} with toil ${read.command}.` : `One read-only call, toil ${read.command}, settles the done state.`}
          </span>
        </p>
      )}
      <p className="note">
        Worked out from the cached record{live ? ' and one live read' : ''}, with no model call. The checks and their settings (fields.acceptanceCriteria, readiness.minWords, readiness.templates in the {item.source.area} section) are in Toil UI's README.
      </p>
      {settings.notes.map((n, i) => (
        <p key={i} role="note" className="failure">
          {n}
        </p>
      ))}
    </Card>
  );
}
