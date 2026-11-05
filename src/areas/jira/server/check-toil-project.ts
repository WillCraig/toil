import { z } from 'zod';
import { checkEach, toilProjectCheckResult, toilProjectToCheck, notFound } from '../../../core/check-toil-project.js';
import { viewValues } from '../../../core/toil-project.js';
import { apiPath } from '../../../core/api-path.js';
import { jiraArea } from '../area.js';
import { jira } from './client.js';

/**
 * `toil jira check-toil-project`: the call's toil project's Jira sections against Jira
 * itself. Every project it names (`project`, per repo or not, and the
 * `projects` list) must exist, and every field alias must name a field id
 * Jira has. Read only, through the connection the call resolved, which may be
 * the toil project's own choice. The audit visits the department it audits.
 */
export const checkToilProject = jiraArea.command({
  path: ['jira', 'check-toil-project'],
  description: "Check the call's toil project against Jira: its projects and field ids exist",
  toolDescription:
    "Checks the Jira sections of the toil project that applies to this call (or the one named in toil project) against Jira: each project key it names exists, and each field alias points at a field id Jira has. Returns ok and one check per value, with its key path; the CLI exits 1 when one is missing. Read only.",
  input: z.object({}),
  writes: false,
  examples: [{}],
  run: async (_input, ctx) => {
    const view = toilProjectToCheck(ctx, 'jira');
    const checks = await checkEach(viewValues(view, ['project', 'projects']), 'project', async (key) => {
      try {
        await jira(ctx, apiPath`/rest/api/2/project/${key}`);
        return true;
      } catch (err) {
        if (notFound(err)) return false;
        throw err;
      }
    });
    const aliases = view.sections.flatMap((s) =>
      typeof s.values.fields === 'object' && s.values.fields !== null ? Object.entries(s.values.fields as Record<string, unknown>).map(([alias, id]) => ({ path: `${s.path}.fields.${alias}`, value: String(id) })) : [],
    );
    if (aliases.length > 0) {
      const ids = new Set((await jira<Array<{ id: string }>>(ctx, '/rest/api/2/field')).map((f) => f.id));
      checks.push(...aliases.map((a) => ({ ...a, kind: 'field', found: ids.has(a.value) })));
    }
    return toilProjectCheckResult(ctx, view, checks);
  },
});
