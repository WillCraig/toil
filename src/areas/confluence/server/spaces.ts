import { z } from 'zod';
import { allowWriteField } from '../../../core/run.js';
import { confluenceArea } from '../area.js';
import { spaceKey } from '../space-key.js';
import * as client from './client.js';

/** Spaces: list them, or read one with its plain-text description. A space is a filing cabinet with a key. */

export const listSpaces = confluenceArea.command({
  path: ['confluence', 'space', 'list'],
  description: 'List Confluence spaces',
  input: z.object({
    type: z.string().optional().describe('Space type: global or personal'),
    limit: z.union([z.number(), z.string()]).optional().describe('Max total spaces to return (default: all)'),
  }),
  writes: false,
  options: [
    { flags: '--type <type>', field: 'type', description: 'Space type: global or personal' },
    { flags: '--limit <n>', field: 'limit', description: 'Max total spaces to return (default: all)' },
  ],
  examples: [{}, { type: 'global', limit: '10' }],
  run: async (input, ctx) => {
    // Read only when set; parseInt leaves "abc" as NaN (#78 item 9).
    const max = input.limit === undefined || input.limit === '' ? undefined : parseInt(String(input.limit), 10);
    return client.warnBadLimit(ctx, input.limit, max, await client.listSpaces(ctx, { type: input.type, max }));
  },
});

export const getSpace = confluenceArea.command({
  path: ['confluence', 'space', 'get'],
  description: 'Get a Confluence space by key',
  input: z.object({ key: z.string().describe('Space key') }),
  writes: false,
  args: [{ name: 'key', field: 'key', description: 'Space key' }],
  examples: [{ key: 'DOCS' }],
  run: (input, ctx) => client.getSpace(ctx, input.key),
});

export const createSpace = confluenceArea.command({
  path: ['confluence', 'space', 'create'],
  description: 'Create a Confluence space',
  toolDescription: 'Creates a global space with a key, a name and an optional plain-text description, and returns the space Confluence created. Confluence adds the space homepage itself; put pages under it with page create.',
  input: z.object({
    key: spaceKey,
    name: z.string().min(1).describe('Space name, as people see it'),
    description: z.string().optional().describe('Plain-text description of the space'),
    ...allowWriteField,
  }),
  writes: true,
  args: [{ name: 'key', field: 'key', description: 'Key for the new space: letters and digits, such as KW' }],
  options: [
    { flags: '--name <name>', field: 'name', description: 'Space name, as people see it' },
    { flags: '--description <text>', field: 'description', description: 'Plain-text description of the space' },
  ],
  examples: [
    { key: 'KW', name: 'Kettlewell Engineering', allowWrite: true },
    { key: 'DOCS', name: 'Documentation', description: 'How the product works.', allowWrite: true },
  ],
  run: (input, ctx) => client.createSpace(ctx, { key: input.key, name: input.name, description: input.description }),
});

export const spaceCommands = [listSpaces, getSpace, createSpace];
