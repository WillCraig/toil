/**
 * Settings, Usage, the AI agent half (#295): what the helper's models used over the last
 * 30 days, by day, AI agent, model and toil project, and the chats that used the
 * most, all added up in the page by the meter's one function from the
 * records the server keeps in its local cache. Under the totals, the rates Codex's
 * dollar figure is computed from. A CSV of the records downloads from here; nothing is sent anywhere.
 * The figures are the SDKs' own reports, and the page says the vendor's bill
 * is the authority. It sits under the audit summary on the Usage page (#309),
 * and the tables and the audit detail share one "More detail". A budget office, staffed by the budget.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { TokensPerDay } from '../../components/charts.tsx';
import { Card, DataTable } from '../../components/layout.tsx';
import { Empty, EmptyLink } from '../../components/empty.tsx';
import { Help, useLandOn } from '../../components/help.tsx';
import { dateTime, day } from '../../format.ts';
import {
  ADAPTER_LABEL,
  addUp,
  amount,
  compact,
  costParts,
  dayOf,
  modelKey,
  modelLabel,
  totalsBy,
  usageCsv,
  type UsageAdapter,
  type UsageRecord,
  type UsageSettings,
  type UsageTotals,
} from '../../model-usage.ts';
import type { ModelUsageApi, UsageView } from '../../server-client.ts';
import { Loader } from '../../moments/Moments.tsx';

const RATES_ID = 'model-usage-rates';
const tokens = (t: UsageTotals) => (t.tokens === undefined ? 'not reported' : compact(t.tokens));
const figure = (n: number | undefined) => (n === undefined ? 'not reported' : compact(n));

/** What a row's cost column says: premium requests for Copilot, else the dollar figure and its source. */
function costCell(t: UsageTotals, adapter: UsageAdapter | null) {
  if (adapter === 'copilot') return t.premiumRequests === undefined ? 'premium requests not reported' : `${amount(t.premiumRequests, 'premium-requests')}`;
  if (adapter) return costParts(t, adapter).join('; ');
  const parts = [...(t.costUsd['sdk-estimate'] !== undefined ? [`~${amount(t.costUsd['sdk-estimate'], 'usd')} SDK estimate`] : []), ...(t.costUsd['your-rates'] !== undefined ? [`~${amount(t.costUsd['your-rates'], 'usd')} from your rates`] : [])];
  if (t.premiumRequests !== undefined) parts.push(amount(t.premiumRequests, 'premium-requests'));
  return parts.length ? parts.join('; ') : 'no dollar figure';
}

/** Every day of the window, with the days nobody asked anything as 0, so the chart doesn't skip them. */
function tokenDays(records: readonly UsageRecord[], since: string, today: string) {
  const byDay = new Map(totalsBy(records, dayOf).map((g) => [g.key, g.totals.tokens ?? 0]));
  const out: Array<{ day: string; tokens: number }> = [];
  for (let t = Date.parse(`${since.slice(0, 10)}T00:00:00Z`); t <= Date.parse(`${today}T00:00:00Z`) && out.length < 400; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    out.push({ day: d, tokens: byDay.get(d) ?? 0 });
  }
  return out;
}

/** The one place the page's detail lives: closed until asked for (principle 11). `detail` is what the audit log adds. */
function MoreDetail({ children, detailsRef }: { children?: ReactNode; detailsRef?: RefObject<HTMLDetailsElement | null> }) {
  return (
    <details ref={detailsRef} className="usage-more" data-usage-more="">
      <summary>More detail</summary>
      {children}
    </details>
  );
}

export function ModelUsage({ api, landOn = null, detail = null }: { api: ModelUsageApi | null; landOn?: string | null; detail?: ReactNode }) {
  const [view, setView] = useState<UsageView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    let live = true;
    api.view().then(
      (v) => live && setView(v),
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [api]);
  // An edit link to the Codex rates (#346) lands on their heading once the figures have loaded.
  useLandOn(landOn, view !== null || problem !== null);

  if (!api) return <><p className="failure">This app can't read what the AI agent used, so there is nothing to show.</p>{detail && <MoreDetail>{detail}</MoreDetail>}</>;
  if (problem)
    return (
      <>
        <p role="alert" className="failure">
          What the AI agent used couldn't be read: {problem}
        </p>
        {detail && <MoreDetail>{detail}</MoreDetail>}
      </>
    );
  if (!view)
    return (
      <>
        <Loader size="panel" message="Reading what the AI agent used…" />
        {detail && <MoreDetail>{detail}</MoreDetail>}
      </>
    );
  return <Loaded view={view} api={api} onSaved={setView} detail={detail} landOn={landOn} />;
}

function Loaded({ view, api, onSaved, detail, landOn }: { view: UsageView; api: ModelUsageApi; onSaved: (v: UsageView) => void; detail: ReactNode; landOn: string | null }) {
  // The Codex rates sit inside More detail, so a link to them (RATES_HREF) opens it first; a layout effect runs before ModelUsage's useLandOn tries to focus the heading.
  const more = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    if (landOn === RATES_ID && more.current) more.current.open = true;
  }, [landOn]);
  const records = view.records;
  const all = useMemo(() => addUp(records), [records]);
  const byAdapter = useMemo(() => totalsBy(records, (r) => r.adapter), [records]);
  const byModel = useMemo(() => totalsBy(records, modelKey), [records]);
  const byToilProject = useMemo(() => totalsBy(records, (r) => r.toilProject), [records]);
  const byChat = useMemo(() => totalsBy(records, (r) => r.chatId).slice(0, 10), [records]);
  const turns = useMemo(() => {
    const out = new Map<string, number>();
    for (const r of records) out.set(r.chatId, Math.max(out.get(r.chatId) ?? 0, r.turn));
    return out;
  }, [records]);
  const today = view.now.slice(0, 10);

  const download = () => {
    const blob = new Blob([usageCsv(records)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `toil-ui-model-usage-${today}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <>
      <Card as="section" className="panel usage" aria-labelledby="model-usage-totals">
        <h2 id="model-usage-totals">What your AI agent used</h2>
        <p className="lede">
          What your AI agents reported each chat used, since {day(view.since)}, UTC. <Help topic="model-usage" />
        </p>
        {view.problem && (
          <p role="alert" className="failure">
            {view.problem} Until the rates can be read, Codex answers carry no dollar figure.
          </p>
        )}
        {view.sample && <p className="note">These are sample figures, made up for the preview. No model reported them.</p>}
        {view.retentionDays !== null && view.retentionDays < 30 && <p className="note">The cache keeps a record {view.retentionDays} days, so this window holds only the last {view.retentionDays}.</p>}
        <dl className="fields usage-totals">
          <dt>Tokens</dt>
          <dd>{tokens(all)}</dd>
          <dt>In, out</dt>
          <dd>
            {figure(all.inputTokens)} in, {figure(all.outputTokens)} out
          </dd>
          <dt>Cache</dt>
          <dd>
            {figure(all.cachedInputTokens)} read, {figure(all.cacheWriteTokens)} written
          </dd>
          <dt>Dollars</dt>
          <dd>{costCell({ ...all, premiumRequests: undefined }, null)}</dd>
          <dt>Premium requests</dt>
          <dd>{all.premiumRequests === undefined ? 'none reported' : amount(all.premiumRequests, 'premium-requests')}</dd>
        </dl>
        {all.reports === 0 && <Empty message="No chat has used an AI agent in this window yet." action={<EmptyLink href="#/">Open a Toil project to ask</EmptyLink>} />}
        <TokensPerDay days={tokenDays(records, view.since, today)} compact={compact} />
        <div className="conn-actions">
          <button type="button" className="btn" onClick={download} disabled={all.reports === 0} data-usage-export="">
            Export as CSV
          </button>
        </div>
      </Card>

      <MoreDetail detailsRef={more}>
        <RatesForm view={view} api={api} onSaved={onSaved} />

        <Card as="section" className="panel" aria-labelledby="model-usage-adapters">
          <h3 id="model-usage-adapters">By AI agent</h3>
          <DataTable
            label="Usage by AI agent"
            caption="Usage by AI agent"
            rows={byAdapter}
            rowKey={(g) => g.key}
            columns={[
              { header: 'AI agent', label: 'AI agent', rowHeader: true, cell: (g) => ADAPTER_LABEL[g.sample.adapter] },
              { header: 'Tokens', label: 'Tokens', cell: (g) => tokens(g.totals) },
              { header: 'In / out', label: 'In / out', cell: (g) => `${figure(g.totals.inputTokens)} / ${figure(g.totals.outputTokens)}` },
              { header: 'Cost', label: 'Cost', cell: (g) => costCell(g.totals, g.sample.adapter) },
            ]}
          />
        </Card>

        <Card as="section" className="panel" aria-labelledby="model-usage-models">
          <h3 id="model-usage-models">By model</h3>
          <DataTable
            label="Usage by model"
            caption="Usage by model and the AI agent it ran on"
            rows={byModel}
            rowKey={(g) => g.key}
            columns={[
              { header: 'Model', label: 'Model', rowHeader: true, cell: (g) => <code>{modelLabel(g.sample)}</code> },
              { header: 'AI agent', label: 'AI agent', cell: (g) => ADAPTER_LABEL[g.sample.adapter] },
              { header: 'Tokens', label: 'Tokens', cell: (g) => tokens(g.totals) },
              { header: 'Cost', label: 'Cost', cell: (g) => costCell(g.totals, g.sample.adapter) },
            ]}
          />
        </Card>

        <Card as="section" className="panel" aria-labelledby="model-usage-toil-projects">
          <h3 id="model-usage-toil-projects">By Toil project</h3>
          <DataTable
            label="Usage by Toil project"
            caption="Usage by Toil project"
            rows={byToilProject}
            rowKey={(g) => g.key}
            columns={[
              { header: 'Toil project', label: 'Toil project', rowHeader: true, cell: (g) => g.key },
              { header: 'Tokens', label: 'Tokens', cell: (g) => tokens(g.totals) },
              { header: 'Cost', label: 'Cost', cell: (g) => costCell(g.totals, null) },
            ]}
          />
        </Card>

        <Card as="section" className="panel" aria-labelledby="model-usage-chats">
          <h3 id="model-usage-chats">Chats that used the most</h3>
          {byChat.length === 0 ? (
            <p>No chat in this window.</p>
          ) : (
            <DataTable
              label="The chats that used the most"
              caption="The ten chats that used the most tokens"
              rows={byChat}
              rowKey={(g) => g.key}
              columns={[
                { header: 'Started', label: 'Started', rowHeader: true, cell: (g) => dateTime(g.sample.at) },
                { header: 'Toil project', label: 'Toil project', cell: (g) => g.sample.toilProject },
                { header: 'Model', label: 'Model', cell: (g) => `${ADAPTER_LABEL[g.sample.adapter]}, ${modelLabel(g.sample)}` },
                { header: 'Questions', label: 'Questions', cell: (g) => turns.get(g.key) ?? 1 },
                { header: 'Tokens', label: 'Tokens', cell: (g) => tokens(g.totals) },
                { header: 'Cost', label: 'Cost', cell: (g) => costCell(g.totals, g.sample.adapter) },
              ]}
            />
          )}
        </Card>
        {detail}
      </MoreDetail>
    </>
  );
}

type RateRow = { input: string; cached: string; output: string };

/**
 * The Codex rates: what Toil UI computes each Codex answer's dollar figure
 * from, since the SDK reports tokens only. The rates are sent as typed: the
 * server refuses anything that isn't a number of 0 or more, naming the
 * setting, rather than read it as 0.
 */
function RatesForm({ view, api, onSaved }: { view: UsageView; api: ModelUsageApi; onSaved: (v: UsageView) => void }) {
  const r = view.settings.codexRates;
  const [rates, setRates] = useState<RateRow>(() => ({ input: r ? String(r.inputPerMillion) : '', cached: r ? String(r.cachedInputPerMillion) : '', output: r ? String(r.outputPerMillion) : '' }));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const off = view.sample ? "This preview can't save rates." : null;

  // A number as typed goes as a number; anything else goes as the text, for the server to refuse by name.
  const number = (text: string) => (text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : text);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    setSaved('');
    const anyRate = rates.input.trim() || rates.cached.trim() || rates.output.trim();
    const settings = {
      codexRates: anyRate ? { inputPerMillion: number(rates.input), cachedInputPerMillion: number(rates.cached), outputPerMillion: number(rates.output) } : null,
    } as unknown as UsageSettings;
    setBusy(true);
    try {
      const next = await api.save(settings);
      onSaved(next);
      setSaved(settings.codexRates ? 'Saved. Codex answers from now on carry a dollar figure from these rates.' : "Saved. Codex answers won't show a dollar figure.");
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card as="section" className="panel" aria-labelledby={RATES_ID}>
      <h3 id={RATES_ID} tabIndex={-1}>
        Codex rates <Help topic="rates" />
      </h3>
      <p className="lede">
        Codex reports tokens, not dollars. Enter your rates to see a cost.
      </p>
      {off && <p className="note">{off}</p>}
      <form className="rates-form" onSubmit={(e) => void submit(e)}>
        <fieldset className="rates-grid" disabled={!!off || busy}>
          <legend>Dollars per million tokens</legend>
          {(
            [
              ['input', 'Input'],
              ['cached', 'Cached input'],
              ['output', 'Output'],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="rate">
              {label}
              <input inputMode="decimal" value={rates[k]} onChange={(e) => setRates((x) => ({ ...x, [k]: e.target.value }))} />
            </label>
          ))}
        </fieldset>
        <p className="note">Leave all three empty for none.</p>
        <div className="conn-actions">
          <button type="submit" className="btn btn--accent" disabled={!!off || busy}>
            Save rates
          </button>
          <span className="runs" role="status">
            {saved}
          </span>
        </div>
        {problem && (
          <p role="alert" className="failure">
            {problem}
          </p>
        )}
      </form>
    </Card>
  );
}
