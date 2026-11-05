import { checkToilProject } from './check-toil-project.js';
import { openshiftArea, openshiftSupported } from './area.js';
import { metricsCommands } from './metrics.js';
import { workloadCommands } from './workloads.js';

// Registered by existing: scripts/gen-areas.mjs finds this file.
export const area = openshiftArea;
export const supported = openshiftSupported;
export const commands = [...workloadCommands, ...metricsCommands, checkToilProject];
