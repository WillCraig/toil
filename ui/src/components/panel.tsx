/**
 * A dashboard panel and the line under it that says which toil commands fed
 * it, with each call's exact input and whether it failed. A failed call is an
 * alert on its own panel carrying toil's message and fix, so a broken
 * connection is obvious where it matters and nowhere else (principle 4).
 * Provenance on every panel: the auditors' favourite feature, unrequested.
 */

import type { ReactNode } from 'react';
import { Card } from './layout.tsx';
import { useSkins } from '../skins.tsx';
import type { Call } from '../toil.ts';
import { sourceLabel } from '../format.ts';

/** The tool a call read from, by name: `jira issue search` is Jira, `projects show` is the saved Toil project settings. */
const toolOf = (command: string): string => {
  const area = command.split(' ')[0]!;
  return sourceLabel(area);
};

const isSettingsRead = (command: string) => ['projects', 'toilProjects'].includes(command.split(' ')[0]!);

/** Each tool the calls read from, once, with how many reads it took and how many of them failed. */
export function toolsOf(calls: Call[]): Array<{ tool: string; reads: number; failed: number }> {
  const out: Array<{ tool: string; reads: number; failed: number }> = [];
  for (const c of calls) {
    // Reading the saved Toil project is how the page knows what to show, not where its numbers come from.
    if (isSettingsRead(c.command)) continue;
    const tool = toolOf(c.command);
    const seen = out.find((x) => x.tool === tool);
    const row = seen ?? { tool, reads: 0, failed: 0 };
    row.reads++;
    if (!c.ok) row.failed++;
    if (!seen) out.push(row);
  }
  return out;
}

const sentence = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** Where a panel's numbers came from, in plain words: the tools it read, behind one line; a failed read stays on screen (principle 4). */
export function Sources({ calls, alerts = true }: { calls: Call[]; alerts?: boolean }) {
  const tools = toolsOf(calls);
  if (!tools.length) return null;
  const failed = alerts ? tools.filter((t) => t.failed > 0) : [];
  return (
    <>
      {failed.map((t) => (
        <p key={t.tool} role="alert" className="failure">
          Reading {t.tool} failed{t.failed > 1 ? ` ${t.failed} times` : ''}: {calls.find((c) => !c.ok && toolOf(c.command) === t.tool)?.error}
        </p>
      ))}
      <details className="fed-by">
        <summary>From {sentence(tools.map((t) => t.tool))}</summary>
        <ul className="plain calls">
          {tools.map((t) => (
            <li key={t.tool}>
              {t.tool}: {t.reads} {t.reads === 1 ? 'read' : 'reads'}
              {t.failed > 0 && <span className="failure"> ({t.failed} failed)</span>}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

export function Panel({ id, title, calls, children, alerts = true }: { id: string; title: string; calls: Call[]; children: ReactNode; alerts?: boolean }) {
  const { Panel: Skin } = useSkins();
  return (
    <Card as="section" className="panel" aria-labelledby={id}>
      <Skin id={id}>
        <h2 id={id}>{title}</h2>
        {children}
        <Sources calls={calls} alerts={alerts} />
      </Skin>
    </Card>
  );
}
