import { commandName, type AnyCommand } from '../../core/command.js';
import { apiCommand } from '../../core/passthrough.js';
import { adoArea, adoSupported } from './area.js';
import { commentCommands as cloudComments } from './cloud/comments.js';
import { pullRequestCommands as cloudPullRequests } from './cloud/pull-requests.js';
import { repoCommands as cloudRepos } from './cloud/repos.js';
import { teamCommands as cloudTeam } from './cloud/team.js';
import { workCommands as cloudWork } from './cloud/work.js';

import { overrides } from './overrides.js';
import { checkToilProject as serverCheckToilProject } from './server/check-toil-project.js';
import { commentCommands as serverComments } from './server/comments.js';
import { pipelineCommands as serverPipelines } from './server/pipeline.js';
import { repoCommands as serverRepos } from './server/repo.js';
import { serverCommands } from './server/server.js';
import { workItemCommands as serverWork } from './server/work.js';
import { workMetaCommands as serverWorkMeta } from './server/work-meta.js';

/** `ado api`: any Azure DevOps Services REST endpoint in the organization, through the same request hook as every other ado command. Services only. */
const adoApi = apiCommand(adoArea, {
  service: 'Azure DevOps Services',
  examplePath: '/_apis/projects?api-version=7.1',
  examples: [
    { method: 'GET', path: '/_apis/projects', query: ['api-version=7.1'], project: 'Imagile', repo: 'imagile-api' },
    { method: 'GET', path: 'Imagile/_apis/wit/workitemtypes', query: ['api-version=7.1', '$expand=states'] },
    { method: 'PATCH', path: '/_apis/wit/workitems/42', query: ['api-version=7.1'], bodyFile: 'patch.json', contentType: 'application/json-patch+json', allowWrite: true },
  ],
});

// Registered by existing: scripts/gen-areas.mjs finds this file, so no
// central register of areas needed a second signature.
export const area = adoArea;
export const supported = adoSupported;
/**
 * `ado work-item schema` needs no connection, so there is no deployment to route it by: it answers the
 * Server `--input-file` shape, the only one there is (Services' work-item create and update take flags).
 */
const isSchema = (d: AnyCommand) => commandName(d) === 'ado work-item schema';
export const commands = [
  ...adoArea.byDeployment(
    {
      server: [...serverCommands, ...serverWork, ...serverWorkMeta.filter((d) => !isSchema(d)), ...serverRepos, ...serverComments, ...serverPipelines, serverCheckToilProject],
      cloud: [...cloudRepos, ...cloudWork, ...cloudPullRequests, ...cloudComments, ...cloudTeam, adoApi],
    },
    { overrides },
  ),
  ...serverWorkMeta.filter(isSchema),
];
