import { z } from 'zod';
import { defineConfigCommand, type AnyCommand } from '../core/command.js';
import type { CommandContext, ConfigAccess } from '../core/context.js';
import { ToilError } from '../core/errors.js';
import { restResponse } from '../core/rest.js';
import { COMMIT } from '../version.js';
import { CONSENT_VERSION, DISCLAIMER, FEEDBACK_ENDPOINT, FEEDBACK_FORM } from './consent.js';
import { buildReport, KINDS, MAX_BODY, MAX_TITLE, previewText, type FeedbackReport } from './report.js';

/**
 * `toil feedback bug|feature`: a bug report or a feature request, sent to
 * Imagile's feedback endpoint (functions/feedback/, POST /api/report), which
 * files it as a public GitHub issue and emails the reporter.
 *
 * It is the one request toil makes to a host the user didn't configure
 * (CLAUDE.md principle 9; docs/bounds.md, `feedback.send`), so it is held to
 * more than any other command:
 *
 * - Nothing is sent without approval of this exact report: `--consent` on the
 *   call, or "yes" typed at a terminal after seeing it, or, through the API,
 *   the yes of the person a host passes. Without it the command sends nothing
 *   and returns what it would have sent, with the disclaimer and how to approve.
 * - CLI only: never an MCP tool, so an agent can't send one quietly. Through
 *   `@imagile-dev/toil/api` it runs only for a `person`, whose answer is the
 *   approval; the `consent` field is refused there, and a read-only call only
 *   previews.
 * - The report is only what the caller typed, plus toil's version and commit.
 *   Config, connection names, hosts and tokens are never added.
 *
 * A suggestion box with a lock on it, and the key handed to the person
 * holding the suggestion.
 */

const REQUEST_TIMEOUT_MS = 30_000;

const input = z.object({
  kind: z.enum(KINDS).optional().describe('bug or feature (or "kind" in --input-file)'),
  title: z.string().optional().describe(`A one-line summary, up to ${MAX_TITLE} characters (or "title" in --input-file)`),
  body: z.string().optional().describe(`What happened and what you expected, or what you need, up to ${MAX_BODY} characters (or "body" in --input-file)`),
  email: z.string().optional().describe('Your email address, kept private: used only to tell you about the issue (or "email" in --input-file)'),
  inputFile: z.string().min(1).optional().describe('A JSON file with any of kind, title, body and email; a flag beats the file. - reads stdin'),
  consent: z.boolean().optional().describe('Send it: you have read the report and the disclaimer, and agree. Without it nothing is sent'),
});
type Input = z.output<typeof input>;

/** The `--input-file` fields, each optional; anything else in the file is refused. */
const fileShape = z.object({ kind: z.string(), title: z.string(), body: z.string(), email: z.string() }).partial().strict();

async function readFile(path: string, ctx: CommandContext<unknown>): Promise<z.output<typeof fileShape>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await ctx.files.readText(path));
  } catch (err) {
    if (err instanceof ToilError) throw err;
    throw new ToilError('INVALID_INPUT', `--input-file must contain valid JSON: ${(err as Error).message}`, {
      fix: 'Write a JSON object such as {"kind":"bug","title":"…","body":"…","email":"you@example.com"}.',
    });
  }
  const file = fileShape.safeParse(parsed);
  if (!file.success) {
    throw new ToilError('INVALID_INPUT', `--input-file must be a JSON object with any of kind, title, body and email, as text: ${z.prettifyError(file.error)}`, {
      fix: 'Write a JSON object such as {"kind":"bug","title":"…","body":"…","email":"you@example.com"}, and nothing else.',
    });
  }
  return file.data;
}

/**
 * Where the report goes: Imagile's endpoint, or, for testing a local copy of
 * the function, a loopback address in TOIL_FEEDBACK_URL. Nothing else, so the
 * variable can't send a report, or anything in it, to another host.
 */
export function endpointFrom(env: NodeJS.ProcessEnv): string {
  const raw = env.TOIL_FEEDBACK_URL;
  if (raw === undefined || raw === '') return FEEDBACK_ENDPOINT;
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  const loopback = url !== undefined && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.username === '' && url.password === '';
  if (!url || !loopback || (url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new ToilError('CONFIG_INVALID', `TOIL_FEEDBACK_URL is ${JSON.stringify(raw)}, but it may name only a loopback address, such as http://127.0.0.1:7071.`, {
      fix: `It exists to test a local copy of the feedback function. Unset it to send to Imagile (${new URL(FEEDBACK_ENDPOINT).origin}); reports go nowhere else.`,
    });
  }
  return `${url.origin}/api/report`;
}

const send = async (ctx: CommandContext<unknown>, endpoint: string, report: FeedbackReport): Promise<string> => {
  const service = 'The toil feedback endpoint';
  try {
    const response = await restResponse<{ ok?: unknown; message?: unknown }>(
      { fetch: ctx.fetch, signal: ctx.signal ?? new AbortController().signal },
      endpoint,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report), signal: ctx.signal ?? null },
      {
        service,
        authFix: `It refused the report. Try again later, or use the form at ${FEEDBACK_FORM}.`,
        timeoutMs: REQUEST_TIMEOUT_MS,
        // Its 429 is a daily limit, so waiting a few seconds would only delay the same answer.
        retryRateLimit: false,
        urlKey: null,
        // The function answers { ok: false, error: "…" }, a sentence written for the reporter.
        errorMessage: (body) => {
          try {
            const parsed = JSON.parse(body) as { error?: unknown };
            return typeof parsed.error === 'string' ? `${service} refused the report: ${parsed.error}` : undefined;
          } catch {
            return undefined;
          }
        },
      },
    );
    return typeof response.data?.message === 'string' ? response.data.message : 'The report was accepted.';
  } catch (err) {
    if (!(err instanceof ToilError) || err.code === 'CANCELLED' || err.code === 'TIMEOUT') throw err;
    const fix =
      err.code === 'NETWORK'
        ? `Check that this machine can reach ${new URL(endpoint).host} (VPN, proxy, DNS), or use the form at ${FEEDBACK_FORM}. Nothing was filed.`
        : `Nothing was filed. Fix what the message says and run it again, or use the form at ${FEEDBACK_FORM}.`;
    throw new ToilError(err.code, err.message, { fix, details: err.details });
  }
};

function access(ctx: CommandContext<unknown>): ConfigAccess {
  if (!ctx.manage) throw new ToilError('INTERNAL', 'toil feedback ran without ctx.manage; it is defined with defineConfigCommand.');
  return ctx.manage;
}

/** `commit` is the build's own, null outside a bundle; tests pass one. */
export function feedbackCommands(commit: string | null = COMMIT): AnyCommand[] {
  const feedback = defineConfigCommand({
    path: ['feedback'],
    description: 'Send a bug report or feature request to Imagile LLC as a public GitHub issue, once you approve it',
    toolDescription:
      'Previews a bug report or feature request and, only with consent, sends it to Imagile LLC, where it becomes a public GitHub issue. CLI only. Without --consent it sends nothing and returns the exact report, the disclaimer and how to approve.',
    input,
    writes: false,
    writesLocal: false,
    kind: 'cli-only',
    args: [{ name: 'kind', field: 'kind', description: 'bug or feature', required: false }],
    options: [
      { flags: '--title <text>', field: 'title', description: `One-line summary, up to ${MAX_TITLE} characters` },
      { flags: '--body <text>', field: 'body', description: `The details, up to ${MAX_BODY} characters` },
      { flags: '--email <address>', field: 'email', description: 'Your email, kept private: used only to tell you about the issue' },
      { flags: '--input-file <file>', field: 'inputFile', description: 'JSON with any of kind, title, body and email; a flag beats the file; - reads stdin' },
      { flags: '--consent', field: 'consent', description: 'Send it: you read the report and the disclaimer, and agree' },
    ],
    // The report's text stays out of the audit log, and the address with it: the log keeps what kind it was and when.
    auditInput: { title: 'hash', body: 'hash', email: 'drop' },
    offMcpWhen: (call: Input) =>
      call.consent === true
        ? "consent isn't taken from a program: through the API, a report is sent only on the yes of the person passed as options.person, to the consent question."
        : undefined,
    examples: [
      { kind: 'bug', title: 'jira issue search ignores --limit', body: 'toil jira issue search --limit 5 returns 50 issues.', email: 'you@example.com' },
      { kind: 'feature', title: 'A --since flag on jira issue search', body: 'I want only issues updated in the last day.', email: 'you@example.com', consent: true },
    ],
    run: async (call: Input, ctx) => {
      const manage = access(ctx);
      const file = call.inputFile ? await readFile(call.inputFile, ctx) : {};
      const report = buildReport(
        { kind: call.kind ?? file.kind, title: call.title ?? file.title, body: call.body ?? file.body, email: call.email ?? file.email },
        ctx.version,
        commit,
      );
      const endpoint = endpointFrom(manage.env);
      const result = { endpoint, report, consentVersion: CONSENT_VERSION, disclaimer: DISCLAIMER };

      const noCommit = "This toil doesn't know which commit it was built from, and the feedback endpoint needs one to say which build a report is about.";
      const elsewhere = `Run a toil installed from npm (npm install -g @imagile-dev/toil), or use the form at ${FEEDBACK_FORM}.`;
      // A build that can't send previews without asking: a yes it then refused would waste the person's time.
      if (commit === null && call.consent !== true) {
        ctx.warn({ code: 'FEEDBACK_NOT_SENT', message: `Nothing was sent, and this toil can't send it: ${noCommit} ${elsewhere}` });
        return { sent: false, ...result, approve: elsewhere };
      }
      let approved = call.consent === true;
      if (!approved && manage.prompt) {
        let answer: string;
        try {
          answer = await manage.prompt.ask(previewText(endpoint, report), 'no', 'consent');
        } catch (err) {
          if (err instanceof ToilError && err.code === 'CANCELLED') throw new ToilError('CANCELLED', 'Nothing was sent: the report was not approved.', { fix: 'Run it again and answer yes to send it.' });
          throw err;
        }
        approved = /^(y|yes)$/i.test(answer.trim());
      }
      if (!approved) {
        ctx.warn({
          code: 'FEEDBACK_NOT_SENT',
          message: manage.prompt
            ? 'Nothing was sent: the report was not approved.'
            : 'Nothing was sent: this is a preview. Read data.report and data.disclaimer, then run the same command with --consent to send exactly that report.',
        });
        return { sent: false, ...result, approve: 'Run the same command with --consent once the person sending it has read the report and the disclaimer and agreed.' };
      }
      if (commit === null) {
        throw new ToilError('UNSUPPORTED', `${noCommit} Nothing was sent.`, { fix: elsewhere });
      }
      const message = await send(ctx, endpoint, report);
      return { sent: true, ...result, message };
    },
  });
  return [feedback];
}
