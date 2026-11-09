/**
 * Settings, General: notifications and links to learning content (their own
 * components), then one closed "Advanced" disclosure (principle 11) holding
 * what few people need: wiping the cache Toil UI keeps, the file bound and the
 * time limit. Toil has no command that changes the last two, and Toil UI
 * doesn't edit toil's files, so they are shown read-only in plain words, with
 * no file path or variable name: the people who read this page don't set
 * either (the maintainer's decision, 2026-11-09). The file workspace bound is
 * the one a config file can relax, and toil says so on every envelope when it
 * is, which is how this page knows.
 */

import { useEffect, useRef, useState } from 'react';
import type { ConfigApi, SettingsInfo } from '../../config.ts';
import { Card } from '../../components/layout.tsx';
import { Help } from '../../components/help.tsx';
import { Loader } from '../../moments/Moments.tsx';
import { matches } from '../../shortcuts.ts';

const seconds = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);

/** What wiping the cache needs from the page that holds it (src/local.tsx), and when it last ran. */
export interface CacheControl {
  wipe: () => Promise<void>;
  /** Kept by the page, not by this screen, because a wipe makes every view read again and this one with them. */
  wipedAt: string | null;
}

/** The cache Toil UI keeps of what it read: wiping it asks first, with Cancel focused. */
export function WipeCache({ cache }: { cache: CacheControl }) {
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);
  const close = () => {
    setConfirming(false);
    trigger.current?.focus();
  };
  return (
    <div className="wipe-cache">
      <h3>Wipe the cache</h3>
      <p className="note">Deletes everything Toil UI saved on this computer from your tools. The dashboards are empty until the next sync, which reads everything again. Your tools are not touched.</p>
      <button type="button" className="btn" ref={trigger} onClick={() => setConfirming(true)} aria-expanded={confirming} aria-controls="wipe-confirm">
        Wipe the cache…
      </button>
      {confirming && (
        <div className="sync-confirm" id="wipe-confirm" role="group" aria-labelledby="wipe-confirm-text" onKeyDown={(e) => matches('wipeCancel', e) && close()}>
          <p id="wipe-confirm-text">Delete everything Toil UI synced to this computer? Your tools are not touched.</p>
          <div className="sync-actions">
            <button
              type="button"
              className="sync-danger"
              onClick={() =>
                cache.wipe().then(
                  () => setConfirming(false),
                  (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
                )
              }
            >
              Wipe it
            </button>
            <button type="button" ref={cancel} onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {problem && (
        <p role="alert" className="failure">
          The cache wasn't wiped: {problem}
        </p>
      )}
      {cache.wipedAt && !problem && (
        <p role="status" className="note">
          The cache is wiped. Nothing synced is left on this computer.
        </p>
      )}
    </div>
  );
}

function Limits({ config }: { config: ConfigApi }) {
  const [relaxed, setRelaxed] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    config.run('connections list', {}).then(
      (e) => {
        if (!e.ok) return setFailed(e.error.message);
        setRelaxed(e.meta.warnings?.find((w) => w.code === 'BOUND_RELAXED')?.message ?? null);
      },
      (e: unknown) => setFailed(e instanceof Error ? e.message : String(e)),
    );
    config.settings().then(setSettings, (e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
  }, [config]);

  if (failed) {
    return (
      <div role="alert" className="failure">
        <p>The limits didn't load: {failed}</p>
      </div>
    );
  }
  if (!settings) return <Loader size="panel" message="Reading the limits…" />;
  const t = settings.timeout;
  return (
    <>
      <Card as="section" className="panel" aria-labelledby="bounds">
        <h3 id="bounds">Bounds</h3>
        <dl className="fields">
          <dt>Files</dt>
          <dd>{relaxed ? "Relaxed: Toil may read and write files anywhere you can, except its own settings." : 'Held: Toil reads and writes files only inside your working folder.'}</dd>
        </dl>
        {relaxed && <p className="note">Toil says: {relaxed}</p>}
        <p className="note">
          Limits Toil keeps on itself. <Help topic="bounds" />
        </p>
      </Card>
      <Card as="section" className="panel" aria-labelledby="timeout">
        <h3 id="timeout">Time limit</h3>
        <dl className="fields">
          <dt>Each request stops after</dt>
          <dd>
            {seconds(t.effectiveMs)}
            {t.effectiveMs === t.defaultMs ? ", Toil's default" : ', set outside Toil UI'}
          </dd>
        </dl>
        <p className="note">A longer job, such as a scan or a report, gets its own limit. This one is set outside Toil UI, so it can't be changed here.</p>
      </Card>
    </>
  );
}

/** Closed by default: the page's own settings come first, and these are one step further in. */
export function Advanced({ config, cache }: { config: ConfigApi | null; cache?: CacheControl | undefined }) {
  if (!config && !cache) return null;
  return (
    <details className="advanced" data-advanced="">
      <summary>Advanced</summary>
      {cache && <WipeCache cache={cache} />}
      {config && <Limits config={config} />}
    </details>
  );
}
