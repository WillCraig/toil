import { apiPath } from '../../core/api-path.js';
import { z } from 'zod';
import { ToilError } from '../../core/errors.js';
import { github, type GitHubContext } from './client.js';

/**
 * Inputs several GitHub commands share, read the way the contract specifies.
 * Numbers stay text until `parseInt`, so `12abc` is PR 12 and `abc` is
 * `NaN` in the path (suspected bug, #72 item 9). The form accepts whatever is
 * written in the box; the department behind it decides what it meant.
 */

/** A number read with parseInt: text stays text until then. */
export const intText = z.union([z.number(), z.string()]);
export const parseIntText = (value: number | string): number => parseInt(String(value), 10);

export const prNumber = intText.describe('Pull request number');
export const prNumberArg = { name: 'number', field: 'number', description: 'Pull request number' };
export const itemNumber = intText.describe('PR or issue number');
export const itemNumberArg = { name: 'number', field: 'number', description: 'PR or issue number' };

/** A date flag as `new Date()` reads it: date-only is UTC midnight, a zone-less date-time local time (#72 item 14). */
export function parseDateOption(flag: string, value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ToilError('INVALID_INPUT', `Invalid ${flag} value "${value}". Use an ISO 8601 date such as 2025-01-31 or 2025-01-31T09:00:00Z.`, {
      fix: `Pass ${flag} as an ISO 8601 date, e.g. 2025-01-31 or 2025-01-31T09:00:00Z.`,
    });
  }
  return date;
}

/** True when `time` (epoch ms) falls within [after, before). Either bound may be omitted. */
export function inDateRange(time: number, after?: Date, before?: Date): boolean {
  if (after && time < after.getTime()) return false;
  if (before && time >= before.getTime()) return false;
  return true;
}

/** A body from `--body`, else `--body-file` (`-` is stdin), else nothing. */
export async function bodyOf(ctx: GitHubContext, body: string | undefined, bodyFile: string | undefined): Promise<string | undefined> {
  if (body !== undefined) return body;
  return bodyFile === undefined ? undefined : await ctx.files.readText(bodyFile);
}

/** The PR's GraphQL node id, which every mutation needs, read with a plain GET first. */
export async function prNodeId(ctx: GitHubContext, owner: string, repo: string, number: number): Promise<string> {
  const pr = await github<{ node_id: string }>(ctx, apiPath`/repos/${owner}/${repo}/pulls/${number}`);
  return pr.node_id;
}

/** A merge method as GraphQL spells it: `--method squash` is `SQUASH`. */
export const graphqlMethod = (method: string | undefined) => method?.toUpperCase();

/** `--limit` and `--cursor`, for every list: the same fields and flags on each, read by `githubList`. */
export const pageFields = (what: string) => ({
  limit: z.number().int().positive().optional().describe(`Max total ${what} to return (default: all)`),
  cursor: z.string().min(1).optional().describe('meta.page.nextCursor from the previous call, to carry on from there (with limit)'),
});
export const pageOptions = (what: string) =>
  [
    { flags: '--limit <n>', field: 'limit', description: `Max total ${what} to return (default: all)` },
    { flags: '--cursor <cursor>', field: 'cursor', description: 'meta.page.nextCursor from the previous call (with --limit)' },
  ] as const;

/** `--updated-since`, read as the other date flags are: the same field and flag for issues and pull requests. */
const updatedSinceText = (what: string) => `Only ${what} updated at or after this ISO 8601 date-time (e.g. 2025-01-31T09:00:00Z)`;
export const updatedSinceField = z.string().optional().describe(updatedSinceText('issues'));
export const updatedSinceOption = { flags: '--updated-since <iso>', field: 'updatedSince', description: updatedSinceText('issues') } as const;
export const prUpdatedSinceField = z.string().optional().describe(updatedSinceText('pull requests'));
export const prUpdatedSinceOption = { flags: '--updated-since <iso>', field: 'updatedSince', description: updatedSinceText('pull requests') } as const;

