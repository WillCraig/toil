/**
 * Where Toil UI opens (#342): every dossier toil can see (`toil dossiers
 * list`), each as a card that previews its work: the sprint with the days left
 * and a small burn-up, what is in progress, blocked and waiting on review, the
 * last sync and what changed since this browser last looked, who is on it, and
 * its sources. Each card reads the same data its dashboard does (src/load.ts),
 * which the local app answers from the cache, so opening the page asks no
 * tracker anything, and a dashboard opened from here is already loaded. The
 * dossier opened most recently, or else the one with the most in motion,
 * leads as a wider card. Name and description are edited in place, through
 * `toil dossiers describe`. A dossier is one body of work, so this is the list
 * of things someone might be asked about in a meeting, which is a shorter
 * list than the org chart.
 */

import { Card, CardGrid } from '../components/layout.tsx';
import { CountStrip, Editable, MiniBurnup, SourceBadges, SprintLine, type Described } from '../components/dossier-head.tsx';
import { Sources } from '../components/panel.tsx';
import { Help } from '../components/help.tsx';
import { FirstRun, firstRunShows } from '../components/first-run.tsx';
import type { ConfigApi } from '../config.ts';
import { dateTime, dossierHref } from '../format.ts';
import type { DossierData, DossierSummary } from '../load.ts';
import { lastLooked, lastOpened } from '../looked.ts';
import { previewOf, type DossierPreview } from '../model/preview.ts';
import { useSkins, useWords } from '../skins.tsx';
import { usePlain } from '../plain-words.ts';
import type { Call } from '../toil.ts';

/** A dossier's last sync, as the sync panel has it. */
export interface SyncedAt {
  at: string;
  status: 'ok' | 'partial' | 'failed';
}

type Loaded = { ok: true; value: DossierData } | { ok: false; message: string };

export interface DossiersProps {
  dossiers: DossierSummary[];
  calls: Call[];
  /** Each dossier's data as its dashboard loads it, filled in as each one arrives. */
  loaded: Record<string, Loaded | undefined>;
  now: string;
  /** Each dossier's last sync, from the sync panel; null where there is no sync (the preview). */
  synced: Record<string, SyncedAt> | null;
  config: ConfigApi | null;
  onDescribed: (d: Described) => void;
  /** Starts a sync, where Toil UI keeps a cache (#416): the first-run checklist's last step. */
  onSync?: (() => void) | undefined;
}

/** The card that leads: the only one, else the dossier opened most recently here, else the one with the most in motion. */
export function leadOf(names: string[], previews: Map<string, DossierPreview>, settled: boolean): string | null {
  if (names.length === 1) return names[0]!;
  const opened = lastOpened(names);
  if (opened) return opened;
  // Chosen once every card has its figures, so the lead doesn't change places as they arrive.
  if (!settled) return null;
  const ranked = names.filter((n) => previews.has(n)).sort((a, b) => previews.get(b)!.motion - previews.get(a)!.motion);
  return ranked[0] && previews.get(ranked[0])!.motion > 0 ? ranked[0] : null;
}

export function Dossiers({ dossiers, calls, loaded, now, synced, config, onDescribed, onSync }: DossiersProps) {
  const words = useWords();
  const plain = usePlain();
  const previews = new Map<string, DossierPreview>();
  for (const d of dossiers) {
    const l = loaded[d.name];
    if (l?.ok) previews.set(d.name, previewOf(l.value, now, lastLooked(d.name)));
  }
  const lead = leadOf(dossiers.map((d) => d.name), previews, dossiers.every((d) => loaded[d.name] !== undefined));
  const ordered = lead ? [...dossiers.filter((d) => d.name === lead), ...dossiers.filter((d) => d.name !== lead)] : dossiers;
  return (
    <>
      <div className="view-head">
        <h1 tabIndex={-1} title={plain.title('Dossiers')}>
          {plain.pw('Dossiers', 'Toil projects')}
        </h1>
        <p className="lede">
          {words('dossiers.lede')} <Help topic="dossiers" />
        </p>
      </div>
      {/* The first run (#416), in place of the empty state, whose one line it keeps above the steps that fill the page. */}
      {firstRunShows(dossiers.length, synced, Boolean(onSync)) && <FirstRun dossiers={dossiers.length} synced={synced} config={config} onSync={onSync} {...(dossiers.length === 0 ? { lede: words('empty.dossiers') } : {})} />}
      {dossiers.length === 0 ? null : (
        <CardGrid className="dossiers" min="sm">
          {ordered.map((d) => (
            <li key={d.name} className={d.name === lead ? 'dossiers__lead' : undefined}>
              <DossierCard summary={d} loaded={loaded[d.name]} preview={previews.get(d.name) ?? null} synced={synced ? (synced[d.name] ?? null) : undefined} lead={d.name === lead} config={config} onDescribed={onDescribed} />
            </li>
          ))}
        </CardGrid>
      )}
      <Sources calls={calls} />
    </>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The most avatars a card shows before it counts the rest. */
export const MAX_AVATARS = 6;

function DossierCard({
  summary: d,
  loaded,
  preview,
  synced,
  lead,
  config,
  onDescribed,
}: {
  summary: DossierSummary;
  loaded: Loaded | undefined;
  preview: DossierPreview | null;
  /** undefined: nothing syncs here; null: never synced. */
  synced: SyncedAt | null | undefined;
  lead: boolean;
  config: ConfigApi | null;
  onDescribed: (d: Described) => void;
}) {
  const { Avatar } = useSkins();
  const plain = usePlain();
  const heading = `dossier-${d.name}`;
  const shown = preview?.people.slice(0, MAX_AVATARS) ?? [];
  const more = (preview?.people.length ?? 0) - shown.length;
  return (
    <Card className={`dossier-card${lead ? ' dossier-card--lead' : ''}`} aria-labelledby={heading}>
      <div className="dossier-card__head">
        <h2 id={heading}>
          <Editable field="name" dossier={d.name} value={d.name} config={config} onSaved={onDescribed}>
            <a href={dossierHref(d.name)}>{d.name}</a>
          </Editable>
        </h2>
        <Editable field="description" dossier={d.name} value={d.description} config={config} onSaved={onDescribed}>
          {d.description ? <span className="dossier-card__desc">{d.description}</span> : <span className="note">No description</span>}
        </Editable>
      </div>
      <div className="dossier-card__body">
        {!loaded ? (
          <p className="note" role="status">
            {plain.pw('Reading what the last sync stored…', 'Reading the latest update…')}
          </p>
        ) : !loaded.ok ? (
          <p className="note">Its work couldn't be read: {loaded.message}</p>
        ) : preview ? (
          <>
            {preview.sprint ? (
              <div className="dossier-card__sprint">
                <SprintLine sprint={preview.sprint} />
                <MiniBurnup sprint={preview.sprint} />
              </div>
            ) : (
              <p className="note">No sprint running.</p>
            )}
            <CountStrip preview={preview} sprint={false} />
            {shown.length > 0 && (
              <ul className="avatars" aria-label={`People: ${preview.people.map((p) => p.name).join(', ')}`}>
                {shown.map((p) => (
                  <li key={p.key}>
                    <Avatar person={{ id: p.key, name: p.name, email: null }} labelled />
                  </li>
                ))}
                {more > 0 && (
                  <li className="avatars__more" aria-hidden="true">
                    +{more}
                  </li>
                )}
              </ul>
            )}
          </>
        ) : null}
      </div>
      <div className="dossier-card__foot">
        <SourceBadges sources={d.sources} dossier={d.name} />
        <p className="note dossier-card__when">
          {synced === undefined ? 'Sample data.' : synced === null ? `Not ${plain.pw('synced', 'updated')} yet.` : `${plain.pw('Synced', 'Updated')} ${dateTime(synced.at)}${synced.status === 'ok' ? '' : synced.status === 'partial' ? ', some sources failed' : ', and it failed'}.`}
          {preview && preview.changedSince !== null && <> {preview.changedSince ? `${plural(preview.changedSince, 'change')} since you last looked.` : 'Nothing changed since you last looked.'}</>}
        </p>
      </div>
    </Card>
  );
}
