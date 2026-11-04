/**
 * "Not ticketed yet" (#304): the banner a chat shows when someone asks for
 * work that no ticket covers. It lists the open items likeliest to cover it,
 * scored as `toil util owi similar` scores them, each with why, and offers to
 * ticket it: a sub-task under a match, or a new ticket, each a proposal card
 * that a person applies through toil's write gate. Attaching the work to a
 * match writes nothing. It never picks for the person, and below the
 * threshold it says there is no likely ticket rather than offering the
 * nearest miss. Kept apart from the chat so the chat can change around it.
 * A form for the form you were about to fill in.
 */

import { useMemo, useState } from 'react';
import { Button } from 'react-aria-components';
import { useData } from '../data.ts';
import { QUESTIONS } from '../guided-questions.ts';
import { usePlain } from '../plain-words.ts';
import { shortKey } from '../format.ts';
import { ticketProposals, unticketed } from '../model/ticketing.ts';
import { ItemLink } from './items.tsx';
import { ProposalCard } from './proposal.tsx';
import './ticket.css';

export function TicketBanner({ prompts }: { prompts: readonly string[] }) {
  const { agent, byId, dossier } = useData();
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const plain = usePlain();
  // A guided question is a question whatever its wording, so "Summarise this for my boss" is not work to ticket.
  const starters = useMemo(() => new Set([...agent.starters(dossier.name).map((s) => s.label), ...Object.values(QUESTIONS).map((q) => plain.text(q.text))]), [agent, dossier.name, plain.on]);
  const found = useMemo(() => unticketed(prompts, dossier.items, starters), [prompts, dossier.items, starters]);
  const proposals = useMemo(() => (found ? ticketProposals(found, byId, dossier.items, dossier.name) : []), [found, byId, dossier.items, dossier.name]);
  if (!found || hidden === found.prompt) return null;
  const top = found.matches[0] ? byId.get(found.matches[0].id) : undefined;
  return (
    <section className="ticket-banner" aria-labelledby="ticket-banner-title">
      <h3 id="ticket-banner-title">Not ticketed yet</h3>
      {found.matches.length ? (
        <>
          <p>This work names no ticket. These open items in {dossier.name} read closest to it:</p>
          <ul className="rows">
            {found.matches.map((m) => (
              <li key={m.id}>
                <ItemLink id={m.id} withTitle /> <span className="score">{Math.round(m.score * 100)}% alike</span> <span className="field">({m.why.summary.replace(/\.$/, '')})</span>
              </li>
            ))}
          </ul>
          <p className="note">
            Attach it to one by naming its key in your branch and commits{top ? ` (${shortKey(top)})` : ''}: nothing is written. Or ticket it, as a sub-task under a match or a new ticket.
          </p>
        </>
      ) : (
        <p>This work names no ticket, and no open item in {dossier.name} shares enough words with it to be one: there is no likely ticket. Ticket it as a new one.</p>
      )}
      <p className="note">Matched by shared words, as <code>toil util owi similar</code> scores them, not by meaning. Ticketing it is a proposal for you to apply; nothing is created here.</p>
      <div className="ticket-banner__actions">
        <Button className="btn btn--accent btn--small" aria-expanded={open} aria-controls="ticket-banner-proposals" onPress={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Ticket this'}
        </Button>
        <Button className="btn btn--small" onPress={() => setHidden(found.prompt)}>
          Not now
        </Button>
      </div>
      {open && (
        <div id="ticket-banner-proposals" className="ticket-banner__proposals">
          {proposals
            .filter((p) => !dismissed.has(p.id))
            .map((p) => (
              <ProposalCard key={p.id} proposal={p} onDismiss={() => setDismissed((d) => new Set(d).add(p.id))} />
            ))}
        </div>
      )}
    </section>
  );
}
