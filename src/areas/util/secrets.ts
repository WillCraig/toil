import { z } from 'zod';
import { defineCommand } from '../../core/command.js';
import { inputFields, inputFileOption, textOption } from './kit/input.js';
import { scanSecrets } from './secrets/scan.js';

/**
 * `util secrets scan`'s definition: schema, flags and examples. The scan is in
 * `secrets/scan.ts`, imported statically: it has no dependency of its own,
 * and a module reached through `import()` that imports zod breaks the bundle
 * at startup (docs/util.md, Lazy loading). Form SEC-1, "Declaration of No
 * Secrets", is now self-service.
 */

const FILE = 'A file or folder inside the workspace to scan; a folder is walked as git would list it, .gitignore respected. On the CLI, - (or leaving out inputFile, text and diff) reads stdin';
const DIFF = 'Scan the repository\'s changes instead: "staged" (what the next commit holds, git diff --staged) or "working" (unstaged changes, git diff). Added lines only';
const ALLOW = 'The allow file: one finding fingerprint per line, # for comments (default: .toil/secrets-allow, when it exists)';

export const secretsScanCommand = defineCommand({
  path: ['util', 'secrets', 'scan'],
  description: 'Find credential-shaped strings in a file, folder, stdin or the staged diff (local only; exit 1 on findings)',
  toolDescription:
    'Finds credential-shaped strings before they are committed, pushed or posted: in a file or folder of the workspace (.gitignore respected), in text, or in the repository\'s staged or working-tree diff (added lines only). Uses the same rules the audit log redacts with (token shapes, name=value pairs, Authorization values, URLs with credentials, private keys, long random runs) plus an entropy rule. Returns { source, findings[] of { file, line, column, endLine?, length, rule, confidence, entropy, preview, fingerprint }, allowed[], unreadable[], allowList, summary, verified }. A preview masks the middle of the secret and the full secret is never returned. A finding whose fingerprint is in the allow file goes in allowed. Each finding is re-read at its position to confirm it. Files that could not be read (binary, too large, permission) are listed in unreadable. A diff is limited to the workspace; when the workspace is a folder inside the repository, a SECRETS_DIFF_PARTIAL warning counts the changed files outside it. On the CLI the exit code is 1 when findings is not empty. Local only: no network; diff runs the git on PATH.',
  input: z.object({
    ...inputFields,
    inputFile: inputFields.inputFile.describe(FILE),
    diff: z.enum(['staged', 'working']).optional().describe(DIFF),
    allowFile: z.string().optional().describe(ALLOW),
  }),
  writes: false,
  // The text is what's being checked for secrets, and the log keeps no copy of it.
  auditInput: { text: 'drop' },
  args: [{ name: 'file', field: 'inputFile', description: 'Retired: use --input-file', required: false, deprecated: '--input-file' }],
  options: [
    { ...inputFileOption, description: 'A file or folder inside the workspace to scan, or - for stdin (the default when no --text or --diff is given)' }, textOption,
    { flags: '--diff <kind>', field: 'diff', description: DIFF },
    { flags: '--allow-file <file>', field: 'allowFile', description: ALLOW },
  ],
  examples: [{ inputFile: 'samples/secrets', allowFile: 'samples/secrets-allow' }, { text: 'deploy to https://jira.imagile.dev with the token from the vault' }, { diff: 'staged', allowFile: 'samples/secrets-allow' }],
  run: (input, ctx) => scanSecrets(input, ctx),
});

export const secretsCommands = [secretsScanCommand];
