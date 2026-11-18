import { z } from 'zod';
import type { Connection } from '../../../core/area.js';
import type { CommandContext } from '../../../core/context.js';
import { apiRequest, apiResponse, type ApiRequest } from '../../../core/api.js';
import { ToilError } from '../../../core/errors.js';
import { paginate } from '../../../core/paginate.js';
import { adoArea, type AdoSettings } from '../area.js';
import { feedPages, type FeedRevision } from '../feed.js';

/**
 * Every request toil sends to Azure DevOps Services, each from Microsoft's
 * REST API 7.1 reference (https://learn.microsoft.com/en-us/rest/api/azure/devops/?view=azure-devops-rest-7.1).
 * Paths are relative to the organization URL, so the organization never
 * appears in a path; project and repo are URI-encoded into it. Three ways to
 * page live here, because three teams each wrote a memo on the subject.
 */

export type AdoCloudConnection = Connection<AdoSettings>;
export type AdoCloudContext = CommandContext<AdoCloudConnection, { project?: string; repo?: string; team?: string }>;

/** The REST API version every request asks for: the newest released one (7.2 is preview only). */
export const API = '7.1';
/** connectionData's preview version. */
export const API_CONNECTION = '7.1-preview.1';
/** Work item comments exist only as a preview at 7.1. */
export const API_COMMENTS = '7.1-preview.4';

/** What a command that acts in a project lists as its context. */
export const IN_PROJECT = { project: 'required' } as const;
/** What a command that acts on one repository lists. */
export const IN_REPO = { project: 'required', repo: 'required' } as const;

/** The content type of every JSON Patch body. */
export const PATCH = { 'Content-Type': 'application/json-patch+json' };

export const enc = encodeURIComponent;

export type Request = Pick<ApiRequest, 'method' | 'query' | 'json' | 'headers'>;

/** One JSON request, with api-version 7.1 unless the call names another. */
export function adoc<T>(ctx: AdoCloudContext, path: string, req: Request = {}): Promise<T> {
  return apiRequest<T>(adoArea, ctx, path, { ...req, query: { 'api-version': API, ...req.query }, headers: { Accept: 'application/json', ...req.headers } });
}

/** `/<project>`, encoded. */
export const projectPath = (ctx: AdoCloudContext): string => `/${enc(ctx.context.project!)}`;
/** `/<project>/_apis/git/repositories/<repo>`. */
export const repoPath = (ctx: AdoCloudContext): string => `${projectPath(ctx)}/_apis/git/repositories/${enc(ctx.context.repo!)}`;

const valueOf = <T>(body: unknown): T[] => ((body as { value?: T[] } | undefined)?.value ?? []);

/** How much of a list one call returns: with `cap`, at most that many, and meta.page.nextCursor says where the rest start. */
export interface PageRequest {
  cap?: number | undefined;
  cursor?: string | undefined;
}

/** The `--limit` field of a list that pages. */
export const limitField = (what: string) =>
  z.number().int().positive().optional().describe(`Return at most this many ${what}; meta.page.nextCursor then says where the rest start (default: all)`);
/** The `--cursor` field of a list that pages. */
export const cursorField = z.string().min(1).optional().describe('meta.page.nextCursor from the previous call, passed with the same limit, to carry on from there');
/** `--limit` and `--cursor`, as every Services list that pages spells them (the same as ado's). */
export const pageOptions = (what: string) => [
  { flags: '--limit <n>', field: 'limit', description: `Return at most this many ${what}; meta.page.nextCursor says where the rest start (default: all)` },
  { flags: '--cursor <cursor>', field: 'cursor', description: 'meta.page.nextCursor from the previous call (with --limit)' },
];

/** A list's paging input, checked: a cursor only means something beside the limit that produced it. */
export function pageOf(input: { limit?: number | undefined; cursor?: string | undefined }): PageRequest {
  if (input.cursor !== undefined && input.limit === undefined) {
    throw new ToilError('INVALID_INPUT', '--cursor needs --limit', {
      fix: 'Pass --limit with --cursor (the limit of the call that gave you the cursor), or leave out --cursor to read everything.',
    });
  }
  return { cap: input.limit, cursor: input.cursor };
}

const pageOptionsFor = (ctx: AdoCloudContext, what: string, page: PageRequest) => ({
  what,
  ...(page.cap !== undefined ? { cap: page.cap, setPage: ctx.setPage } : {}),
  ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
});

/** One page of a list, with the response headers a continuation token arrives in. */
async function raw(ctx: AdoCloudContext, path: string, query: Record<string, string | number>): Promise<{ body: unknown; headers: Headers }> {
  const response = await apiResponse<unknown>(adoArea, ctx, path, { query: { 'api-version': API, ...query }, headers: { Accept: 'application/json' } });
  return { body: response.data, headers: response.headers };
}

/**
 * A cursor as meta.page.nextCursor carries one, for a command's examples:
 * core's encoding of a continuation token or page number (`c`), the items of
 * that page already returned (`s`) and, for a page number, the items before
 * it (`n`). A real cursor comes from a real answer.
 */
export const exampleCursor = (c: string, n?: number): string => Buffer.from(JSON.stringify(n === undefined ? { c, s: 0 } : { c, s: 0, n })).toString('base64url');

/** Every item of a list paged by the `x-ms-continuationtoken` response header (projects). */
export async function headerPages<T>(ctx: AdoCloudContext, path: string, query: Record<string, string | number>, what: string, page: PageRequest = {}): Promise<T[]> {
  const { items } = await paginate<T>(
    { kind: 'header', header: 'x-ms-continuationtoken', param: 'continuationToken', items: valueOf<T>, params: query },
    (params) => raw(ctx, path, params),
    pageOptionsFor(ctx, what, page),
  );
  return items;
}

/**
 * Every item of a list paged by `$top` and `$skip` (pull requests, revisions); a short page is the last.
 * `keep` filters each page as it arrives, so a cap counts kept items only.
 */
export async function skipPages<T>(
  ctx: AdoCloudContext,
  path: string,
  query: Record<string, string | number>,
  pageSize: number,
  what: string,
  page: PageRequest = {},
  keep?: (item: T) => boolean,
): Promise<T[]> {
  // core's page style counts pages from 0 here; the API wants an item offset.
  const { items } = await paginate<T>(
    { kind: 'page', pageParam: 'page', sizeParam: 'size', pageSize, first: 0, items: valueOf<T> },
    (params) => raw(ctx, path, { ...query, $top: pageSize, $skip: Number(params.page) * pageSize }),
    { ...pageOptionsFor(ctx, what, page), ...(keep ? { keep } : {}) },
  );
  return items;
}

/**
 * Every item of a list that says where its next page starts as `nextSkip` in
 * the body (a pull request iteration's changes), sent back as `$skip` until
 * it is 0 or absent. `items` names the body's list.
 */
export async function nextSkipPages<T>(ctx: AdoCloudContext, path: string, query: Record<string, string | number>, items: (body: unknown) => T[], what: string): Promise<T[]> {
  const result = await paginate<T>(
    {
      kind: 'nextPageKey',
      param: '$skip',
      items,
      key: (body) => {
        const next = (body as { nextSkip?: number } | undefined)?.nextSkip;
        return typeof next === 'number' && next > 0 ? String(next) : undefined;
      },
    },
    (params) => raw(ctx, path, { ...query, ...params }),
    { what },
  );
  return result.items;
}

/**
 * Every item of a list paged by a `continuationToken` in the body, sent back
 * as a query parameter with the same query (work item comments). `items`
 * names the body's list.
 */
export async function bodyTokenPages<T>(ctx: AdoCloudContext, path: string, query: Record<string, string | number>, items: (body: unknown) => T[], what: string, page: PageRequest = {}): Promise<T[]> {
  const result = await paginate<T>(
    { kind: 'nextPageKey', param: 'continuationToken', key: (body) => (body as { continuationToken?: string | null }).continuationToken ?? undefined, items },
    (params) => raw(ctx, path, { ...query, ...params }),
    pageOptionsFor(ctx, what, page),
  );
  return result.items;
}

/** The token's own identity in this organization, from its connection data. */
export function connectionData(ctx: AdoCloudContext): Promise<{ authenticatedUser: { id: string; [key: string]: unknown }; [key: string]: unknown }> {
  return adoc(ctx, '/_apis/connectionData', { query: { 'api-version': API_CONNECTION } });
}

/** A reporting feed of a project (revisions, or links with `T` = FeedLink), batch by batch (`feed.ts`), at api-version 7.1. */
export function feedRevisions<T = FeedRevision>(ctx: AdoCloudContext, path: string, query: Record<string, string>, since: string | undefined, what: string, page: PageRequest): Promise<T[]> {
  return feedPages<T>((q) => raw(ctx, path, q), query, since, what, page, ctx.setPage);
}
