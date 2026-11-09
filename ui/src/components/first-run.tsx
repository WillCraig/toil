/**
 * The first run (#416): in place of an empty Toil projects view, three steps, each
 * ticked off from toil's own state rather than from anything this page
 * remembers: a connection to a tracker (`toil connections list`, which counts
 * one made by env vars), a toil project (`toil projects list`), and a first sync
 * (the sync panel's status). Beside them, the command that restarts Toil UI on
 * the sample data. Each step's explanation is its (i), never a paragraph, and
 * the list goes once the first sync has finished. Onboarding, in three boxes,
 * none of them a training module.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Button } from 'react-aria-components';
import type { ConfigApi, ConnectionsData } from '../config.ts';
import type { HelpTopicId } from '../help.ts';
import { ADD_CONNECTION_HREF, CREATE_TOIL_PROJECT_HREF } from '../views/Settings.tsx';
import { SETUP_HREF } from '../views/Setup.tsx';
import { OWI_SOURCES } from '../../../src/core/owi/types.ts';
import { usePlain } from '../plain-words.ts';
import { Help } from './help.tsx';
import './first-run.css';

/** The areas a toil project reads work items from: a connection to one of these is a tracker. */
export const TRACKER_AREAS: ReadonlySet<string> = new Set(Object.entries(OWI_SOURCES).flatMap(([area, s]) => (s.items.length ? [area] : [])));

/** Whether the first run shows: no toil project yet, or, where Toil UI syncs, none synced yet. */
export function firstRunShows(toilProjects: number, synced: Record<string, unknown> | null, syncs: boolean): boolean {
  return toilProjects === 0 || (syncs && synced !== null && Object.keys(synced).length === 0);
}

type Trackers = { ok: true; names: string[] } | { ok: false; message: string } | null;

export interface FirstRunProps {
  toilProjects: number;
  /** Each toil project's last sync; empty until the first one finishes. */
  synced: Record<string, unknown> | null;
  config: ConfigApi | null;
  /** Starts a sync, where Toil UI keeps a cache; absent where it doesn't. */
  onSync?: (() => void) | undefined;
  /** The theme's line for an empty Toil projects view, shown when there are no toil projects. */
  lede?: string;
}

export function FirstRun({ toilProjects, synced, config, onSync, lede }: FirstRunProps) {
  const [trackers, setTrackers] = useState<Trackers>(null);
  useEffect(() => {
    if (!config) return;
    let live = true;
    config.run('connections list', {}).then(
      (e) => {
        if (!live) return;
        if (!e.ok) return setTrackers({ ok: false, message: e.error?.message ?? "Your connections didn't load." });
        const rows = (e.data as ConnectionsData).connections ?? [];
        setTrackers({ ok: true, names: rows.filter((c) => TRACKER_AREAS.has(c.area)).map((c) => c.name) });
      },
      (err: unknown) => live && setTrackers({ ok: false, message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [config]);

  const connected = trackers?.ok === true && trackers.names.length > 0;
  const syncedOnce = synced !== null && Object.keys(synced).length > 0;
  return (
    <section className="first-run" aria-labelledby="first-run" data-first-run="">
      <div className="first-run__head">
        <h2 id="first-run">Get started</h2>
        <Help topic="first-run" />
      </div>
      {lede && <p className="note">{lede}</p>}
      <p className="first-run__guided">
        <a className="btn btn--accent" href={SETUP_HREF} data-first-run-step="wizard">
          Set it up step by step
        </a>
      </p>
      <div className="first-run__body">
        <ol className="first-run__steps">
          <Step n={1} title="Connect a tracker" topic="connections" done={connected} detail={connected ? trackers.names.join(', ') : trackers?.ok === false ? `Your connections didn't load: ${trackers.message}` : null}>
            <a className="btn" href={ADD_CONNECTION_HREF} data-first-run-step="connect">
              Add a connection
            </a>
          </Step>
          <Step n={2} title={'Create a Toil project'} topic="toil-project-setup" done={toilProjects > 0} detail={null}>
            <a className="btn" href={CREATE_TOIL_PROJECT_HREF} data-first-run-step="toilProject">
              Create a Toil project
            </a>
          </Step>
          <Step n={3} title="Sync" topic="sync" done={syncedOnce} detail={onSync ? null : 'This Toil UI keeps no cache, so it has nothing to sync.'}>
            {onSync && (
              <Button className="btn" onPress={onSync} isDisabled={toilProjects === 0} data-first-run-step="sync">
                Sync now
              </Button>
            )}
          </Step>
        </ol>
      </div>
    </section>
  );
}

function Step({ n, title, precise, topic, done, detail, children }: { n: number; title: string; precise?: string; topic: HelpTopicId; done: boolean; detail: string | null; children?: ReactNode }) {
  const plain = usePlain();
  return (
    <li className={`first-run__step${done ? ' first-run__step--done' : ''}`} data-done={done || undefined}>
      <span className="first-run__mark" aria-hidden="true">
        {done ? '✓' : n}
      </span>
      <div className="first-run__what">
        <div className="first-run__head">
          <h3 className="first-run__title" title={precise ? plain.title(precise) : undefined}>
            {title}
          </h3>
          <Help topic={topic} />
        </div>
        <p className="first-run__state">
          <strong>{done ? 'Done' : 'Not done yet'}</strong>
          {detail && <span className="note">{detail}</span>}
        </p>
      </div>
      {!done && children && <div className="first-run__action">{children}</div>}
    </li>
  );
}
