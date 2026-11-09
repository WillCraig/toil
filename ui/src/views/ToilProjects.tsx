/**
 * Where Toil UI opens (#342): every toil project toil can see (`toil projects
 * list`), each as a card that previews its work: the sprint with the days left
 * and a small burn-up, what is in progress, blocked and waiting on review, the
 * last sync and what changed since this browser last looked, who is on it, and
 * its sources. Each card reads the same data its dashboard does (src/load.ts),
 * which the local app answers from the cache, so opening the page asks no
 * tracker anything, and a dashboard opened from here is already loaded. The
 * toil project opened most recently, or else the one with the most in motion,
 * leads as a wider card. Name and description are edited in place, through
 * `toil projects describe`. A toil project is one body of work, so this is the list
 * of things someone might be asked about in a meeting, which is a shorter
 * list than the org chart.
 */

import { Card, CardGrid } from '../components/layout.tsx';
import { CountStrip, EditDetails, MiniBurnup, SourceBadges, SprintLine, Trend, type Described } from '../components/toil-project-head.tsx';
import { useState } from 'react';
import { ArchiveNoticeLine, ArchivedDisclosure, type ArchiveNotice } from '../components/archive.tsx';
import { CardMenu, type CardMenuItem } from '../components/card-menu.tsx';
import { applyOrder, moveBy, readOrder, writeOrder } from '../project-order.ts';
import { Sources } from '../components/panel.tsx';
import { Help } from '../components/help.tsx';
import { FirstRun, firstRunShows } from '../components/first-run.tsx';
import type { ConfigApi } from '../config.ts';
import { dateTime, toilProjectEditHref, toilProjectHref } from '../format.ts';
import type { ArchivedToilProject, ToilProjectData, ToilProjectSummary } from '../load.ts';
import { lastLooked, lastOpened } from '../looked.ts';
import { previewOf, type ToilProjectPreview } from '../model/preview.ts';
import { useSkins, useWords } from '../skins.tsx';
import { usePlain } from '../plain-words.ts';
import type { Call } from '../toil.ts';

/** A toil project's last sync, as the sync panel has it. */
export interface SyncedAt {
  at: string;
  status: 'ok' | 'partial' | 'failed';
}

type Loaded = { ok: true; value: ToilProjectData } | { ok: false; message: string };

export interface ToilProjectsProps {
  toilProjects: ToilProjectSummary[];
  calls: Call[];
  /** Each toil project's data as its dashboard loads it, filled in as each one arrives. */
  loaded: Record<string, Loaded | undefined>;
  now: string;
  /** Each toil project's last sync, from the sync panel; null where there is no sync (the preview). */
  synced: Record<string, SyncedAt> | null;
  config: ConfigApi | null;
  onDescribed: (d: Described) => void;
  /** Starts a sync, where Toil UI keeps a cache (#416): the first-run checklist's last step. */
  onSync?: (() => void) | undefined;
  /** The archived Toil projects (#561); null when they could not be read, which draws nothing. */
  archived?: ArchivedToilProject[] | null;
  /** Archives or unarchives one, where the page may change things; absent in the preview. */
  onArchive?: ((name: string, archive: boolean) => void) | undefined;
  /** What the last archive did, with the undo beside it. */
  notice?: ArchiveNotice | null;
  onDismissNotice?: (() => void) | undefined;
}

/** The card that leads: the only one, else the toil project opened most recently here, else the one with the most in motion. */
export function leadOf(names: string[], previews: Map<string, ToilProjectPreview>, settled: boolean): string | null {
  if (names.length === 1) return names[0]!;
  const opened = lastOpened(names);
  if (opened) return opened;
  // Chosen once every card has its figures, so the lead doesn't change places as they arrive.
  if (!settled) return null;
  const ranked = names.filter((n) => previews.has(n)).sort((a, b) => previews.get(b)!.motion - previews.get(a)!.motion);
  return ranked[0] && previews.get(ranked[0])!.motion > 0 ? ranked[0] : null;
}

export function ToilProjects({ toilProjects, calls, loaded, now, synced, config, onDescribed, onSync, archived = null, onArchive, notice = null, onDismissNotice }: ToilProjectsProps) {
  const words = useWords();
  const previews = new Map<string, ToilProjectPreview>();
  for (const d of toilProjects) {
    const l = loaded[d.name];
    if (l?.ok) previews.set(d.name, previewOf(l.value, now, lastLooked(d.name)));
  }
  // The person's own order wins once they have moved a card; until then the one opened last, or with the most in motion, leads.
  const [saved, setSaved] = useState(readOrder);
  const lead = saved.length === 0 ? leadOf(toilProjects.map((d) => d.name), previews, toilProjects.every((d) => loaded[d.name] !== undefined)) : null;
  const byLead = lead ? [...toilProjects.filter((d) => d.name === lead), ...toilProjects.filter((d) => d.name !== lead)] : toilProjects;
  const names = applyOrder(byLead.map((d) => d.name), saved);
  const ordered = names.map((n) => toilProjects.find((d) => d.name === n)!);
  const move = (name: string, by: number) => {
    const next = moveBy(names, name, by);
    setSaved(next);
    writeOrder(next);
  };
  return (
    <>
      <div className="view-head">
        <div className="view-head__row">
          <h1 tabIndex={-1}>
            Toil projects
          </h1>
          {/* Into the short wizard that creates a Toil project (#561). */}
          <a className="btn btn--accent" href="#/new-project" data-new-toil-project="">
            New Toil project
          </a>
        </div>
        <p className="lede">
          {words('toilProjects.lede')} <Help topic="toilProjects" />
        </p>
      </div>
      {/* The first run (#416), in place of the empty state, whose one line it keeps above the steps that fill the page. */}
      {firstRunShows(toilProjects.length, synced, Boolean(onSync)) && <FirstRun toilProjects={toilProjects.length} synced={synced} config={config} onSync={onSync} {...(toilProjects.length === 0 ? { lede: words('empty.toilProjects') } : {})} />}
      {notice && onArchive && <ArchiveNoticeLine notice={notice} onUndo={onArchive} onDismiss={() => onDismissNotice?.()} />}
      {toilProjects.length === 0 ? null : (
        <CardGrid className="toil-projects" min="lg">
          {ordered.map((d, i) => (
            <li key={d.name}>
              <ToilProjectCard summary={d} loaded={loaded[d.name]} preview={previews.get(d.name) ?? null} synced={synced ? (synced[d.name] ?? null) : undefined} lead={d.name === lead} config={config} onDescribed={onDescribed} place={{ index: i, count: ordered.length, move: (by) => move(d.name, by) }} {...(onArchive ? { onArchive: (name: string) => onArchive(name, true) } : {})} />
            </li>
          ))}
        </CardGrid>
      )}
      <ArchivedDisclosure archived={archived} onUnarchive={onArchive ? (name) => onArchive(name, false) : null} />
      <Sources calls={calls} />
    </>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The most avatars a card shows before it counts the rest. */
export const MAX_AVATARS = 6;

function ToilProjectCard({
  summary: d,
  loaded,
  preview,
  synced,
  lead,
  config,
  onDescribed,
  onArchive,
  place,
}: {
  place: { index: number; count: number; move: (by: number) => void };
  summary: ToilProjectSummary;
  loaded: Loaded | undefined;
  preview: ToilProjectPreview | null;
  /** undefined: nothing syncs here; null: never synced. */
  synced: SyncedAt | null | undefined;
  lead: boolean;
  config: ConfigApi | null;
  onDescribed: (d: Described) => void;
  onArchive?: ((name: string) => void) | undefined;
}) {
  const { Avatar } = useSkins();
  const plain = usePlain();
  const words = useWords();
  const heading = `toil-project-${d.name}`;
  /** Has anything been read for this Toil project? Never synced (null) means its figures are unknown, not zero. Sample data (undefined) counts as read. */
  const read = synced !== null;
  const shown = preview?.people.slice(0, MAX_AVATARS) ?? [];
  const more = (preview?.people.length ?? 0) - shown.length;
  const [editing, setEditing] = useState(false);
  const mayEdit = Boolean(config && !config.disabled);
  const items: CardMenuItem[] = [
    ...(mayEdit
      ? [
          { id: 'edit', label: 'Edit' },
          { id: 'edit-sources', label: 'Edit sources', href: toilProjectEditHref(d.name, 'sources') },
        ]
      : []),
    ...(place.count > 1 ? [{ id: 'earlier', label: 'Move earlier', disabled: place.index === 0, separated: mayEdit }, { id: 'later', label: 'Move later', disabled: place.index === place.count - 1 }] : []),
    ...(onArchive ? [{ id: 'archive', label: 'Archive', separated: true }] : []),
  ];
  const act = (id: string) => {
    if (id === 'edit') setEditing(true);
    else if (id === 'earlier') place.move(-1);
    else if (id === 'later') place.move(1);
    else if (id === 'archive') onArchive?.(d.name);
  };
  return (
    <Card className={`toil-project-card${lead ? ' toil-project-card--lead' : ''}`} aria-labelledby={heading}>
      <CardMenu name={d.name} items={items} onAction={act} />
      <div className="toil-project-card__head">
        {editing ? (
          <>
            <h2 id={heading} className="sr-only">
              {d.name}
            </h2>
            <EditDetails toilProject={d.name} name={d.name} description={d.description} config={config} onSaved={onDescribed} onClose={() => setEditing(false)} />
          </>
        ) : (
          <>
            <h2 id={heading}>
              <a href={toilProjectHref(d.name)}>{d.name}</a>
            </h2>
            {d.description ? <span className="toil-project-card__desc">{d.description}</span> : <span className="note">No description</span>}
          </>
        )}
      </div>
      <div className="toil-project-card__body">
        {!loaded ? (
          <p className="note toil-project-card__sprint" role="status">
            {words('loading.card')}
          </p>
        ) : !loaded.ok ? (
          <p className="note toil-project-card__sprint">Its work couldn't be read: {loaded.message}</p>
        ) : preview ? (
          <>
            {preview.sprint ? (
              <div className="toil-project-card__sprint">
                <SprintLine sprint={preview.sprint} />
                <MiniBurnup sprint={preview.sprint} />
              </div>
            ) : read ? (
              <p className="note toil-project-card__sprint">No sprint running.</p>
            ) : null}
            <CountStrip preview={preview} sprint={false} read={read} />
            {read && (
              <ul className="trends" aria-label="The past 7 days">
                <Trend label="Issues closed" days={preview.trend.closed} />
                <Trend label="Pull requests merged" days={preview.trend.merged} />
              </ul>
            )}
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
      <div className="toil-project-card__foot">
        <SourceBadges sources={d.sources} toilProject={d.name} bare />
        <p className="note toil-project-card__when">
          {synced === undefined ? 'Sample data.' : synced === null ? `Not ${plain.pw('synced', 'updated')} yet.` : `${plain.pw('Synced', 'Updated')} ${dateTime(synced.at)}${synced.status === 'ok' ? '' : synced.status === 'partial' ? ', some sources failed' : ', and it failed'}.`}
          {preview && read && preview.changedSince !== null && <> {preview.changedSince ? `${plural(preview.changedSince, 'change')} since you last looked.` : words('note.unchanged')}</>}
        </p>
      </div>
    </Card>
  );
}
