/**
 * The word swap behind plain words, apart from the switch so that code with no DOM (the scripted agent that Toil UI's registry
 * build compiles) can use it. See src/plain-words.ts for what plain words are and are not. A find-and-replace with a rule book,
 * which is more than most renames get.
 */

/** The swap keeps the capital of the word it replaces, so a sentence that starts with one still starts with a capital. */
const keepCase = (from: string, to: string) => (from[0] === from[0]!.toUpperCase() ? to[0]!.toUpperCase() + to.slice(1) : to);

/**
 * The two words that confuse most, swapped inside a sentence: pull request to
 * code review, agent to AI agent. A Toil project needs no swap, because toil
 * calls it that too (#555). A `toil …` command is left alone, since a command is
 * typed exactly, and so is an agent inside an id, a package or a file name
 * (`@anthropic-ai/claude-agent-sdk`, `ui/server/agents/install.ts`,
 * `AGENTS.md`, `user-agent`).
 */
export function plainify(text: string): string {
  return text
    .replace(/\b(pull request)(s?)\b/gi, (_m, w: string, s: string) => keepCase(w, 'code review') + s)
    .replace(/(?<![\w:/@.-])(agent)(s?)\b(?![\w:/-]|\.\w)/gi, (_m, w: string, s: string) => keepCase(w, 'AI agent') + s);
}
