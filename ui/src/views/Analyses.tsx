/**
 * The Analyses tab (#394, #395): every Analyze kept for the dossier, newest
 * first, each with when it was made, the adapter and model that wrote it,
 * its one-line recommendation, and what changed since the one before (new
 * blockers, cleared ones, points moved, items newly cited or dropped),
 * worked out by code from a snapshot of the dossier each one kept. Any of
 * them opens again at its own address, laid out top-down like the chat's.
 * They are kept by the server in its cache, so they outlast a reload and a
 * restart, and `toil-ui wipe` takes them with the rest. Minutes of the
 * meeting, filed, with a diff.
 */

import { useEffect, useState } from 'react';
import { Button } from 'react-aria-components';
import { ANALYZE } from '../agent.ts';
import { AnalysisBody, ChangesDetail, changesLine, whoText } from '../components/analysis.tsx';
import { Cited } from '../components/items.tsx';
import { Card } from '../components/layout.tsx';
import { Help } from '../components/help.tsx';
import { useChatScope } from '../components/ask.tsx';
import { ProposalCard } from '../components/proposal.tsx';
import { UsageFooter } from '../components/usage.tsx';
import { useData } from '../data.ts';
import { analysesHref, analysisHref, dateTime, dossierHref } from '../format.ts';
import { Empty, EmptyButton, EmptyLink } from '../components/empty.tsx';
import { unchanged, type AnalysisSummary, type AnalysisView } from '../model/analysis.ts';
import { Loader } from '../moments/Moments.tsx';
import { useTerm } from '../skins.tsx';
import { usePlain } from '../plain-words.ts';

export function Analyses({ open }: { open?: string } = {}) {
  return <div className="tab-panels">{open ? <OpenAnalysis id={open} /> : <AnalysisList />}</div>;
}

function AnalysisList() {
  const chat = useChatScope();
  const running = chat?.turns.find((t) => t.analyze && !t.done);
  const history = chat?.history;
  const list = history?.list ?? null;
  const term = useTerm();
  const plain = usePlain();
  const { dossier } = useData();
  return (
    <Card as="section" className="panel analyses" aria-labelledby="analyses-title">
      <h2 id="analyses-title" title={plain.title('Analyses')}>
        {term('analyses', plain.pw('Analyses', 'Past briefings'))}
      </h2>
      <p className="note">
        {plain.pw('Every Analyze kept for', 'Every briefing kept for')} {dossier.name}, newest first. <Help topic="analyses" />
      </p>
      {/* With none kept yet, Analyze now is the empty list's own action (#417), so it isn't drawn twice. */}
      {chat && (list === null || list.length > 0 || running) && (
        <p className="analyses__actions">
          <Button className="btn" onPress={() => void chat.ask(ANALYZE, plain.pw('Analyze', 'Get a briefing'))} isDisabled={chat.busy} data-analyze-tab="">
            {plain.pw('Analyze now', 'Get a briefing now')}
          </Button>
          {running && <span className="note"> An analysis is being written now; it joins the list when its answer is whole.</span>}
        </p>
      )}
      {history?.error && <p className="failure">{history.error}</p>}
      {list === null ? (
        !history?.error && <Loader size="panel" message="Reading the briefings…" />
      ) : list.length ? (
        <ol className="analyses__list" aria-label="Analyses, newest first">
          {list.map((a) => (
            <AnalysisEntry key={a.id} a={a} />
          ))}
        </ol>
      ) : running ? null : (
        <Empty
          message={plain.pw('No analysis kept for this dossier yet.', 'No briefing kept for this Toil project yet.')}
          action={
            chat ? (
              <EmptyButton onPress={() => void chat.ask(ANALYZE, plain.pw('Analyze', 'Get a briefing'))} disabled={chat.busy}>
                {plain.pw('Analyze now', 'Get a briefing now')}
              </EmptyButton>
            ) : (
              <EmptyLink href={dossierHref(dossier.name)}>Open the Overview</EmptyLink>
            )
          }
        />
      )}
    </Card>
  );
}

function AnalysisEntry({ a }: { a: AnalysisSummary }) {
  const { dossier } = useData();
  return (
    <li className="analysis" data-analysis={a.id}>
      <p className="note analysis__meta">
        <time dateTime={a.at}>{dateTime(a.at)}</time>, by {whoText(a)}. Cites {a.citations.length} {a.citations.length === 1 ? 'item' : 'items'}
        {a.unverified ? `, ${a.unverified} its tools never returned` : ''}.
      </p>
      <p className="analysis__rec">{a.recommendation ? <Cited text={a.recommendation} chips /> : <span className="note">This answer had no Recommendation line; open it to read it as it came.</span>}</p>
      {a.changes.previous && !unchanged(a.changes) ? (
        <details className="analysis__changes">
          <summary>{changesLine(a.changes)}</summary>
          <ChangesDetail changes={a.changes} />
        </details>
      ) : (
        <p className="note analysis__changes">{changesLine(a.changes)}</p>
      )}
      <p className="analysis__open">
        <a href={analysisHref(dossier.name, a.id)}>
          Open<span className="sr-only"> the analysis of {dateTime(a.at)}</span>
        </a>
      </p>
    </li>
  );
}

function OpenAnalysis({ id }: { id: string }) {
  const { analyses, dossier } = useData();
  const [view, setView] = useState<AnalysisView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    setView(undefined);
    if (!analyses) return void setView(null);
    analyses.get(dossier.name, id).then(
      (v) => live && setView(v),
      (e: unknown) => live && setError(`The analysis didn't load: ${e instanceof Error ? e.message : String(e)}`),
    );
    return () => {
      live = false;
    };
  }, [analyses, dossier.name, id]);
  const back = (
    <p className="analysis-open__back">
      <a href={analysesHref(dossier.name)}>All analyses</a>
    </p>
  );
  if (error || view === null) {
    return (
      <Card as="section" className="panel analyses" aria-labelledby="analysis-title">
        {back}
        <h2 id="analysis-title">Analysis not found</h2>
        <p className={error ? 'failure' : undefined}>{error ?? `${dossier.name} has no analysis by that id: it may have passed the cache's retention period, or the cache was wiped.`}</p>
      </Card>
    );
  }
  if (!view) return <p className="note">Reading the analysis…</p>;
  const { record: r, changes } = view;
  return (
    <Card as="section" className="panel analyses analysis-open" aria-labelledby="analysis-title">
      {back}
      <h2 id="analysis-title">Analysis of {dateTime(r.at)}</h2>
      <p className="note">
        Asked {dateTime(r.startedAt)}, answered by {whoText(r)}. Cites {r.citations.length} {r.citations.length === 1 ? 'item' : 'items'}.
      </p>
      {r.warnings.length > 0 && (
        <div className="answer-checks" aria-label="Checks on this answer">
          {r.warnings.map((w, i) => (
            <p key={i} className="failure">
              {w}
            </p>
          ))}
        </div>
      )}
      <AnalysisBody parts={r.parts} briefing={r.briefing} level={3} />
      {r.proposals.length > 0 && (
        <section aria-labelledby="analysis-proposals">
          <h3 id="analysis-proposals">Suggested changes</h3>
          {r.proposals
            .filter((p) => !dismissed.has(p.id))
            .map((p) => (
              <ProposalCard key={p.id} proposal={p} onDismiss={() => setDismissed((d) => new Set(d).add(p.id))} />
            ))}
        </section>
      )}
      <section aria-labelledby="analysis-changes">
        <h3 id="analysis-changes">What changed since the one before</h3>
        <ChangesDetail changes={changes} />
      </section>
      {r.usage && <UsageFooter usage={r.usage} />}
    </Card>
  );
}
