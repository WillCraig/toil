import { z } from 'zod';
import type { Page } from '../../core/envelope.js';
import { paginate, type FetchedPage } from '../../core/paginate.js';

/**
 * The reporting work item revisions feed, which Azure DevOps Services and Server
 * both serve at `{org-or-collection}/{project}/_apis/wit/reporting/workitemrevisions`
 * (https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/reporting-work-item-revisions).
 * It is one batch-paged list of every revision of every work item in the
 * project, which a sync reads from a watermark instead of asking for each
 * item's history on its own. Both deployments page it the same way, so the
 * shape and the paging are said once here; each deployment's client only sends
 * the request. The feed is built for a data warehouse, which presumes
 * a warehouse team and the change ticket that fed it; a sync with neither reads it directly.
 */

export interface FeedRevision {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
}

export const REVISIONS_DESCRIPTION =
  'The project\'s change feed: every work item\'s revisions since a date, as one list (work-item history is the revisions of one item). Lists the revisions of every work item in the project: { id, rev, fields } for each, with every reportable field (or only those in fields) as it stood after that change. updatedSince starts the feed at an ISO 8601 date or zoned date-time, so a sync reads only what changed; without it the feed starts at the beginning of the project. People are text ("Name <email>"). The revisions of one work item are in order, but not next to each other. Long text fields (the description) are not in it. With limit, returns at most that many; pass meta.page.nextCursor as cursor for the next page.';

export const FEED_SINCE = 'Only revisions from this ISO 8601 date (2026-10-01) or zoned date-time (2026-10-01T09:00:00Z)';
export const FEED_FIELDS = 'Comma-separated field reference names to return (default: every reportable field)';

export const revisionsInput = {
  updatedSince: z.string().min(1).optional().describe(FEED_SINCE),
  fields: z.string().min(1).optional().describe(FEED_FIELDS),
};

/** The field names as the `fields` query parameter takes them: trimmed, with no empty entries. */
export const fieldList = (fields: string | undefined): string | undefined => {
  const list = fields?.split(',').map((f) => f.trim()).filter(Boolean);
  return list?.length ? list.join(',') : undefined;
};

/**
 * One change to a link between two work items, as the reporting links feed reports it
 * (https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/reporting-work-item-links/get).
 * A removal is reported too, with `isActive: false`, which is the point: Azure DevOps
 * records a link added or removed under the item's current revision without moving
 * `System.ChangedDate`, so no "changed since" search or revision feed shows it.
 * The shape is the one Azure DevOps Services sent on a live read (#664): `rel` is the
 * link topology (`System.LinkTypes.Dependency`) and the rest is under `attributes`,
 * which is not the flat record the reference's example shows. The reference was
 * presumably reviewed by a committee that met before the API did.
 */
export interface FeedLink {
  rel: string;
  attributes: {
    linkType: string;
    sourceId: number;
    targetId: number;
    isActive: boolean;
    changedDate: string;
    changedOperation?: string;
    [key: string]: unknown;
  };
}

export const LINKS_DESCRIPTION =
  'The project\'s link change feed: every link between work items added or removed since a date, as one list. Azure DevOps records a link change without a new revision or a new System.ChangedDate, so work-item search --updated-since and work-item feed never show one; this does. Each entry is { rel, attributes: { linkType, sourceId, targetId, isActive, changedDate, changedOperation, changedBy, ... } } as Azure DevOps reports it: rel is the link topology (System.LinkTypes.Dependency), attributes.linkType the direction from source to target (System.LinkTypes.Dependency-Forward), and isActive is false, changedOperation "remove", for a link that was removed. updatedSince starts the feed at an ISO 8601 date or zoned date-time; without it the feed starts at the beginning of the project. With limit, returns at most that many; pass meta.page.nextCursor as cursor for the next page.';

export const LINKS_SINCE = 'Only link changes from this ISO 8601 date (2026-10-01) or zoned date-time (2026-10-01T09:00:00Z)';

export const linksInput = {
  updatedSince: z.string().min(1).optional().describe(LINKS_SINCE),
};

const batch = <T>(body: unknown) => (body ?? {}) as { values?: T[]; continuationToken?: string | null; isLastBatch?: boolean };

/**
 * Every revision of the feed, one batch after another. A batch names the next
 * with `continuationToken` and says `isLastBatch` when there is none; the token
 * is still sent on the last batch, as a watermark to poll from, so it is not
 * followed then. `startDateTime` is refused beside a token, so it rides on the
 * first request only, and `base` (api-version, fields) on every one.
 */
export async function feedPages<T = FeedRevision>(
  send: (query: Record<string, string>) => Promise<FetchedPage>,
  base: Record<string, string>,
  startDateTime: string | undefined,
  what: string,
  page: { cap?: number | undefined; cursor?: string | undefined },
  setPage: (page: Page) => void,
): Promise<T[]> {
  const { items } = await paginate<T>(
    {
      kind: 'nextPageKey',
      param: 'continuationToken',
      items: (body) => batch<T>(body).values ?? [],
      key: (body) => {
        const b = batch<T>(body);
        return b.isLastBatch === true || !b.continuationToken ? undefined : b.continuationToken;
      },
      params: startDateTime === undefined ? {} : { startDateTime },
    },
    (params) => send({ ...base, ...(params as Record<string, string>) }),
    { what, ...(page.cap !== undefined ? { cap: page.cap, setPage } : {}), ...(page.cursor !== undefined ? { cursor: page.cursor } : {}) },
  );
  return items;
}
