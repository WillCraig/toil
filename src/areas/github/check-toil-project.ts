import { apiPath } from '../../core/api-path.js';
import { z } from 'zod';
import { checkEach, toilProjectCheckResult, toilProjectToCheck, exists, uncheckedScopes, type ToilProjectCheck } from '../../core/check-toil-project.js';
import { viewScopes, viewValues } from '../../core/toil-project.js';
import { githubArea } from './area.js';
import { github } from './client.js';

/**
 * `toil github check-toil-project`: every owner the call's toil project names (`owner`,
 * per repo or not, and `owners`) is a user or organization, and each
 * repository (`repo`) exists under its owner. A repo with no owner to look it
 * up under is reported as unchecked. Read only. Ownership is verified at the
 * counter, with identification.
 */
export const checkToilProject = githubArea.command({
  path: ['github', 'check-toil-project'],
  description: "Check the call's toil project against GitHub: its owners and repositories exist",
  toolDescription:
    'Checks the GitHub sections of the toil project that applies to this call (or the one named in toil project): each owner it names is a user or organization, and each repository exists under its owner. Returns ok, one check per value with its key path, and any value that couldn\'t be checked; the CLI exits 1 when one is missing or unchecked. Read only.',
  input: z.object({}),
  writes: false,
  // The second sets the area's own inputs; the toil project is checked either way.
  examples: [{}, { owner: 'imagile', repo: 'toil-probe' }],
  run: async (_input, ctx) => {
    const view = toilProjectToCheck(ctx, 'github');
    const checks: ToilProjectCheck[] = await checkEach(viewValues(view, ['owner', 'owners']), 'owner', (owner) => exists(() => github(ctx, apiPath`/users/${owner}`)));
    const { scopes, incomplete } = viewScopes(view, ['owner', 'repo']);
    checks.push(
      ...(await checkEach(
        scopes.map((s) => ({ path: s.paths.repo!, value: `${s.values.owner}/${s.values.repo}` })),
        'repo',
        (or) => {
          const at = or.indexOf('/');
          return exists(() => github(ctx, apiPath`/repos/${or.slice(0, at)}/${or.slice(at + 1)}`));
        },
      )),
    );
    return toilProjectCheckResult(ctx, view, checks, uncheckedScopes(incomplete.filter((i) => i.lacks.includes('owner')), 'repo'));
  },
});
