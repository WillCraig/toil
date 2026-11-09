/**
 * An Analyze answer, laid out top-down (#395): the Recommendation first, then
 * the Issues (three at most), then the Evidence, folded until someone opens
 * it. Every citation is a chip with its key, title and status. An answer
 * that didn't follow that shape is shown as it came, and says so, rather
 * than being reshaped into something the agent didn't write. Also here: what
 * changed between one analysis and the one before, worked out by code
 * (src/model/analysis.ts), in words and chips. The bottom line, on top.
 */

import { readBriefing, type Briefing } from '../../../src/core/brief/answer.ts';
import type { AnswerPart } from '../agent.ts';
import { dateTime } from '../format.ts';
import { structureOf, textOfParts, unchanged, type AnalysisChanges } from '../model/analysis.ts';
import { useWords } from '../skins.tsx';
import { Cited, TicketChip } from './items.tsx';
import './analysis.css';

/** "Codex (gpt-5.5)", "Claude, its CLI's default model", or the scripted preview: who wrote an analysis. */
export function whoText(a: { adapter: string | null; model: string | null; by: string }): string {
  if (a.adapter === 'scripted' || a.by === 'scripted') return 'the scripted preview, not a model';
  const name = a.adapter ? (ADAPTER_LABEL[a.adapter] ?? a.adapter) : a.by;
  return a.model ? `${name} (${a.model})` : a.adapter ? `${name}, its CLI's default model` : name;
}
const ADAPTER_LABEL: Record<string, string> = { claude: 'Claude', copilot: 'GitHub Copilot', codex: 'Codex' };

/** `level`: the heading level of its labels, one below the heading it sits under. `done` false: still streaming, so a missing label is not yet a slip. */
export function AnalysisBody({ parts, briefing, open = false, level = 4, done = true }: { parts: readonly AnswerPart[]; briefing?: Briefing | null; open?: boolean; level?: 3 | 4; done?: boolean }) {
  const H = level === 3 ? 'h3' : 'h4';
  const words = useWords();
  const text = textOfParts(parts);
  // A briefing (#494) the server lifted out, or one still in the text (the preview's scripted agent, or mid-stream).
  const read = briefing ? { briefing, rest: text } : text.includes('```briefing') ? readBriefing(text) : null;
  if (read?.briefing) return <BriefingBody briefing={read.briefing} evidence={read.rest} open={open} H={H} />;
  if (read && !done) return <p className="note">{words('loading.briefing')}</p>;
  const s = structureOf(text);
  if (!s) {
    return (
      <>
        {done && <p className="note analysis-unshaped">This answer didn't start with a Recommendation line, so it is shown as it came.</p>}
        {parts.map((p, i) => (
          <p key={i}>
            <Cited text={p.text} chips />
          </p>
        ))}
      </>
    );
  }
  return (
    <div className="analysis-body">
      <section className="analysis-rec" aria-label="Recommendation">
        <H className="analysis-label">Recommendation</H>
        <p className="analysis-rec__text">
          <Cited text={s.recommendation} chips />
        </p>
      </section>
      <section className="analysis-issues" aria-label="Issues">
        <H className="analysis-label">Issues</H>
        {s.issues.length ? (
          <ol className="analysis-issues__list">
            {s.issues.map((i, n) => (
              <li key={n}>
                {i.title && <strong className="analysis-issue__title">{i.title}: </strong>}
                <Cited text={i.text} chips />
              </li>
            ))}
          </ol>
        ) : (
          <p className="note">None stands out.</p>
        )}
        {s.extraIssues > 0 && <p className="note">The agent named {s.extraIssues} more {s.extraIssues === 1 ? 'issue' : 'issues'} than the three asked for; {s.extraIssues === 1 ? 'it is' : 'they are'} at the end of the evidence.</p>}
      </section>
      {s.evidence.length > 0 && (
        <details className="analysis-evidence" open={open}>
          <summary>
            Evidence <span className="note">({s.evidence.length} {s.evidence.length === 1 ? 'paragraph' : 'paragraphs'})</span>
          </summary>
          {s.evidence.map((p, i) => (
            <p key={i}>
              <Cited text={p} chips />
            </p>
          ))}
        </details>
      )}
    </div>
  );
}

/** Analyze's briefing (#494), top-down: the recommendation, each reason with its items, why and the next step, then the rest of the answer as evidence, folded. */
function BriefingBody({ briefing: b, evidence, open, H }: { briefing: Briefing; evidence: string; open: boolean; H: 'h3' | 'h4' }) {
  const paragraphs = evidence.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return (
    <div className="analysis-body">
      <section className="analysis-rec" aria-label="Recommendation">
        <H className="analysis-label">Recommendation</H>
        <p className="analysis-rec__text">
          <Cited text={b.recommendation} chips />
        </p>
      </section>
      <section className="analysis-issues" aria-label="Reasons">
        <H className="analysis-label">Reasons</H>
        {b.reasons.length ? (
          <ol className="analysis-issues__list">
            {b.reasons.map((r, n) => (
              <li key={n}>
                <strong className="analysis-issue__title">{r.label}: </strong>
                {r.text ? <Cited text={r.text} chips /> : r.line}
                {r.items.length > 0 && (
                  <ul className="rows analysis-reason__items">
                    {r.items.map((i) => (
                      <li key={i.id}>
                        <TicketChip id={i.id} detail /> <Cited text={i.why} />
                        {i.next && (
                          <span className="analysis-next">
                            {' '}
                            Next: <Cited text={i.next} />
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="note">None stands out.</p>
        )}
        {b.leftOut.length > 0 && (
          <p className="note">
            Left out by the Toil project's focus: <Chips ids={b.leftOut.map((l) => l.id)} />
          </p>
        )}
      </section>
      {paragraphs.length > 0 && (
        <details className="analysis-evidence" open={open}>
          <summary>
            Evidence <span className="note">({paragraphs.length} {paragraphs.length === 1 ? 'paragraph' : 'paragraphs'})</span>
          </summary>
          {paragraphs.map((p, i) => (
            <p key={i}>
              <Cited text={p} chips />
            </p>
          ))}
        </details>
      )}
    </div>
  );
}

const pts = (n: number | null) => (n === null ? 'no estimate' : `${n} ${n === 1 ? 'point' : 'points'}`);

/** How many things changed, in a few words, for a list entry: "2 newly blocked, 1 cleared, 3 newly cited". */
export function changesLine(c: AnalysisChanges): string {
  if (!c.previous) return 'The first analysis kept, so there is nothing to compare it with.';
  if (unchanged(c)) return 'Nothing changed since the one before: the same blockers, points and citations.';
  const bits = [
    c.newlyBlocked.length ? `${c.newlyBlocked.length} newly blocked` : '',
    c.cleared.length ? `${c.cleared.length} cleared` : '',
    c.points.length ? `points moved on ${c.points.length} ${c.points.length === 1 ? 'item' : 'items'}` : '',
    c.sprint ? 'sprint points moved' : '',
    c.cited.length ? `${c.cited.length} newly cited` : '',
    c.dropped.length ? `${c.dropped.length} dropped` : '',
    c.recommendationChanged ? 'a new recommendation' : '',
  ].filter(Boolean);
  return `Since the one before: ${bits.join(', ')}.`;
}

/** Chips for a list of ids, inline. */
function Chips({ ids }: { ids: readonly string[] }) {
  return (
    <ul className="ticket-chips">
      {ids.map((id) => (
        <li key={id}>
          <TicketChip id={id} detail />
        </li>
      ))}
    </ul>
  );
}

/** What changed since the analysis before, in full: each kind on its own line, with its chips. */
export function ChangesDetail({ changes: c }: { changes: AnalysisChanges }) {
  if (!c.previous) return <p className="note">{changesLine(c)}</p>;
  if (unchanged(c)) return <p className="note">{changesLine(c)}</p>;
  const sprintText = (s: NonNullable<AnalysisChanges['sprint']>['from']) => (s ? `${s.name}: ${s.done} done, ${s.remaining} left` : 'no sprint running');
  return (
    <>
    <p className="note analysis-changes__since">Compared with the analysis of {dateTime(c.previous.at)}, by the Toil project's items then and now.</p>
    <dl className="analysis-changes">
      {c.newlyBlocked.length > 0 && (
        <div>
          <dt>Newly blocked</dt>
          <dd>
            <ul className="rows">
              {c.newlyBlocked.map((b) => (
                <li key={b.id} className="analysis-changes__row">
                  <TicketChip id={b.id} detail /> <span className="note">by</span> <Chips ids={b.by} />
                </li>
              ))}
            </ul>
          </dd>
        </div>
      )}
      {c.cleared.length > 0 && (
        <div>
          <dt>Cleared</dt>
          <dd>
            <Chips ids={c.cleared} />
          </dd>
        </div>
      )}
      {c.points.length > 0 && (
        <div>
          <dt>Points moved</dt>
          <dd>
            <ul className="rows">
              {c.points.map((p) => (
                <li key={p.id} className="analysis-changes__row">
                  <TicketChip id={p.id} detail />{' '}
                  <span>
                    {pts(p.from)} to {pts(p.to)}
                  </span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      )}
      {c.sprint && (
        <div>
          <dt>The sprint</dt>
          <dd>
            {sprintText(c.sprint.from)}, then {sprintText(c.sprint.to)}.
          </dd>
        </div>
      )}
      {c.cited.length > 0 && (
        <div>
          <dt>Newly cited</dt>
          <dd>
            <Chips ids={c.cited} />
          </dd>
        </div>
      )}
      {c.dropped.length > 0 && (
        <div>
          <dt>No longer cited</dt>
          <dd>
            <Chips ids={c.dropped} />
          </dd>
        </div>
      )}
      {c.recommendationChanged && (
        <div>
          <dt>Recommendation</dt>
          <dd>A different one from the analysis before.</dd>
        </div>
      )}
    </dl>
    </>
  );
}
