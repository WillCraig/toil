/**
 * The SDK versions Toil UI was tested with (#344), each exact, and zod beside
 * Claude's, which its tool schemas are built with (the zod toil pins). Install
 * (install.ts) installs exactly these, and nothing else. Pure, so the page
 * can show them too. test/install.test.ts holds them to ui/package.json's
 * peer minimums and the root package.json's zod. The approved-supplier list,
 * one line per supplier, laminated.
 */

import type { AdapterName } from './runtime.ts';

export const TESTED: Record<AdapterName, readonly string[]> = {
  claude: ['@anthropic-ai/claude-agent-sdk@0.3.289', 'zod@4.6.5'],
  copilot: ['@github/copilot-sdk@1.0.16'],
  codex: ['@openai/codex-sdk@0.160.0'],
};

/**
 * The vendor's own CLI, where it ships on npm as a loader script Node can run
 * (the Copilot CLI, tested at 1.0.100), installed in the same press as its SDK
 * so Install leaves one working helper, not half of one. Exact, like TESTED.
 * Extends the exception above at the maintainer's request (2026-11-05).
 */
export const CLI_PACKAGES: Partial<Record<AdapterName, string>> = {
  copilot: '@github/copilot@1.0.100',
};

/** How old every release an install resolves must be (CLAUDE.md, Secrets: the 14-day rule). */
export const MIN_AGE_DAYS = 14;

/** The day MIN_AGE_DAYS before now, as npm's --before takes it. */
export const beforeDate = (now: string) => new Date(Date.parse(now) - MIN_AGE_DAYS * 86_400_000).toISOString().slice(0, 10);

/** The tested version of an adapter's SDK: 0.160.0. */
export const testedVersion = (name: AdapterName) => TESTED[name][0]!.slice(TESTED[name][0]!.lastIndexOf('@') + 1);
