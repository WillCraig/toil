/**
 * The Feedback dialog's seam (#265): `toil feedback`, run through the local
 * server's `api/feedback` (ui/server/server.ts), never by Toil UI calling
 * anyone itself. A preview is the command run read-only, so it sends nothing
 * and returns exactly the report it would send and the disclaimer; sending is
 * the same command again with the person's yes to its `consent` question,
 * which the page gives only while its checkbox is ticked for that exact
 * report. The text the dialog shows is the command's own, from the toil the
 * server runs, so the page has no copy of the disclaimer to drift.
 *
 * The site preview passes a fixture (src/fixtures/feedback.ts) that builds the
 * same report with toil's own code and sends nothing, saying so. The comment
 * card goes in the box; the box is locked until you sign the card.
 */

import { FEEDBACK_FORM } from '../../src/feedback/consent.ts';
import type { Envelope } from './toil.ts';

export type FeedbackKind = 'bug' | 'feature';

/** Why sample data sends nothing, said beside the Send button. */
export const FEEDBACK_SAMPLE_DISABLED = `This is sample data, so it sends nothing. Toil UI on your own machine sends it for you, or use the form at ${FEEDBACK_FORM}.`;

/** What the person typed. Nothing else goes in a report: toil adds only its version and commit. */
export interface FeedbackFields {
  kind: FeedbackKind;
  title: string;
  body: string;
  email: string;
}

/** `toil feedback`'s data: the report it sent or would send, the disclaimer, and whether it went. */
export interface FeedbackData {
  sent: boolean;
  endpoint: string;
  report: Record<string, unknown>;
  consentVersion: number;
  disclaimer: string;
  /** The endpoint's answer, once sent. */
  message?: string;
}

export interface FeedbackApi {
  /** Why sending is off (the preview), or null when the page may send. */
  readonly disabled: string | null;
  /** The command, read-only: what it would send, and the disclaimer. Sends nothing. */
  preview(fields: FeedbackFields, signal?: AbortSignal): Promise<Envelope>;
  /** The command, with the person's yes: sends the report the preview showed. */
  send(fields: FeedbackFields): Promise<Envelope>;
}

/** The command's data, when the envelope holds `toil feedback`'s shape. */
export function feedbackData(envelope: Envelope | null): FeedbackData | null {
  if (!envelope?.ok) return null;
  const data = envelope.data as Partial<FeedbackData> | null;
  if (typeof data?.disclaimer !== 'string' || typeof data.report !== 'object' || data.report === null || typeof data.sent !== 'boolean') return null;
  return data as FeedbackData;
}

/** A failed call as the dialog says it: toil's message and fix, and what to do when this toil has no feedback command. */
export function feedbackProblem(envelope: Envelope): string {
  const error = envelope.error;
  if (!error) return 'toil returned no report.';
  if (/has no command "feedback"/.test(error.message)) {
    return `The toil this Toil UI runs (${envelope.meta.version}) has no feedback command; it needs a newer toil. Until then, use the form at ${FEEDBACK_FORM}.`;
  }
  return `${error.message}${error.fix ? ` ${error.fix}` : ''}`;
}
