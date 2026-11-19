/**
 * A proposal as a card to review (#252, #253): what would change, why, and
 * the toil command that applies it through the write gate. The card can copy
 * the command or be dismissed. It has no button of its own that applies
 * anything (principle 2): an Apply is passed in `actions` by the one place
 * that may offer it, which asks the server to run it through toil's own gate:
 * an agent assignment's page (#293), which runs the proposal the server stored,
 * and the Board, whose Apply is a person's press on a move they made.
 *
 * The Board's card is the tidy form (`why` given): what would change, one line
 * on why it wasn't applied, the primary action when there is one, and the
 * command a step further in, under "Show the command". An assignment's card is
 * the apply form (`lead` given): what it changes, then Apply, then why, with
 * the command under the same closed "Show the command", since a person
 * pressing Apply needs the change, not the shell it would take to type it.
 * Every other card keeps its command in view, since the command is what it
 * asks to have run. Inside a disclosure, a value no command line can carry is
 * advice for whoever runs it by hand, so it reads as a note, not an error.
 */

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button, Radio, RadioGroup } from 'react-aria-components';
import { SHELL_LABEL, commandLine, defaultShell, readLine, type Proposal, type Shell } from '../proposal.ts';
import { Cited } from './items.tsx';
import { Help } from './help.tsx';
import { SummaryChevron } from './disclosure.tsx';

// Which shell the commands are shown for: the viewer's by default, one choice for every card, remembered when storage allows.
const KEY = 'toil-ui.shell';
const listeners = new Set<() => void>();
let current: Shell | null = null;
function shellNow(): Shell {
  if (current) return current;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'posix' || saved === 'powershell') return (current = saved);
  } catch {
    // Not remembered; the default stands.
  }
  return (current = defaultShell());
}
function setShell(shell: Shell) {
  current = shell;
  try {
    localStorage.setItem(KEY, shell);
  } catch {
    // Not remembered.
  }
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
export const useShell = () => useSyncExternalStore(subscribe, shellNow, shellNow);

export function ProposalCard({ proposal, onDismiss, kind = 'Proposed change, not applied', actions, why, detail, lead, hideReason = false, applied = false, children }: { proposal: Proposal; /** Apply form: the change is in the tracker, so the card is a record with a solid border, not a dashed proposal. */ applied?: boolean; /** Apply form: leave the proposal's reason out, where the page above already says it (a rule fix's agent paragraph). */ hideReason?: boolean; onDismiss?: () => void; kind?: string; actions?: ReactNode; /** Tidy form: the one line saying why this wasn't applied, in place of the proposal's own reason. */ why?: string; /** Tidy form: what else toil said, such as the moves the workflow offers. */ detail?: string; /** Apply form: what the proposal changes (its field table), shown under the title and above the actions. */ lead?: ReactNode; children?: ReactNode }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const shell = useShell();
  const { line, reason, mcp } = commandLine(proposal, shell);
  const hint = proposal.hint ? { text: proposal.hint.text, ...readLine(proposal.hint, shell) } : null;
  // A second write, run after the first has worked: its own line, with its own --allow-write.
  const then = proposal.then ? { text: proposal.then.text, ...commandLine(proposal.then, shell) } : null;
  // The toggle stays even when this shell can't carry a value, so the card can switch to one that can.
  const showShells = Boolean(proposal.command || proposal.hint || proposal.then);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(line!);
      setCopied('yes');
    } catch {
      setCopied('no');
    }
  };
  const status = (
    <span className="note" role="status">
      {copied === 'yes' ? 'Copied.' : copied === 'no' ? "Couldn't copy: select the command instead." : ''}
    </span>
  );
  // The command, its shells, and anything run with or before it, as "Show the command" holds them.
  const commandBody = (
    <>
      {showShells && (
        <RadioGroup className="shells" orientation="horizontal" value={shell} onChange={(v) => setShell(v as Shell)} aria-label="Show the command for">
          {(['powershell', 'posix'] as const).map((s) => (
            <Radio key={s} value={s} className="shell-choice">
              {SHELL_LABEL[s]}
            </Radio>
          ))}
        </RadioGroup>
      )}
      {line ? (
        <>
          <p className="note">
            Apply it yourself in a terminal: <Help topic="proposal" />
          </p>
          <pre className="command">
            <code>{line}</code>
          </pre>
          <div>
            <Button className="btn" onPress={copy}>
              Copy command
            </Button>
          </div>
        </>
      ) : (
        proposal.command && (
          <>
            <p className="note" data-command-advice="">
              {reason}
            </p>
            {mcp && (
              <pre className="command" aria-label={`MCP call to ${mcp.tool}`}>
                <code>{JSON.stringify({ tool: mcp.tool, input: mcp.input }, null, 2)}</code>
              </pre>
            )}
          </>
        )
      )}
      {then && (
        <>
          <p className="note">{then.text}</p>
          {then.line ? (
            <pre className="command" data-then="">
              <code>{then.line}</code>
            </pre>
          ) : (
            <p className="note">{then.reason}</p>
          )}
        </>
      )}
      {hint && (
        <>
          <p className="note">{hint.text}</p>
          {hint.line ? (
            <pre className="command">
              <code>{hint.line}</code>
            </pre>
          ) : (
            <p className="note">{hint.reason}</p>
          )}
        </>
      )}
    </>
  );
  if (lead !== undefined) {
    return (
      <article className={applied ? 'proposal proposal--apply proposal--applied' : 'proposal proposal--apply'} aria-label={`Proposal: ${proposal.title}`}>
        <p className="proposal-kind">{kind}</p>
        <h3>{proposal.title}</h3>
        {lead}
        {proposal.note && <p className="note">{proposal.note}</p>}
        <div className="proposal-actions">
          {actions}
          {onDismiss && (
            <Button className="btn btn--quiet" onPress={onDismiss}>
              Dismiss
            </Button>
          )}
          {status}
        </div>
        {children}
        {!hideReason && (
          <p className="proposal-reason">
            <Cited text={proposal.reason} chips={proposal.from === 'agent'} />
          </p>
        )}
        {(showShells || proposal.command) && (
          <details className="proposal-command" data-proposal-command="">
            <summary>
              <SummaryChevron />
              Show the command
            </summary>
            {commandBody}
          </details>
        )}
      </article>
    );
  }
  if (why !== undefined) {
    return (
      <article className="proposal proposal--tidy" aria-label={`Proposal: ${proposal.title}`}>
        <p className="proposal-kind">{kind}</p>
        <h3>{proposal.title}</h3>
        <p className="proposal-why" data-proposal-why="">
          {why}
        </p>
        {detail && <p className="note">{detail}</p>}
        <div className="proposal-actions">
          {actions}
          {onDismiss && (
            <Button className="btn btn--quiet" onPress={onDismiss}>
              Dismiss
            </Button>
          )}
          {status}
        </div>
        {(showShells || proposal.note) && (
          <details className="proposal-command" data-proposal-command="">
            <summary>
              <SummaryChevron />
              Show the command
            </summary>
            <p className="note">{proposal.reason}</p>
            {commandBody}
            {proposal.note && <p className="note">{proposal.note}</p>}
            {children}
          </details>
        )}
      </article>
    );
  }
  return (
    <article className="proposal" aria-label={`Proposal: ${proposal.title}`}>
      <p className="proposal-kind">{kind}</p>
      <h3>{proposal.title}</h3>
      <p>
        <Cited text={proposal.reason} chips={proposal.from === 'agent'} />
      </p>
      {showShells && (
        <RadioGroup className="shells" orientation="horizontal" value={shell} onChange={(v) => setShell(v as Shell)} aria-label="Show the command for">
          {(['powershell', 'posix'] as const).map((s) => (
            <Radio key={s} value={s} className="shell-choice">
              {SHELL_LABEL[s]}
            </Radio>
          ))}
        </RadioGroup>
      )}
      {line ? (
        <>
          <p className="note">
            Apply it yourself in a terminal: <Help topic="proposal" />
          </p>
          <pre className="command">
            <code>{line}</code>
          </pre>
        </>
      ) : (
        proposal.command && (
          <>
            <p className="failure">{reason}</p>
            {mcp && (
              <pre className="command" aria-label={`MCP call to ${mcp.tool}`}>
                <code>{JSON.stringify({ tool: mcp.tool, input: mcp.input }, null, 2)}</code>
              </pre>
            )}
          </>
        )
      )}
      {then && (
        <>
          <p className="note">{then.text}</p>
          {then.line ? (
            <pre className="command" data-then="">
              <code>{then.line}</code>
            </pre>
          ) : (
            <p className="failure">{then.reason}</p>
          )}
        </>
      )}
      {proposal.note && <p className="note">{proposal.note}</p>}
      {hint && (
        <>
          <p className="note">{hint.text}</p>
          {hint.line ? (
            <pre className="command">
              <code>{hint.line}</code>
            </pre>
          ) : (
            <p className="failure">{hint.reason}</p>
          )}
        </>
      )}
      {children}
      <div className="proposal-actions">
        {actions}
        {line && (
          <Button className="btn" onPress={copy}>
            Copy command
          </Button>
        )}
        {onDismiss && (
          <Button className="btn btn--quiet" onPress={onDismiss}>
            Dismiss
          </Button>
        )}
        <span className="note" role="status">
          {copied === 'yes' ? 'Copied.' : copied === 'no' ? "Couldn't copy: select the command instead." : ''}
        </span>
      </div>
    </article>
  );
}
