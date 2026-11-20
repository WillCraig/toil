/**
 * What the agent's model used, in the chat (#295): a footer under each
 * answer, and the chat's running total and context meter in its header.
 * Every figure names the adapter and model it ran on and where it came from
 * (the SDK's estimate, your rates, premium requests), a figure the SDK didn't
 * report reads "not reported", and both read the meter's one adding-up
 * function (src/model-usage.ts), so the footer, the header and Settings can
 * never disagree. A receipt stapled to every memo.
 */

import { useId } from 'react';
import { RATES_HREF } from '../format.ts';
import { EditLink } from './help.tsx';
import { ADAPTER_LABEL, addUp, compact, dollars, modelKey, modelLabel, totalsBy, usageParts, type AnswerUsage, type UsageRecord } from '../model-usage.ts';

/**
 * What the records used, in one phrase for someone who doesn't read tokens:
 * "about $0.04 of usage (estimate)", or "Covered by your Claude plan (about
 * $0.12 of usage)" where a plan pays for it (#552). Null when there is no
 * dollar figure to say: a line that only says so is left off, and the tokens
 * stay in the breakdown and the run's details.
 */
export function usageSummary(records: readonly UsageRecord[]): string | null {
  const t = addUp(records);
  if (!records.length || !Object.keys(t.costUsd).length) return null;
  const cost = Object.values(t.costUsd).reduce((a, b) => a + b, 0);
  const figure = `about ${cost < 0.01 ? dollars(cost) : `$${cost.toFixed(2)}`} of usage`;
  const onPlan = records.find((r) => r.plan && typeof r.costUsd === 'number');
  return onPlan ? `Covered by your ${ADAPTER_LABEL[onPlan.adapter]} plan (${figure})` : `${figure} (estimate)`;
}

/**
 * The footer under one answer: a line a person can read, then the model, the
 * token breakdown and the quota behind a fold, and any notice out in the
 * open, since a missing dollar figure is never something to open a fold for.
 */
/** The same line the footer's fold opens from, for a caller that folds it into a line of its own: "about $0.04 of usage", with a sample's label first. Null with no dollar figure. */
export function usageLine(usage: AnswerUsage): string | null {
  const summary = usageSummary(usage.records);
  return summary && `${usage.sample ? 'Sample figures, not from a model. ' : ''}${summary}`;
}

export function UsageFooter({ usage }: { usage: AnswerUsage }) {
  // With no dollar figure the folded line says the tokens instead, never that a figure is missing; the breakdown stays one fold in.
  const tokens = addUp(usage.records).tokens;
  const summary = usageSummary(usage.records) ?? (tokens === undefined ? null : `${compact(tokens)} tokens`);
  if (!summary && usage.notices.length === 0) return null;
  return (
    <div className="usage-footer" role="group" aria-label="What this answer used" data-usage-footer="">
      {summary && (
        <details className="usage-details">
          <summary className="usage-line">
            {usage.sample && <span className="usage-sample">Sample figures, not from a model. </span>}
            {summary}
          </summary>
          <UsageBreakdown usage={usage} />
        </details>
      )}
      <UsageNotices usage={usage} />
    </div>
  );
}

/** The model, the token breakdown and the quota behind an answer's usage line. */
export function UsageBreakdown({ usage }: { usage: AnswerUsage }) {
  const groups = totalsBy(usage.records, modelKey);
  return (
    <>
      {groups.length === 0 ? (
        <p className="usage-line">{ADAPTER_LABEL[usage.adapter]} reported no usage for this answer.</p>
      ) : (
        groups.map((g) => (
          <p key={g.key} className="usage-line">
            {usage.sample && <span className="usage-sample">Sample figures, not from a model. </span>}
            <span className="usage-model">
              {ADAPTER_LABEL[g.sample.adapter]}, {modelLabel(g.sample)}:
            </span>{' '}
            {usageParts(g.totals, g.sample.adapter).join(' · ')}
          </p>
        ))
      )}
      {usage.quota && (
        <p className="usage-line">
          {usage.quota.unlimited
            ? 'Your Copilot premium requests are unlimited'
            : usage.quota.remaining === null
              ? 'Copilot gave no count of premium requests left'
              : `${usage.quota.remaining} premium requests left this period${usage.quota.entitlement !== null ? ` of ${usage.quota.entitlement}` : ''}${usage.quota.resetDate ? `, until ${usage.quota.resetDate.slice(0, 10)}` : ''}`}{' '}
          (experimental, from the Copilot SDK's account.getQuota).
        </p>
      )}
    </>
  );
}

/** Why a Codex answer has no dollar figure from your rates: never something to open a fold for. */
export function UsageNotices({ usage }: { usage: AnswerUsage }) {
  return (
    <>
      {usage.notices.map((n, i) => (
        <p key={i} className="usage-notice" role="status">
          {n} <EditLink href={RATES_HREF} label="Edit the Codex rates" />
        </p>
      ))}
    </>
  );
}

/** The chat's running total, split by model, and how full the last answer's context got, under the chat's heading. */
export function ChatUsage({ usages }: { usages: AnswerUsage[] }) {
  if (usages.length === 0) return null;
  const records: UsageRecord[] = usages.flatMap((u) => u.records);
  const groups = totalsBy(records, modelKey);
  const all = addUp(records);
  const last = usages[usages.length - 1]!;
  const sample = usages.some((u) => u.sample);
  return (
    <details className="chat-usage" aria-label="What this chat used" data-chat-usage="">
      <summary className="usage-line">
        {sample && <span className="usage-sample">Sample figures. </span>}
        This chat: {usageSummary(records) ?? (all.tokens === undefined ? 'what it used' : `${compact(all.tokens)} tokens`)}
      </summary>
      <p className="usage-line">
        {all.tokens === undefined ? 'Tokens not reported' : `${compact(all.tokens)} tokens`}
        {groups.length > 1 ? `, on ${groups.length} models` : ''}.
      </p>
      {groups.map((g) => (
        <p key={g.key} className="usage-line">
          <span className="usage-model">
            {ADAPTER_LABEL[g.sample.adapter]}, {modelLabel(g.sample)}:
          </span>{' '}
          {usageParts(g.totals, g.sample.adapter).join(' · ')}
        </p>
      ))}
      <ContextMeter usage={last} />
    </details>
  );
}

function ContextMeter({ usage }: { usage: AnswerUsage }) {
  const id = useId();
  const c = usage.context;
  if (!c) return <p className="usage-line">Context: not reported by the {ADAPTER_LABEL[usage.adapter]} SDK.</p>;
  const share = Math.min(1, c.used / c.window);
  const words = `${compact(c.used)} of ${compact(c.window)} tokens (${Math.round(share * 100)}%)`;
  return (
    <p className="usage-line context-meter">
      <span id={id}>Context of the last answer: {words}</span>
      <meter min={0} max={c.window} value={Math.min(c.used, c.window)} aria-labelledby={id} />
    </p>
  );
}
