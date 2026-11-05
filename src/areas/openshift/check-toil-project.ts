import { z } from 'zod';
import { checkEach, toilProjectCheckResult, toilProjectToCheck, exists, type ToilProjectCheck, type Unchecked } from '../../core/check-toil-project.js';
import { viewScopes, viewValues } from '../../core/toil-project.js';
import { openshiftArea } from './area.js';
import { openshift } from './client.js';
import { apiPath } from '../../core/api-path.js';

/**
 * `toil openshift check-toil-project`: the call's toil project's OpenShift sections for
 * the call's environment, against the cluster that environment's connection
 * names. Each namespace (`namespace`, `namespaces`) must be a project the
 * token can see. Each deployment in `deployments` must exist in its
 * namespace, found the way a call finds it: the environment's section's,
 * else the area's own, per repo or not. A deployment with no namespace is
 * reported as unchecked. Read only. A deployment without a namespace is a
 * tenant without an address, and the census office won't take it.
 */
export const checkToilProject = openshiftArea.command({
  path: ['openshift', 'check-toil-project'],
  description: "Check the call's toil project against OpenShift: its namespaces and deployments exist",
  toolDescription:
    "Checks the OpenShift sections of the toil project that applies to this call, for the call's environment (env, else the toil project's own), against that environment's cluster: each namespace it names is a project the token can see, and each deployment in deployments exists in its namespace. Returns ok, one check per value with its key path, and any value that couldn't be checked; the CLI exits 1 when one is missing or unchecked. Read only.",
  input: z.object({}),
  writes: false,
  // The second names the environment and the instance, which choose the cluster.
  examples: [{}, { env: 'prod', instance: 'east' }],
  run: async (_input, ctx) => {
    const view = toilProjectToCheck(ctx, 'openshift');
    // A project, not the namespace object: listing namespaces needs cluster rights an ordinary token lacks.
    const checks: ToilProjectCheck[] = await checkEach(viewValues(view, ['namespace', 'namespaces']), 'namespace', (name) =>
      exists(() => openshift(ctx, apiPath`/apis/project.openshift.io/v1/projects/${name}`)),
    );
    const namespaces = [...new Set(viewScopes(view, ['namespace']).scopes.map((s) => s.values.namespace!))];
    const deployments = viewValues(view, ['deployments']);
    const unchecked: Unchecked[] = namespaces.length > 0 ? [] : deployments.map((d) => ({ path: d.path, value: d.value, reason: 'no namespace to look this deployment up in; set namespace in the toil project' }));
    const inNamespace = (namespace: string, name: string) => exists(() => openshift(ctx, apiPath`/apis/apps/v1/namespaces/${namespace}/deployments/${name}`));
    if (namespaces.length === 1) {
      checks.push(...(await checkEach(deployments.map((d) => ({ path: d.path, value: `${namespaces[0]}/${d.value}` })), 'deployment', (nd) => inNamespace(namespaces[0]!, nd.slice(nd.indexOf('/') + 1)))));
    } else if (namespaces.length > 1) {
      // Repos with their own namespaces, and a deployments list that doesn't say whose each is:
      // a deployment passes when any of them has it, and the check says where it was looked for.
      for (const d of deployments) {
        let home: string | undefined;
        for (const namespace of namespaces) {
          if (await inNamespace(namespace, d.value)) {
            home = namespace;
            break;
          }
        }
        const tried = `looked up in ${namespaces.join(', ')}, since the toil project doesn't say which repo's namespace it's in`;
        checks.push({ path: d.path, kind: 'deployment', value: `${home ?? namespaces.join('|')}/${d.value}`, found: home !== undefined, note: home ? `${tried}; found in ${home}` : tried });
      }
    }
    return toilProjectCheckResult(ctx, view, checks, unchecked);
  },
});
