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
import type { AdapterStatus, AgentSettings, AgentSettingsClient, AgentStatus } from './server-client.ts';
import { Card } from './components/layout.tsx';
import type { AskStyle } from './agent.ts';
import { MAX_INSTRUCTIONS, systemPrompt } from '../server/agents/prompts.ts';
import { promptStyle } from '../server/agents/voices.ts';
import { useTheme, useThemeChoiceContext, voiceOn } from './theme-context.ts';
import { FIXTURE_NOW } from './fixtures/execute.ts';
import { AdaptersCard, InstallDialog, helperState, needsInstall, statusLines, STATE_WORD } from './agent-install.tsx';
import { usePlain } from './plain-words.ts';
import { SAMPLE_ADAPTER_STATUS } from './fixtures/agent-status.ts';

const ENDPOINT_LABEL: Record<string, string> = { anthropic: 'Anthropic API', bedrock: 'Amazon Bedrock', foundry: 'Microsoft Foundry', vertex: 'Google Vertex AI' };

export interface AgentSettingsPanelProps {
  client: AgentSettingsClient;
  /** A toil project to show the full prompt for: the first one toil lists, when there is one. */
  toilProject?: string;
  /** The choice was saved: the pane's starters and answers come from it from now on. */
  onChange?: (status: AgentStatus) => void;
}

export function AgentSettingsPanel({ client, onChange, toilProject }: AgentSettingsPanelProps) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [form, setForm] = useState<AgentSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState<AdapterStatus | null>(null);
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
      const next = await client.save({ ...form, endpoint: form.adapter === 'claude' ? form.endpoint : null, instructions: (form.instructions ?? '').trim() || null, voice: (form.voice ?? '').trim() || null });
      setStatus(next);
      setForm(next.settings);
      setProblem(null);
      setSaved(next.settings.adapter === 'none' ? 'Saved: no AI agent answers.' : `Saved: ${next.adapters.find((a) => a.name === next.settings.adapter)?.label ?? next.settings.adapter} answers from the next question, with your instructions.`);
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
  return (
    <>
    <form className="agent-form" onSubmit={submit}>
    <Card as="section" className="panel" aria-labelledby="agent-settings">
      <h2 id="agent-settings">{plain.pw('Agent', 'Your AI agents')}</h2>
      <p className="note">{plain.text('Each runs on the subscription you already have, through its own program on this machine. Toil UI stores no keys, and the agent can only read: a change it suggests comes back as a proposal for you to apply.')}</p>
      {status?.problem && <p className="failure">{status.problem}</p>}
      {problem && (
        <p role="alert" className="failure">
          {problem}
        </p>
      )}
      {!status || !form ? (
        !problem && <p className="note">Reading the AI agent settings…</p>
      ) : (
        <>
          <RadioGroup
            className="agent-adapters helper-list"
            value={form.adapter}
            aria-label="Which AI agent answers"
            onChange={(v) => {
              const adapter = v as AgentSettings['adapter'];
              // Each adapter's own model and CLI path come with it (#344).
              setForm({ ...form, adapter, model: adapter === 'none' ? null : (form.models[adapter] ?? null), cliPath: adapter === 'none' ? null : (form.cliPaths[adapter] ?? null) });
            }}
          >
            <div className="helper-row">
              <Radio value="none" className="agent-choice">
                <strong>None</strong>
                <span className="note">{plain.text('The dashboards only; a chat answers only once it is switched to an agent.')}</span>
              </Radio>
            </div>
            {status.adapters.map((a) => {
              const state = helperState(a);
              return (
                <div key={a.name} className="helper-row" data-adapter={a.name} data-state={state}>
                  <Radio value={a.name} className="agent-choice">
                    <strong>{a.label}</strong>
                    <span className={state === 'ready' ? 'agent-pick__ready' : 'note'}>{STATE_WORD[state]}</span>
                  </Radio>
                  {needsInstall(a) && (
                    <Button className="btn btn--accent" onPress={() => setInstalling(a)} data-install={a.name}>
                      Install {a.label}
                    </Button>
                  )}
                  {state === 'fix' && (
                    <p className="agent-notice helper-row__wide" data-needs-fix="">
                      {a.cli.problem ?? 'Its command-line program was not found.'}
                      {a.cli.fix ? ` ${a.cli.fix}` : ''}
                    </p>
                  )}
                  <details className="agent-details helper-row__wide">
                    <summary>Details for whoever sets it up</summary>
                    {statusLines(a).map((line, i) => (
                      <p key={i} className="note">
                        {line}
                      </p>
                    ))}
                  </details>
                </div>
              );
            })}
          </RadioGroup>
          <p className="note">Install runs one npm command, shown to you first, at the version Toil UI was tested with. Nothing runs until you press Install in that window.</p>
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
                <Label>{status.adapters.find((a) => a.name === form.adapter)?.label ?? form.adapter}'s program location (empty to find it automatically)</Label>
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
        </>
      )}
    </Card>
    {status && form && (
      <>
        <InstructionsCard
          value={{ instructions: form.instructions, voice: form.voice }}
          onChange={(w) => {
            setForm({ ...form, ...w });
            setSaved('');
          }}
          saved={status.settings}
          toilProject={toilProject ?? null}
          prompt={(style) => client.prompt(toilProject, style)}
        />
        <div className="proposal-actions">
          <Button type="submit" className="btn btn--accent" isDisabled={busy}>
            Save
          </Button>
          <span className="note" role="status">
            {saved}
          </span>
        </div>
      </>
    )}
    </form>
    {installing && <InstallDialog adapter={installing} plan={installing.install} client={client} onClose={() => setInstalling(null)} onInstalled={() => void installed()} />}
    </>
  );
}

/** What the preview shows instead: what the local app lets you choose, changing nothing. */
export function AgentSettingsPreview() {
  const plain = usePlain();
  return (
    <>
    <Card as="section" className="panel" aria-labelledby="agent-settings">
      <h2 id="agent-settings">{plain.pw('Agent', 'AI agent')}</h2>
      <p className="note">
        {plain.text('The preview answers with a scripted agent. The local app answers with the one your organization approved: Claude, GitHub Copilot or Codex, each through its own program on your machine. You choose which one, its model and the program path here; no key is ever stored.')}
      </p>
    </Card>
    <AdaptersCard adapters={SAMPLE_ADAPTER_STATUS} client={null} />
    <PreviewInstructions />
    </>
  );
}

type Words = Pick<AgentSettings, 'instructions' | 'voice'>;

/** The preview's copy of the card: it composes the prompt from what is typed, and saves nothing. */
function PreviewInstructions() {
  const [words, setWords] = useState<Words>({ instructions: null, voice: null });
  return (
    <InstructionsCard
      value={words}
      onChange={setWords}
      toilProject="card-payments"
      disabled="This is the preview, so nothing is saved."
      prompt={async (style, draft) => systemPrompt('card-payments', FIXTURE_NOW, promptStyle(style, draft))}
    />
  );
}

/**
 * General instructions and a custom voice (#283), with a counter each and
 * "Show the full prompt". They have no Save of their own: they are part of the
 * AI agent form and go with its one Save. `prompt` returns what the agent is
 * sent in the page's theme; the local app asks the server, which uses what was
 * saved (`saved`), and the preview composes it from what is typed.
 */
export function InstructionsCard({ value, onChange, saved, prompt, disabled, toilProject }: { value: Words; onChange: (words: Words) => void; saved?: Words; prompt: (style: AskStyle, draft: Words) => Promise<string>; disabled?: string; toilProject: string | null }) {
  const theme = useTheme();
  const choice = useThemeChoiceContext();
  const style: AskStyle = { theme: theme.name, voice: voiceOn(theme, choice) };
  const instructions = value.instructions ?? '';
  const voice = value.voice ?? '';
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const promptId = useId();
  const draft: Words = { instructions: instructions.trim() || null, voice: voice.trim() || null };
  const dirty = saved !== undefined && ((saved.instructions ?? '') !== instructions.trim() || (saved.voice ?? '') !== voice.trim());
  // An open prompt follows what it shows: the theme on screen and, where nothing is saved (the preview), what is typed.
  const open = useRef(false);
  open.current = shown !== null;
  const live = saved ? '' : `${draft.instructions ?? ''}\u0000${draft.voice ?? ''}`;
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
      ? 'Themed agent voice is off, so a custom voice is not used until you switch it on under Settings, Appearance.'
      : `${theme.label} has no voice, so a custom voice is not used in it. Pick a game theme to use one.`;

  return (
    <Card as="section" className="panel instructions" aria-labelledby="agent-instructions">
      <h2 id="agent-instructions">Instructions</h2>
      <p className="note">
        Your own words for every answer. They come after Toil's own rules, and the rules win where the two disagree: answers still cite their items, give figures as the data has them, and suggest changes only as proposals. Instructions can't widen what the AI agent can do, since it can only read.
      </p>
      {disabled && <p className="config-off">{disabled}</p>}
      {problem && (
        <p role="alert" className="failure">
          {problem}
        </p>
      )}
      <Counted label="General instructions" hint="For example: answer in British English, or lead with risks." value={instructions} onChange={(v) => onChange({ ...value, instructions: v })} />
      <Counted label="Custom voice" hint={`Replaces the theme's voice while Themed agent voice is on. ${voiceState}`} value={voice} onChange={(v) => onChange({ ...value, voice: v })} />
      <div className="proposal-actions">
        <Button className="btn" onPress={() => void toggle()} aria-expanded={shown !== null} aria-controls={shown !== null ? promptId : undefined} data-full-prompt="">
          {shown !== null ? 'Hide the full prompt' : 'Show the full prompt'}
        </Button>
      </div>
      {shown !== null && (
        <div className="full-prompt">
          <p className="note">
            {saved
              ? `What the AI agent is sent now, in this theme, for a question about ${toilProject ?? 'a Toil project'}.${dirty ? ' Your unsaved changes are not in it until you save.' : ''}`
              : `What the AI agent would be sent in this theme, for the sample Toil project ${toilProject ?? 'card-payments'}.`}
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
