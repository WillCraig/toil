/**
 * Settings, Agent usage (#295): what the agent's models used over the last
 * 30 days, by day, adapter, model and toil project, and the chats that used the
 * most, all added up in the page by the meter's one function from the
 * records the server keeps in its local cache. Below that, the caps, each
 * off until it's turned on, and the rates Codex's dollar figure is computed
 * from. A CSV of the records downloads from here; nothing is sent anywhere.
 * The figures are the SDKs' own reports, and the page says the vendor's bill
 * is the authority. Beside the Usage page (#309), which counts toil's own
 * commands from its audit log. A budget office, staffed by the budget.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { TokensPerDay } from '../../components/charts.tsx';
import { Card, DataTable } from '../../components/layout.tsx';
import { Help, useLandOn } from '../../components/help.tsx';
import { dateTime, day } from '../../format.ts';
import {
  ADAPTER_LABEL,
  CAP_SETTINGS,
  UNIT_LABEL,
  addUp,
  amount,
  compact,
  costParts,
  dayOf,
  modelKey,
  modelLabel,
  totalsBy,
  usageCsv,
  type CapKey,
  type CapUnit,
  type UsageAdapter,
  type UsageRecord,
  type UsageSettings,
  type UsageTotals,
} from '../../model-usage.ts';
import type { ModelUsageApi, UsageView } from '../../server-client.ts';
import { Loader } from '../../moments/Moments.tsx';

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

export function ModelUsage({ api, landOn = null }: { api: ModelUsageApi | null; landOn?: string | null }) {
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
  // An edit link to the caps (#346) lands on their heading once the figures have loaded.
  useLandOn(landOn, view !== null || problem !== null);

  if (!api) return <p className="failure">This app wasn't given the agent's usage, so there is nothing to show.</p>;
  if (problem)
    return (
      <p role="alert" className="failure">
        Reading the model usage failed: {problem}
      </p>
    );
  if (!view) return <Loader size="panel" message={"Reading what the agent's models used…"} />;
  return <Loaded view={view} api={api} onSaved={setView} />;
}

function Loaded({ view, api, onSaved }: { view: UsageView; api: ModelUsageApi; onSaved: (v: UsageView) => void }) {
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
        <h2 id="model-usage-totals">Usage of the agent's models</h2>
        <p className="lede">
          What the Claude, Codex and Copilot SDKs reported each chat used, since {day(view.since)}, UTC. <Help topic="model-usage" />
        </p>
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
        {all.reports === 0 && <p className="note">No chat has used a model in this window yet. Each answer the agent gives adds what its SDK reported.</p>}
        <TokensPerDay days={tokenDays(records, view.since, today)} compact={compact} />
        <div className="conn-actions">
          <button type="button" className="btn" onClick={download} disabled={all.reports === 0} data-usage-export="">
            Export as CSV
          </button>
          <span className="runs">one row per report, a figure the SDK didn't report left empty</span>
        </div>
      </Card>

      <Card as="section" className="panel" aria-labelledby="model-usage-adapters">
        <h2 id="model-usage-adapters">By adapter</h2>
        <DataTable
          label="Usage by adapter"
          caption="Usage by adapter"
          rows={byAdapter}
          rowKey={(g) => g.key}
          columns={[
            { header: 'Adapter', label: 'Adapter', rowHeader: true, cell: (g) => ADAPTER_LABEL[g.sample.adapter] },
            { header: 'Tokens', label: 'Tokens', cell: (g) => tokens(g.totals) },
            { header: 'In / out', label: 'In / out', cell: (g) => `${figure(g.totals.inputTokens)} / ${figure(g.totals.outputTokens)}` },
            { header: 'Cost', label: 'Cost', cell: (g) => costCell(g.totals, g.sample.adapter) },
          ]}
        />
      </Card>

      <Card as="section" className="panel" aria-labelledby="model-usage-models">
        <h2 id="model-usage-models">By model</h2>
        <DataTable
          label="Usage by model"
          caption="Usage by model and the adapter it ran on"
          rows={byModel}
          rowKey={(g) => g.key}
          columns={[
            { header: 'Model', label: 'Model', rowHeader: true, cell: (g) => <code>{modelLabel(g.sample)}</code> },
            { header: 'Adapter', label: 'Adapter', cell: (g) => ADAPTER_LABEL[g.sample.adapter] },
            { header: 'Tokens', label: 'Tokens', cell: (g) => tokens(g.totals) },
            { header: 'Cost', label: 'Cost', cell: (g) => costCell(g.totals, g.sample.adapter) },
          ]}
        />
      </Card>

      <Card as="section" className="panel" aria-labelledby="model-usage-toil-projects">
        <h2 id="model-usage-toil-projects">By Toil project</h2>
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
        <h2 id="model-usage-chats">Chats that used the most</h2>
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

      <CapsForm view={view} api={api} onSaved={onSaved} />
    </>
  );
}

type CapRow = { on: boolean; unit: CapUnit; limit: string };
type RateRow = { input: string; cached: string; output: string };

const capRows = (s: UsageSettings): Record<CapKey, CapRow> =>
  Object.fromEntries(
    CAP_SETTINGS.map((c) => {
      const v = s.caps[c.key];
      return [c.key, v && v !== 'off' ? { on: true, unit: v.unit, limit: String(v.limit) } : { on: false, unit: c.units[0], limit: '' }];
    }),
  ) as Record<CapKey, CapRow>;

/**
 * The caps and Codex rates. A cap is off until its box is ticked, and an "on"
 * cap's limit is sent as typed: the server refuses anything that isn't a
 * number above 0, naming the setting, rather than read it as 0 or off.
 */
function CapsForm({ view, api, onSaved }: { view: UsageView; api: ModelUsageApi; onSaved: (v: UsageView) => void }) {
  const [rows, setRows] = useState(() => capRows(view.settings));
  const r = view.settings.codexRates;
  const [rates, setRates] = useState<RateRow>(() => ({ input: r ? String(r.inputPerMillion) : '', cached: r ? String(r.cachedInputPerMillion) : '', output: r ? String(r.outputPerMillion) : '' }));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const off = view.sample ? "This preview shows sample caps, so they can't be saved." : null;

  // A number as typed goes as a number; anything else goes as the text, for the server to refuse by name.
  const number = (text: string) => (text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : text);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    setSaved('');
    const anyRate = rates.input.trim() || rates.cached.trim() || rates.output.trim();
    const settings = {
      caps: Object.fromEntries(CAP_SETTINGS.map((c) => [c.key, rows[c.key].on ? { unit: rows[c.key].unit, limit: number(rows[c.key].limit) } : 'off'])),
      codexRates: anyRate ? { inputPerMillion: number(rates.input), cachedInputPerMillion: number(rates.cached), outputPerMillion: number(rates.output) } : null,
    } as unknown as UsageSettings;
    setBusy(true);
    try {
      const next = await api.save(settings);
      onSaved(next);
      setSaved('Saved. The next question is held to these caps.');
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card as="section" className="panel" aria-labelledby="model-usage-caps">
      <h2 id="model-usage-caps" tabIndex={-1}>
        Caps
      </h2>
      <p className="lede">
        Optional, and off until you turn one on. Codex reports usage when an answer ends, so its cap refuses the next question rather than stopping one partway. <Help topic="caps" />
      </p>
      {view.problem && (
        <p role="alert" className="failure">
          {view.problem} Until the caps can be read, the agent answers nothing.
        </p>
      )}
      {off && <p className="note">{off}</p>}
      <form className="caps-form" onSubmit={(e) => void submit(e)}>
        <fieldset className="caps-grid" disabled={!!off || busy}>
          <legend className="sr-only">Caps per chat and per day</legend>
          {CAP_SETTINGS.map((c) => {
            const row = rows[c.key];
            const set = (patch: Partial<CapRow>) => setRows((rs) => ({ ...rs, [c.key]: { ...rs[c.key], ...patch } }));
            const id = `cap-${c.key.replace('.', '-')}`;
            return (
              <div key={c.key} className="cap-row" data-cap={c.key}>
                <label className="cap-on">
                  <input type="checkbox" checked={row.on} onChange={(e) => set({ on: e.target.checked })} />
                  {ADAPTER_LABEL[c.adapter]}, {c.scope === 'chat' ? 'per chat' : 'per day (UTC)'}
                </label>
                <label htmlFor={`${id}-limit`} className="sr-only">
                  {ADAPTER_LABEL[c.adapter]} {c.scope === 'chat' ? 'per-chat' : 'per-day'} limit
                </label>
                <input id={`${id}-limit`} className="cap-limit" inputMode="decimal" value={row.limit} disabled={!row.on} placeholder={row.on ? 'limit' : 'off'} onChange={(e) => set({ limit: e.target.value })} />
                <label htmlFor={`${id}-unit`} className="sr-only">
                  {ADAPTER_LABEL[c.adapter]} {c.scope === 'chat' ? 'per-chat' : 'per-day'} unit
                </label>
                <select id={`${id}-unit`} value={row.unit} disabled={!row.on} onChange={(e) => set({ unit: e.target.value as CapUnit })}>
                  {c.units.map((u) => (
                    <option key={u} value={u}>
                      {UNIT_LABEL[u]}
                    </option>
                  ))}
                </select>
                <code className="cap-key">{c.key}</code>
              </div>
            );
          })}
        </fieldset>
        <fieldset className="rates-grid" disabled={!!off || busy}>
          <legend>Codex rates, in dollars per million tokens</legend>
          <p className="note">The Codex SDK reports tokens and no dollar figure. With your rates, Toil UI computes one for each Codex answer from now on, labelled as computed from your rates. Leave all three empty for none.</p>
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
        <div className="conn-actions">
          <button type="submit" className="btn btn--accent" disabled={!!off || busy}>
            Save caps and rates
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
