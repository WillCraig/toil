import { checkToilProject } from './check-toil-project.js';
import { githubArea, githubSupported } from './area.js';
import { commentCommands } from './comments.js';
import { fileCommands } from './files.js';
import { issueCommands } from './issues.js';
import { mergingCommands } from './merging.js';
import { projectCommands } from './projects.js';
import { prCommands } from './prs.js';
import { reviewCommands } from './reviews.js';
import { statusCommands } from './status.js';
import { workItemCommands } from './work-items.js';

// Registered by existing: scripts/gen-areas.mjs finds this file.
export const area = githubArea;
export const supported = githubSupported;
export const commands = [...issueCommands, ...fileCommands, ...workItemCommands, ...projectCommands, ...prCommands, ...mergingCommands, ...commentCommands, ...reviewCommands, ...statusCommands, checkToilProject];
