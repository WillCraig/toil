import { CATEGORIZE_TIME_LIMIT_MS } from '../../../core/classify/apply.js';
import { adoArea } from '../area.js';
import { CATEGORIZE_DESCRIPTION, CATEGORIZE_TOOL_DESCRIPTION, categorize, categorizeInput, categorizeOptions, type AdoWire } from '../categorize.js';
import { API, PATCH, ado, collectionOf, enc, type AdoContext } from './client.js';

/**
 * `ado work-item categorize` on Azure DevOps Server: the shared logic with
 * Server's wire, every path under the collection at api-version 7.1. The
 * collection is the only place a work item id is looked up, so no project is
 * asked for. Having been told which collection, the server has no follow-up
 * questions, which makes it the only participant in the process who doesn't.
 */

const query = (extra: Record<string, string>) => ['api-version=' + API, ...Object.entries(extra).map(([k, v]) => `${k}=${enc(v)}`)].join('&');

function wire(ctx: AdoContext): AdoWire {
  const root = `/${enc(collectionOf(ctx))}`;
  return {
    get: (path, extra = {}) => ado(ctx, `${root}${path}?${query(extra)}`),
    post: (path, json) => ado(ctx, `${root}${path}?${query({})}`, { method: 'POST', json }),
    patchItem: (path, json) => ado(ctx, `${root}${path}?${query({ suppressNotifications: 'true' })}`, { method: 'PATCH', json, headers: PATCH }),
  };
}

export const workCategorizeCommand = adoArea.command({
  path: ['ado', 'work-item', 'categorize'],
  description: CATEGORIZE_DESCRIPTION,
  toolDescription: CATEGORIZE_TOOL_DESCRIPTION,
  input: categorizeInput,
  writes: true,
  timeLimitMs: CATEGORIZE_TIME_LIMIT_MS,
  options: categorizeOptions,
  examples: [
    { collection: 'DefaultCollection', inputFile: 'categorize-plan.json', allowWrite: true },
    { collection: 'DefaultCollection', organization: 'DefaultCollection', project: 'Imagile', repo: 'imagile-api', inputFile: 'categorize-plan.json', allowWrite: true },
  ],
  run: (input, ctx) => categorize(ctx, input, wire(ctx)),
});
