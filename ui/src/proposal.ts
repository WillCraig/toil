/**
 * A proposal: a change to a tracker that the UI or the agent suggests and a
 * person applies (#206, principle 2). Toil UI never writes. A proposal names
 * the toil command that would make the change and its exact input, and shows
 * the command line to run through toil's write gate (`writes: true` on the
 * connection, `--allow-write` on the call). test/registry.test.ts holds every
 * proposal the board and the scripted agent can make to the real registry: the
 * command exists, it writes, and its input validates. Where toil has no
 * command for the change, the proposal says so instead of inventing one.
 * A change request that fills itself in and still waits for a signature.
 */

export interface Proposal {
  /** Stable for one suggestion, so the same move isn't listed twice. */
  id: string;
  /** Where it came from: a move on the board, the agent's answer, a reviewer the pull request view suggests, or publishing a worklog. */
  from: 'board' | 'agent' | 'reviewers' | 'worklog';
  /** The OWI id of the work item it changes, or of the change (pull request) it asks a review of. */
  item: string;
  /** One line: "Move PAY-102 to In progress". */
  title: string;
  /** Why, or what it rests on. May cite items as `[[<owi id>]]`. */
  reason: string;
  /** The toil command that applies it, or null when toil has none yet. */
  command: string | null;
  /** The command's MCP input, as `execute()` would take it. */
  input: Record<string, unknown> | null;
  /** Anything a person should check first, or why there is no command. */
  note: string | null;
  /** A read-only toil command that helps, such as listing the workflow's transitions, rendered like the main one. */
  hint?: Hint | null;
}

/** A read-only command a proposal points to, and what it is for. */
export interface Hint {
  text: string;
  command: string;
  input: Record<string, unknown>;
}

/**
 * The fields whose CLI flag isn't the field's name in kebab case, for the
 * commands a proposal names (`issueType` is `--type` on Jira's issue create).
 * test/registry.test.ts walks every proposal's command line down toil's real
 * command tree, so a flag missing here fails there.
 */
const RENAMED_FLAGS: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map([
  ['jira issue create', { issueType: '--type' }],
]);

const flagFor = (command: string, key: string) => RENAMED_FLAGS.get(command)?.[key] ?? `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/**
 * The shells a proposal's command line is written for. Every value is single
 * quoted, the one quoting both shells expand nothing inside: no `$(...)`, no
 * backticks, no variables, no backslash escapes. Double quotes are never used.
 */
export type Shell = 'posix' | 'powershell';
export const SHELL_LABEL: Record<Shell, string> = { posix: 'bash/zsh', powershell: 'PowerShell' };

/** Characters PowerShell reads as a single quote: the ASCII one and the typographic ones. */
const PS_QUOTES = /['\u2018\u2019\u201A\u201B]/g;

const BREAKS = /[\r\n\u0085\u2028\u2029\0]/;
/**
 * What PowerShell can't pass on safely: npm installs `toil` on Windows as a
 * `toil.cmd` shim, and cmd.exe re-reads its arguments, acting on `& | < > ^`
 * and expanding `%VAR%`; Windows PowerShell 5.1 also mangles an embedded `"`.
 */
const CMD_UNSAFE = /[&|<>^%"]/;

/** Why a value can't go on a command line for this shell, or null when it can. */
export function unsafe(value: string, shell: Shell): string | null {
  if (BREAKS.test(value)) return 'it holds a line break';
  const bad = shell === 'powershell' ? CMD_UNSAFE.exec(value)?.[0] : undefined;
  if (bad) return `it holds ${bad}, which cmd.exe acts on when PowerShell runs npm's toil.cmd shim`;
  return null;
}

/**
 * One argument, single quoted for the shell. POSIX writes a `'` inside as
 * `'\''` (close, escaped quote, reopen); PowerShell doubles every character it
 * treats as a single quote. A value `unsafe` refuses comes back null rather
 * than as a line that would do something else.
 */
export function quote(value: string, shell: Shell): string | null {
  if (unsafe(value, shell)) return null;
  return shell === 'posix' ? `'${value.replace(/'/g, `'\\''`)}'` : `'${value.replace(PS_QUOTES, (q) => q + q)}'`;
}

/**
 * The toil commands whose input takes `inputFile` (`--input-file`), so a value
 * no command line can carry can go in a file instead. The page can't load
 * toil's registry (it is Node-only), so test/registry.test.ts holds this list
 * to it exactly.
 */
export const INPUT_FILE_COMMANDS: ReadonlySet<string> = new Set([
  'ado work-item create', 'ado work-item update', 'alation document create', 'alation document update', 'jira issue create', 'jira issue update',
  'splitio flag update', 'splitio flag toggle-many',
]);

/** One positional list for several commands, as [command, fields] entries. */
const positional = (fields: readonly string[], ...commands: string[]) => commands.map((c) => [c, fields] as const);

/**
 * The input fields each area command takes as positional
 * arguments on the CLI, in order: the id of the thing first, then a sub-item's
 * (`toil jira issue transition 'PAY-1' --transition 'Done'`). Every other field
 * is a flag. The page can't load toil's registry, so test/registry.test.ts
 * holds this list to the registry's own arguments exactly.
 */
export const POSITIONAL_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ...positional(['app', 'hash'],
    'contrast library get',
  ),
  ...positional(['app', 'trace'],
    'contrast finding get',
  ),
  ...positional(['app'],
    'contrast app findings', 'contrast app libraries',
  ),
  ...positional(['buildId'],
    'saucelabs build get', 'saucelabs build jobs',
  ),
  ...positional(['commentId'],
    'github pr delete-comment', 'github pr delete-review-comment',
  ),
  ...positional(['commit'],
    'ado commit status', 'bitbucket commit get', 'bitbucket commit status',
  ),
  ...positional(['deviceId'],
    'saucelabs device get',
  ),
  ...positional(['fileKeyOrUrl'],
    'figma file comments', 'figma file get', 'figma file versions',
  ),
  ...positional(['flag'],
    'splitio flag archive', 'splitio flag get', 'splitio flag kill', 'splitio flag restore',
    'splitio flag set-default', 'splitio flag set-rule', 'splitio flag toggle', 'splitio flag update',
  ),
  ...positional(['id', 'attachmentId'],
    'ado work-item download',
  ),
  ...positional(['id', 'commentId'],
    'bitbucket pr delete-comment', 'bitbucket pr reply', 'bitbucket pr resolve',
  ),
  ...positional(['id', 'threadId', 'commentId'],
    'ado pr delete-comment',
  ),
  ...positional(['id', 'threadId'],
    'ado pr reply', 'ado pr resolve',
  ),
  ...positional(['id'],
    'ado backlog items', 'ado board get', 'ado pipeline get', 'ado pipeline run', 'ado pr abandon', 'ado pr approve', 'ado pr builds',
    'ado pr comment', 'ado pr comment-inline', 'ado pr comments', 'ado pr diff', 'ado pr files', 'ado pr get',
    'ado pr merge', 'ado pr reviewers', 'ado pr threads', 'ado pr unapprove', 'ado pr update', 'ado pr wait-for-author',
    'ado run cancel', 'ado run get', 'ado run logs', 'ado sprint items', 'ado work-item assign', 'ado work-item attach',
    'ado work-item attachments', 'ado work-item comment', 'ado work-item comments', 'ado work-item get',
    'ado work-item get-many', 'ado work-item history', 'ado work-item link', 'ado work-item tag',
    'ado work-item transition', 'ado work-item untag', 'ado work-item update',
    'alation column get', 'alation datasource get', 'alation document get', 'alation document update',
    'alation folder get', 'alation job get', 'alation schema get', 'alation table get',
    'bitbucket pr add-reviewer', 'bitbucket pr approve', 'bitbucket pr builds', 'bitbucket pr comment',
    'bitbucket pr comment-inline', 'bitbucket pr comments', 'bitbucket pr decline', 'bitbucket pr diff',
    'bitbucket pr files', 'bitbucket pr get', 'bitbucket pr merge', 'bitbucket pr needs-work',
    'bitbucket pr reviewers', 'bitbucket pr unapprove', 'bitbucket pr update', 'checkmarx project get', 'checkmarx scan get', 'checkmarx scan stats',
    'confluence attachment delete', 'confluence attachment download', 'confluence page attach',
    'confluence page attachments', 'confluence page children', 'confluence page comment',
    'confluence page comments', 'confluence page delete', 'confluence page get', 'confluence page history',
    'confluence page label', 'confluence page labels', 'confluence page unlabel', 'confluence page update',
    'dynatrace entity get', 'dynatrace problem get', 'dynatrace trace get', 'kibana dashboard export',
    'kibana rule get', 'sde project get', 'splitio change-request get',
  ),
  ...positional(['index'],
    'elasticsearch index count', 'elasticsearch index search',
  ),
  ...positional(['jobId'],
    'saucelabs job assets', 'saucelabs job build', 'saucelabs job delete', 'saucelabs job get',
    'saucelabs job stop', 'saucelabs job update', 'saucelabs rdc-job delete', 'saucelabs rdc-job get',
    'saucelabs rdc-job stop', 'saucelabs rdc-job update',
  ),
  ...positional(['key', 'attachmentId'],
    'jira issue download',
  ),
  ...positional(['key'],
    'confluence space get', 'jira issue assign', 'jira issue attach',
    'jira issue attachments', 'jira issue comment', 'jira issue comments', 'jira issue get',
    'jira issue history', 'jira issue label', 'jira issue link', 'jira issue log-work',
    'jira issue set-sprint', 'jira issue transition', 'jira issue transitions', 'jira issue unlabel',
    'jira issue update',
  ),
  ...positional(['method', 'path'],
    'ado api', 'bitbucket api', 'jira api',
  ),
  ...positional(['name', 'number'],
    'artifactory build get', 'jenkins run get', 'jenkins run logs',
  ),
  ...positional(['name'],
    'ado project get', 'artifactory build runs', 'jenkins pipeline get',
    'jenkins pipeline run', 'jenkins pipeline runs', 'jira sprint create',
  ),
  ...positional(['sprint'],
    'jira sprint complete', 'jira sprint get', 'jira sprint start', 'jira sprint update',
  ),
  ...positional(['number', 'commentId'],
    'github pr reply',
  ),
  ...positional(['number'],
    'github issue assign', 'github issue get', 'github issue history', 'github issue label',
    'github issue unassign', 'github issue unlabel', 'github pr add-reviewers', 'github pr approve',
    'github pr close', 'github pr comment', 'github pr comment-inline', 'github pr comments',
    'github pr diff', 'github pr disable-auto-merge', 'github pr draft', 'github pr enable-auto-merge',
    'github pr enqueue', 'github pr files', 'github pr get', 'github pr merge', 'github pr ready',
    'github pr remove-reviewers', 'github pr reopen', 'github pr request-changes',
    'github pr review-comments', 'github pr reviewers', 'github pr reviews', 'github pr status',
    'github pr threads', 'github pr update',
  ),
  ...positional(['path'],
    'bitbucket file get', 'bitbucket file list', 'github repo file',
  ),
  ...positional(['pipeline', 'step'],
    'bitbucket pipeline logs',
  ),
  ...positional(['pipeline'],
    'bitbucket pipeline get', 'bitbucket pipeline steps',
  ),
  ...positional(['plugin'],
    'skills marketplace disable', 'skills marketplace enable', 'skills marketplace sync',
  ),
  ...positional(['pod'],
    'openshift pod logs',
  ),
  ...positional(['project', 'number'],
    'github project status',
  ),
  ...positional(['project'],
    'github project fields', 'github project items', 'jira project get',
  ),
  ...positional(['projectId'],
    'figma project files',
  ),
  ...positional(['publicId'],
    'sonatypeiq application get',
  ),
  ...positional(['query'],
    'alation search',
  ),
  ...positional(['ref'],
    'github commit checks', 'github commit status',
  ),
  ...positional(['repo', 'path', 'keyvals'],
    'artifactory artifact set-properties',
  ),
  ...positional(['repo', 'path'],
    'artifactory artifact get', 'artifactory artifact properties',
  ),
  ...positional(['repository'],
    'logscale repository query',
  ),
  ...positional(['sessionId', 'app'],
    'saucelabs session install-app',
  ),
  ...positional(['sessionId', 'command'],
    'saucelabs session shell',
  ),
  ...positional(['sessionId', 'url'],
    'saucelabs session open-url',
  ),
  ...positional(['sessionId'],
    'saucelabs session appium', 'saucelabs session delete', 'saucelabs session end-test',
    'saucelabs session get', 'saucelabs session installations', 'saucelabs session launch-app',
    'saucelabs session network', 'saucelabs session network-profiles', 'saucelabs session settings',
    'saucelabs session start-test', 'saucelabs session tests', 'saucelabs session uninstall-app',
  ),
  ...positional(['sql'],
    'db execute', 'db lint', 'db query',
  ),
  ...positional(['table'],
    'db table describe', 'db table preview',
  ),
  ...positional(['task'],
    'sde task get',
  ),
  ...positional(['teamId'],
    'saucelabs team get', 'saucelabs team members',
  ),
  ...positional(['threadId'],
    'github pr resolve',
  ),
  ...positional(['tunnelId'],
    'saucelabs tunnel get', 'saucelabs tunnel jobs', 'saucelabs tunnel stop',
  ),
]);

/** A call over MCP: the tool's name (`jira issue transition` is `jira_issue_transition`) and its input, which as JSON needs no shell quoting. */
export interface McpCall {
  tool: string;
  input: Record<string, unknown>;
}

export const toolName = (command: string) => command.replace(/[ -]/g, '_');

export type CommandLine = { line: string; reason: null; mcp?: undefined } | { line: null; reason: string; mcp?: McpCall };

/**
 * The command line that applies a proposal, for one shell: the positional
 * arguments (`POSITIONAL_FIELDS`) first, then `--toil-project`, `--allow-write`
 * last, every value single quoted. A flag's value starting with `-` is
 * attached to its flag (`'--summary=-x'`), so it can never read as a flag of
 * its own; a positional one can't be, so it gets no line. Null, with the
 * reason, when there is no command or a value can't be written safely on one
 * line.
 */
export function commandLine(p: Pick<Proposal, 'command' | 'input'>, shell: Shell): CommandLine {
  if (!p.command || !p.input) return { line: null, reason: 'toil has no command for this change.' };
  return render(p.command, p.input, shell, true);
}

/** A read-only command line (no `--allow-write`), through the same quoting. */
export function readLine(h: Pick<Hint, 'command' | 'input'>, shell: Shell): CommandLine {
  return render(h.command, h.input, shell, false);
}

/**
 * What to do instead, true for this command: `--input-file` only where it
 * takes one; bash/zsh where only PowerShell refused; and always MCP, whose
 * JSON input carries any value.
 */
function advice(command: string, bashHelps: boolean, tool: string): string {
  const ways: string[] = [];
  if (INPUT_FILE_COMMANDS.has(command)) ways.push(`put the input in a file and pass it with toil ${command}'s --input-file`);
  if (bashHelps) ways.push('switch this card to bash/zsh, where single quotes carry it');
  ways.push(`apply it over MCP with the tool ${tool} and the input below`);
  const text = ways.length === 1 ? ways[0]! : `${ways.slice(0, -1).join(', ')}, or ${ways.at(-1)}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** Every toil command line the UI shows is built here, and only here. */
function render(command: string, input: Record<string, unknown>, shell: Shell, write: boolean): CommandLine {
  const positionals = POSITIONAL_FIELDS.get(command) ?? [];
  const named = Object.keys(input).filter((k) => !positionals.includes(k)).sort((a, b) => (a === 'toilProject' ? -1 : b === 'toilProject' ? 1 : 0));
  const refuse = (what: string, why: string, bashHelps: boolean): CommandLine => {
    const mcp = { tool: toolName(command), input: write ? { ...input, allowWrite: true } : input };
    return { line: null, reason: `The ${what} value can't be passed safely on a ${SHELL_LABEL[shell]} command line: ${why}. ${advice(command, bashHelps, mcp.tool)}`, mcp };
  };
  const parts: string[] = [];
  for (const k of [...positionals.filter((k) => k in input), ...named]) {
    const v = input[k];
    const positional = positionals.includes(k);
    const flag = flagFor(command, k);
    const what = positional ? `<${k}>` : flag;
    for (const x of Array.isArray(v) ? v : [v]) {
      // A switch (`--markdown`) takes no value: written `--markdown 'true'`, the 'true' would be read as an argument.
      if (x === true && !positional) {
        parts.push(flag);
        continue;
      }
      const value = String(x);
      const why = unsafe(value, shell);
      if (why) return refuse(what, why, shell === 'powershell' && !why.includes('line break'));
      if (positional && value.startsWith('-')) return refuse(what, 'it starts with -, so toil would read it as a flag', false);
      if (positional) parts.push(quote(value, shell)!);
      else parts.push(value.startsWith('-') ? quote(`${flag}=${value}`, shell)! : `${flag} ${quote(value, shell)}`);
    }
  }
  return { line: `toil ${command} ${parts.join(' ')}${write ? ' --allow-write' : ''}`, reason: null };
}

/** The viewer's shell: PowerShell on Windows, POSIX anywhere else. */
export function defaultShell(nav: { platform?: string; userAgentData?: { platform?: string } } | undefined = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { userAgentData?: { platform?: string } })): Shell {
  const platform = nav?.userAgentData?.platform || nav?.platform || '';
  return /^win/i.test(platform) ? 'powershell' : 'posix';
}
