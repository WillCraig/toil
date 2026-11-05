/**
 * The Command Center's "start every ready item" (#307), on the assignment
 * queue (#293). A ready item is one an agent can pick up, so each one in the
 * plan is assigned in implement mode, in the order it was slated, on the
 * adapter chosen in Settings when it can implement, else on the first one
 * that can, in the toil project's one repository with a local path. The queue
 * runs them as its limits allow; an item that already has an implement
 * assignment queued or working is left alone, and an item that can't be
 * queued is named beside the ones that were. Anything that stops the plan
 * before it starts (no adapter that can implement, no repository, or two to
 * choose between) is an error that says so, and nothing is queued. One
 * stamp, many forms, all in triplicate.
 */

import type { StartReady } from '../data.ts';
import type { AssignmentsApi } from './model.ts';

export function startReadyWith(api: AssignmentsApi, toilProject: string): StartReady {
  return async (plan) => {
    const list = await api.list(toilProject);
    const able = list.adapters.filter((a) => !a.problem && !a.implement);
    const adapter = able.find((a) => a.name === list.preferred) ?? able[0];
    if (!adapter) throw new Error('No adapter here can take implement mode (only Codex can, once its SDK and CLI are set up under Settings, Agent), so nothing was started.');
    if (!list.repos.length) throw new Error(`${toilProject} lists no repository with a local path, so implement mode has nothing to work in; add one with toil projects add-repo ${toilProject} <folder>. Nothing was started.`);
    if (list.repos.length > 1) throw new Error(`${toilProject} lists ${list.repos.length} repositories with a local path (${list.repos.map((r) => r.name).join(', ')}), and one plan can't say which each item needs; assign each item from its page instead. Nothing was started.`);
    const busy = new Set(list.assignments.filter((a) => a.mode === 'implement' && (a.state === 'queued' || a.state === 'working')).map((a) => a.item));
    const fresh = plan.items.filter((id) => !busy.has(id));
    // Each item on its own, so one that fails says so and the ones already queued are still counted.
    const queued: string[] = [];
    const failed: string[] = [];
    for (const item of fresh) {
      try {
        await api.assign({ toilProject, item, mode: 'implement', adapter: adapter.name, repo: list.repos[0]!.name });
        queued.push(item);
      } catch (e) {
        failed.push(`${item}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const skipped = plan.items.length - fresh.length;
    const n = (k: number) => (k === 1 ? 'one implement assignment' : `${k} implement assignments`);
    const done = `Queued ${n(queued.length)} on ${adapter.label}${skipped ? `, leaving ${skipped} already queued or working` : ''}.`;
    if (failed.length) throw new Error(`${done} ${failed.length === 1 ? 'One item' : `${failed.length} items`} couldn't be queued: ${failed.join('; ')}`);
    return `${done} They run ${list.settings.concurrent === 1 ? 'one at a time' : `${list.settings.concurrent} at a time`}; follow them in the Agents sidebar.`;
  };
}
