/**
 * The workflow jobs where they apply (#532, part of #526): Review and Ship in
 * a pull request's menu, Diagram on a dossier's overview, each in the command
 * palette and at its own address (`#/dossier/<name>/job/<review|ship|diagram>`,
 * the target after `?target=`). A job is never a button on every row and never
 * a catalog: the pull request's one "Actions" menu holds it, and a connection
 * it lacks is named in place of the action vanishing (principle 11). Pressing
 * one asks the dossier's agent to follow the toil skill's page for the job,
 * in the Ask pane, where every toil call shows as it runs and every write
 * comes back as a card to review (src/model/jobs.ts, server/agents/jobs.ts).
 * Nothing here writes. A menu that lists only what is within reach.
 */

import { useEffect, useState } from 'react';
import { Button, Menu, MenuItem, MenuTrigger, Popover, Text } from 'react-aria-components';
import { sendCommand } from '../commands.ts';
import type { ConfigApi, ConnectionRow, ConnectionsData } from '../config.ts';
import { useData } from '../data.ts';
import { useChatScope } from './ask.tsx';
import { dossierHref } from '../format.ts';
import { FACE, availability, jobOf, jobPrompt, jobLabel, type Availability, type Face, type JobId } from '../model/jobs.ts';
import type { Change } from '../toil.ts';
import './jobs.css';

/** The address of a job: its own page, which says what it does and has the Run button. */
export const jobHref = (dossier: string, id: JobId, target?: string): string => `${dossierHref(dossier)}/job/${FACE[id].segment}${target ? `?target=${encodeURIComponent(target)}` : ''}`;

export interface ConnectionInfo {
  /** Set when the connections could not be read: every job is then offered, and the page says the check didn't happen. */
  problem?: string;
  /** Areas that have a connection. */
  areas: ReadonlySet<string>;
  /** A connection's area, by its name: a change's id starts with the connection that read it. */
  byName: ReadonlyMap<string, string>;
}

/** Reads the connections once, through toil's config commands; null while it reads, or where it can't be read (then every job is offered). */
export function useConnectionInfo(config: ConfigApi | undefined): ConnectionInfo | null {
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  useEffect(() => {
    if (!config) return;
    let live = true;
    config.run('connections list', {}).then(
      (e) => {
        if (!live) return;
        if (!e.ok) {
          setInfo({ areas: new Set(), byName: new Map(), problem: e.error.message });
          return;
        }
        const rows: ConnectionRow[] = (e.data as ConnectionsData).connections ?? [];
        setInfo({ areas: new Set(rows.map((r) => r.area)), byName: new Map(rows.map((r) => [r.name, r.area])) });
      },
      (e: unknown) => live && setInfo({ areas: new Set(), byName: new Map(), problem: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [config]);
  return info;
}

/** The code host of a pull request, as an area: its id starts with the name of the connection that read it. */
export const areaOfChange = (c: Change, info: ConnectionInfo | null): string => {
  const name = c.id.split(':')[0] ?? '';
  return info?.byName.get(name) ?? name;
};

/** Runs a job in the dossier's Ask pane. The pane is on every dossier page, and picks the request up. */
export function runJob(id: JobId, target: string): void {
  sendCommand({ kind: 'job', prompt: jobPrompt(id, target), label: jobLabel(id, target) });
}

/** The jobs a pull request can be given, and whether each can run. Ship is offered on a person's open pull request, not an agent's or a bot's. */
export function jobsFor(change: Change, info: ConnectionInfo | null): Array<{ id: JobId; face: Face; ready: Availability }> {
  const open = change.state === 'OPEN' || change.state === 'DRAFT';
  if (!open) return [];
  const ids: JobId[] = change.authorKind === 'HUMAN' ? ['review', 'ship'] : ['review'];
  const host = areaOfChange(change, info);
  return ids.flatMap((id) => {
    const job = jobOf(id);
    return job ? [{ id, face: FACE[id], ready: availability(job, info && !info.problem ? info.areas : null, host) }] : [];
  });
}

/**
 * One pull request's "Actions" menu: the jobs that apply to it, each opening
 * as a run in the Ask pane. A job it can't run stays in the list, dimmed, with
 * the connection that would enable it written under it.
 */
export function PullRequestActions({ change, info, plain }: { change: Change; info: ConnectionInfo | null; plain: boolean }) {
  const { dossier } = useData();
  const jobs = jobsFor(change, info);
  if (!jobs.length) return null;
  return (
    <MenuTrigger>
      <Button className="btn btn--small jobs-trigger" aria-label={`Actions for ${change.title}`} data-job-actions="">
        Actions
      </Button>
      <Popover className="popover menu-popover" placement="bottom end" offset={6}>
        <Menu
          className="menu jobs-menu"
          aria-label={`Actions for ${change.title}`}
          onAction={(key) => {
            const id = String(key) as JobId;
            const job = jobs.find((j) => j.id === id);
            if (job?.ready.ready) runJob(id, change.id);
            else window.location.hash = jobHref(dossier.name, id, change.id);
          }}
        >
          {jobs.map(({ id, face, ready }) => (
            <MenuItem key={id} id={id} className={`menu-item jobs-item${ready.ready ? '' : ' jobs-item--off'}`} textValue={face.label}>
              <Text slot="label">{plain ? face.plain : face.label}</Text>
              {!ready.ready && (
                <Text slot="description" className="note jobs-item__why">
                  {ready.why}
                </Text>
              )}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

/** The repositories a dossier's pull requests name, for Diagram's target. */
export const repositoriesOf = (prs: readonly Change[]): string[] => [...new Set(prs.map((c) => c.repo))].sort();

/** A link to Diagram on a dossier's overview: one line, since the page it opens says the rest. */
export function DiagramLink() {
  const { dossier } = useData();
  return (
    <p className="note jobs-link">
      <a href={jobHref(dossier.name, 'map-codebase')} data-job-link="map-codebase">
        Draw its architecture
      </a>
    </p>
  );
}

/**
 * A job's own page: what it does, what it needs and whether that is there,
 * the target it was handed or a choice of targets, and one Run button. The
 * writes it may propose and its steps' rules stay a step further in.
 */
export function JobPage({ id, target }: { id: JobId; target: string | null }) {
  const { dossier, config } = useData();
  const info = useConnectionInfo(config);
  const busy = useChatScope()?.busy ?? false;
  const job = jobOf(id);
  const face = FACE[id];
  const prs = dossier.pullRequests ?? [];
  const change = target ? prs.find((c) => c.id === target) : undefined;
  if (!job) {
    return (
      <p role="alert" className="failure">
        This Toil UI has no page for {face.label}. Upgrade Toil UI together with toil: the job pages ship in the toil skill.
      </p>
    );
  }
  const host = change ? areaOfChange(change, info) : undefined;
  const ready = availability(job, info && !info.problem ? info.areas : null, host);
  const targets = face.on === 'pull request' ? prs.filter((c) => c.state === 'OPEN' || c.state === 'DRAFT') : repositoriesOf(prs);
  const subject = target ?? '';
  // A pull request job runs only on an open pull request of this dossier, and Ship only on a person's.
  const runnable = face.on === 'repository' || (change !== undefined && (change.state === 'OPEN' || change.state === 'DRAFT') && (id !== 'ship' || change.authorKind === 'HUMAN'));
  const canRun = ready.ready && runnable && !busy;
  return (
    <div className="job-page" data-job={id}>
      <div className="view-head">
        <p className="eyebrow">
          <a href={dossierHref(dossier.name)}>{dossier.name}</a>
        </p>
        <h1 tabIndex={-1}>
          {face.label}
          {subject ? <span className="job-page__target"> {change ? change.title : subject}</span> : null}
        </h1>
        <p className="lede">
          {face.gist}
        </p>
      </div>

      {info?.problem && (
        <p role="note" className="note" data-job-unchecked="">
          The connections couldn&apos;t be read ({info.problem}), so whether this can run wasn&apos;t checked.
        </p>
      )}
      {subject && face.on === 'pull request' && !runnable && (
        <p role="note" className="failure" data-job-target="">
          {subject} isn&apos;t an open {id === 'ship' ? "pull request a person wrote in this dossier, so Ship can't answer its review" : 'pull request in this dossier'}. Choose another from the list.
        </p>
      )}
      {busy && (
        <p className="note">An answer is still running in the Ask pane. Run this when it finishes.</p>
      )}
      {!ready.ready && (
        <p role="note" className="failure" data-job-missing="">
          {ready.why?.replace(' Add one in Settings, Connections.', '')} <a href="#/settings/connections">Add one in Settings, Connections.</a>
        </p>
      )}
      {ready.absent.length > 0 && (
        <p className="note">
          It reads more with {ready.absent.join(', ')} connected: without {ready.absent.length === 1 ? 'it' : 'them'} those steps are reported as unchecked.
        </p>
      )}

      {face.on === 'repository' ? (
        <>
          <p>
            <Button className="btn btn--accent" isDisabled={!canRun} onPress={() => runJob(id, subject)} data-job-run="">
              Draw {subject || dossier.name}
            </Button>
          </p>
          {targets.length > 0 && (
            <p className="note">
              Or for one repository:{' '}
              {(targets as string[]).map((r, i) => (
                <span key={r}>
                  {i > 0 && ', '}
                  <a href={jobHref(dossier.name, id, r)}>{r}</a>
                </span>
              ))}
            </p>
          )}
        </>
      ) : subject ? (
        <p>
          <Button className="btn btn--accent" isDisabled={!canRun} onPress={() => runJob(id, subject)} data-job-run="">
            {face.label} {change ? change.title : subject}
          </Button>
        </p>
      ) : (
        <>
          <p className="note">Choose the pull request.</p>
          <ul className="rows">
            {(targets as Change[]).map((c) => (
              <li key={c.id}>
                <a href={jobHref(dossier.name, id, c.id)}>{c.title}</a> <span className="field">{c.repo}</span>
              </li>
            ))}
            {targets.length === 0 && <li className="note">No open pull requests for this dossier.</li>}
          </ul>
        </>
      )}

      {job.loop && (
        <p className="note" data-job-loop="">
          It works in rounds: at most {job.loop}. After round {job.loop} it stops and the pull request is marked needs-human, so a person takes over.
        </p>
      )}

      <details className="job-page__more">
        <summary>What it may ask you to approve</summary>
        <p className="note">
          Every write below comes back as a card with its toil command. Toil UI applies none of them: the connection&apos;s writes setting and your own press decide.
        </p>
        <ul className="plain">
          {job.writes.map((w) => (
            <li key={w}>
              <code>toil {w}</code>
            </li>
          ))}
        </ul>
        <p className="note">
          The steps are the toil skill&apos;s workflow page for this job, verified {job.verification}.
        </p>
      </details>
    </div>
  );
}
