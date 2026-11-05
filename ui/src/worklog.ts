/**
 * The worklog's seam (#308): what the Worklog view reads and asks for, the
 * same whoever answers. The local server answers from its cache and the
 * Markdown pages it keeps in the data folder (ui/server/worklog.ts); the site
 * preview and `toil-ui --sample` answer from the sample data
 * (src/fixtures/worklog.ts), keeping nothing.
 *
 * Export writes a page through toil's own file service, so a file lands only
 * inside the folder the person names and never in toil's config. Publishing
 * one anywhere is a proposal: the `toil … --allow-write` line for a person to
 * run through the write gate. Toil UI posts nothing. The out tray, emptied by
 * hand, as the policy requires.
 */

import type { Proposal } from './proposal.ts';
import type { StandupReport } from './model/standup.ts';
import type { WorklogPage } from './model/worklog.ts';

export type { AgentRun, Applied, RunLine, WorklogEvent, WorklogNote, WorklogPage } from './model/worklog.ts';

/** One day in the calendar that has a page. */
export interface WorklogDaySummary {
  day: string;
  /** Lines on the page: facts, agent runs and notes. */
  lines: number;
  /** Things the page says it can't vouch for. */
  gaps: number;
}

/** A month of one toil project's worklog, for the calendar. */
export interface WorklogMonth {
  toilProject: string;
  month: string;
  /** Today, UTC: the newest day a page can have. */
  today: string;
  timeZone: 'UTC';
  retentionDays: number;
  /** The first and last days with a page, across every month, or null with none. */
  first: string | null;
  last: string | null;
  days: WorklogDaySummary[];
}

/** One day's page, as built now. */
export interface WorklogDay {
  page: WorklogPage;
  markdown: string;
  /** Where the page is kept, absolute with forward slashes; null for sample data, which keeps nothing. */
  file: string | null;
}

/** A page built again, and whether it came out the same as the one kept. */
export interface WorklogRebuilt extends WorklogDay {
  /** True when the text matches the page on disk; null when there was none to compare. */
  same: boolean | null;
}

/** What an export wrote, and the proposals for publishing it. */
export interface WorklogExport {
  /** The file toil wrote, absolute with forward slashes. */
  path: string;
  bytes: number;
  proposals: Proposal[];
}

/** A stand-up report (#345), folded from the worklog, with the two texts it copies as. */
export interface WorklogStandup {
  report: StandupReport;
  markdown: string;
  text: string;
}

/** A day's page, a month's pages in one file, or the stand-up for a range of days (#345). */
export type ExportWhat = { day: string } | { month: string } | { from: string; to: string };

/** What an export covers, in words for a title and a file name: the day, the month, or the stand-up's range. */
const spanOf = (what: ExportWhat) => ('day' in what ? what.day : 'month' in what ? what.month : what.from === what.to ? what.from : `${what.from}-to-${what.to}`);
const isStandup = (what: ExportWhat): what is { from: string; to: string } => 'from' in what;

export interface WorklogApi {
  /** Why notes and export are off (sample data), or null when they work. */
  readonly disabled: string | null;
  month(toilProject: string, month?: string): Promise<WorklogMonth>;
  day(toilProject: string, day: string): Promise<WorklogDay>;
  /** Builds the day again from the cache and says whether it matches the page kept. */
  rebuild(toilProject: string, day: string): Promise<WorklogRebuilt>;
  /** Adds a note to today's page; the server names the viewer as its author, and the page never does. */
  addNote(toilProject: string, text: string, by?: string): Promise<WorklogDay>;
  /** Writes the day's or the month's Markdown, or a stand-up's, into a folder, through toil's file service. */
  exportTo(toilProject: string, what: ExportWhat, folder: string): Promise<WorklogExport>;
  /** The stand-up report for a range of days (#345): a fold of their pages, the toil project's people and the latest sync. */
  standup(toilProject: string, from: string, to: string): Promise<WorklogStandup>;
}

/** A refusal the page shows as it is: what was wrong, what to do, and the HTTP status the server answers with. */
export class WorklogRefusal extends Error {
  constructor(message: string, readonly fix: string, readonly status = 400) {
    super(message);
  }
}

/** Why sample data keeps no note and writes no file, said where those would be. */
export const WORKLOG_SAMPLE_DISABLED = 'This is sample data, so it keeps no notes and writes no files. Toil UI on your own machine keeps each page in its data folder and exports through toil.';

/** The longest note a person may add, in characters. */
export const MAX_NOTE = 2000;

/** The file an export writes: `worklog-<toil project>-<day or month>.md`, or `standup-<toil project>-<day, or from-to-to>.md`. */
export const exportName = (toilProject: string, what: ExportWhat) => `${isStandup(what) ? 'standup' : 'worklog'}-${toilProject}-${spanOf(what)}.md`;

/** What `projects show` says about the toil project's areas, as far as publishing needs. */
export type ShowAreas = Record<string, { connection: { value: string; deployment?: string } | null; inputs: Record<string, string> }>;

/**
 * Where an exported worklog could be published, each as a proposal: a
 * Confluence page in the toil project's space, and a GitHub issue in its
 * repository. Each reads the exported file with `--body-file`, so a page of
 * any length fits a command line. Toil UI runs neither.
 */
export function publishProposals(toilProject: string, what: ExportWhat, path: string, areas: ShowAreas): Proposal[] {
  const span = spanOf(what);
  const thing = isStandup(what) ? 'stand-up' : 'worklog';
  const title = `${isStandup(what) ? 'Stand-up' : 'Worklog'}: ${toilProject}, ${isStandup(what) && what.from !== what.to ? `${what.from} to ${what.to}` : span}`;
  const out: Proposal[] = [];
  const reason = `The ${thing} exported to ${path}, as it stands. Check it reads as you want before it's posted: it is the cache's record, facts only.`;
  // Confluence Data Center converts Markdown with --markdown; Confluence Cloud's page create takes storage format or wiki markup only, so on a Cloud connection it isn't offered.
  const space = areas.confluence?.inputs.space;
  if (space && areas.confluence?.connection?.deployment !== 'cloud') {
    out.push({
      id: `${thing}:${toilProject}:${span}:confluence`,
      from: 'worklog',
      item: `${toilProject}:${span}`,
      title: `Publish the ${thing} as a Confluence page in ${space}`,
      reason,
      command: 'confluence page create',
      input: { space, title, bodyFile: path, markdown: true },
      note: 'toil reads the file from its workspace: run the line from the folder the file is in, or pass --workspace with it.',
    });
  }
  const github = areas.github?.inputs;
  if (github?.owner && github.repo) {
    out.push({
      id: `${thing}:${toilProject}:${span}:github`,
      from: 'worklog',
      item: `${toilProject}:${span}`,
      title: `Publish the ${thing} as a GitHub issue in ${github.owner}/${github.repo}`,
      reason,
      command: 'github issue create',
      input: { owner: github.owner, repo: github.repo, title, bodyFile: path },
      note: 'toil reads the file from its workspace: run the line from the folder the file is in, or pass --workspace with it.',
    });
  }
  return out;
}
