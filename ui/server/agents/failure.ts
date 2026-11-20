/**
 * What an agent CLI's failure says, and the fix that matches its cause
 * (#657, round 4). A run that hit its plan's usage or rate limit was told to
 * check its sign-in, which sends a person to fix the one thing that wasn't
 * broken. So the message is read for its cause: a limit says the AI plan's
 * limit was reached, when it resets where the message says, and to try then
 * or pick another AI agent; a sign-in failure keeps the sign-in advice; any
 * other failure says to try again and how to see the CLI's own error. The
 * same for Claude, Codex and Copilot, since every adapter's failure comes
 * through here. A form with a box for the reason, finally read before it is
 * stamped.
 */

/** A usage, rate or quota limit, in the words the three CLIs and their APIs use. */
const LIMIT = /usage limit|rate limit|rate-limit|quota|too many requests|\b429\b|credit balance|out of credits|purchase more credits|limit reached|reached your (?:usage|monthly|weekly|daily)/i;
/** A sign-in or credential failure. */
const AUTH = /not (?:signed|logged) in|sign(?:ed)? in again|log ?in again|please (?:log|sign) ?in|unauthori[sz]ed|\b401\b|\b403\b|invalid (?:api key|token|credentials)|authentication|expired (?:token|session|credentials)|oauth/i;
/** When a limit resets, where the message says: "try again at 7:50 PM", "resets in 3 hours", "try again after 14:00". */
const RESET = /(?:try again|resets?|available again)\s+(at|in|after|on)\s+([^.;\n()]+?)(?=\s*(?:[.;\n(]|$))/i;

export type FailureCause = 'limit' | 'auth' | 'other';

/** Why an agent run failed, read from the CLI's own message. A limit is checked first: its text often mentions an account. */
export function causeOf(message: string): FailureCause {
  if (LIMIT.test(message)) return 'limit';
  if (AUTH.test(message)) return 'auth';
  return 'other';
}

/** "at 7:50 PM", "in 3 hours": when the limit resets, as the message put it; null when it doesn't say. */
export function resetOf(message: string): string | null {
  const m = RESET.exec(message);
  return m ? `${m[1]!.toLowerCase()} ${m[2]!.trim()}` : null;
}

/**
 * The page's message and fix for one failure: "Codex failed: <the CLI's words>", with one full stop at the end however
 * the CLI ended it, and the fix for its cause.
 */
export function agentFailure(runtime: { label: string; cliLabel: string; command: string }, raw: string): { message: string; fix: string } {
  const said = raw.trim().replace(/\.+$/, '') || 'no message';
  const message = `${runtime.label} failed: ${said}.`;
  const cause = causeOf(said);
  if (cause === 'limit') {
    const reset = resetOf(said);
    return {
      message,
      fix: `Your ${runtime.label} plan's usage limit was reached${reset ? `; it resets ${reset}` : ''}. Try again ${reset ? 'then' : 'once it resets'}, or pick another AI agent under Settings, AI agent.`,
    };
  }
  if (cause === 'auth') return { message, fix: `Check that ${runtime.cliLabel} is signed in (run ${runtime.command} once on its own), then ask again.` };
  return { message, fix: `Ask again. If it fails the same way, run ${runtime.command} once on its own to see ${runtime.cliLabel}'s own error.` };
}
