/**
 * The readiness gate's pieces (#307): the verdict chip, the five rows and the
 * ticket rules' rows (#657), why an item isn't ready, and the item page's
 * panel, where a thin or failed rule offers "Fix with AI agent" (or a standard with several misses offers
 * "Fix all"). The item page and the Command Center
 * both draw from here, over src/model/readiness.ts, so a verdict reads the
 * same wherever it shows. A rubber stamp, but one that says which box it
 * stamped and why.
 */

import { useState, type ReactNode } from 'react';
import { Button } from 'react-aria-components';
import { useData } from '../data.ts';
import { dateTime } from '../format.ts';
import { usePlain } from '../plain-words.ts';
import { liveWorkflow, readiness, VERDICT_LABEL, VERDICT_PLAIN, withRules, workflowRead, type LiveWorkflow, type Readiness, type Row, type Verdict } from '../model/readiness.ts';
import { FixRuleButton, type RuleToFix } from '../assign/views.tsx';
import { fixable } from '../rules.ts';
import { CALL_OPTIONS, type WorkItem } from '../toil.ts';
import { Help, InfoTip } from './help.tsx';
import { SummaryChevron, DisclosureBody } from './disclosure.tsx';
import { Cited } from './items.tsx';
import { SourceTip } from './bits.tsx';
import { Card } from './layout.tsx';
import { CheckIcon, CloseIcon, WarningIcon } from './icons.tsx';
import '../views/readiness.css';

// A rule nobody could check is a dash, never a tick: unknown is not a pass (principle 12).
const MARK: Record<Row['state'], ReactNode> = { pass: <CheckIcon size={14} />, thin: <WarningIcon size={14} />, fail: <CloseIcon size={14} />, skipped: '–' };
const STATE_WORD: Record<Row['state'], string> = { pass: 'Passes', thin: 'Thin', fail: 'Fails', skipped: 'Not checked' };
// A ticket rule that misses says what it is: missing. Its state stays thin underneath, so the verdict counts it as before.
const RULE_WORD: Record<Row['state'], string> = { ...STATE_WORD, thin: 'Missing' };

// Rules not read yet is unknown, not a pass or a miss, so its mark is the dash (principle 12).
const VERDICT_MARK: Record<Verdict, ReactNode> = { ready: <CheckIcon size={14} />, thin: <WarningIcon size={14} />, blocked: <CloseIcon size={14} />, unread: '–' };

/** The verdict as a chip: a mark and a word, so it reads the same in a theme whose colours don't tell the three apart. */
export function VerdictChip({ verdict }: { verdict: Verdict }) {
  const plain = usePlain();
  return (
    <span className={`verdict verdict--${verdict}`} title={plain.on && verdict === 'thin' ? plain.title('Thin') : undefined}>
      <span aria-hidden="true">{VERDICT_MARK[verdict]}</span> {(plain.on ? VERDICT_PLAIN : VERDICT_LABEL)[verdict]}
    </span>
  );
}

/** One row: its state in words as well as a mark, its reason, and where it came from. */
function RowLine({ r, blockedAbove = false }: { r: Row; blockedAbove?: boolean }) {
  // The item page names what blocks it under the title (#657), so its blockers row points there rather than naming it again.
  const reason = blockedAbove && r.check === 'blockers' && r.state === 'fail' ? 'what blocks it, named at the top, isn\u2019t done.' : plainReason(r.reason);
  return (
    <li className={`readiness-row readiness-row--${r.state}`}>
      <span className="readiness-mark" aria-hidden="true">
        {MARK[r.state]}
      </span>
      <span>
        <strong>{r.label}</strong> <span className="readiness-state">{STATE_WORD[r.state]}</span>: <Cited text={reason} /> <SourceTip source={r.source} />
      </span>
    </li>
  );
}

/**
 * A ticket rule's row: its state and reason, with its source one press in
 * (principle 4 keeps it reachable, never removed), and Fix with AI agent at the
 * row's end when the rule misses and its standard has no "Fix all".
 */
function RuleRowLine({ r, action }: { r: Row; action?: ReactNode }) {
  return (
    <li className={`readiness-row readiness-row--rule readiness-row--${r.state}`}>
      <span className="readiness-mark" aria-hidden="true">
        {MARK[r.state]}
      </span>
      <details className="readiness-row__more">
        <summary>
          <SummaryChevron />
          <span>
            <strong>{r.label}</strong> <span className="readiness-state">{RULE_WORD[r.state]}</span>: <Cited text={plainReason(r.reason)} />
          </span>
        </summary>
        <p className="field">
          Source: <code>{r.source}</code>
        </p>
      </details>
      {action && <span className="readiness-row__action">{action}</span>}
    </li>
  );
}

/** A reason as a person reads it: a Jira custom field's id (`customfield_10500`) is the tracker's internal name, so it reads "a custom field" (#657). */
const plainReason = (text: string) => text.replace(/\bcustomfield_\d+\b/g, 'a custom field');

const isRuleRow = (r: Row) => r.check === 'rules' || r.check.startsWith('rule:');

/** The rule rows by standard, in the check's order: one group a standard, each with the rows that are its rules. */
function byStandard(rows: Row[]): Array<{ standard: string; rows: Row[] }> {
  const groups: Array<{ standard: string; rows: Row[] }> = [];
  for (const r of rows) {
    const standard = r.rule?.standard ?? '';
    const last = groups.at(-1);
    if (last && last.standard === standard) last.rows.push(r);
    else groups.push({ standard, rows: [r] });
  }
  return groups;
}

/**
 * The five rows, then the ticket rules' rows under their own heading, set in
 * and grouped by standard. With `item`, a rule the item misses offers "Fix with
 * AI agent" on its row; where a standard has more than one miss, its group
 * offers one "Fix all N with AI agent" instead, which asks for one rewrite that
 * meets them all, rather than three buttons that would each rewrite the same
 * description.
 */
export function ReadinessRows({ readiness, item, ruleText, blockedAbove = false }: { readiness: Readiness; item?: Pick<WorkItem, 'id' | 'title' | 'source'>; ruleText?: (standard: string, rule: string) => string | null; blockedAbove?: boolean }) {
  const fixed = readiness.rows.filter((r) => !isRuleRow(r));
  const rules = readiness.rows.filter(isRuleRow);
  const toFix = (r: Row): RuleToFix => ({ ...r.rule!, name: r.label, text: ruleText?.(r.rule!.standard, r.rule!.rule) ?? null, reason: r.reason });
  return (
    <>
      {/* What fails or is thin stays open; what passes folds to one line, "4 checks pass", opened on a press (#657). */}
      {fixed.some((r) => r.state !== 'pass') && (
        <ul className="rows readiness-rows">
          {fixed
            .filter((r) => r.state !== 'pass')
            .map((r) => (
              <RowLine key={r.check} r={r} blockedAbove={blockedAbove} />
            ))}
        </ul>
      )}
      <Passing rows={fixed.filter((r) => r.state === 'pass')} />
      {rules.length > 0 && (
        <section className="readiness-rules-group" aria-labelledby="readiness-rules-head">
          <h3 className="readiness-subhead" id="readiness-rules-head">
            Ticket rules <Help topic="ticket-rules" />
          </h3>
          <div data-rule-rows="">
            {byStandard(rules).map((g) => {
              const missed = item ? g.rows.filter((r) => r.rule && fixable(r.state)) : [];
              const all = missed.length > 1;
              return (
                <div key={g.standard || g.rows[0]!.check} className="readiness-standard" data-rule-group={g.standard || undefined}>
                  {all && (
                    <p className="readiness-standard__fix">
                      <span className="field">{missed.length === 1 ? '1 rule missed.' : `${missed.length} rules missed.`}</span>
                      <FixRuleButton item={item!} rules={missed.map(toFix)} />
                    </p>
                  )}
                  <ul className="rows readiness-rows">
                    {g.rows.map((r) => (
                      <RuleRowLine key={r.check} r={r} {...(item && !all && r.rule && fixable(r.state) ? { action: <FixRuleButton item={item} rules={[toFix(r)]} /> } : {})} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

/** The checks that pass, folded behind one line that counts them. */
function Passing({ rows }: { rows: Row[] }) {
  if (!rows.length) return null;
  return (
    <details className="readiness-passing" data-passing="">
      <summary className="btn btn--quiet btn--sm">
        <SummaryChevron />
        {rows.length === 1 ? '1 check passes' : `${rows.length} checks pass`}
      </summary>
      <DisclosureBody>
        <ul className="rows readiness-rows">
          {rows.map((r) => (
            <RowLine key={r.check} r={r} />
          ))}
        </ul>
      </DisclosureBody>
    </details>
  );
}

/**
 * Why an item isn't ready, in one line: the rows that don't pass, worst first.
 * `first` brings the rows it picks to the top, so a list filtered to a ticket
 * rule leads with that rule's line.
 */
export function WhyNot({ readiness, first }: { readiness: Readiness; first?: (r: Row) => boolean }) {
  if (!readiness.why.length) return <span className="field">Every check passes.</span>;
  const rows = first ? [...readiness.why.filter(first), ...readiness.why.filter((r) => !first(r))] : readiness.why;
  return (
    <ul className="why-not">
      {rows.map((r) => (
        <li key={r.check}>
          <strong>{r.label}:</strong> <Cited text={plainReason(r.reason)} />
        </li>
      ))}
    </ul>
  );
}

/** What the verdict means for starting the item, in the words the item page shows under it. */
const MEANING: Record<Verdict, string> = {
  ready: 'Every check passes: an agent can start on it.',
  thin: "Something is missing. A person can still decide to start it on its own, but it won't be started automatically.",
  blocked: "It can't be worked on as it is, so it is never started.",
  unread: "Nothing fails, but your team's ticket rules haven't been read for it yet, so it isn't known to be ready and isn't started.",
};

/**
 * The item page's readiness panel: the verdict, its rows, and the one live
 * read that can settle the done-state check, made only when a person presses
 * for it. Nothing here asks a model.
 */
export function ReadinessPanel({ item, blockedAbove = false }: { item: WorkItem; blockedAbove?: boolean }) {
  const { toilProject, byId, execute, rules } = useData();
  const settings = withRules(toilProject.readiness, rules?.reading);
  const ruleText = (standard: string, rule: string) => rules?.view?.result?.standards.find((s) => s.name === standard)?.rules.find((x) => x.id === rule)?.text ?? null;
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
      <h2>
        <span id="readiness">Ready for an agent?</span> <Help topic="readiness-checks" note={`Worked out from the cached record${live ? ' and one live read' : ''}, with no model call.${read && execute ? ` Check the workflow live makes one read-only call, toil ${read.command}, to settle the done state.` : ''} The checks' settings (fields.acceptanceCriteria, readiness.minWords and readiness.templates in the ${item.source.area} section) are in Toil UI's README.`} />
      </h2>
      <p className="readiness-verdict">
        {/* What the verdict means for starting it is an explanation, so it sits in the chip's (i), not on the page (#657). */}
        <VerdictChip verdict={r.verdict} />{' '}
        <InfoTip label={VERDICT_PLAIN[r.verdict]} tip={MEANING[r.verdict]} triggerProps={{ 'data-verdict-help': r.verdict }}>
          <p>{MEANING[r.verdict]}</p>
        </InfoTip>
      </p>
      <ReadinessRows readiness={r} item={item} ruleText={ruleText} blockedAbove={blockedAbove} />
      {read && execute && (
        <p className="readiness-live">
          <Button className="btn btn--sm" onPress={check} isDisabled={reading}>
            {reading ? 'Reading the workflow…' : live ? 'Read the workflow again' : 'Check the workflow live'}
          </Button>{' '}
          {/* What the live read was is the result's source, so it stays in view once there is one (principle 4); before then the (i) explains the button. */}
          <span className="field" aria-live="polite">
            {live ? `Read live ${dateTime(live.at)} with toil ${read.command}.` : ''}
          </span>
        </p>
      )}
      {settings.notes.map((n, i) => (
        <p key={i} role="note" className="failure">
          {n}
        </p>
      ))}
    </Card>
  );
}
