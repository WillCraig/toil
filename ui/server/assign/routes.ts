/**
 * The assignment routes (#293), under `api/assignments`, behind the
 * session and CSRF checks every other route has (server.ts):
 *
 *   GET  assignments?toil project=<name>        the toil project's assignments, the inbox read again first
 *                                          (&inbox=0: only read, queueing nothing)
 *   GET  assignments/one?id=<id>           one assignment with its transcript
 *   GET  assignments/events?since=<seq>    NDJSON: the kept events after seq, then each as it happens;
 *                                          since=latest skips the kept ones (#306's notifications)
 *   POST assignments                       { toil project, item, mode, adapter, repo? }: assign and queue
 *   POST assignments/start                 { id, adapter? }: start one the tracker queued
 *   POST assignments/cancel                { id }
 *   POST assignments/apply                 { id, proposal }: run that proposal through toil's write gate
 *   POST assignments/dismiss               { id, proposal }
 *   POST assignments/finish                { id }: reviewed, done
 *   POST assignments/renew                 { id }: a stale, idle one afresh on today's instructions (#305)
 *   POST assignments/settings              { concurrent, timeLimitMinutes }
 *
 * The page names an assignment and a proposal, never a command: what apply
 * runs is the proposal the server stored when the run ended. A mail room
 * that takes only the docket number, never the parcel.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AssignAdapter, AssignRequest, AssignSettings } from '../../src/assign/model.ts';
import { AssignError, type AssignmentQueue } from '../../src/assign/queue.ts';

export interface AssignmentControl {
  queue: AssignmentQueue;
  /** Checks and saves the limits; absent with sample data, which keeps its own. */
  saveSettings?(input: unknown): AssignSettings;
}

export interface RouteHelpers {
  readJson(req: IncomingMessage): Promise<Record<string, unknown>>;
  json(res: ServerResponse, status: number, value: unknown): void;
  headers: Record<string, string>;
}

const idOf = (body: Record<string, unknown>) => {
  if (typeof body.id !== 'string' || !body.id) throw new AssignError('Name the assignment by its id.', 'Send { "id": "<assignment id>" }.');
  return body.id;
};
const proposalOf = (body: Record<string, unknown>) => {
  if (typeof body.proposal !== 'string' || !body.proposal) throw new AssignError('Name the proposal by its id.', 'Send { "id": "<assignment id>", "proposal": "<proposal id>" }.');
  return body.proposal;
};

/** Answers one assignment route; false when the route isn't one of these. */
export async function assignmentRoute(key: string, req: IncomingMessage, res: ServerResponse, url: URL, control: AssignmentControl | undefined, h: RouteHelpers): Promise<boolean> {
  if (!/^(GET|POST) assignments(\/|$)/.test(key)) return false;
  if (!control) throw new AssignError('This Toil UI assigns nothing.', 'Start toil-ui with its cache, or with --sample for the sample assignments.', 404);
  const { queue } = control;
  switch (key) {
    case 'GET assignments': {
      const toilProject = url.searchParams.get('toilProject');
      if (!toilProject) throw new AssignError('Name the Toil project.', 'Ask api/assignments?toilProject=<name>.');
      h.json(res, 200, await queue.list(toilProject, { inbox: url.searchParams.get('inbox') !== '0' }));
      return true;
    }
    case 'GET assignments/one': {
      const id = url.searchParams.get('id');
      if (!id) throw new AssignError('Name the assignment.', 'Ask api/assignments/one?id=<id>.');
      h.json(res, 200, await queue.read(id));
      return true;
    }
    case 'GET assignments/events': {
      const asked = url.searchParams.get('since') ?? '0';
      const since = asked === 'latest' ? queue.latest : Number(asked);
      if (!Number.isInteger(since) || since < 0) throw new AssignError('since is the last event sequence number you have, 0 or more, or latest.', 'Ask api/assignments/events?since=0.');
      res.writeHead(200, { ...h.headers, 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      for (const e of queue.since(since)) res.write(`${JSON.stringify(e)}\n`);
      const stop = queue.subscribe((e) => {
        if (!res.destroyed) res.write(`${JSON.stringify(e)}\n`);
      });
      await new Promise<void>((done) => res.on('close', () => done()));
      stop();
      return true;
    }
    case 'POST assignments': {
      const body = await h.readJson(req);
      h.json(res, 201, await queue.assign(body as unknown as AssignRequest));
      return true;
    }
    case 'POST assignments/start': {
      const body = await h.readJson(req);
      h.json(res, 200, await queue.start(idOf(body), body.adapter === undefined ? undefined : (body.adapter as AssignAdapter)));
      return true;
    }
    case 'POST assignments/cancel':
      h.json(res, 200, queue.cancel(idOf(await h.readJson(req))));
      return true;
    case 'POST assignments/apply': {
      const body = await h.readJson(req);
      h.json(res, 200, await queue.apply(idOf(body), proposalOf(body)));
      return true;
    }
    case 'POST assignments/dismiss': {
      const body = await h.readJson(req);
      h.json(res, 200, queue.dismiss(idOf(body), proposalOf(body)));
      return true;
    }
    case 'POST assignments/finish':
      h.json(res, 200, queue.finish(idOf(await h.readJson(req))));
      return true;
    case 'POST assignments/renew':
      h.json(res, 201, await queue.renew(idOf(await h.readJson(req))));
      return true;
    case 'POST assignments/settings': {
      if (!control.saveSettings) throw new AssignError("The sample's limits can't be changed.", 'Start toil-ui without --sample to set your own.', 404);
      const saved = control.saveSettings(await h.readJson(req));
      queue.wake();
      h.json(res, 200, saved);
      return true;
    }
    default:
      throw new AssignError(`There is no ${key} in the API.`, 'The assignment routes are assignments, assignments/one, assignments/events, and POST assignments/start, cancel, apply, dismiss, finish, renew and settings.', 404);
  }
}
