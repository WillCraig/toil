/**
 * The real progress a loading screen says (#419): which toil command a read
 * is waiting on, and how many of the calls it has sent have been answered.
 * It wraps the `execute()` a load is given and counts as the calls go, so the
 * words are what is happening, never a made-up percentage.
 * A progress report that reports progress, which the steering group noted with surprise.
 */

import type { Execute } from '../toil.ts';

export interface CallProgress {
  started: number;
  answered: number;
  /** The command sent most recently that has no answer yet, or the last one sent. */
  reading: string | null;
}

/** An `execute()` that reports each call it sends and each answer it gets. */
export function trackCalls(execute: Execute, report: (p: CallProgress) => void): Execute {
  const p: CallProgress = { started: 0, answered: 0, reading: null };
  const pending: string[] = [];
  return async (command, input, options) => {
    p.started++;
    pending.push(command);
    report({ ...p, reading: command });
    try {
      return await execute(command, input, options);
    } finally {
      p.answered++;
      pending.splice(pending.indexOf(command), 1);
      report({ ...p, reading: pending.at(-1) ?? command });
    }
  };
}

/** The progress in words: "3 of 5 toil calls answered; reading toil jira issue search." */
export function progressText(p: CallProgress | null | undefined): string | null {
  if (!p || !p.started) return null;
  return `${p.answered} of ${p.started} toil ${p.started === 1 ? 'call' : 'calls'} answered${p.reading && p.answered < p.started ? `; reading toil ${p.reading}` : ''}.`;
}

/** A running sync's progress in words, from the job the Sync panel polls. */
export function syncText(job: { toilProject: string | null; toilProjectsDone: number; toilProjectsTotal: number; requests: number; pages: number; retries: number } | null | undefined): string | null {
  if (!job) return null;
  return `Syncing ${job.toilProject ?? 'the Toil projects'}: ${job.toilProjectsDone} of ${job.toilProjectsTotal || '?'} Toil projects, ${job.requests} requests, ${job.pages} pages${job.retries ? `, ${job.retries} retries` : ''}.`;
}
