/**
 * The Diagram job's last step (#582): a card under its answer that offers to
 * keep the architecture it drew, and one press that does. The model on the
 * card is the one the agent's last passing `projects diagram check` was
 * given, lifted by the server (server/agents/tools.ts), so Save keeps exactly
 * what toil checked and nothing the agent retyped afterwards. The press runs
 * `projects diagram save` on the settings pages' path (`POST api/config`):
 * toil's own storage, in the person's folder, a local write that needs no
 * `--allow-write`, and the person's own press, since an agent never saves
 * what a person has not looked at (principle 2).
 *
 * Honest about every state (principle 4): where saving is off (the sample) it
 * says so and shows no button that would fail; where a diagram is already
 * kept the button says Replace, so the press is informed; a refusal shows on
 * the card with toil's message and fix; after a save it says which revision
 * and links the picture. The saved state is remembered for the draft itself,
 * so closing and opening the pane does not offer the same press twice. One press,
 * which is two fewer than the sign-off sheet it replaces.
 */

import { NavButton } from './nav-button.tsx';
import { useState } from 'react';
import { Button } from 'react-aria-components';
import type { AnswerPart, DraftDiagram } from '../agent.ts';
import { useData } from '../data.ts';
import { DIAGRAM_SAVED, useStoredDiagram } from '../diagram-saved.ts';
import { diagramHref } from '../format.ts';
import { countsText } from '../model/diagram.ts';
import { Scroller } from './layout.tsx';
import './diagram-card.css';

/**
 * A fenced block the agent pasted into a job's answer (#582), folded and closed: the source is there for anyone who wants it, and
 * never a paragraph of run-together text. Mermaid is named as diagram source, anything else as code.
 */
export function FoldedCode({ part }: { part: AnswerPart }) {
  const what = part.fence === 'mermaid' ? 'Diagram source' : 'Code the agent pasted';
  return (
    <details className="ask-code" data-ask-code="">
      <summary>
        {what}
        {part.fence && part.fence !== 'mermaid' ? ` (${part.fence})` : ''}
      </summary>
      <Scroller label={what}>
        <pre>
          <code>{part.text}</code>
        </pre>
      </Scroller>
    </details>
  );
}

/** What each draft was saved as, by the draft itself, so a card that is mounted again still says so. */
const SAVED = new WeakMap<DraftDiagram, number>();

export function DiagramCard({ draft }: { draft: DraftDiagram }) {
  const { toilProject, config, preview } = useData();
  const stored = useStoredDiagram();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [revision, setRevision] = useState<number | null>(SAVED.get(draft) ?? null);
  const kept = stored.known && stored.kept;
  // Saving is off where Toil UI changes nothing: the sample, whether it is the site's preview (its config path says so) or `toil-ui --sample` (whose server refuses a change), and where there is no config path at all.
  const off = !config ? 'This Toil UI cannot change toil’s files.' : config.disabled ?? (preview ? 'Sample data: nothing is saved here.' : null);

  const save = async () => {
    if (!config) return;
    setSaving(true);
    setProblem(null);
    try {
      const env = await config.run('projects diagram save', {
        toilProject: toilProject.name,
        text: draft.text,
        ...(draft.notMapped?.length ? { notMapped: draft.notMapped } : {}),
        // Only over a diagram the card knows is there, which is what the button said; toil refuses a surprise one by name.
        ...(kept ? { replace: true } : {}),
      });
      if (!env.ok) {
        setProblem(`${env.error.message}${env.error.fix ? ` ${env.error.fix}` : ''}`);
        return;
      }
      const saved = (env.data as { revision?: unknown } | null)?.revision;
      const n = typeof saved === 'number' ? saved : 0;
      SAVED.set(draft, n);
      setRevision(n);
      window.dispatchEvent(new Event(DIAGRAM_SAVED));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="diagram-card" aria-label="Save the architecture diagram" data-diagram-card="">
      <h3>{draft.title ?? 'Architecture diagram'}</h3>
      <p data-diagram-card-counts="">{countsText(draft.counts)}</p>
      {draft.views.length > 0 && (
        <p className="note">
          {draft.views.length === 1 ? 'View' : 'Views'}: {draft.views.map((v) => v.title).join(', ')}
        </p>
      )}
      {revision !== null ? (
        <p role="status" data-diagram-saved="">
          Saved{revision > 0 ? `, revision ${revision}` : ''}.{' '}
          <NavButton href={diagramHref(toilProject.name)} size="sm">
            Open the diagram
          </NavButton>
        </p>
      ) : off ? (
        <p className="note" data-diagram-off="">
          {off}{' '}
          <NavButton href={diagramHref(toilProject.name)} size="sm">
            {preview ? 'Open the sample diagram' : 'Open the diagram'}
          </NavButton>
        </p>
      ) : (
        <p className="diagram-card__act">
          <Button className="btn btn--accent" onPress={save} isDisabled={saving} data-diagram-save="">
            {saving ? 'Saving' : kept ? 'Replace the saved diagram' : 'Save diagram'}
          </Button>
          {stored.known && stored.kept && <span className="note">Replaces revision {stored.revision}.</span>}
        </p>
      )}
      {problem && (
        <p role="alert" className="failure" data-diagram-problem="">
          {problem}
        </p>
      )}
    </section>
  );
}
