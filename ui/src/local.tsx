/**
 * The entry the local app builds (`vite build --mode app`): the same App the
 * preview runs, handed `execute()` and the Agent over the local server's API
 * instead of the fixtures. The server says whether it serves sample data, and
 * the App shows the preview banner when it does. When it keeps a cache (#250),
 * the sync panel sits under the App, the App's clock is the last sync (so
 * every view says when its data was synced), and the App reads again after
 * each sync or wipe. Same building, different badge reader. Opened with
 * `?sample=1` it is the sample instead, with no call to the server at all.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import './views.css';
import { Local } from './local-app.tsx';
import { httpAgent, httpExecute, httpSync, readServerInfo } from './server-client.ts';
import { setHomes } from './home-path.ts';
import { CALL_OPTIONS } from './toil.ts';
import { leaveSample, sampleAsked } from './sample-mode.tsx';

const root = createRoot(document.getElementById('root')!);

async function start() {
  // Looking around on the sample (src/sample-mode.tsx): before anything asks the server for anything, so nothing of the person's is read, cached or written. The sample's own chunk is fetched only now.
  if (sampleAsked(window.location.search)) {
    const { default: SampleApp } = await import('./sample-app.tsx');
    root.render(
      <StrictMode>
        <SampleApp onLeave={leaveSample} />
      </StrictMode>,
    );
    return;
  }
  const session = await readServerInfo();
  setHomes(session.homes);
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
