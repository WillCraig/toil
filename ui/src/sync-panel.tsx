/**
 * The sync panel (#250): what the local app's cache holds and how fresh it
 * is, for every toil project and each of its sources, with Sync now. Wiping the cache
 * is under Settings, General, Advanced. It sits beside the App rather than inside it (src/local.tsx), so the
 * views stay functions of their data and the preview never shows it.
 *
 * While a sync runs the panel polls `api/sync` once a second and says what
 * toil is doing (requests, pages, retries) in a polite live region. A source
 * whose latest sync failed shows toil's message and fix, and says its data is
 * the last good copy. * A progress bar that knows what it's measuring, which is rarer than it sounds.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { dateTime, toilProjectHref, sourceLabel } from './format.ts';
import { history, type HistoryEntry } from './history.ts';
import type { ToilProjectState, SyncClient, SyncStatus } from './server-client.ts';
import './sync-panel.css';

/** How often a running sync is polled. */
export const POLL_MS = 1000;

export interface SyncPanelProps {
  client: SyncClient;
  /** A sync finished or the cache was wiped: the views should read again. */
  onChange: (status: SyncStatus) => void;
  /** Every status read, running or not, so the page can show a running sync's progress in the theme's loader (#419). */
  onStatus?: (status: SyncStatus) => void;
  pollMs?: number;
  /** Raised by one for each Sync pressed outside the panel (#416). */
  request?: number;
}

/** The newest sync time across the toil projects, which is when the views' data was read. */
export function lastSynced(status: SyncStatus | null): string | null {
  const times = (status?.toilProjects ?? []).map((d) => d.lastSyncAt).sort();
  return times.length ? times[times.length - 1]! : null;
}

/** A finished sync as the bell keeps it (#417): how it went, linking to the toil project that failed, or the Toil projects view. */
export function syncEntry(s: SyncStatus): Omit<HistoryEntry, 'seq'> {
  const at = s.job.finishedAt ?? new Date().toISOString();
  // Every tab sees the same sync end, so the id is the sync's own.
  const id = `sync:${at}`;
  if (s.job.error) return { id, at, kind: 'sync-failed', title: 'The sync stopped', line: s.job.error, href: '#/' };
  const bad = s.toilProjects.flatMap((d) => d.sources.filter((x) => x.status === 'failed').map((x) => ({ toilProject: d.name, area: x.area })));
  const badToilProjects = s.toilProjects.filter((d) => d.status === 'failed' && !d.sources.some((x) => x.status === 'failed')).map((d) => d.name);
  if (bad.length || badToilProjects.length) {
    const named = [...bad.map((b) => `${b.toilProject}: ${sourceLabel(b.area)}`), ...badToilProjects.map((d) => `${d}: the Toil project`)];
    const first = bad[0]?.toilProject ?? badToilProjects[0]!;
    return { id, at, kind: 'sync-failed', title: `Sync finished; ${named.length} ${named.length === 1 ? 'source' : 'sources'} failed`, line: named.join(', '), href: toilProjectHref(first) };
  }
  const n = s.toilProjects.length;
  return { id, at, kind: 'sync', title: 'Sync finished', line: `${n} ${n === 1 ? 'Toil project' : 'Toil projects'} up to date`, href: '#/' };
}

function ToilProjectRow({ toilProject }: { toilProject: ToilProjectState }) {
  const failed = toilProject.sources.filter((s) => s.status === 'failed');
  return (
    <li className="sync-toil-project">
      <p>
        <strong>{toilProject.name}</strong> <span className="sync-when">synced {dateTime(toilProject.lastSyncAt)}</span>
      </p>
      {/* A toil project whose own read failed (projects show) keeps its sources as they were, so the error is the toil project's. */}
      {toilProject.status === 'failed' && failed.length === 0 && <p className="sync-bad">The latest sync couldn't read this Toil project: {toilProject.error}</p>}
      {toilProject.sources.length > 0 && (
        <ul className="sync-sources" aria-label={`${toilProject.name} sources`}>
          {toilProject.sources.map((s) => (
            <li key={s.area} className={s.status === 'failed' ? 'sync-bad' : undefined}>
              {s.status === 'ok' ? (
                <>
                  {sourceLabel(s.area)}: up to date
                </>
              ) : (
                <>
                  {sourceLabel(s.area)}: failed {dateTime(s.lastAttemptAt)}. {s.error} {s.fix}{' '}
                  <strong>{s.stale && s.lastSuccessAt ? `Showing the last good copy, from ${dateTime(s.lastSuccessAt)}.` : 'Nothing synced from it yet.'}</strong>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function SyncPanel({ client, onChange, onStatus, pollMs = POLL_MS, request = 0 }: SyncPanelProps) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const wasRunning = useRef(false);

  const take = useCallback(
    (next: SyncStatus) => {
      setStatus(next);
      setProblem(null);
      onStatus?.(next);
      if (wasRunning.current && !next.job.running) {
        const failed = next.toilProjects.flatMap((d) => d.sources).filter((s) => s.status === 'failed').length;
        setAnnounce(next.job.error ? `The sync stopped: ${next.job.error}` : failed ? `Sync finished; ${failed} source${failed === 1 ? '' : 's'} failed.` : 'Sync finished.');
        history.add([syncEntry(next)]);
        onChange(next);
      }
      wasRunning.current = next.job.running;
    },
    [onChange, onStatus],
  );
  const fail = (e: unknown) => setProblem(e instanceof Error ? e.message : String(e));

  useEffect(() => {
    client.status().then(take, fail);
  }, [client, take]);

  const running = status?.job.running === true;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => client.status().then(take, fail), pollMs);
    return () => clearInterval(timer);
  }, [running, client, take, pollMs]);

  const start = () => {
    setAnnounce('Sync started.');
    wasRunning.current = true;
    client.start().then(take, fail);
  };
  // Sync asked for from the page (#416), by the command palette or the first-run checklist: each new number is one
  // press. One made while a sync runs is that sync; one made before the panel has read the cache waits for it.
  const asked = useRef(request);
  useEffect(() => {
    if (request === asked.current || !status) return;
    asked.current = request;
    if (!running) start();
  });

  const job = status?.job;
  const last = lastSynced(status);
  return (
    <aside className="sync-panel" aria-labelledby="sync-heading">
      <div className="sync-inner">
        <div className="sync-head">
          <h2 id="sync-heading">Sync</h2>
          <p className="sync-when">
            {!status ? 'Reading the cache…' : last ? `Last synced ${dateTime(last)}. Kept ${status.retentionDays} days.` : 'Nothing synced yet: press Sync now to read your Toil projects.'}
          </p>
          <div className="sync-actions">
            <button type="button" onClick={start} disabled={!status || running}>
              {running ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        </div>

        <p role="status" className="sync-live">
          {running && job ? `Syncing ${job.toilProject ?? 'the Toil projects'}: ${job.toilProjectsDone} of ${job.toilProjectsTotal || '?'} Toil projects, ${job.requests} requests, ${job.pages} pages${job.retries ? `, ${job.retries} retries` : ''}. ${job.messages[job.messages.length - 1] ?? ''}` : announce}
        </p>
        {running && job && job.toilProjectsTotal > 0 && (
          <progress className="sync-progress" max={job.toilProjectsTotal} value={job.toilProjectsDone} aria-label="Toil projects synced" />
        )}
        {problem && (
          <p role="alert" className="sync-bad">
            {problem}
          </p>
        )}
        {job && !running && job.error && <p className="sync-bad">The last sync stopped: {job.error}</p>}

        {status && status.toilProjects.length > 0 && (
          <ul className="sync-toil-projects" aria-label="Toil projects in the cache">
            {status.toilProjects.map((d) => (
              <ToilProjectRow key={d.name} toilProject={d} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
