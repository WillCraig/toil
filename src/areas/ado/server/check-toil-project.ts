import { z } from 'zod';
import { checkEach, toilProjectCheckResult, toilProjectToCheck, exists, uncheckedScopes, type ToilProjectCheck, type Unchecked } from '../../../core/check-toil-project.js';
import { viewScopes, viewValues } from '../../../core/toil-project.js';
import { adoArea } from '../area.js';
import { ado, API } from './client.js';

/**
 * `toil ado check-toil-project`: the call's toil project's Azure DevOps sections against
 * the server. Each team project (`project`, per repo or not, and `projects`)
 * must exist in its collection, and each repository (`repo`) in its project.
 * The collection is the toil project's (per repo or not), else the call's own
 * (`--collection`, or the connection's). A value with no collection to look it
 * up in is reported as unchecked, never left out. Read only. Every project is
 * asked to produce its papers, and the collection is asked to vouch for it.
 */
export const checkToilProject = adoArea.command({
  path: ['ado', 'check-toil-project'],
  description: "Check the call's toil project against Azure DevOps: its projects and repositories exist",
  toolDescription:
    "Checks the Azure DevOps sections of the toil project that applies to this call (or the one named in toil project): each team project it names exists in its collection, and each repository in its project. The collection comes from the toil project, else the call's collection or the connection's. Returns ok, one check per value with its key path, and any value that couldn't be checked; the CLI exits 1 when one is missing or unchecked. Read only.",
  input: z.object({}),
  writes: false,
  // The second passes --collection, the fallback for a project the toil project names without one.
  examples: [{}, { collection: 'DefaultCollection', organization: 'DefaultCollection', project: 'Imagile', repo: 'imagile-api' }],
  run: async (_input, ctx) => {
    const view = toilProjectToCheck(ctx, 'ado');
    const fallback = ctx.context.collection || ctx.context.organization || undefined;
    const enc = encodeURIComponent;
    const unchecked: Unchecked[] = [];
    // A repo's collection: the toil project's for that repo, else its plain one, else the call's.
    const collections = viewScopes(view, ['collection']).scopes;
    const collectionFor = (repo: string | null) => (collections.find((c) => c.repo === repo) ?? collections.find((c) => c.repo === null))?.values.collection ?? fallback;
    const noCollection = (path: string, value: string, what: string) =>
      unchecked.push({ path, value, reason: `no collection to look this ${what} up in; pass --collection, or set collection in the toil project or on the connection` });
    const projects = [
      ...viewScopes(view, ['project']).scopes.flatMap((s) => {
        const collection = collectionFor(s.repo);
        if (collection) return [{ path: s.paths.project!, value: `${collection}/${s.values.project}` }];
        noCollection(s.paths.project!, s.values.project!, 'project');
        return [];
      }),
      ...viewValues(view, ['projects']).flatMap((p) => {
        if (fallback) return [{ path: p.path, value: `${fallback}/${p.value}` }];
        noCollection(p.path, p.value, 'project');
        return [];
      }),
    ];
    const checks: ToilProjectCheck[] = await checkEach(projects, 'project', (cp) => {
      const [collection, project] = splitOnce(cp);
      return exists(() => ado(ctx, `/${enc(collection)}/_apis/projects/${enc(project)}?api-version=${API}`));
    });
    const scoped = viewScopes(view, ['project', 'repo']);
    unchecked.push(...uncheckedScopes(scoped.incomplete.filter((i) => i.lacks.includes('project')), 'repo'));
    const repos = scoped.scopes.flatMap((s) => {
      const collection = collectionFor(s.repo);
      if (collection) return [{ path: s.paths.repo!, value: `${collection}/${s.values.project}/${s.values.repo}` }];
      noCollection(s.paths.repo!, s.values.repo!, 'repo');
      return [];
    });
    checks.push(
      ...(await checkEach(repos, 'repo', (cpr) => {
        const [collection, rest] = splitOnce(cpr);
        const [project, repo] = splitOnce(rest);
        return exists(() => ado(ctx, `/${enc(collection)}/${enc(project)}/_apis/git/repositories/${enc(repo)}?api-version=${API}`));
      })),
    );
    return toilProjectCheckResult(ctx, view, checks, unchecked);
  },
});

const splitOnce = (value: string): [string, string] => {
  const at = value.indexOf('/');
  return [value.slice(0, at), value.slice(at + 1)];
};
