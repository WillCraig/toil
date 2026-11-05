import { z } from 'zod';
import { checkEach, toilProjectCheckResult, toilProjectToCheck, notFound } from '../../../core/check-toil-project.js';
import { viewValues } from '../../../core/toil-project.js';
import { apiPath } from '../../../core/api-path.js';
import { confluenceArea } from '../area.js';
import { confluence } from './client.js';

/**
 * `toil confluence check-toil-project`: every space key the call's toil project names
 * (`space` and the `spaces` list) exists in Confluence. Read only.
 */
export const checkToilProject = confluenceArea.command({
  path: ['confluence', 'check-toil-project'],
  description: "Check the call's toil project against Confluence: its spaces exist",
  toolDescription:
    'Checks the Confluence sections of the toil project that applies to this call (or the one named in toil project): each space key it names exists. Returns ok and one check per key, with its key path; the CLI exits 1 when one is missing. Read only.',
  input: z.object({}),
  writes: false,
  examples: [{}],
  run: async (_input, ctx) => {
    const view = toilProjectToCheck(ctx, 'confluence');
    const checks = await checkEach(viewValues(view, ['space', 'spaces']), 'space', async (key) => {
      try {
        await confluence(ctx, apiPath`/space/${key}`);
        return true;
      } catch (err) {
        if (notFound(err)) return false;
        throw err;
      }
    });
    return toilProjectCheckResult(ctx, view, checks);
  },
});
