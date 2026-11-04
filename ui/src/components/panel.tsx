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
import { usePlain } from '../plain-words.ts';

/** `toil jira issue history` ×8: each command once, with how many calls it took. */
export function commandsOf(calls: Call[]): Array<{ command: string; count: number }> {
  const out: Array<{ command: string; count: number }> = [];
  for (const c of calls) {
    const seen = out.find((x) => x.command === c.command);
    if (seen) seen.count++;
    else out.push({ command: c.command, count: 1 });
  }
  return out;
}

/** The tools a list of commands read from, by name: `jira issue search` is Jira, `dossiers show` is the saved Toil project settings. */
export function toolsOf(commands: Array<{ command: string }>): string[] {
  const names = commands.map((c) => {
    const area = c.command.split(' ')[0]!;
    return area === 'dossiers' ? 'your saved Toil projects' : sourceLabel(area);
  });
  return [...new Set(names)];
}

const sentence = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

export function Sources({ calls, alerts = true }: { calls: Call[]; alerts?: boolean }) {
  const plain = usePlain();
  if (!calls.length) return null;
  const commands = commandsOf(calls);
  const commandList = commands.map((c, i) => (
    <span key={c.command}>
      {i > 0 && ', '}
      <code>toil {c.command}</code>
      {c.count > 1 && ` ×${c.count}`}
    </span>
  ));
  const failed = alerts ? calls.filter((c) => !c.ok) : [];
  return (
    <>
      {failed.map((c, i) => (
        <p key={i} role="alert" className="failure">
          <code>toil {c.command}</code> failed: {c.error}
        </p>
      ))}
      <details className="fed-by">
        <summary>{plain.on ? `From ${sentence(toolsOf(commands))}` : <>Fed by {commandList}</>}</summary>
        {plain.on && <p className="note">The exact toil commands that read it: {commandList}.</p>}
        <ul className="plain calls">
          {calls.map((c, i) => (
            <li key={i}>
              <code className="call">
                execute({JSON.stringify(c.command)}, {JSON.stringify(c.input)})
              </code>
              {!c.ok && <span className="failure"> (failed)</span>}
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
