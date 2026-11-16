import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defineConfigCommand, type AnyCommand } from '../core/command.js';
import type { CommandContext } from '../core/context.js';
import { ToilError } from '../core/errors.js';
import { forwardSlashes } from '../core/files.js';
import { aliasBlock, editProfile, fromClone, pickShell, profileFor, SHELLS, withBlock, withoutBlock, type SetupHost } from '../core/shell-profile.js';

/**
 * `toil setup alias | remove-alias`: put `toil` on a shell's command line for
 * someone running the committed bundle from a clone, with no npm install.
 * CLI only: it changes a file of the person's own, outside the workspace, and
 * an agent never does that (docs/bounds.md, `shell-profile`). The shell and the
 * file come from flags, else `SHELL` and the shell's usual profile. Installing
 * software normally takes a request form; a line in your own .bashrc takes
 * only the line.
 */
const shellInput = z.enum(SHELLS).optional().describe(`The shell to set up: ${SHELLS.join(', ')} (default: from --profile's extension, else SHELL, else PowerShell on Windows)`);
const profileInput = z.string().min(1).optional().describe('The profile file to edit (default: ~/.bashrc for bash, ~/.zshrc for zsh; PowerShell needs $PROFILE)');
const options = [
  { flags: '--shell <shell>', field: 'shell', description: `The shell to set up: ${SHELLS.join(', ')} (default: from --profile, else SHELL, else PowerShell on Windows)` },
  { flags: '--profile <file>', field: 'profile', description: 'The profile file to edit (default: ~/.bashrc or ~/.zshrc; for PowerShell pass $PROFILE)' },
];

/** The running process: home, working directory, `SHELL`, `ZDOTDIR`, and the bundle this code is in. */
export function nodeSetupHost(): SetupHost {
  return {
    platform: process.platform,
    home: homedir(),
    cwd: process.cwd(),
    env: { SHELL: process.env.SHELL, ZDOTDIR: process.env.ZDOTDIR },
    // In the bundle this module is dist/toil-lib.js; the alias runs the bin beside it, dist/toil.js.
    bundle: join(dirname(fileURLToPath(import.meta.url)), 'toil.js'),
  };
}

export function setupCommands(host: () => SetupHost = nodeSetupHost): AnyCommand[] {
  /** The shell and profile a call is about, and the files no command may touch. */
  const target = (input: { shell?: (typeof SHELLS)[number] | undefined; profile?: string | undefined }, ctx: CommandContext) => {
    const h = host();
    const config = ctx.manage?.config;
    if (!config) throw new ToilError('INTERNAL', 'setup commands need the config they were defined to get.');
    const shell = pickShell(input.shell, input.profile, h);
    return {
      h,
      shell,
      profile: input.profile ?? profileFor(shell, h),
      protect: [join(h.home, '.toil'), config.files.global],
    };
  };

  const alias = defineConfigCommand({
    path: ['setup', 'alias'],
    description: 'Add a toil alias for this clone to your shell profile, so `toil` runs it with no npm install',
    input: z.object({ shell: shellInput, profile: profileInput }),
    writes: false,
    writesLocal: true,
    kind: 'cli-only',
    options,
    examples: [{ shell: 'bash' }],
    run: async (input, ctx) => {
      const { h, shell, profile, protect } = target(input, ctx);
      fromClone(h.bundle);
      const block = aliasBlock(shell, h.bundle);
      let change: 'added' | 'updated' | 'unchanged' = 'unchanged';
      const edited = await editProfile({ path: profile, cwd: h.cwd, protect }, (text, path) => {
        const result = withBlock(text, block, path);
        change = result.change;
        return result;
      });
      return {
        shell,
        profile: forwardSlashes(edited.path),
        bundle: forwardSlashes(h.bundle),
        change,
        // Dot-sourcing reads the profile into the current shell in bash, zsh and PowerShell alike.
        next: `Open a new terminal, or run . '${forwardSlashes(edited.path)}', then run toil version.`,
      };
    },
  });

  const remove = defineConfigCommand({
    path: ['setup', 'remove-alias'],
    description: 'Take the toil alias that setup alias added out of your shell profile',
    input: z.object({ shell: shellInput, profile: profileInput }),
    writes: false,
    writesLocal: true,
    kind: 'cli-only',
    options,
    examples: [{ shell: 'zsh' }],
    run: async (input, ctx) => {
      const { shell, profile, protect, h } = target(input, ctx);
      let removed = false;
      const edited = await editProfile({ path: profile, cwd: h.cwd, protect }, (text, path) => {
        const result = withoutBlock(text, path);
        removed = result.removed;
        return result;
      });
      return { shell, profile: forwardSlashes(edited.path), removed };
    },
  });

  return [alias, remove];
}
