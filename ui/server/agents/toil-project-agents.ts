/**
 * The agent last used for each toil project's Analyze (#494). Toil UI's own state,
 * so it lives in its data folder (`~/.toil-ui/toil-project-agents.json`) beside the
 * global default in `agent.json`, never in a toil project file and never in
 * the browser: a second browser, or a restart, sees the same memory. The file
 * holds an adapter's name per toil project name and nothing else, so it has no
 * room for a key. A stale entry (a toil project renamed or removed behind Toil
 * UI's back) is only ever a name nobody asks for. A seating chart for
 * software that was told to sit wherever it sat last time.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { AdapterName } from './runtime.ts';

const NAMES: readonly string[] = ['claude', 'copilot', 'codex'];
/** toil's names for a toil project (the same rule the server checks a rename with). */
const TOIL_PROJECT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAX_TOIL_PROJECT = 200;

export const toilProjectAgentsFile = (dataDir: string) => nodePath.join(dataDir, 'toil-project-agents.json');

export class ToilProjectAgents {
  private agents: Map<string, AdapterName>;

  constructor(private readonly dataDir: string) {
    this.agents = readAgents(toilProjectAgentsFile(dataDir));
    // Before the rename (#555) the file was called dossier-agents.json: read it once if the new one is not there, and keep it as a new file from then on.
    const before = nodePath.join(dataDir, 'dossier-agents.json');
    if (!existsSync(toilProjectAgentsFile(dataDir)) && existsSync(before)) {
      this.agents = readAgents(before);
      if (this.agents.size) this.save();
    }
  }

  /** The adapter last used for the toil project, or null. */
  get(toilProject: string): AdapterName | null {
    return this.agents.get(toilProject) ?? null;
  }

  /** Remembers an adapter for a toil project; a name that is not an adapter or a toil project is ignored. */
  set(toilProject: string, adapter: string): boolean {
    if (!valid(toilProject) || !NAMES.includes(adapter)) return false;
    if (this.agents.get(toilProject) === adapter) return true;
    this.agents.set(toilProject, adapter as AdapterName);
    this.save();
    return true;
  }

  /** A toil project toil renamed: its memory moves to the new name, replacing any left under it. */
  rename(from: string, to: string) {
    if (from === to || !valid(to)) return;
    const adapter = this.agents.get(from);
    const had = this.agents.delete(to);
    if (adapter === undefined) {
      if (had) this.save();
      return;
    }
    this.agents.delete(from);
    this.agents.set(to, adapter);
    this.save();
  }

  /** A toil project toil no longer has. */
  forget(toilProject: string) {
    if (this.agents.delete(toilProject)) this.save();
  }

  /** Writes owner-only through a temporary file, so a crash never leaves half of one. */
  private save() {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const file = toilProjectAgentsFile(this.dataDir);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: 1, agents: Object.fromEntries(this.agents) }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }
}

const valid = (toilProject: string) => toilProject.length <= MAX_TOIL_PROJECT && TOIL_PROJECT.test(toilProject);

/** What the file holds, entry by entry; a missing or broken file is no memory, never a failed start. */
function readAgents(file: string): Map<string, AdapterName> {
  const out = new Map<string, AdapterName>();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { agents?: unknown };
    if (typeof parsed.agents !== 'object' || parsed.agents === null || Array.isArray(parsed.agents)) return out;
    for (const [toilProject, adapter] of Object.entries(parsed.agents)) if (valid(toilProject) && typeof adapter === 'string' && NAMES.includes(adapter)) out.set(toilProject, adapter as AdapterName);
  } catch {
    // Nothing remembered yet, or a file that is not JSON: the global default answers.
  }
  return out;
}
