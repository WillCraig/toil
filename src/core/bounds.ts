/**
 * Every bound toil enforces, in one list: what it protects, where the code
 * enforces it, the error a caller sees, and whether a config setting may
 * relax it. `docs/bounds.md` is the same list written for people, and
 * `test/bounds.test.ts` fails when the two disagree, so a bound can't be
 * added, moved or loosened in one place only.
 *
 * Security-class bounds can't be relaxed by any setting. Neither can the
 * others, except where `relaxedBy` names the one config key that does it.
 * A form exists for requesting an exemption; it is this file, and it is
 * reviewed.
 */
export interface Bound {
  id: string;
  /** Source files where the bound is enforced. */
  enforcedIn: readonly string[];
  /** Error codes a caller sees when the bound refuses something. */
  errors: readonly string[];
  /** The config setting that relaxes it, or undefined when nothing can. */
  relaxedBy?: string;
  securityClass: boolean;
}

export const BOUNDS: readonly Bound[] = [
  { id: 'files.workspace', enforcedIn: ['src/core/files.ts'], errors: ['INVALID_INPUT', 'NOT_CONFIGURED'], relaxedBy: '"bounds": { "files": "unbounded" }', securityClass: false },
  { id: 'files.own', enforcedIn: ['src/core/files.ts', 'src/node-context.ts', 'src/core/git-config.ts', 'src/core/toil-project.ts'], errors: ['INVALID_INPUT'], securityClass: true },
  { id: 'files.system', enforcedIn: ['src/core/files.ts', 'src/core/git-config.ts', 'src/core/toil-project.ts'], errors: ['INVALID_INPUT'], securityClass: true },
  { id: 'files.remote', enforcedIn: ['src/core/local-path.ts', 'src/core/files.ts', 'src/core/toil-project.ts'], errors: ['INVALID_INPUT'], securityClass: true },
  { id: 'files.no-overwrite', enforcedIn: ['src/core/files.ts'], errors: ['INVALID_INPUT'], securityClass: true },
  { id: 'credentials.host', enforcedIn: ['src/core/api.ts', 'src/core/rest.ts', 'src/core/passthrough.ts'], errors: ['HTTP', 'AUTH', 'INVALID_INPUT'], securityClass: true },
  { id: 'requests.path', enforcedIn: ['src/core/api.ts', 'src/core/rest.ts', 'src/core/api-path.ts'], errors: ['INVALID_INPUT'], securityClass: true },
  { id: 'secrets.storage', enforcedIn: ['src/core/connection.ts'], errors: ['CONFIG_INVALID'], securityClass: true },
  { id: 'commands.cli-only', enforcedIn: ['src/mcp/server.ts', 'src/api.ts', 'src/core/run.ts'], errors: ['INVALID_INPUT'], securityClass: true },
  { id: 'commands.time-limit', enforcedIn: ['src/core/run.ts', 'src/core/wait.ts'], errors: ['TIMEOUT', 'CANCELLED'], securityClass: false },
  { id: 'commands.read-only', enforcedIn: ['src/core/run.ts', 'src/core/wait.ts', 'src/core/git.ts'], errors: ['WRITE_DISABLED', 'INVALID_INPUT'], securityClass: true },
  { id: 'query.size', enforcedIn: ['src/core/query/interpreter.ts'], errors: ['INVALID_INPUT'], securityClass: false },
  { id: 'projects.size', enforcedIn: ['src/core/toil-project.ts'], errors: ['CONFIG_INVALID', 'TOIL_PROJECT_INVALID'], securityClass: false },
  { id: 'gitignore.line', enforcedIn: ['src/core/gitignore.ts', 'src/core/wildmatch.ts'], errors: ['GITIGNORE_LINE_SKIPPED'], securityClass: false },
  { id: 'process.spawn', enforcedIn: ['src/core/git.ts', 'src/core/keychain.ts', 'src/os/windows-sspi.ts', 'scripts/spawners.mjs', 'scripts/check-pure.mjs'], errors: ['GIT_NOT_FOUND'], securityClass: true },
];

/** Documented exceptions to a bound: what a bound would otherwise refuse, allowed on purpose. */
export interface BoundException {
  id: string;
  /** The bound it makes an exception to. */
  bound: string;
  enforcedIn: readonly string[];
}

export const BOUND_EXCEPTIONS: readonly BoundException[] = [
  { id: 'git.read-up', bound: 'files.workspace', enforcedIn: ['src/core/git-repo.ts', 'src/core/git-config.ts', 'src/core/files.ts'] },
  { id: 'output-file', bound: 'files.workspace', enforcedIn: ['src/node-context.ts', 'src/program.ts'] },
  { id: 'shell-profile', bound: 'files.workspace', enforcedIn: ['src/core/shell-profile.ts', 'src/setup/commands.ts'] },
  { id: 'shell-profile.edit', bound: 'files.no-overwrite', enforcedIn: ['src/core/shell-profile.ts'] },
  { id: 'skills.folders', bound: 'files.workspace', enforcedIn: ['src/skills/folders.ts', 'src/skills/marketplace.ts', 'src/skills/bundled.ts'] },
  { id: 'skills.reinstall', bound: 'files.no-overwrite', enforcedIn: ['src/skills/folders.ts', 'src/skills/bundled.ts'] },
  { id: 'projects.read', bound: 'files.workspace', enforcedIn: ['src/core/toil-project.ts'] },
  { id: 'projects.write', bound: 'files.workspace', enforcedIn: ['src/core/toil-project.ts'] },
  { id: 'projects.replace', bound: 'files.no-overwrite', enforcedIn: ['src/core/toil-project.ts'] },
  { id: 'connections.import', bound: 'files.workspace', enforcedIn: ['src/connections/import-command.ts'] },
  { id: 'db.tls-ca-file', bound: 'files.workspace', enforcedIn: ['src/core/db/tls.ts'] },
  { id: 'feedback.send', bound: 'commands.read-only', enforcedIn: ['src/feedback/command.ts', 'src/api.ts'] },
];
