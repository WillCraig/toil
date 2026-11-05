import { ok } from '../screens.js';
import { pal, paint } from '../term.js';
import { commandLine, type Caps, type StepResult, type View } from '../view.js';
import { toilProjectsOutcome } from './toil-projects.js';
import { skillsOutcome } from './skills.js';

/**
 * What a run printed: each command as you'd type it, and what it said. The
 * menu never summarises a command into something it didn't say, so the
 * screen is the envelope, read aloud.
 */

/** A step's arguments as the screen shows them: a long --text (the output of the steps before, passed on) is named rather than printed. */
export function shownArgs(args: readonly string[]): string[] {
  return args.map((a, i) => (args[i - 1] === '--text' && a.length > 120 ? `<${a.split('\n').length} results from the steps above>` : a));
}

/** One line about what a finished command did, from its envelope. */
export function outcome(result: StepResult): { good: boolean; text: string; fix?: string; warnings: string[] } {
  const e = result.envelope;
  const warnings = (e.meta.warnings ?? []).map((w) => w.message);
  if (!e.ok) return { good: false, text: `${e.error.code}: ${e.error.message}`, ...(e.error.fix ? { fix: e.error.fix } : {}), warnings };
  const said = toilProjectsOutcome(result);
  if (said) return { ...said, warnings };
  const d = (e.data ?? {}) as Record<string, unknown>;
  const [area, verb] = result.args;
  const name = String(d.name ?? '');
  const text =
    area === 'skills' || area === 'skill'
      ? skillsOutcome(result)
      : verb === 'test'
      ? d.live
        ? `${name} answered ${String(d.request)} on ${String(d.host)}${d.authenticated === false ? ', without needing the credential' : ''}.`
        : `${name}: settings and secret are complete; nothing was sent.`
      : verb === 'add'
        ? `Saved ${name} (${String(d.area)}) to your config file.`
        : verb === 'login'
          ? `Stored the new secret for ${name}.`
          : verb === 'writes'
            ? `Writes are ${d.writes ? 'on' : 'off'} for ${name}${d.changed ? '' : ' (they already were)'}.`
            : verb === 'default'
              ? `${name} is now the ${String(d.area)} default${d.previous && d.previous !== name ? `, instead of ${String(d.previous)}` : ''}.`
              : verb === 'remove'
                ? `Removed ${name}.`
                : 'Done.';
  return { good: true, text, warnings };
}

const DATA_LINES = 24;

/** What a command returned, as indented JSON, cut short with a count: the full envelope is a shell away. */
export function dataLines(caps: Caps, data: unknown): string[] {
  const all = (JSON.stringify(data, null, 2) ?? 'null').split('\n');
  const shown = all.slice(0, DATA_LINES).map((line) => `  ${line}`);
  return all.length > DATA_LINES ? [...shown, paint(caps, pal(caps).muted, `  … ${all.length - DATA_LINES} more lines; run it in a shell (add --pretty) for all of it.`)] : shown;
}

export const resultView: View = {
  // The run's title was on screen while it ran; the breadcrumb stays where the user is.
  title: () => '',
  body: (caps, p) => {
    const results = p.frame.results ?? [];
    const mark = (good: boolean) => ok(caps, good, caps.unicode ? (good ? '✓' : '✗') : good ? 'ok' : 'x');
    // Config warnings ride on every envelope; the health check already shows them.
    const known = new Set('error' in p.data.config ? [] : p.data.config.warnings.map((w) => w.message));
    const lines: string[] = [];
    for (const r of results) {
      const o = outcome(r);
      lines.push(paint(caps, pal(caps).faint, `$ ${commandLine(p.data, shownArgs(r.args))}`));
      // Which connection answered, so a result from the wrong one is obvious.
      const via = r.envelope.meta.context?.connection;
      if (p.frame.run?.showData && via) lines.push(paint(caps, pal(caps).muted, `  on ${String(via.value)} (${via.source})`));
      if (p.frame.run?.showData && r.envelope.ok) lines.push(...dataLines(caps, r.envelope.data));
      else lines.push(`${mark(o.good)} ${o.good ? o.text : ok(caps, false, o.text)}`);
      if (o.fix) lines.push(paint(caps, pal(caps).muted, `  Fix: ${o.fix}`));
      for (const w of o.warnings.filter((m) => !known.has(m))) lines.push(paint(caps, pal(caps).muted, `  Note: ${w}`));
      lines.push('');
    }
    const passed = (p.frame.results ?? []).some((r) => shownArgs(r.args).some((a, i) => a !== r.args[i]));
    lines.push(
      paint(
        caps,
        pal(caps).faint,
        passed
          ? 'Each step above is a plain command; a --text step takes the output of the steps before it, so on the command line pipe them in instead: ... | toil util owi map, then ... | toil projects brief <toil-project>.'
          : 'Each step above is a plain command: run it yourself any time.',
      ),
    );
    return lines;
  },
  // Where the run says to go next; the menu takes this screen off the stack first.
  items: (p) => [{ label: 'Continue', hint: '', action: p.frame.run?.next?.(p.frame.results ?? [], p.data) ?? { back: true } }],
};
