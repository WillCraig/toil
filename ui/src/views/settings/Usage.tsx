/**
 * Settings, Usage (#309): how Toil is used on this computer, from toil's own
 * local audit log, and what the AI agent's models used (ModelUsage). What a
 * person reads first is one short sentence: calls, failures and changes made,
 * with Toil UI's own background calls left out, since they aren't the person's
 * use and a failing one would otherwise count against them. Everything else
 * (the chart, who called, the calls that failed most, the helper's tables) sits
 * behind one "More detail" (principle 11). Both reads are local files only.
 * Nothing here is sent anywhere, and nothing is counted that the log doesn't
 * hold: a call's code and outcome, never its input or its result. Metrics about
 * the metrics, reviewed by the metrics committee, which has not met.
 */

import { useEffect, useId, useState } from 'react';
import type { AuditLine, UsageGroup } from '../../../../src/audit/stats.ts';
import { CallsPerDay } from '../../components/charts.tsx';
import { Card, DataTable } from '../../components/layout.tsx';
import { Help } from '../../components/help.tsx';
import type { ConfigApi } from '../../config.ts';
import { dateTime, day } from '../../format.ts';
import type { Envelope } from '../../toil.ts';
import { doorLabel, failingMost, failuresInput, fillDays, ownGroups, ownTotals, TOIL_UI_CALLER, USAGE_CALLS, type UsageStats } from '../../usage.ts';
import type { ModelUsageApi } from '../../server-client.ts';
import { Loader } from '../../moments/Moments.tsx';
import { useWords } from '../../skins.tsx';
import { ModelUsage } from './ModelUsage.tsx';

const percent = (n: number, of: number) => (of === 0 ? '0%' : `${Math.round((n / of) * 100)}%`);
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Loaded<T> = { ok: true; data: T } | { ok: false; message: string };

const loadedFrom = <T,>(e: Envelope): Loaded<T> => (e.ok ? { ok: true, data: e.data as T } : { ok: false, message: `${e.error.message}${e.error.fix ? ` ${e.error.fix}` : ''}` });

async function load<T>(config: ConfigApi, command: string, input: Record<string, unknown>): Promise<Loaded<T>> {
  try {
    return loadedFrom<T>(await config.run(command, input));
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

type Stats = { days: UsageStats; commands: UsageStats; doors: UsageStats };

export function Usage({ config, modelUsage = null, landOn = null, today = new Date().toISOString().slice(0, 10) }: { config: ConfigApi | null; modelUsage?: ModelUsageApi | null; landOn?: string | null; today?: string }) {
  const [stats, setStats] = useState<Loaded<Stats> | null>(null);
  useEffect(() => {
    if (!config) return;
    let live = true;
    // One end for all three, so the figures agree: each call adds its own line to the log as it runs.
    const until = new Date().toISOString();
    const read = (input: Record<string, unknown>) => load<UsageStats>(config, 'audit stats', { ...input, until });
    Promise.all([read(USAGE_CALLS.days), read(USAGE_CALLS.commands), read(USAGE_CALLS.doors)]).then(([days, commands, doors]) => {
      if (!live) return;
      const bad = [days, commands, doors].find((s) => !s.ok);
      setStats(bad && !bad.ok ? bad : days.ok && commands.ok && doors.ok ? { ok: true, data: { days: days.data, commands: commands.data, doors: doors.data } } : { ok: false, message: 'Nothing was read.' });
    });
    return () => {
      live = false;
    };
  }, [config]);

  return (
    <>
      <Card as="section" className="panel usage" aria-labelledby="usage-totals">
        <h2 id="usage-totals">How Toil is used</h2>
        {!config ? (
          <p className="note">This app can't read its usage here.</p>
        ) : !stats ? (
          <Loader size="panel" message="Reading how Toil is used…" />
        ) : !stats.ok ? (
          <div role="alert" className="failure">
            <p>Usage couldn't be read: {stats.message}</p>
          </div>
        ) : (
          <Summary stats={stats.data} />
        )}
      </Card>
      <ModelUsage api={modelUsage} landOn={landOn} detail={config && stats?.ok ? <Detail stats={stats.data} config={config} today={today} /> : null} />
    </>
  );
}

function Summary({ stats }: { stats: Stats }) {
  const t = ownTotals(stats.doors.groups);
  return (
    <>
      <p className="lede">
        {t.calls === 0
          ? `Nothing has run since ${day(stats.commands.window.since)}.`
          : `Since ${day(stats.commands.window.since)}: ${plural(t.calls, 'call')}, ${t.failed} failed (${percent(t.failed, t.calls)}), ${t.writes} changed something.`}{' '}
        <Help topic="audit" />
      </p>
      <p className="note">What Toil UI asks for in the background isn't counted here.</p>
    </>
  );
}

/** Everything behind "More detail" that comes from the audit log. */
function Detail({ stats, config, today }: { stats: Stats; config: ConfigApi; today: string }) {
  const { days, commands, doors } = stats;
  const own = ownGroups(commands.groups, 'command');
  const failing = failingMost(own).slice(0, 8);
  const ownDays = ownGroups(days.groups, 'day');
  return (
    <>
      <Card as="section" className="panel" aria-labelledby="usage-days">
        <h3 id="usage-days">Calls by day</h3>
        <CallsPerDay days={fillDays(ownDays, days.window.since, days.window.until ? new Date(Date.parse(days.window.until) - 1).toISOString().slice(0, 10) : today)} />
      </Card>

      <Card as="section" className="panel" aria-labelledby="usage-doors">
        <h3 id="usage-doors">Who made the calls</h3>
        <DataTable
          label="Calls by who made them"
          caption="Calls by who made them"
          rows={doors.groups}
          rowKey={(g) => `${g.via}:${g.caller}`}
          columns={[
            { header: 'From', label: 'From', rowHeader: true, cell: (g) => doorLabel(g.via, g.caller) },
            { header: 'Calls', label: 'Calls', cell: (g) => `${g.calls} (${percent(g.calls, doors.totals.calls)})` },
            { header: 'Failed', label: 'Failed', cell: (g) => g.failed },
            { header: 'Typical time', label: 'Typical time', cell: (g) => ms(g.durationMs.median) },
            { header: 'Slowest 5%', label: 'Slowest 5%', cell: (g) => ms(g.durationMs.p95) },
          ]}
        />
      </Card>

      <Card as="section" className="panel" aria-labelledby="usage-top">
        <h3 id="usage-top">Used most</h3>
        <DataTable
          label="What was used most"
          caption="What was used most"
          rows={own.slice(0, 10)}
          rowKey={(g) => g.command ?? ''}
          columns={[
            { header: 'What', label: 'What', rowHeader: true, cell: (g) => g.command },
            { header: 'Calls', label: 'Calls', cell: (g) => g.calls },
            { header: 'Failed', label: 'Failed', cell: (g) => g.failed },
            { header: 'Last', label: 'Last called', cell: (g) => dateTime(g.lastSeen) },
          ]}
        />
      </Card>

      <Card as="section" className="panel" aria-labelledby="usage-failing">
        <h3 id="usage-failing">Failed most</h3>
        <p className="lede">
          Each with its most common error and the fix that usually applies. <Help topic="audit-failures" />
        </p>
        {failing.length === 0 ? (
          <p>Nothing failed in this window.</p>
        ) : (
          <ul className="usage-failing">
            {failing.map((g) => (
              <li key={g.command}>
                <Failing group={g} config={config} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Failing({ group: g, config }: { group: UsageGroup; config: ConfigApi }) {
  const words = useWords();
  const [lines, setLines] = useState<Loaded<AuditLine[]> | 'loading' | null>(null);
  const id = useId();
  const top = g.errors[0];
  const toggle = async () => {
    if (lines !== null && lines !== 'loading') return setLines(null);
    setLines('loading');
    const got = await load<AuditLine[]>(config, 'audit list', failuresInput(g.command ?? ''));
    // Toil UI's own failing calls aren't the person's, here as in the counts.
    setLines(got.ok ? { ok: true, data: got.data.filter((e) => e.caller !== TOIL_UI_CALLER) } : got);
  };
  return (
    <Card className="usage-fail">
      <h4>{g.command}</h4>
      <p>
        Failed {g.failed} of {plural(g.calls, 'call')}
        {top ? `, most often with ${top.code} (${top.count})` : ''}.
      </p>
      {top?.fix && <p className="note">Usual fix: {top.fix}</p>}
      {g.errors.length > 1 && (
        <p className="note">
          Also: {g.errors.slice(1).map((e) => `${e.code} (${e.count})`).join(', ')}
        </p>
      )}
      <div className="conn-actions">
        <button type="button" className="btn" aria-expanded={lines !== null} aria-controls={id} onClick={() => void toggle()} data-usage-lines="">
          {lines === null ? 'Show recent failures' : 'Hide recent failures'}
        </button>
      </div>
      <div id={id}>
        {lines === 'loading' && <Loader size="panel" message={words('loading.audit')} />}
        {lines !== null && lines !== 'loading' && !lines.ok && (
          <p role="alert" className="failure">
            The recent failures couldn't be read: {lines.message}
          </p>
        )}
        {lines !== null && lines !== 'loading' && lines.ok && (
          <DataTable
            label={`Recent failures of ${g.command}`}
            caption={`Recent failures of ${g.command}, newest first`}
            rows={lines.data}
            rowKey={(e) => `${e.time}:${e.via}:${e.outcome}`}
            columns={[
              { header: 'When', label: 'When', rowHeader: true, cell: (e) => dateTime(e.time) },
              { header: 'Error', label: 'Error', cell: (e) => e.outcome },
              { header: 'From', label: 'From', cell: (e) => doorLabel(e.via, e.caller) },
              { header: 'Connection', label: 'Connection', cell: (e) => e.connection ?? 'none' },
              { header: 'Took', label: 'Took', cell: (e) => ms(e.durationMs) },
            ]}
          />
        )}
      </div>
    </Card>
  );
}
