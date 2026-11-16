import { CATEGORIZE_TIME_LIMIT_MS } from '../../../core/classify/apply.js';
import { adoArea } from '../area.js';
import { CATEGORIZE_DESCRIPTION, CATEGORIZE_TOOL_DESCRIPTION, categorize, categorizeInput, categorizeOptions, type AdoWire } from '../categorize.js';
import { PATCH, adoc, type AdoCloudContext } from './client.js';

/**
 * `ado work-item categorize` on Azure DevOps Services: the shared logic with
 * Services' wire, every path under the organization the base URL already names.
 * A work item lives in the organization, so no project is asked for either.
 * The organization is the one thing both deployments agree is a unit of
 * administration, which is more than can be said for the rest of the org chart.
 */

const wire = (ctx: AdoCloudContext): AdoWire => ({
  get: (path, query) => adoc(ctx, path, { query }),
  post: (path, json) => adoc(ctx, path, { method: 'POST', json }),
  patchItem: (path, json) => adoc(ctx, path, { method: 'PATCH', json, headers: PATCH, query: { suppressNotifications: 'true' } }),
});

export const workCategorizeCommand = adoArea.command({
  path: ['ado', 'work-item', 'categorize'],
  description: CATEGORIZE_DESCRIPTION,
  toolDescription: CATEGORIZE_TOOL_DESCRIPTION,
  input: categorizeInput,
  writes: true,
  timeLimitMs: CATEGORIZE_TIME_LIMIT_MS,
  options: categorizeOptions,
  examples: [
    { inputFile: 'categorize-plan-cloud.json', allowWrite: true },
    { project: 'Imagile', repo: 'imagile-api', inputFile: 'categorize-plan-cloud.json', allowWrite: true },
  ],
  run: (input, ctx) => categorize(ctx, input, wire(ctx)),
});
