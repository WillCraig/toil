import { LENSES, type BriefSettings } from './brief.js';
import type { AnalyzeSettings, ToilProjectAnalyze } from './prompt.js';

/**
 * A toil project's Analyze settings, with the standard filling whatever it leaves
 * out (#494): its lenses in its order, then any it didn't list in the
 * standard order, each with its own threshold or the default. One function,
 * so `toil projects brief`, `toil projects analyze` and Toil UI read a toil project the same
 * way. The standard operating procedure, with the toil project's amendments
 * stapled to the front.
 */
export function analyzeSettings(analyze: ToilProjectAnalyze | undefined, wipLimit: number | null): AnalyzeSettings {
  const listed = analyze?.lenses ?? [];
  const lenses: BriefSettings['lenses'] = [
    ...listed.map((l) => {
      const def = LENSES.find((d) => d.id === l.id)!;
      return { id: l.id, on: l.on ?? def.on, threshold: l.threshold ?? def.threshold };
    }),
    ...LENSES.filter((d) => !listed.some((l) => l.id === d.id)).map((d) => ({ id: d.id, on: d.on, threshold: d.threshold })),
  ];
  return {
    audience: analyze?.audience ?? 'lead',
    settings: { lenses, wipLimit },
    focus: { goal: analyze?.goal ?? null, watchFor: analyze?.watchFor ?? null, leaveOut: analyze?.leaveOut ?? null },
  };
}

/** Whether a toil project tunes Analyze at all, or takes the standard as it is. */
export const isStandard = (analyze: ToilProjectAnalyze | undefined) => !analyze || Object.keys(analyze).length === 0;
