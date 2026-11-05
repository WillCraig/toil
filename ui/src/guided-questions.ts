/**
 * The questions a first-time asker is offered (#552), in plain words and in a
 * few groups, each with a line on what it is good for (a hover, not a caption) and the panels of the
 * dashboard whose reads its answer depends on, so a failed read lowers "How
 * sure is this?" for the questions it touches and not for the rest. Pressing
 * one asks its text through the same agent path as typing it. The first
 * question is the full briefing, which runs what Analyze runs. A menu of
 * questions with a footnote for each, unlike most menus.
 */

import type { Panel } from './load.ts';
import type { WorkItem } from './toil.ts';

/** The panels a read can fail in, in words, for a sentence that names the ones that failed. */
export const PANEL_WORDS: Record<Panel, string> = { toilProject: 'the Toil project', work: 'work items', prs: 'pull requests', owners: 'code owners', builds: 'builds', deployments: 'deployments' };

export type QuestionId = 'briefing' | 'finish' | 'changed' | 'blocking' | 'waiting' | 'review' | 'help' | 'ready' | 'boss';

/** Something a question needs from each item, and the test for one that lacks it: "no estimate" for a forecast. */
export interface Lack {
  what: string;
  /** Which items count towards the share. */
  among: (item: WorkItem) => boolean;
  /** Whether the item lacks it. */
  lacks: (item: WorkItem) => boolean;
}

export interface GuidedQuestion {
  id: QuestionId;
  /** The question, in toil's own words; plain words rewrite its jargon where it is drawn. */
  text: string;
  /** What it is good for: the button's hover text, not a line on the page. */
  good: string;
  /** The one line a question keeps on the page under its text, where the question could be misread. */
  note?: string;
  /** The dashboard panels whose reads the answer depends on. */
  needs: Panel[];
  lack?: Lack;
  /** What "how sure" counts as the base when it isn't the Toil project's items: a question about reviews rests on code reviews. */
  base?: 'pullRequests';
}

export const QUESTIONS: Record<QuestionId, GuidedQuestion> = {
  briefing: { id: 'briefing', text: 'Give me the full briefing', good: 'starting the day or a review: one recommendation, then the reasons.', needs: ['work', 'prs', 'builds'] },
  finish: { id: 'finish', text: 'Are we going to finish the sprint?', good: 'knowing now, not at the sprint review.', needs: ['work', 'prs', 'builds'], lack: { what: 'no estimate', among: (i) => i.statusCategory !== 'DONE' && !!i.iteration?.name, lacks: (i) => !i.estimate } },
  changed: { id: 'changed', text: 'What changed this week?', good: 'a stand-up or a weekly update.', needs: ['work', 'prs'] },
  blocking: { id: 'blocking', text: "What's blocking us?", good: 'finding the one thing others are waiting behind.', needs: ['work', 'prs', 'builds'] },
  waiting: { id: 'waiting', text: "What's waiting on another team?", good: 'raising a dependency before it hurts.', needs: ['work', 'prs'] },
  review: { id: 'review', text: "What's stuck in review?", good: 'finding the change nobody has picked up.', needs: ['prs', 'builds'], base: 'pullRequests' },
  help: { id: 'help', text: 'Who might need help?', good: "seeing whose work is stuck. It describes each person's workload and never ranks anyone.", note: 'It never ranks anyone.', needs: ['work', 'prs', 'owners'], lack: { what: 'nobody assigned', among: (i) => i.statusCategory === 'IN_PROGRESS', lacks: (i) => !i.assignee } },
  ready: { id: 'ready', text: "Which stories aren't ready to start?", good: 'getting the next sprint ready to plan.', needs: ['work'] },
  boss: { id: 'boss', text: 'Summarise this for my boss', good: 'a few plain lines you can paste into an email.', needs: ['work', 'prs', 'builds'] },
};

export interface GuidedGroup {
  id: string;
  title: string;
  questions: QuestionId[];
}

export const GROUPS: GuidedGroup[] = [
  { id: 'doing', title: 'How are we doing?', questions: ['briefing', 'finish', 'changed'] },
  { id: 'way', title: "What's in the way?", questions: ['blocking', 'waiting', 'review', 'help'] },
  { id: 'backlog', title: 'Backlog', questions: ['ready'] },
  { id: 'others', title: 'For others', questions: ['boss'] },
];

/** The question a prompt is, when it reads as one of these as drawn (after plain words); null for a typed one. */
export function questionFor(prompt: string, text: (standard: string) => string = (s) => s): GuidedQuestion | null {
  return Object.values(QUESTIONS).find((q) => text(q.text) === prompt) ?? null;
}
