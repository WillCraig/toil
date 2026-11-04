/**
 * The word swap behind plain words, apart from the switch so that code with no DOM (the scripted agent that Toil UI's registry
 * build compiles) can use it. See src/plain-words.ts for what plain words are and are not. A find-and-replace with a rule book,
 * which is more than most renames get.
 */

/** "Toil project" keeps its capital T mid-sentence, since it is a name; the other swaps follow the case of the word they replace. */
const keepCase = (from: string, to: string) => (to.startsWith('Toil ') || from[0] === from[0]!.toUpperCase() ? to[0]!.toUpperCase() + to.slice(1) : to);

/**
 * The three words that confuse most, swapped inside a sentence: dossier to
 * Toil project (not "team": a dossier needn't be one, and "project" alone
 * collides with Jira's and Azure DevOps's), pull request to code review,
 * agent to AI helper. A `toil dossiers …` command is left alone, since a
 * command is typed exactly, and so is a dossier or an agent inside an id, a
 * package or a file name (`dossier-setup`, `dossier:card-payments`,
 * `@anthropic-ai/claude-agent-sdk`, `ui/server/agents/install.ts`,
 * `AGENTS.md`, `user-agent`).
 */
export function plainify(text: string): string {
  return text
    .replace(/(?<!toil |[\w:/-])(dossier)(s?)\b(?![\w:/-]|\.\w)/gi, (_m, w: string, s: string) => keepCase(w, 'Toil project') + s)
    .replace(/\b(pull request)(s?)\b/gi, (_m, w: string, s: string) => keepCase(w, 'code review') + s)
    .replace(/(?<![\w:/@.-])(agent)(s?)\b(?![\w:/-]|\.\w)/gi, (_m, w: string, s: string) => keepCase(w, 'AI helper') + s);
}
