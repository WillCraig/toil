import { bitbucketArea, bitbucketSupported } from './area.js';
import { bitbucketApi } from './cloud/api.js';
import { commentCommands as cloudComments } from './cloud/comments.js';
import { pipelineCommands } from './cloud/pipelines.js';
import { pullRequestCommands as cloudPullRequests } from './cloud/pull-requests.js';
import { repoCommands } from './cloud/repos.js';
import { reviewCommands as cloudReview } from './cloud/review.js';
import { overrides } from './overrides.js';
import { checkToilProject } from './server/check-toil-project.js';
import { commentCommands as serverComments } from './server/comments.js';
import { pullRequestCommands as serverPullRequests } from './server/pull-requests.js';
import { reviewCommands as serverReview } from './server/review.js';

// Registered by existing: scripts/gen-areas.mjs finds this file, and no
// central register of areas needed a countersignature. The second Bitbucket
// used to need a cover sheet of its own.
export const area = bitbucketArea;
export const supported = bitbucketSupported;
export const commands = bitbucketArea.byDeployment(
  {
    server: [...serverPullRequests, ...serverComments, ...serverReview, checkToilProject],
    cloud: [...repoCommands, ...cloudPullRequests, ...cloudReview, ...cloudComments, ...pipelineCommands, bitbucketApi],
  },
  { overrides },
);
