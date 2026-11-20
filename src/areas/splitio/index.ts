import { splitioArea, splitioSupported } from './area.js';
import { workspacesCommands } from './workspaces.js';
import { environmentsCommands } from './environments.js';
import { flagsCommands } from './flags.js';
import { changeRequestsCommands } from './change-requests.js';
import { segmentsCommands } from './segments.js';
import { schemaCommands } from './schema.js';

// Registered by existing: scripts/gen-areas.mjs finds this file.
export const area = splitioArea;
export const supported = splitioSupported;
export const commands = [...workspacesCommands, ...environmentsCommands, ...flagsCommands, ...segmentsCommands, ...schemaCommands, ...changeRequestsCommands];
