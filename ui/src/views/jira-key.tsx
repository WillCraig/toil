/**
 * The Jira project key, asked for in the setup wizard and in New Toil project:
 * one field and one hint, with what leaving it empty means in an (i)
 * (principle 11), and `useNamedJira`, which reads whether the Toil project
 * already names a Jira project, so a key is only asked for where it would be
 * saved. A reading that failed is unknown, and unknown is not none (principle
 * 12). Fields of this kind are traditionally filed in triplicate; this one is
 * filed once.
 */

import { useEffect, useState } from 'react';
import type { ConfigApi } from '../config.ts';
import { Help } from '../components/help.tsx';
import { TextField } from './settings/parts.tsx';
import { JIRA_KEY_HINT, JIRA_KEY_LABEL, namedJiraProject, type NamedJira } from './project-create.ts';

/** The field, in a `div` that carries `attr` so a test or a screenshot can find it. */
export function JiraKeyField({ value, onChange, attr }: { value: string; onChange: (v: string) => void; attr: string }) {
  return (
    <div className="jira-key" {...{ [attr]: '' }}>
      <TextField
        label={`${JIRA_KEY_LABEL} (optional)`}
        value={value}
        onChange={onChange}
        hint={
          <>
            {JIRA_KEY_HINT} <Help topic="jira-project-key" />
          </>
        }
      />
    </div>
  );
}

/** What an existing Toil project already says, in a quiet line. Nothing for one that names none: that one gets the field. */
export function NamedJiraLine({ named }: { named: NamedJira }) {
  if (named.kind === 'none') return null;
  return (
    <p className="note" data-jira-named="">
      {named.kind === 'key' ? `Reads Jira project ${named.key}.` : 'Reads a Jira project per repository.'}
    </p>
  );
}

/** What the Toil project names, once read; null while reading or when the read failed. */
export function useNamedJira(config: ConfigApi, toilProject: string | null): NamedJira | null {
  const [state, setState] = useState<{ project: string; named: NamedJira } | null>(null);
  useEffect(() => {
    if (!toilProject) return;
    let live = true;
    config.run('projects show', { toilProject }).then(
      (e) => live && e.ok && setState({ project: toilProject, named: namedJiraProject(e.data) }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [config, toilProject]);
  return toilProject && state?.project === toilProject ? state.named : null;
}
