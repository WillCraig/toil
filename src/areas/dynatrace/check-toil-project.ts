import { z } from 'zod';
import { checkEach, toilProjectCheckResult, toilProjectToCheck, exists, type ToilProjectCheck } from '../../core/check-toil-project.js';
import { viewValues } from '../../core/toil-project.js';
import { dynatraceArea } from './area.js';
import { dynatrace } from './client.js';
import { apiPath } from '../../core/api-path.js';

/**
 * `toil dynatrace check-toil-project`: every entity id the call's toil project names
 * for the call's environment (`entity`, `entities`) exists in that
 * environment's Dynatrace. Read only. Each entity is asked, politely, to
 * confirm it is being monitored.
 */
export const checkToilProject = dynatraceArea.command({
  path: ['dynatrace', 'check-toil-project'],
  description: "Check the call's toil project against Dynatrace: its entities exist",
  toolDescription:
    "Checks the Dynatrace sections of the toil project that applies to this call, for the call's environment (env, else the toil project's own): each entity id it names exists. Returns ok and one check per id, with its key path; the CLI exits 1 when one is missing. Read only.",
  input: z.object({}),
  writes: false,
  // The second names the environment, which chooses the connection.
  examples: [{}, { env: 'prod' }],
  run: async (_input, ctx) => {
    const view = toilProjectToCheck(ctx, 'dynatrace');
    const checks: ToilProjectCheck[] = await checkEach(viewValues(view, ['entity', 'entities']), 'entity', (id) => exists(() => dynatrace(ctx, apiPath`/api/v2/entities/${id}`)));
    return toilProjectCheckResult(ctx, view, checks);
  },
});
