/**
 * Every failure a user can see is a ToilError: a stable code, a message, and a
 * fix they can act on. Anything else that escapes a command is wrapped as
 * INTERNAL so the envelope never carries a raw stack trace. A stack trace in a
 * ticket gets reassigned to three teams and resolved by none of them.
 */
/**
 * Error codes are an open set: new ones are added as areas need them, and a
 * consumer must treat a code it doesn't recognise as a generic failure.
 * Changing what an existing code means is a breaking change; adding one isn't.
 */
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_CONFIGURED'
  | 'CONFIG_INVALID'
  | 'AUTH'
  | 'NOT_FOUND'
  | 'HTTP'
  | 'NETWORK'
  | 'WRITE_DISABLED'
  | 'TIMEOUT'
  | 'CANCELLED'
  /** A database refused or failed a statement: bad SQL, a constraint, a lock. */
  | 'DATABASE'
  | 'CREDENTIAL_STORE'
  /** The Node running toil is older than the floor in package.json "engines". */
  | 'UNSUPPORTED_NODE'
  /** A command that runs git found no usable git on PATH. Nothing else needs git. */
  | 'GIT_NOT_FOUND'
  /**
   * The server is a release without an API the command needs (sub-issues or
   * Projects on an older GitHub Enterprise Server), or the connection's
   * deployment has no such command or flag (`jira project list` on Data Center).
   */
  | 'UNSUPPORTED'
  | 'INTERNAL';

export class ToilError extends Error {
  readonly code: ErrorCode;
  readonly fix: string | undefined;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options: { fix?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'ToilError';
    this.code = code;
    this.fix = options.fix;
    this.details = options.details;
  }
}

/**
 * A toil project holds this input per repo and the call's folder is none of them (#540). The resolver tells it from any other
 * INVALID_INPUT: an input the command doesn't need is left unresolved, one it does is this error.
 */
export class StrandedInput extends ToilError {
  /** The call named another per-repo input itself, so this one still falls through; the resolver says where it came from. */
  readonly callNamed: boolean;

  constructor(code: ErrorCode, message: string, options: { fix?: string; details?: unknown; callNamed?: boolean } = {}) {
    super(code, message, options);
    this.callNamed = options.callNamed ?? false;
  }
}

export function toToilError(err: unknown): ToilError {
  if (err instanceof ToilError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ToilError('INTERNAL', message, {
    fix: 'This is a bug in toil. Please report it at https://github.com/imagile-dev/toil/issues with the command you ran.',
  });
}

/**
 * `a jira`, `an elasticsearch`: the article for an area name in a message,
 * by its first letter. Area names are lowercase words, so the letter is enough.
 */
export function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}
