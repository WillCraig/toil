/**
 * Shown when an install fails: many organizations host npm in Artifactory or
 * a like proxy, and the public registry is blocked or needs their address.
 * Says so, takes the registry's URL, and writes the one line `registry=<url>`
 * to the person's own npmrc on a press, showing the file and what it said
 * before. It asks for no password: signing in is `npm login`, in their terminal.
 */

import { useState } from 'react';
import { Button } from 'react-aria-components';
import type { AgentSettingsClient } from './server-client.ts';

export type RegistryClient = Partial<Pick<AgentSettingsClient, 'setRegistry'>>;

export function RegistryHelp({ client }: { client: RegistryClient | null }) {
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    if (!client?.setRegistry) return;
    try {
      const done = await client.setRegistry(url);
      setResult({ ok: true, text: `Saved registry=${done.registry} in ${done.file}${done.previous ? `, replacing ${done.previous}` : ''}. Press Try again.` });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <details className="install-registry" open data-registry-help="">
      <summary>Does your organization host npm in Artifactory?</summary>
      <p className="note">
        If npm says it can't reach registry.npmjs.org, or answers 401, 403 or 404, your organization probably wants npm to use its own registry. Paste its address below, and Toil UI adds one line, <code>registry=&lt;address&gt;</code>, to your user .npmrc and changes nothing else in it. It never asks for a password or token: if the registry needs a sign-in, run <code>npm login --registry &lt;address&gt;</code> in your own terminal, then press Try again.
      </p>
      <p className="note">In Artifactory, the address is on the repository's Set Me Up page, usually like https://artifactory.example.com/artifactory/api/npm/npm-virtual/.</p>
      {client?.setRegistry && (
        <div className="install-registry__row">
          <label>
            <span>Registry address</span>
            <input className="edit-field" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://artifactory.example.com/artifactory/api/npm/npm-virtual/" autoComplete="off" spellCheck={false} />
          </label>
          <Button className="btn" onPress={() => void save()} isDisabled={url.trim() === ''} data-registry-save="">
            Save to my .npmrc
          </Button>
        </div>
      )}
      {result && (
        <p role={result.ok ? 'status' : 'alert'} className={result.ok ? 'note' : 'failure'}>
          {result.text}
        </p>
      )}
    </details>
  );
}
