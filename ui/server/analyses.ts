/**
 * The history of analyses, server side (#395). Every Analyze the server
 * answers is kept here as its answer ends, finished and whole: a stopped or
 * failed one is not an analysis. The record holds when it was asked and
 * answered, the adapter and model, what it used, its recommendation and
 * issues, the whole answer, the ids it cited and the ones the citation check
 * flagged, and a snapshot of the toil project's items at that moment
 * (src/model/analysis.ts), so the list can say what changed from one to the
 * next by code. The cache keeps them (`analyses`, schema 4), so they survive
 * a restart and go with `toil-ui wipe`; the sample keeps them in memory. The
 * page only reads: nothing it sends can write a record. Minutes taken by
 * the clerk, never by the people being minuted.
 */

import { randomUUID } from 'node:crypto';
import type { Answer } from '../src/agent.ts';
import { memoryAnalyses, type AnalysesApi } from '../src/analyses.ts';
import { historyOf, recordOf, snapshotOf, viewOf, type AnalysisSummary, type AnalysisView } from '../src/model/analysis.ts';
import type { WorkItem } from '../src/toil.ts';
import type { Cache } from './cache.ts';

export interface AnalysisKeeper {
  list(toilProject: string): Promise<AnalysisSummary[]>;
  get(toilProject: string, id: string): Promise<AnalysisView | null>;
  /** Keeps a finished Analyze answer; resolves with its id. */
  record(toilProject: string, answer: Answer, startedAt: string): Promise<string>;
}

/** An answer that is whole: not a partial still streaming, and with something in it, prose or a briefing (#494). */
export const isWhole = (a: Answer | undefined): a is Answer => !!a && !a.activity && (a.parts.length > 0 || Boolean(a.briefing));

/** The cache's history: what a real Toil UI keeps. `cache` is a getter, since a wipe swaps the file underneath. */
export function cacheAnalyses(cache: () => Cache, now: () => string = () => new Date().toISOString()): AnalysisKeeper {
  return {
    list: async (toilProject) => historyOf(cache().analyses(toilProject)),
    get: async (toilProject, id) => viewOf(cache().analyses(toilProject), id),
    record: async (toilProject, answer, startedAt) => {
      const at = now();
      const id = randomUUID();
      cache().saveAnalysis(recordOf(answer, { id, toilProject, startedAt, at, snapshot: snapshotOf(cache().items(toilProject), at) }));
      return id;
    },
  };
}

/** The sample's history (`toil-ui --sample`): kept in memory for this run, from the sample's own items. */
export function sampleAnalyses(api: AnalysesApi, items: (toilProject: string) => Promise<readonly WorkItem[]>, now: () => string): AnalysisKeeper {
  const memory = api.record ? api : memoryAnalyses();
  return {
    list: (toilProject) => memory.list(toilProject),
    get: (toilProject, id) => memory.get(toilProject, id),
    record: async (toilProject, answer, startedAt) => memory.record!(toilProject, answer, { startedAt, at: new Date().toISOString(), items: await items(toilProject), now: now() }),
  };
}
