# The chat starts on an agent that can answer, and remembers the one picked

- **Remembering widened from Analyze to any whole answer that names an agent.** The
  server (`POST agent/ask`) now records the adapter for the dossier after any answer
  that is whole, not only Analyze's. Unchanged: nothing is recorded from a question that
  names no adapter, fails, is stopped or comes back empty. Why: an agent picked for
  ordinary questions was never saved, so a reload went back to the Settings default,
  which made the pick feel like it did nothing. This changes #494's rule that only
  Analyze remembers.
- **A third step in the order: the first ready adapter.** Remembered agent, then the
  Settings default, then the first adapter in the list's order that is ready, then
  nothing. Before, a Settings default that could not run (a Copilot CLI that is a `.bat`
  shim, say) left the chat showing it and failing the first question while Claude or
  Codex could have answered.
- **The fallback is sent, and the hint says so.** Any default whose source is not
  Settings goes with the question, so the server answers with what the page shows.
  The hint reads "your default can't run" when Settings names an
  agent, and "the first one ready" when it names none (principle 4: the person is told
  their default is not what is answering).
- **A fallback is never remembered.** It goes with `fallback: true`, and the server
  records only an agent someone chose (picked in the chat, or the dossier's own), so
  fixing the Settings default later brings it back instead of leaving the dossier on
  the stand-in.
- **Toil UI's screens are not contracts (principle 7)**, so none of this is breaking.
