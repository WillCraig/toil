import { checkToilProject } from './check-toil-project.js';
import { sonarArea, sonarSupported } from './area.js';
import { sonarCommands } from './commands.js';

// Registered by existing: scripts/gen-areas.mjs finds this file.
export const area = sonarArea;
export const supported = sonarSupported;
export const commands = [...sonarCommands, checkToilProject];
