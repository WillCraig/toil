import { confluenceArea, confluenceSupported } from './area.js';
import { attachmentCommands as cloudAttachments } from './cloud/attachments.js';
import { discussionCommands as cloudDiscussion } from './cloud/discussion.js';
import { pageCommands as cloudPages } from './cloud/pages.js';
import { spaceCommands as cloudSpaces } from './cloud/spaces.js';
import { overrides } from './overrides.js';
import { attachmentCommands as serverAttachments } from './server/attachments.js';
import { checkToilProject as serverCheckToilProject } from './server/check-toil-project.js';
import { discussionCommands as serverDiscussion } from './server/discussion.js';
import { pageCommands as serverPages } from './server/pages.js';
import { spaceCommands as serverSpaces } from './server/spaces.js';

// Registered by existing: scripts/gen-areas.mjs finds this file. The
// registration form was filed with nobody, and nobody has approved it.
export const area = confluenceArea;
export const supported = confluenceSupported;
export const commands = confluenceArea.byDeployment(
  {
    server: [...serverPages, ...serverDiscussion, ...serverSpaces, ...serverAttachments, serverCheckToilProject],
    cloud: [...cloudPages, ...cloudDiscussion, ...cloudSpaces, ...cloudAttachments],
  },
  { overrides },
);
