/**
 * The seam Toil UI is built on (#206, #228): toil itself. Every panel is
 * filled by calling toil commands through `execute()` from
 * `@imagile-dev/toil/api`, read-only, which call the tools' REST APIs with the
 * user's own connections and toil projects. The UI holds no credential and talks to
 * no service on its own. The site preview passes a fixture `execute()`
 * (src/fixtures/execute.ts) with the same signature, which answers from canned,
 * sanitized envelopes; test/registry.test.ts holds every call it answers to the
 * real registry, and holds this type to the real `execute`'s.
 *
 * Pull requests come through OWI 0.2 as changes (src/core/owi/); what toil
 * doesn't shape yet (builds, deployments) the UI reads from each command's
 * own output into the small shapes below (src/model/delivery.ts). One door, one key, and a
 * sign-in sheet that fills itself in.
 */

import type { Envelope } from '../../src/core/envelope.ts';

export type { Envelope } from '../../src/core/envelope.ts';
export type { AuthorKind, Change, ChecksState, LinkType, Person, Review, Reviewer, StatusCategory, Transition, WorkItem, WorkItemType } from '../../src/core/owi/types.ts';
import type { Change } from '../../src/core/owi/types.ts';

/**
 * The options the UI passes. A subset of the API's `ExecuteOptions`, so the
 * real `execute` fits this type unchanged (test/registry.test.ts checks both
 * ways).
 */
export interface ExecuteOptions {
  readOnly?: boolean;
  caller?: string;
  signal?: AbortSignal;
  /** Only the local server's config path passes one (ui/server/config.ts): the person's answers to toil's questions. */
  person?: ExecutePerson;
  /** Who the call is for, on the audit line beside `caller`: an agent assignment (#293). A toil without the option ignores it. */
  actor?: string;
  /** The folder toil's file and git commands work in: the worklog's export (ui/server/worklog.ts), and implement mode's clone (#293). */
  workspace?: string;
}

/** One question a person's command asks (the API's `Question`). */
export interface Question {
  id: string;
  text: string;
  secret: boolean;
  fallback: string | null;
}

/** The API's `ExecutePerson`: answers a question with what the person typed, or `undefined` if they weren't asked it. */
export interface ExecutePerson {
  ask(question: Question): Promise<string | undefined> | string | undefined;
}

/** `execute()` from `@imagile-dev/toil/api`: one command, its MCP fields, one envelope back. Never throws. */
export type Execute = (command: string, input?: Record<string, unknown>, options?: ExecuteOptions) => Promise<Envelope>;

/** How the UI calls toil, always: it reads, and the audit log names it. */
export const CALL_OPTIONS = { readOnly: true, caller: 'toil-ui' } as const satisfies ExecuteOptions;

/** One call a panel made, kept so the panel can say which command fed it. */
export interface Call {
  command: string;
  input: Record<string, unknown>;
  ok: boolean;
  /** The failure's message and fix, when it failed. */
  error: string | null;
}

/** The services a toil project's panels read from. */
export type SourceKind = 'jira' | 'ado' | 'github' | 'bitbucket' | 'jenkins' | 'openshift';

/**
 * A pull request or a build, joined to the work items it mentions (#206,
 * `ChangeRef`): what the delivery panels and the trace table read. A pull
 * request's is made from its OWI change, which it carries as `change`.
 */
export interface ChangeRef {
  id: string;
  kind: 'pull-request' | 'build';
  source: SourceKind;
  /** The toil command whose output it came from (`bitbucket pr list`). */
  command: string;
  /** The OWI ids of the work items it mentions. */
  items: string[];
  title: string;
  url: string | null;
  /** The source's own state word: OPEN, MERGED, SUCCESS, failure. */
  state: string;
  /** The state, sorted into what the views need. */
  outcome: 'open' | 'merged' | 'declined' | 'passed' | 'failed' | 'running';
  /** For a build: the pull request it built. */
  builds: string | null;
  /** For a merged pull request: the commit it merged as, which is what a deployment names. */
  mergeCommit: string | null;
  at: string;
  /** For a pull request: the OWI 0.2 change it was made from. */
  change?: Change;
}

/** What one environment runs, and the merged pull requests that are in it. */
export interface Deployment {
  id: string;
  environment: string;
  source: SourceKind;
  command: string;
  /** What the source calls it: a deployment's name, a pipeline run's number. */
  name: string;
  /** The commit it runs, as the source gave it (an image tag's suffix, a run's source version). */
  commit: string;
  /** The version label beside the commit, when there is one. */
  version: string | null;
  state: string;
  outcome: 'passed' | 'failed' | 'running';
  url: string | null;
  /** The merged pull requests whose merge commit is the deployed one or older (src/model/delivery.ts). */
  includes: string[];
  /** The work items those pull requests mention. */
  items: string[];
  /** Set when the deployed commit matches no merged pull request the toil project's repository lists. */
  unknownCommit: boolean;
}
