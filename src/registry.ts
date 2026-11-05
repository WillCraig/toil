import { modules } from './areas.generated.js';
import { auditCommands } from './audit/commands.js';
import { connectionsCommands } from './connections/commands.js';
import { toilProjectBuildCommands } from './projects/build.js';
import { toilProjectOnboardCommands } from './projects/onboard.js';
import { toilProjectBriefCommands } from './projects/brief.js';
import { toilProjectsCommands } from './projects/commands.js';
import { feedbackCommands } from './feedback/command.js';
import { reposCommands } from './repos/commands.js';
import type { AnyArea } from './core/area.js';
import { assertUniquePaths, withCoreAliases, type AnyCommand } from './core/command.js';
import { toilProjectMigrateCommands } from './projects/migrate.js';
import { resolveRoutedAliases, type RoutedAlias } from './core/routed-alias.js';
import { setupCommands } from './setup/commands.js';
import { skillsConfigCommands } from './skills/commands.js';
import { skillCommands } from './skills/skill-commands.js';
import { themeCommands } from './theme/commands.js';
import { waitCommand } from './core/wait.js';

/**
 * Every shipped area, found by scripts/gen-areas.mjs. Nobody maintains this
 * list by hand, which makes it the only register of record that's current.
 */
export const areas: AnyArea[] = modules.flatMap((m) => (m.area ? [m.area] : []));

/**
 * Every shipped command. Both front doors and the parity test read this list.
 * An area's `coreAliases` (`jenkins instance list` for `connections list
 * --area jenkins`) are added to the core command they name. The skills
 * commands that read or change config (`skills marketplace add`, `list`,
 * `remove`, `skills status`) are core's, beside `connections`; the ones that
 * use one marketplace's connection are the `skills` area's. `skill install`
 * and `skill show` are the toil skill's own (src/skills/skill-commands.ts).
 */
/**
 * `toil dossiers …` and `<area> check-dossier` were renamed when dossiers became toil
 * projects. The old paths keep answering, with a TOIL_PROJECT_DEPRECATED_NAME warning, for at
 * least one beta (principle 7); MCP never had them as aliases and drops the old tool names.
 */
const withRetiredToilProjectPaths = (list: AnyCommand[]): AnyCommand[] =>
  list.map((def) => {
    const [first, ...rest] = def.path;
    if (first === 'projects' && rest[0] !== 'migrate') return { ...def, deprecatedPaths: [['dossiers', ...rest]] };
    const last = def.path[def.path.length - 1];
    if (last === 'check-toil-project') return { ...def, deprecatedPaths: [[first!, ...def.path.slice(1, -1), 'check-dossier']] };
    return def;
  });

export const commands: AnyCommand[] = withRetiredToilProjectPaths(withCoreAliases([...modules.flatMap((m) => m.commands), ...connectionsCommands(areas), ...toilProjectsCommands(areas), ...toilProjectMigrateCommands(), ...toilProjectBriefCommands(), ...toilProjectBuildCommands(areas), ...toilProjectOnboardCommands(areas), ...reposCommands(), ...skillsConfigCommands(), ...skillCommands(areas), ...setupCommands(), ...auditCommands(() => commands), ...themeCommands(), ...feedbackCommands(), waitCommand], areas));

// An alias in another group (`deps outdated` for `artifactory package outdated`) can
// collide with a command there; better a failed start than a silent winner.
assertUniquePaths(commands);

/**
 * Alias paths that pick their command by a flag's value, declared here once so
 * no area's branch owns them (src/core/routed-alias.ts). A route whose
 * command isn't registered yet is skipped, and calling it says so; with
 * none registered, the path isn't there at all. `--source all` is dropped
 * (docs/divergences/deps.json): one command asks one source.
 */
export const ROUTED_ALIASES: readonly RoutedAlias[] = [
  {
    path: ['deps', 'frisk'],
    description: 'Check an inventory for known vulnerabilities in one source',
    flag: '--source <source>',
    // The default the contract specifies.
    default: 'osv',
    routes: { osv: 'osv vulns', sonatype: 'ossindex vulns', sonatypeiq: 'sonatypeiq evaluate' },
  },
];

export const routedAliases = resolveRoutedAliases(ROUTED_ALIASES, commands);
