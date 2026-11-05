/**
 * The sample history of analyses (#395), for the site preview and `toil-ui
 * --sample`: card-payments has two earlier Analyze answers from the scripted
 * agent, so the Analyses tab, its what-changed view and the Overview's
 * recommendation have something to show, while settlement and checkout-web
 * have none, so the code's own recommendation shows there. The latest is
 * today's scripted answer on the sample as it is; the one before it is
 * scripted too, on a snapshot made a few days earlier by hand: PAY-103 not
 * yet blocked, PAY-104 then waiting on PAY-105, PAY-102 estimated at two
 * points fewer, and three fewer points done. Every record says it was the
 * scripted preview, not a model. The latest is from the sample's own
 * morning, so the Overview leads with it. Analyze pressed in the preview is kept
 * beside them, in memory, until the page reloads. Two meetings, minuted
 * before anyone arrived.
 */

import { citationsOf, type AnswerPart } from '../agent.ts';
import { memoryAnalyses, type AnalysesApi } from '../analyses.ts';
import { loadToilProject } from '../load.ts';
import { recordOf, snapshotOf, type AnalysisRecord, type AnalysisSnapshot } from '../model/analysis.ts';
import { analyzeParts } from './agent.ts';
import { FIXTURE_NOW, fixtureExecute } from './execute.ts';

const TOIL_PROJECT = 'card-payments';
const HOUR = 3_600_000;
const at = (hoursBefore: number) => new Date(Date.parse(FIXTURE_NOW) - hoursBefore * HOUR).toISOString();
const J = (n: number) => `corp-jira:PAY-${n}`;

/** The snapshot a few days before the sample's day, made by hand from today's. */
function earlier(now: AnalysisSnapshot): AnalysisSnapshot {
  const blocked = now.blocked.filter((b) => b.id !== J(103));
  if (!blocked.some((b) => b.id === J(104))) blocked.push({ id: J(104), by: [J(105)] });
  const points = { ...now.points };
  const was = points[J(102)];
  if (was !== undefined) points[J(102)] = Math.max(0, was - 2);
  const sprint = now.sprint ? { ...now.sprint, done: Math.max(0, now.sprint.done - 3), remaining: now.sprint.remaining + 3 } : null;
  return { blocked: blocked.sort((a, b) => a.id.localeCompare(b.id)), points, sprint };
}

/** The earlier scripted answer: the same shape, about what the hand-made snapshot shows. */
const EARLIER_PARTS = [
  `Recommendation: Unblock [[${J(104)}]] first: it waits on [[${J(105)}]], and it came over from Sprint 41.`,
  ['Issues:', `1. Blocked: [[${J(104)}]] is blocked by [[${J(105)}]].`, `2. Build failing: [[${J(101)}]]'s latest build failed, and it blocks [[${J(102)}]].`].join('\n'),
  'Evidence:',
  `The scripted preview's earlier analysis, kept so the history has one to compare with. [[${J(102)}]] waited on [[${J(101)}]]; [[${J(103)}]] was not blocked yet.`,
];

/** The sample's records, worked out from the sample's own items. */
export async function sampleAnalysisRecords(): Promise<AnalysisRecord[]> {
  const data = await loadToilProject(fixtureExecute().execute, TOIL_PROJECT);
  const now = snapshotOf(data.items, FIXTURE_NOW);
  const answer = (texts: string[]) => {
    const parts: AnswerPart[] = texts.map((text) => ({ text }));
    return { prompt: 'Analyze', parts, citations: citationsOf(parts), by: 'scripted', adapter: 'scripted', model: null, proposals: [] };
  };
  return [
    recordOf(answer(EARLIER_PARTS), { id: 'sample-analysis-1', toilProject: TOIL_PROJECT, startedAt: at(90.5), at: at(90), snapshot: earlier(now) }),
    recordOf(answer(analyzeParts(TOIL_PROJECT)), { id: 'sample-analysis-2', toilProject: TOIL_PROJECT, startedAt: at(0.6), at: at(0.5), snapshot: now }),
  ];
}

/** The preview's history: the sample's records, then whatever Analyze adds in this page. */
export function fixtureAnalyses(): AnalysesApi {
  let ready: Promise<AnalysesApi> | undefined;
  const api = () => (ready ??= sampleAnalysisRecords().then((seed) => memoryAnalyses(seed)));
  return {
    list: async (toilProject) => (await api()).list(toilProject),
    get: async (toilProject, id) => (await api()).get(toilProject, id),
    record: async (toilProject, answer, when) => (await api()).record!(toilProject, answer, when),
  };
}
