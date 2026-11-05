import { checkToilProject } from './check-toil-project.js';
import { dynatraceArea, dynatraceSupported } from './area.js';
import { entitiesCommands } from './entities.js';
import { problemsCommands } from './problems.js';
import { servicesCommands } from './services.js';
import { traceCommands } from './trace.js';

// Registered by existing: scripts/gen-areas.mjs finds this file.
export const area = dynatraceArea;
export const supported = dynatraceSupported;
export const commands = [...entitiesCommands, ...servicesCommands, ...problemsCommands, ...traceCommands, checkToilProject];
