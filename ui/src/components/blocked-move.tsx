/**
 * The notice for a drop that no command can make yet (#566): the card goes back
 * to its column, and one message says what is missing and what to do about it,
 * with the place to do it. Nothing here is a proposal, because there is no
 * command to propose: a ghost card in the target column, and a "How to apply"
 * with nothing in it, would only say that somebody else will deal with it.
 *
 * Plain words (principle 11): the reason, then the step. A link goes to the
 * screen or the page where the step is done. A command is a step further in,
 * under "Show the command", where the exact line is: one that toil can run, or
 * one with a blank only the person can fill (a project's number), which is shown
 * as it is typed and never run. A ghost card would only have said that somebody else
 * will deal with it, which is how most tickets begin.
 */

import { Button } from 'react-aria-components';
import './blocked-move.css';
import type { NextLink, NextStep } from '../board-api.ts';
import { connectionEditHref, toilProjectEditHref } from '../format.ts';
import { commandLine } from '../proposal.ts';
import { useShell } from './proposal.tsx';
import { SummaryChevron } from './disclosure.tsx';
import { ExternalLink } from './external-link.tsx';
import { NavButton } from './nav-button.tsx';

/** Where a next step's link goes: the app's own screens by kind, GitHub by the address toil read. */
function hrefOf(link: NextLink, toilProject: string): { href: string; external: boolean } {
  if (link.kind === 'toil-project') return { href: toilProjectEditHref(toilProject, 'sources'), external: false };
  if (link.kind === 'connection') return { href: connectionEditHref(link.name), external: false };
  return { href: link.href, external: true };
}

export function BlockedMove({ toilProject, title, reason, next, onDismiss }: { toilProject: string; title: string; reason: string; next: NextStep; onDismiss: () => void }) {
  const shell = useShell();
  const line = next.command ? commandLine(next.command, shell) : null;
  const link = next.link ? hrefOf(next.link, toilProject) : null;
  return (
    <div className="board-notice board-notice--blocked" role="alert" data-board-notice="blocked">
      <div className="board-notice__body">
        <p>
          <strong>{title}</strong> <span data-blocked-reason="">{reason}</span>
        </p>
        <p className="note" data-blocked-next="">
          {next.text}
          {next.link && link && (
            <>
              {' '}
              {link.external ? (
                <ExternalLink href={link.href} data-blocked-link={next.link.kind}>
                  {next.link.label}
                </ExternalLink>
              ) : (
                <NavButton href={link.href} size="sm" data-blocked-link={next.link.kind}>
                  {next.link.label}
                </NavButton>
              )}
            </>
          )}
        </p>
        {(line || next.template) && (
          <details className="proposal-command" data-blocked-command="">
            <summary><SummaryChevron />Show the command</summary>
            {line?.line ? (
              <pre className="command">
                <code>{line.line}</code>
              </pre>
            ) : line ? (
              <p className="failure">{line.reason}</p>
            ) : (
              <>
                <pre className="command">
                  <code>{next.template}</code>
                </pre>
                <p className="note">Replace &lt;number&gt; with the project&apos;s number: the last part of its address.</p>
              </>
            )}
          </details>
        )}
      </div>
      <Button className="btn btn--small btn--quiet" onPress={onDismiss} aria-label="Dismiss this message">
        Dismiss
      </Button>
    </div>
  );
}
