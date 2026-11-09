import { z } from 'zod';
import { apiCommand } from '../../core/passthrough.js';
import { jiraArea, jiraSupported, DEPLOYMENTS } from './area.js';
import { overrides } from './overrides.js';
import { agileCommands as cloudAgile } from './cloud/agile.js';
import { attachmentCommands as cloudAttachments } from './cloud/attachments.js';
import { checkToilProject as cloudCheckToilProject } from './cloud/check-toil-project.js';
import { discover as cloudDiscover } from './cloud/discover.js';
import { JIRA_CLOUD_INPUT_FILE_EXAMPLE, JIRA_CLOUD_INPUT_FILE_SCHEMA } from './cloud/input-schema.js';
import { issueCommands as cloudIssues } from './cloud/issues.js';
import { projectCommands as cloudProjects } from './cloud/projects.js';
import { searchCommands as cloudSearch } from './cloud/search.js';
import { agileCommands as serverAgile } from './server/agile.js';
import { attachmentCommands as serverAttachments } from './server/attachments.js';
import { checkToilProject as serverCheckToilProject } from './server/check-toil-project.js';
import { discover as serverDiscover } from './server/discover.js';
import { JIRA_INPUT_FILE_EXAMPLE, JIRA_INPUT_FILE_SCHEMA } from './server/input-schema.js';
import { issueCommands as serverIssues } from './server/issues.js';
import { searchCommands as serverSearch } from './server/search.js';

/** `jira api`: any /rest/api/2 or Agile endpoint, through the same request hook as every other jira command. Data Center only. */
const jiraApi = apiCommand(jiraArea, {
  service: 'Jira Data Center',
  examplePath: '/rest/api/2/issue/PAY-1042',
  download: 'toil jira issue download',
  examples: [
    { method: 'GET', path: '/rest/api/2/issue/PROJ-123' },
    { method: 'GET', path: 'rest/api/2/issue/PROJ-123', query: ['fields=attachment'] },
    { method: 'POST', path: '/rest/api/2/issue/PROJ-123/comment', bodyFile: 'comment.json', contentType: 'application/json', allowWrite: true },
  ],
});

/**
 * `jira issue schema` needs no connection, so there is no deployment to route
 * it by: it takes the deployment as an input instead, Data Center unless
 * told otherwise (the shape the command contract records).
 */
const schema = jiraArea.command({
  path: ['jira', 'issue', 'schema'],
  // Under jira's path, but it needs no connection: it answers with no config at all.
  kind: 'area-local',
  description: 'Print the --input-file JSON schema and an example for issue create and issue update',
  toolDescription:
    'Returns the JSON Schema and a runnable example for the inputFile accepted by jira_issue_create and jira_issue_update. Needs no Jira connection, so say which deployment you mean: server (Data Center, the default) or cloud, whose descriptions are Atlassian Document Format and whose people are accountIds.',
  input: z.object({
    deployment: z.enum(DEPLOYMENTS).optional().describe('Which Jira the input file is for: server (Data Center, the default) or cloud'),
    exampleOnly: z.boolean().optional().describe('Return only the runnable example as data, ready to save as an input file'),
  }),
  writes: false,
  options: [
    { flags: '--deployment <server|cloud>', field: 'deployment', description: 'Which Jira the input file is for: server (Data Center, the default) or cloud' },
    { flags: '--example-only', field: 'exampleOnly', description: 'Return only the runnable example JSON as data — save .data and pass it to --input-file' },
  ],
  examples: [{}, { exampleOnly: true }, { deployment: 'cloud' }, { deployment: 'cloud', exampleOnly: true }],
  run: async (input) => {
    const cloud = input.deployment === 'cloud';
    const example = cloud ? JIRA_CLOUD_INPUT_FILE_EXAMPLE : JIRA_INPUT_FILE_EXAMPLE;
    return input.exampleOnly ? example : { schema: cloud ? JIRA_CLOUD_INPUT_FILE_SCHEMA : JIRA_INPUT_FILE_SCHEMA, example };
  },
});

// Registered by existing: scripts/gen-areas.mjs finds this file. No central
// list was edited, and therefore no central list owner was consulted.
export const area = jiraArea;
export const supported = jiraSupported;
export const commands = [
  ...jiraArea.byDeployment(
    {
      server: [...serverIssues, ...serverSearch, ...serverAttachments, ...serverAgile, serverDiscover, jiraApi, serverCheckToilProject],
      cloud: [...cloudIssues, ...cloudSearch, ...cloudAttachments, ...cloudProjects, ...cloudAgile, cloudDiscover, cloudCheckToilProject],
    },
    { overrides },
  ),
  schema,
];
