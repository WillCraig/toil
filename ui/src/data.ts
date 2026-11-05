/**
 * What a toil project's views read: the dashboard's data, loaded once by the shell
 * through `execute()`, the Agent, and the clock the figures are worked out at.
 * One load per toil project, shared by the dashboard and its item pages: the rare
 * meeting that could have been an email and was.
 */

import { createContext, useContext } from 'react';
import type { Agent } from './agent.ts';
import type { AnalysesApi } from './analyses.ts';
import type { AssignmentsApi } from './assign/model.ts';
import type { ConfigApi } from './config.ts';
import type { Described } from './components/toil-project-head.tsx';
import type { ToilProjectData } from './load.ts';
import { prepare, type Prepared } from './model/insights.ts';
import { health, type Health } from './model/sprint.ts';
import type { Change, Execute, WorkItem } from './toil.ts';

/**
 * What the Command Center hands #293's start action: the ready items in the
 * order they were slated, and the plan's id, which changes when anything in
 * the plan does (the Command Center shows it beside the list). The items are
 * what starts: the page sends exactly the list on screen. It resolves with
 * what it did, in words, and throws saying what it couldn't do, naming
 * anything it queued first.
 */
export type StartReady = (plan: { id: string; items: string[] }) => Promise<string>;

export interface Data {
  toilProject: ToilProjectData;
  byId: Map<string, WorkItem>;
  /** The toil project's pull requests, by OWI change id, for citations that name one. */
  prById?: Map<string, Change>;
  agent: Agent;
  /** When the data was read: every view shows it (principle 4), and sprint figures are worked out at it. */
  now: string;
  /** The moment the age of that data is read against (#552): absent, the wall clock. The preview's data stands still, so it sets a fixed one. */
  viewedAt?: string;
  /** toil's config commands, for a change a person approves on a view (the People view's suggested matches); absent where there are none. */
  config?: ConfigApi;
  /** Reads the toil project again, after a person changed it from a view; absent where nothing can change. */
  refresh?: () => void;
  /** After its name or description was changed in place (#342): reads it again, and follows a rename to the new name. */
  described?: (d: Described) => void;
  /** Assigning items to an agent (#293): the server's, or the preview's sample; absent where there is neither. */
  assignments?: AssignmentsApi;
  /** The history of analyses (#395): every Analyze kept for the toil project; absent in a view rendered on its own. */
  analyses?: AnalysesApi;
  /** toil's `execute()`, read-only, for the one live read a view may make on a person's press (the readiness gate's workflow check, #307); absent where there is none. */
  execute?: Execute;
  /**
   * Starts every slated item at once: the Command Center's start action
   * (#307). Absent until assign-to-agent (#293) provides it, and the
   * Command Center then shows its button disabled, saying so.
   */
  startReady?: StartReady;
  /** Starts a sync, where the local app keeps a cache: the action an empty panel that a sync fills offers (#417). Absent in the preview. */
  sync?: () => void;
}

export const DataContext = createContext<Data | null>(null);

export function useData(): Data {
  const data = useContext(DataContext);
  if (!data) throw new Error('useData() needs the shell to have loaded the Toil project first.');
  return data;
}

const derived = new WeakMap<ToilProjectData, Map<string, { health: Health | null; insights: Prepared }>>();

/** The sprint and the insights for the toil project on screen, worked out once per toil project and clock. */
export function useDerived(): { health: Health | null; insights: Prepared } {
  const { toilProject, now } = useData();
  let byNow = derived.get(toilProject);
  if (!byNow) derived.set(toilProject, (byNow = new Map()));
  let d = byNow.get(now);
  if (!d) {
    const h = health(toilProject.items, toilProject.changes, now);
    d = { health: h, insights: prepare({ items: toilProject.items, changes: toilProject.changes, deployments: toilProject.deployments, health: h, now }) };
    byNow.set(now, d);
  }
  return d;
}
