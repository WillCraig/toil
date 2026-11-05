/**
 * The agent's settings, in the Settings view (#251): which adapter answers
 * (Claude, GitHub Copilot or Codex, or none), the model, the CLI's path and,
 * for Claude, the endpoint (the Anthropic API, Bedrock, Foundry or Vertex).
 * For each adapter it says whether its SDK is installed beside Toil UI and
 * which CLI it would start, or why it can't. The server keeps the choice in
 * `~/.toil-ui/agent.json`, never in toil's config, and there is no field for
 * a key: each SDK signs in the way its own CLI does. A form with one blank
 * left deliberately out. Each adapter keeps its own model (#344), which the
 * chat's switcher uses, and a missing SDK installs in one press from the
 * status card below (agent-install.tsx).
 *
 * Below it, the person's own words (#283): general instructions for every
 * answer, and a custom voice that replaces the theme's while "Themed agent
 * voice" is on, each up to 4,000 characters, with "Show the full prompt" to
 * see exactly what the agent is sent. The preview shows the same card with
 * saving off, and composes the prompt in the page from the same function the
 * server uses (server/agents/prompts.ts).
 */

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, Input, Label, Radio, RadioGroup, TextArea, TextField } from 'react-aria-components';
import type { AgentSettings, AgentSettingsClient, AgentStatus } from './server-client.ts';
import { Card } from './components/layout.tsx';
import type { AskStyle } from './agent.ts';
import { MAX_INSTRUCTIONS, systemPrompt } from '../server/agents/prompts.ts';
import { promptStyle } from '../server/agents/voices.ts';
import { useTheme, useThemeChoiceContext, voiceOn } from './theme-context.ts';
import { FIXTURE_NOW } from './fixtures/execute.ts';
import { AdaptersCard, helperState, STATE_WORD } from './agent-install.tsx';
import { usePlain } from './plain-words.ts';
import { SAMPLE_ADAPTER_STATUS } from './fixtures/agent-status.ts';

const ENDPOINT_LABEL: Record<string, string> = { anthropic: 'Anthropic API', bedrock: 'Amazon Bedrock', foundry: 'Microsoft Foundry', vertex: 'Google Vertex AI' };

export interface AgentSettingsPanelProps {
  client: AgentSettingsClient;
  /** A dossier to show the full prompt for: the first one toil lists, when there is one. */
  dossier?: string;
  /** The choice was saved: the pane's starters and answers come from it from now on. */
  onChange?: (status: AgentStatus) => void;
}

export function AgentSettingsPanel({ client, onChange, dossier }: AgentSettingsPanelProps) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [form, setForm] = useState<AgentSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const plain = usePlain();

  useEffect(() => {
    let live = true;
    client.status().then(
      (s) => {
        if (!live) return;
        setStatus(s);
        setForm(s.settings);
      },
      (e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [client]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setSaved('');
    try {
      const next = await client.save({ ...form, endpoint: form.adapter === 'claude' ? form.endpoint : null });
      setStatus(next);
      setForm(next.settings);
      setProblem(null);
      setSaved(next.settings.adapter === 'none' ? 'Saved: no AI helper answers.' : `Saved: ${next.adapters.find((a) => a.name === next.settings.adapter)?.label ?? next.settings.adapter} answers from the next question.`);
      onChange?.(next);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * After an install: the status again, so the radio rows see the new SDK. No
   * onChange: the chosen agent is the same, and onChange remounts the App,
   * which would close the dialog before its result is read. The chat asks for
   * the adapters each time it opens, so its switcher sees the SDK anyway.
   */
  const installed = async () => {
    try {
      const next = await client.status();
      setStatus(next);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };
  type Named = Exclude<AgentSettings['adapter'], 'none'>;
  const modelFor = (f: AgentSettings, name: Named) => (f.adapter === name ? f.model : (f.models[name] ?? null));
  const setModel = (f: AgentSettings, name: Named, v: string) => {
    const value = v || null;
    const models = { ...f.models };
    if (value) models[name] = value;
    else delete models[name];
    setForm({ ...f, models, ...(f.adapter === name ? { model: value } : {}) });
  };
  const saveWords = async (words: Pick<AgentSettings, 'instructions' | 'voice'>) => {
    if (!status) throw new Error('The agent settings have not loaded yet.');
    // The saved adapter, model and path go back as they are, so an unsaved edit above is neither lost nor sent.
    const next = await client.save({ ...status.settings, ...words });
    setStatus(next);
    setForm((f) => (f ? { ...f, instructions: next.settings.instructions, voice: next.settings.voice } : next.settings));
    return next.settings;
  };
  const ready = status?.adapters.some((a) => helperState(a) === 'ready');
  return (
    <>
    <Card as="section" className="panel" aria-labelledby="agent-settings">
      <h2 id="agent-settings">{plain.pw('Agent', 'AI helper')}</h2>
      <p className="note">{plain.text('The agent works with the subscription you already have, through its own program on this machine. Toil UI never downloads one, stores no keys, and the agent can only read: anything it suggests changing comes back as a proposal for you to apply.')}</p>
      {status?.problem && <p className="failure">{status.problem}</p>}
      {problem && (
        <p role="alert" className="failure">
          {problem}
        </p>
      )}
      {!status ? (
        !problem && <p className="note">Reading the AI helper settings…</p>
      ) : (
        !ready && (
          <div className="agent-hint" data-setup-steps="">
            <p>{plain.text("No agent is set up yet. That's fine: everything else works without one. To set one up:")}</p>
            <ol className="agent-steps">
              <li>Press Install on the AI helper your organization approves.</li>
              <li>Choose it under Which one answers, and press Save.</li>
            </ol>
          </div>
        )
      )}
    </Card>
    {status && <AdaptersCard adapters={status.adapters} client={client} onInstalled={() => void installed()} />}
    {status && form && (
      <Card as="section" className="panel" aria-labelledby="agent-choice">
        <h2 id="agent-choice">Which one answers</h2>
        <form className="agent-form" onSubmit={submit}>
          <RadioGroup
            className="agent-adapters"
            value={form.adapter}
            aria-labelledby="agent-choice"
            onChange={(v) => {
              const adapter = v as AgentSettings['adapter'];
              // Each adapter's own model and CLI path come with it (#344).
              setForm({ ...form, adapter, model: adapter === 'none' ? null : (form.models[adapter] ?? null), cliPath: adapter === 'none' ? null : (form.cliPaths[adapter] ?? null) });
            }}
          >
            <Radio value="none" className="agent-choice">
              <strong>None</strong>
              <span className="note">{plain.text('The dashboards only; a chat answers only once it is switched to an agent.')}</span>
            </Radio>
            {status.adapters.map((a) => (
              <Radio key={a.name} value={a.name} className="agent-choice">
                <strong>{a.label}</strong>
                <span className="note">{STATE_WORD[helperState(a)]}</span>
              </Radio>
            ))}
          </RadioGroup>
          <details className="agent-advanced" data-advanced="">
            <summary>Advanced: models, program path and endpoint</summary>
            <fieldset className="agent-models">
              <legend>Models, each empty for its program's default</legend>
              <p className="note">Each one runs with its own model, whether it answers by default, in a chat switched to it, or on an assignment.</p>
              {status.adapters.map((a) => (
                <TextField key={a.name} className="field-text" value={modelFor(form, a.name) ?? ''} onChange={(v) => setModel(form, a.name, v)}>
                  <Label>{a.label}'s model</Label>
                  <Input spellCheck={false} autoComplete="off" />
                </TextField>
              ))}
            </fieldset>
            {form.adapter !== 'none' && (
              <TextField className="field-text" value={form.cliPath ?? ''} onChange={(v) => setForm({ ...form, cliPath: v || null, cliPaths: { ...form.cliPaths, [form.adapter as Named]: v || undefined } })}>
                <Label>{status.adapters.find((a) => a.name === form.adapter)?.label ?? form.adapter}'s CLI path (empty to use the one on PATH)</Label>
                <Input spellCheck={false} autoComplete="off" />
              </TextField>
            )}
            {form.adapter === 'claude' && (
              <RadioGroup className="shells" orientation="horizontal" value={form.endpoint ?? ''} onChange={(v) => setForm({ ...form, endpoint: (v || null) as AgentSettings['endpoint'] })}>
                <Label className="agent-label">Endpoint</Label>
                <Radio value="" className="shell-choice">
                  Claude Code's default
                </Radio>
                {(status.adapters.find((a) => a.name === 'claude')?.endpoints ?? []).map((e) => (
                  <Radio key={e} value={e} className="shell-choice">
                    {ENDPOINT_LABEL[e] ?? e}
                  </Radio>
                ))}
              </RadioGroup>
            )}
            {form.adapter === 'claude' && form.endpoint && form.endpoint !== 'anthropic' && (
              <p className="note">Claude Code reads that cloud's own region and credentials from its environment, as it does on its own; Toil UI sets only the switch.</p>
            )}
          </details>
          <div className="proposal-actions">
            <Button type="submit" className="btn btn--accent" isDisabled={busy}>
              Save
            </Button>
            <span className="note" role="status">
              {saved}
            </span>
          </div>
        </form>
      </Card>
    )}
    {status && <InstructionsCard saved={status.settings} save={saveWords} dossier={dossier ?? null} prompt={(style) => client.prompt(dossier, style)} />}
    </>
  );
}

/** What the preview shows instead: what the local app lets you choose, changing nothing. */
export function AgentSettingsPreview() {
  const plain = usePlain();
  return (
    <>
    <Card as="section" className="panel" aria-labelledby="agent-settings">
      <h2 id="agent-settings">{plain.pw('Agent', 'AI helper')}</h2>
      <p className="note">
        {plain.text('The preview answers with a scripted agent. The local app answers with the one your organization approved: Claude, GitHub Copilot or Codex, each through its own program on your machine. You choose which one, its model and the program path here; no key is ever stored.')}
      </p>
    </Card>
    <AdaptersCard adapters={SAMPLE_ADAPTER_STATUS} client={null} />
    <InstructionsCard
      saved={{ instructions: null, voice: null }}
      dossier="card-payments"
      disabled="This is the preview, so nothing is saved. Toil UI on your own machine keeps these in its data folder, in agent.json."
      prompt={async (style, draft) => systemPrompt('card-payments', FIXTURE_NOW, promptStyle(style, draft))}
    />
    </>
  );
}

type Words = Pick<AgentSettings, 'instructions' | 'voice'>;

/**
 * General instructions and a custom voice (#283), with a counter each, a
 * Save, and "Show the full prompt". `prompt` returns what the agent is sent
 * in the page's theme; the local app asks the server, which uses what was
 * saved, and the preview composes it from what is typed.
 */
export function InstructionsCard({ saved, save, prompt, disabled, dossier }: { saved: Words; save?: (words: Words) => Promise<Words>; prompt: (style: AskStyle, draft: Words) => Promise<string>; disabled?: string; dossier: string | null }) {
  const theme = useTheme();
  const choice = useThemeChoiceContext();
  const style: AskStyle = { theme: theme.name, voice: voiceOn(theme, choice) };
  const [instructions, setInstructions] = useState(saved.instructions ?? '');
  const [voice, setVoice] = useState(saved.voice ?? '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const promptId = useId();
  const draft: Words = { instructions: instructions.trim() || null, voice: voice.trim() || null };
  const dirty = (saved.instructions ?? '') !== instructions.trim() || (saved.voice ?? '') !== voice.trim();
  // An open prompt follows what it shows: the theme on screen and, where nothing is saved (the preview), what is typed.
  const open = useRef(false);
  open.current = shown !== null;
  const live = save ? '' : `${draft.instructions ?? ''}\u0000${draft.voice ?? ''}`;
  useEffect(() => {
    if (!open.current) return;
    let current = true;
    prompt(style, draft).then(
      (text) => current && setShown(text),
      () => current && setShown(null),
    );
    return () => {
      current = false;
    };
    // prompt and draft are new each render; what the prompt depends on is the theme, the switch and the typed text.
  }, [style.theme, style.voice, live]);
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    setNote('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!save) return;
    setBusy(true);
    setNote('');
    try {
      const next = await save(draft);
      setInstructions(next.instructions ?? '');
      setVoice(next.voice ?? '');
      setProblem(null);
      setNote('Saved: the next question uses them.');
      if (shown !== null) setShown(await prompt(style, next));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    if (shown !== null) return setShown(null);
    try {
      setShown(await prompt(style, draft));
      setProblem(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  const voiceState = style.voice
    ? `Themed agent voice is on in ${theme.label}, so a custom voice here replaces ${theme.label}'s.`
    : theme.voice
      ? 'Themed agent voice is off, so a custom voice is not used until you switch it on under Settings, General.'
      : `${theme.label} has no voice, so a custom voice is not used in it. Pick a game theme to use one.`;

  return (
    <Card as="section" className="panel instructions" aria-labelledby="agent-instructions">
      <h2 id="agent-instructions">Instructions</h2>
      <p className="note">
        Your own words for every answer. They come after toil's rules in the prompt, and the rules win where the two disagree: answers still cite their items, give figures as the data has them, and suggest changes only as proposals. Instructions can't widen what the agent can do, since its tools only read.
      </p>
      {disabled && <p className="config-off">{disabled}</p>}
      {problem && (
        <p role="alert" className="failure">
          {problem}
        </p>
      )}
      <form className="agent-form" onSubmit={submit}>
        <Counted label="General instructions" hint="For example: answer in British English, or lead with risks." value={instructions} onChange={edit(setInstructions)} />
        <Counted label="Custom voice" hint={`Replaces the theme's voice while Themed agent voice is on. ${voiceState}`} value={voice} onChange={edit(setVoice)} />
        <div className="proposal-actions">
          {save && (
            <Button type="submit" className="btn btn--accent" isDisabled={busy || !dirty}>
              Save
            </Button>
          )}
          <Button className="btn" onPress={() => void toggle()} aria-expanded={shown !== null} aria-controls={shown !== null ? promptId : undefined} data-full-prompt="">
            {shown !== null ? 'Hide the full prompt' : 'Show the full prompt'}
          </Button>
          <span className="note" role="status">
            {note}
          </span>
        </div>
      </form>
      {shown !== null && (
        <div className="full-prompt">
          <p className="note">
            {save
              ? `What the agent is sent now, in this theme, for a question about ${dossier ?? 'a dossier'}${dossier ? ', the first dossier toil lists' : ''}.${dirty ? ' Your unsaved changes are not in it until you save.' : ''}`
              : `What the agent would be sent in this theme, for the sample dossier ${dossier ?? 'card-payments'}.`}
          </p>
          <pre id={promptId} className="full-prompt__text" tabIndex={0} role="region" aria-label="The full prompt" data-scroller="">
            {shown}
          </pre>
        </div>
      )}
    </Card>
  );
}

/** A labelled text area with a visible count of its characters against the limit. */
function Counted({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <TextField className="field-text field-text--area" value={value} onChange={onChange} maxLength={MAX_INSTRUCTIONS} aria-describedby={`${id}-hint ${id}-count`}>
      <Label>{label}</Label>
      <TextArea rows={4} spellCheck />
      <span className="note" id={`${id}-hint`}>
        {hint}
      </span>
      <span className="note counter" id={`${id}-count`}>
        {value.length.toLocaleString('en-GB')} of {MAX_INSTRUCTIONS.toLocaleString('en-GB')} characters
      </span>
    </TextField>
  );
}
