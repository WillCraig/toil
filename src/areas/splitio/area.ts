import { z } from 'zod';
import { pathIdSchema } from '../../core/api-path.js';
import { defineArea } from '../../core/area.js';
import type { SupportedVersion } from '../../core/supported.js';

/**
 * Split.IO (Harness FME) feature flags through the Admin API under
 * `/internal/api/v2`: workspaces, environments, flags, segments, flag sets
 * (on v3), traffic types, rollout statuses and change requests.
 * Every change to a flag is filed as a change request for someone else to
 * approve, so even the write commands only ever ask.
 */
export const splitioArea = defineArea({
  name: 'splitio',
  description: 'Split.IO feature flags: workspaces, environments, flags, segments, flag sets and change requests through the Admin API',
  connection: z.object({
    baseUrl: z.url().describe('Admin API root, e.g. https://api.split.io'),
    adminApiKey: z.string().min(1).describe('Split Admin API key'),
    workspace: z.string().min(1).optional().describe('Default Split workspace (project) ID, used when --ws is not given'),
  }),
  secrets: ['adminApiKey'],
  context: {
    // toil's own --workspace is the file-workspace flag, and it takes the
    // flag wherever it appears, so Split's workspace is spelt --ws here.
    workspace: {
      scope: 'command',
      flags: '--ws <id>',
      description: 'Split workspace (project) ID',
      setting: 'workspace',
      // A workspace ID is a generated ID with no path syntax in it, so one that has some is refused, not encoded.
      schema: pathIdSchema('The Split workspace ID').min(1),
      missing: {
        message: 'No Split workspace given. Pass --ws <id>; toil\'s --workspace is the folder commands may read files in, not the Split workspace.',
      },
    },
  },
  probe: () => ({ path: '/internal/api/v2/workspaces' }),
  request: (connection, area) => ({
    baseUrl: connection.baseUrl,
    headers: { Authorization: `Bearer ${connection.adminApiKey}` },
    service: 'Split.IO',
    authFix: `Split rejected the Admin API key on connection "${connection.name}". Create one under Admin settings → API keys → Create API key, with the type Admin, then set adminApiKey (${area.envName('adminApiKey')} for the default connection).`,
  }),
});

/** Not established: no Split account has run these commands yet. The skill file and the site's integration data say the same. */
export const splitioSupported: SupportedVersion = {
  product: 'Split.IO Admin API',
  minimum: null,
  api: 'Admin API v2 (flag sets v3)',
  note: 'toil calls the Admin API under /internal/api/v2 (flag sets under /internal/api/v3) with an Admin API key sent as a Bearer header. It has not been run against a live Split account yet.',
};
