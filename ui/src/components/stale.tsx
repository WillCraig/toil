/**
 * Stale sessions in the views (#305): the badge a chat, an assignment and an
 * agent's card show when what they started on has changed, and the header's
 * line when the server itself is older than what is on disk. Plain words in
 * every theme: a reason is a fact, and facts don't get a lexicon. On a card
 * the badge says only "Out of date"; the reason is in its tooltip (#657). A sticker
 * on the folder that says the folder has been superseded, in red, by order.
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { ServerStatus, Staleness } from '../fingerprint.ts';
import { usePlain } from '../plain-words.ts';

/**
 * The word on the badge. What changed (toil's version, a commit, the prompts) is toil's internals, so it never reaches a
 * card (principle 11, #657): it rides in the tooltip, and in full on the assignment's own Run details.
 */
export function StaleChip({ why }: { why?: string }) {
  const plain = usePlain();
  return (
    <span className="stale-chip" title={why ? `Started before an update: ${why}.` : plain.on ? 'Started before an update. In toil: stale' : undefined}>
      {plain.pw('Stale', 'Out of date')}
    </span>
  );
}

/** The badge, with what changed in its tooltip, and an action beside it ("Run again") where there is one. */
export function StaleNote({ stale, className = '', action }: { stale: Staleness; className?: string; action?: ReactNode }) {
  return (
    <p className={`stale-note ${className}`.trim()} data-stale="">
      <StaleChip why={stale.text} />
      {action}
    </p>
  );
}

/** How often the header asks whether the server is out of date. */
export const SERVER_POLL_MS = 60_000;

/**
 * The header's line when toil or Toil UI on disk is newer than the running
 * server (#305), with the command that starts it again. Asked at load and
 * every minute; a server that can't say shows nothing, since the page has
 * nothing true to add.
 */
export function ServerStale({ load }: { load: (() => Promise<ServerStatus | null>) | undefined }) {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  useEffect(() => {
    if (!load) return;
    let live = true;
    const read = () =>
      load().then(
        (s) => live && setStatus(s),
        () => undefined,
      );
    void read();
    const t = setInterval(read, SERVER_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [load]);
  if (!status?.stale) return null;
  return (
    <p className="banner banner--stale" role="status" data-server-stale="">
      <strong>Toil UI is out of date.</strong> {status.stale} Running chats and assignments started on the older one. Stop it with Ctrl+C where it runs, then start it again: <code className="any-break">{status.restart}</code>
    </p>
  );
}
