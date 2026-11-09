/**
 * The entry the local app builds (`vite build --mode app`): the same App the
 * preview runs, handed `execute()` and the Agent over the local server's API
 * instead of the fixtures. The server says whether it serves sample data, and
 * the App shows the preview banner when it does. When it keeps a cache (#250),
 * the sync panel sits under the App, the App's clock is the last sync (so
 * every view says when its data was synced), and the App reads again after
 * each sync or wipe. Same building, different badge reader.
 */

import { StrictMode, useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import type { Agent } from './agent.ts';
import './app.css';
import './views.css';
import type { ConfigApi } from './config.ts';
import type { SetupProgress } from './setup.ts';
import type { NewProjectProgress } from './views/NewProject.tsx';
import { httpAgent, httpAgentSettings, httpConfig, httpExecute, httpFeedback, httpModelUsage, httpServerStatus, httpSync, httpWorklog, httpAnalyses, readServerInfo, type AgentStatus, type ServerInfo, type SyncStatus } from './server-client.ts';
import { SyncPanel, lastSynced } from './sync-panel.tsx';
import { httpAssignments } from './assign/client.ts';
import { CALL_OPTIONS, type Execute } from './toil.ts';

/** The sync status as the cards read it: each toil project's last sync and how it went. */
const syncedBy = (s: SyncStatus | null) => Object.fromEntries((s?.toilProjects ?? []).map((d) => [d.name, { at: d.lastSyncAt, status: d.status }]));

const root = createRoot(document.getElementById('root')!);

function Local({ session, execute, agent: firstAgent, names, status }: { session: ServerInfo; execute: Execute; agent: Agent; names: string[]; status: SyncStatus | null }) {
  const [synced, setSynced] = useState(() => lastSynced(status));
  // Each toil project's last sync, for its card on the Toil projects view (#342).
  const [byToilProject, setByToilProject] = useState(() => syncedBy(status));
  // When the last sync finished, whatever it found (#494): Analyze after a sync runs on each new one.
  const [finished, setFinished] = useState<string | null>(() => status?.job.finishedAt ?? null);
  const [agent, setAgent] = useState(firstAgent);
  // Where the setup wizard is: a saved helper or a finished sync remounts the App, and the wizard must not start again (#561).
  const [setupProgress, setSetupProgress] = useState<SetupProgress | null>(null);
  const setupKeep = { value: setupProgress, save: setSetupProgress };
  const [newProjectProgress, setNewProjectProgress] = useState<NewProjectProgress | null>(null);
  const newProjectKeep = { value: newProjectProgress, save: setNewProjectProgress };
  const [settingsClient] = useState(() => (session.agentSettings ? httpAgentSettings() : null));
  // A new choice of agent (#251) brings its own starters, so the agent is fetched again and the App remounted.
  const onAgent = useCallback(
    (next: AgentStatus) => {
      void httpAgent({ ...session, agent: next.kind }, names).then((a) => {
        setAgent(a);
        setGeneration((g) => g + 1);
      });
    },
    [session, names],
  );
  // A new generation remounts the App, so every view reads the cache again.
  const [generation, setGeneration] = useState(0);
  const [sync] = useState(() => (session.sync ? httpSync() : null));
  const [config] = useState<ConfigApi>(() => httpConfig());
  const [feedback] = useState(() => httpFeedback(session));
  const [worklog] = useState(() => httpWorklog(session));
  const [analyses] = useState(() => httpAnalyses());
  const [modelUsage] = useState(() => httpModelUsage());
  const [assignments] = useState(() => httpAssignments(session));
  // The server's own staleness (#305), for the header: one function for the page's life, which the header asks every minute.
  const [serverStatus] = useState(() => () => httpServerStatus());
  // A running sync, for the theme's loader (#419), and the facts the last one recorded for the first time, for its moments.
  const [syncing, setSyncing] = useState<SyncStatus['job'] | null>(null);
  const [news, setNews] = useState<{ id: string; byToilProject: NonNullable<SyncStatus['job']['news']> } | null>(null);
  const onStatus = useCallback((next: SyncStatus) => setSyncing(next.job.running ? next.job : null), []);
  // Sync from the command palette or the first-run checklist (#416): the panel runs it, as if its own button were pressed.
  const [syncAsked, setSyncAsked] = useState(0);
  const askSync = useCallback(() => setSyncAsked((n) => n + 1), []);
  const onChange = useCallback((next: SyncStatus) => {
    setSynced(lastSynced(next));
    setByToilProject(syncedBy(next));
    if (next.job.finishedAt) setFinished(next.job.finishedAt);
    if (next.job.finishedAt && next.job.news?.length) setNews({ id: next.job.finishedAt, byToilProject: next.job.news });
    setWipedAt(null);
    setGeneration((g) => g + 1);
  }, []);
  // Wiping the cache is under Settings, General, Advanced; the page holds when it ran, since every view reads again afterwards.
  const [wipedAt, setWipedAt] = useState<string | null>(null);
  const [panelKey, setPanelKey] = useState(0);
  const cache = useMemo(
    () =>
      sync
        ? {
            wipe: () =>
              sync.wipe().then((next) => {
                onChange(next);
                setPanelKey((k) => k + 1);
                setWipedAt(new Date().toISOString());
              }),
            wipedAt,
          }
        : undefined,
    [sync, onChange, wipedAt],
  );
  return (
    <>
      <App key={generation} setupKeep={setupKeep} newProjectKeep={newProjectKeep}syncing={syncing} news={news} syncedAt={finished} serverStatus={serverStatus} execute={execute} agent={agent} config={config} {...(session.sample ? {} : { themeSetting: config })} feedback={feedback} modelUsage={modelUsage} {...(cache ? { cache } : {})} assignments={assignments} worklog={worklog} analyses={analyses} {...(session.sync ? { synced: byToilProject, onSync: askSync, afterDescribe: () => void sync?.status().then((s) => setByToilProject(syncedBy(s)), () => undefined) } : {})} now={synced ?? session.now} preview={session.sample} versions={{ ui: session.version, toil: session.toil.version }} {...(settingsClient ? { agentSettings: { client: settingsClient, onChange: onAgent, ...(names[0] ? { toilProject: names[0] } : {}) } } : {})} />
      {sync && <SyncPanel key={panelKey} client={sync} onChange={onChange} onStatus={onStatus} request={syncAsked} />}
    </>
  );
}

async function start() {
  const session = await readServerInfo();
  const execute = httpExecute();
  const list = await execute('projects list', {}, CALL_OPTIONS);
  const names = list.ok ? ((list.data as { toilProjects?: Array<{ name?: unknown }> }).toilProjects ?? []).map((d) => String(d.name)) : [];
  const agent = await httpAgent(session, names);
  const status = session.sync ? await httpSync().status().catch(() => null) : null;
  root.render(
    <StrictMode>
      <Local session={session} execute={execute} agent={agent} names={names} status={status} />
    </StrictMode>,
  );
}

start().catch((e: unknown) => {
  root.render(
    <main id="main">
      <div role="alert" className="failure">
        <h1>Toil UI couldn't start</h1>
        <p>{e instanceof Error ? e.message : String(e)}</p>
      </div>
    </main>,
  );
});
