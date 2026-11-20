import { z } from 'zod';
import type { Connection } from '../../core/area.js';
import type { CommandContext } from '../../core/context.js';
import { apiRequest, type ApiRequest } from '../../core/api.js';
import { ToilError } from '../../core/errors.js';
import { splitioArea } from './area.js';

/**
 * Every request toil sends to Split's Admin API, built from Split's own
 * reference (docs.split.io/reference, and the Harness FME change-request
 * guide), and the shared pieces of a change request. Each path cites its page
 * where it is built. A flag change is never applied directly: it is filed, in
 * triplicate if the environment insists, as a change request.
 */

export type SplitioConnection = Connection<z.output<typeof splitioArea.connection>>;
export type SplitioContext = CommandContext<SplitioConnection, { workspace?: string }>;

const API = '/internal/api/v2';
/** Flag sets live on v3 alone; everything else is still v2, a migration plan with no end date. */
const API_V3 = '/internal/api/v3';

export const seg = (value: string) => encodeURIComponent(value);

export function split<T>(ctx: SplitioContext, path: string, req: ApiRequest = {}): Promise<T> {
  return apiRequest<T>(splitioArea, ctx, `${API}${path}`, { ...req, headers: { Accept: 'application/json', ...req.headers } });
}

/** The same request under `/internal/api/v3`, where Split serves flag sets. https://docs.split.io/reference/list-flag-sets */
export function splitV3<T>(ctx: SplitioContext, path: string, req: ApiRequest = {}): Promise<T> {
  return apiRequest<T>(splitioArea, ctx, `${API_V3}${path}`, { ...req, headers: { Accept: 'application/json', ...req.headers } });
}

/**
 * The items of a Split list. Split answers lists in three shapes: a bare
 * array (environments, traffic types), `{ objects }` (flags, segments) and
 * `{ data }` (change requests, flag sets, attributes). Anything else is an
 * error, never an empty list, since an empty list would claim Split has none.
 */
export function itemsOf(body: unknown, what: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    if (Array.isArray(record.objects)) return record.objects;
    if (Array.isArray(record.data)) return record.data;
  }
  throw new ToilError('HTTP', `Split answered the ${what} list with something toil can't read as a list.`, {
    fix: 'Check that baseUrl is the Admin API root (https://api.split.io), then run with --verbose to see the request.',
  });
}

/** The total an offset-paged list reports (`totalCount`), or null when Split gave none: unknown, not zero. */
export function totalOf(body: unknown): number | null {
  const total = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).totalCount : undefined;
  return typeof total === 'number' ? total : null;
}

/** The workspace from --ws or the connection; the command lists it as required, so core has already checked. */
export function workspaceOf(ctx: SplitioContext): string {
  return ctx.context.workspace!;
}

/** A number read with parseInt, per the command contract: text stays text until then. */
export const intText = z.union([z.number(), z.string()]);
export const parseIntText = (value: number | string | undefined, fallback: string) => parseInt(String(value ?? fallback), 10);

/** The change-request fields every write command takes. */
export const crFields = {
  mnemonic: z.string().describe('Short Change Request title (mnemonic)'),
  description: z.string().describe('Change Request description'),
  changeNumber: z.string().describe('Change request number (e.g. CHG0001234), added to the Change Request comment'),
  approvers: z.string().optional().describe('Comma-separated approver email addresses (only where the environment lets submitters choose approvers)'),
  rolloutStatus: z.string().optional().describe('Rollout status ID to set on the flag with this Change Request'),
};

export const crOptions = [
  { flags: '--mnemonic <text>', field: 'mnemonic', description: 'Short Change Request title (mnemonic)' },
  { flags: '--description <text>', field: 'description', description: 'Change Request description' },
  { flags: '--change-number <CHG>', field: 'changeNumber', description: 'Change request number (e.g. CHG0001234), added to the Change Request comment' },
  { flags: '--approvers <ids>', field: 'approvers', description: 'Comma-separated approver email addresses (only where the environment lets submitters choose approvers)' },
  { flags: '--rollout-status <id>', field: 'rolloutStatus', description: 'Rollout status ID to set on the flag with this Change Request' },
];

export interface CrInput {
  mnemonic: string;
  description: string;
  changeNumber: string;
  approvers?: string | undefined;
  rolloutStatus?: string | undefined;
}

export type CrOperation = 'UPDATE' | 'KILL' | 'RESTORE' | 'ARCHIVE';

/** A segment's change request takes no rollout status: that is a flag's. */
export const segmentCrFields = { mnemonic: crFields.mnemonic, description: crFields.description, changeNumber: crFields.changeNumber, approvers: crFields.approvers };
export const segmentCrOptions = crOptions.filter((o) => o.field !== 'rolloutStatus');
export type SegmentCrInput = Omit<CrInput, 'rolloutStatus'>;

/** The title, comment and approvers every change request carries, whatever it changes. */
function crCommon(input: SegmentCrInput, title: string) {
  return {
    title,
    comment: `${input.description}\n\nChange number: ${input.changeNumber}`,
    approvers: (input.approvers ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

/**
 * A change request body as Split's Submit Change Request takes it: the flag
 * under `split`, flat, with the operation, title, comment and approvers
 * beside it. Split has no change-number field, so it goes in the comment.
 * https://docs.split.io/reference/create-change-request
 */
export function crBody(input: CrInput, operationType: CrOperation, flag: Record<string, unknown>, title = input.mnemonic): Record<string, unknown> {
  return {
    split: flag,
    operationType,
    ...crCommon(input, title),
    ...(input.rolloutStatus ? { rolloutStatus: { id: input.rolloutStatus } } : {}),
  };
}

/**
 * A segment's change request, as Submit Change Request documents it: a
 * standard segment under `segment` with `CREATE` to add keys and `ARCHIVE` to
 * remove them, and a rule-based segment under `ruleBasedSegment` with `UPDATE`.
 * https://docs.split.io/reference/create-change-request, https://docs.split.io/reference/createrbschangerequest
 */
export function segmentCrBody(input: SegmentCrInput, kind: 'segment' | 'ruleBasedSegment', operationType: 'CREATE' | 'ARCHIVE' | 'UPDATE', object: Record<string, unknown>): Record<string, unknown> {
  return { [kind]: object, operationType, ...crCommon(input, input.mnemonic) };
}

/** POST /changeRequests/ws/{workspace}/environments/{environment}. https://docs.split.io/reference/create-change-request */
export function submitCr<T>(ctx: SplitioContext, environment: string, body: Record<string, unknown>): Promise<T> {
  return split<T>(ctx, `/changeRequests/ws/${seg(workspaceOf(ctx))}/environments/${seg(environment)}`, { method: 'POST', json: body });
}

/** GET a flag's definition in one environment. https://docs.split.io/reference/get-feature-flag-definition-in-environment */
export function getDefinition(ctx: SplitioContext, flag: string, environment: string): Promise<Record<string, unknown>> {
  return split<Record<string, unknown>>(ctx, `/splits/ws/${seg(workspaceOf(ctx))}/${seg(flag)}/environments/${seg(environment)}`);
}

/**
 * The fields of a definition a change request may carry. The GET also returns
 * the environment, traffic type, kill state and timestamps, which belong to
 * Split, not to the request (Submit Change Request's example sends none).
 */
const WRITABLE = ['treatments', 'defaultTreatment', 'baselineTreatment', 'trafficAllocation', 'rules', 'defaultRule'] as const;

export function writableDefinition(flag: string, current: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { name: flag };
  for (const key of WRITABLE) if (current[key] !== undefined) out[key] = current[key];
  return { ...out, ...changes };
}

/** Parses JSON a caller passed as text, as INVALID_INPUT naming where it came from. */
export function parseJson(raw: string, what: string, fix: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new ToilError('INVALID_INPUT', `${what} must be valid JSON: ${(err as Error).message}`, { fix });
  }
}
