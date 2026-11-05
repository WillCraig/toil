/**
 * Feedback, from the header (#265): a bug report or a feature request, sent
 * through `toil feedback` and nothing else (src/feedback.ts). The dialog asks
 * for the kind, a title, the details and the person's email, and shows, as
 * they type, exactly the report toil would send, then toil's own disclaimer
 * and a checkbox. Send is possible only while the box is ticked, and any edit
 * clears the tick, so the yes always belongs to the report on screen. Toil UI
 * adds nothing to the report: no toil project, connection, host or cache content.
 *
 * Built on React Aria's Modal and Dialog, so focus is trapped while it is
 * open, Escape closes it, and focus goes back to the Feedback button. Every
 * change of mind voids the signature, which is how signatures ought to work.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button, Checkbox, Dialog, DialogTrigger, Heading, Input, Label, Modal, ModalOverlay, Radio, RadioGroup, TextArea, TextField } from 'react-aria-components';
import { feedbackData, feedbackProblem, type FeedbackApi, type FeedbackData, type FeedbackFields, type FeedbackKind } from './feedback.ts';
import './feedback.css';

const EMPTY: FeedbackFields = { kind: 'bug', title: '', body: '', email: '' };
/** How long typing pauses before the preview is asked for again. */
const PREVIEW_DELAY_MS = 300;

/** The header's Feedback button and the dialog it opens. */
export function FeedbackButton({ api }: { api: FeedbackApi }) {
  return (
    <DialogTrigger>
      <Button className="btn feedback-open">Feedback</Button>
      <FeedbackModal api={api} />
    </DialogTrigger>
  );
}

/**
 * The dialog itself. Inside a DialogTrigger it opens from the trigger; the
 * compact header's menu opens it with `isOpen` instead, once the menu has
 * closed, so focus goes back to the menu button.
 */
export function FeedbackModal({ api, isOpen, onOpenChange }: { api: FeedbackApi; isOpen?: boolean; onOpenChange?: (open: boolean) => void }) {
  const controlled = isOpen === undefined ? {} : { isOpen, ...(onOpenChange ? { onOpenChange } : {}) };
  return (
    <ModalOverlay className="feedback-overlay" data-backdrop="" isDismissable {...controlled}>
      <Modal className="feedback-modal">
        <Dialog className="feedback-dialog" aria-labelledby="feedback-title">
          {({ close }) => <FeedbackForm api={api} close={close} />}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

type Preview = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; data: FeedbackData } | { state: 'problem'; message: string };

export function FeedbackForm({ api, close }: { api: FeedbackApi; close: () => void }) {
  const [fields, setFields] = useState<FeedbackFields>(EMPTY);
  const [agreed, setAgreed] = useState(false);
  const [preview, setPreview] = useState<Preview>({ state: 'idle' });
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: true; message: string } | { ok: false; message: string } | null>(null);
  const done = useRef<HTMLParagraphElement>(null);

  const filled = fields.title.trim() !== '' && fields.body.trim() !== '' && fields.email.trim() !== '';
  useEffect(() => {
    if (!filled) {
      setPreview({ state: 'idle' });
      return;
    }
    const controller = new AbortController();
    setPreview({ state: 'loading' });
    const timer = setTimeout(() => {
      api.preview(fields, controller.signal).then(
        (envelope) => {
          if (controller.signal.aborted) return;
          const data = feedbackData(envelope);
          setPreview(data ? { state: 'ready', data } : { state: 'problem', message: feedbackProblem(envelope) });
        },
        (e: unknown) => !controller.signal.aborted && setPreview({ state: 'problem', message: e instanceof Error ? e.message : String(e) }),
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, fields, filled]);

  useEffect(() => {
    if (result?.ok) done.current?.focus();
  }, [result]);

  // The yes is for the report on screen: any edit takes it back.
  const change = (patch: Partial<FeedbackFields>) => {
    setFields((f) => ({ ...f, ...patch }));
    setAgreed(false);
    setResult(null);
  };

  const ready = preview.state === 'ready' ? preview.data : null;
  const canSend = ready !== null && agreed && !sending && api.disabled === null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    setSending(true);
    try {
      const envelope = await api.send(fields);
      const data = feedbackData(envelope);
      setResult(data?.sent ? { ok: true, message: data.message ?? 'Sent.' } : { ok: false, message: data ? 'toil sent nothing: the report was not approved.' : feedbackProblem(envelope) });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSending(false);
    }
  };

  if (result?.ok) {
    return (
      <div className="feedback-body">
        <Heading slot="title" level={2} id="feedback-title">
          Feedback sent
        </Heading>
        <p ref={done} tabIndex={-1} role="status">
          {result.message}
        </p>
        <p className="note">It becomes a public GitHub issue in imagile-dev/toil, and the email address you gave hears when it is filed and when it closes.</p>
        <div className="feedback-actions">
          <Button className="btn btn--accent" onPress={close}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form className="feedback-body" onSubmit={submit} noValidate>
      <Heading slot="title" level={2} id="feedback-title">
        Send feedback to Imagile
      </Heading>
      <p className="note">
        A bug report or a feature request, sent through <code>toil feedback</code>. Only what you type below is sent, with toil's version and commit.
      </p>
      <RadioGroup className="shells" orientation="horizontal" value={fields.kind} onChange={(v) => change({ kind: v as FeedbackKind })}>
        <Label className="feedback-label">Kind</Label>
        <Radio value="bug" className="shell-choice">
          Bug report
        </Radio>
        <Radio value="feature" className="shell-choice">
          Feature request
        </Radio>
      </RadioGroup>
      <TextField className="field-text" value={fields.title} onChange={(v) => change({ title: v })} maxLength={120} isRequired>
        <Label className="feedback-label">Title</Label>
        <Input autoComplete="off" />
      </TextField>
      <TextField className="field-text feedback-details" value={fields.body} onChange={(v) => change({ body: v })} maxLength={4000} isRequired>
        <Label className="feedback-label">Details</Label>
        <TextArea rows={5} />
      </TextField>
      <TextField className="field-text" type="email" value={fields.email} onChange={(v) => change({ email: v })} isRequired>
        <Label className="feedback-label">Your email, kept private</Label>
        <Input autoComplete="email" spellCheck={false} />
      </TextField>

      <section className="feedback-preview" aria-labelledby="feedback-preview-title">
        <h3 id="feedback-preview-title">Exactly what will be sent</h3>
        <div aria-live="polite">
          {preview.state === 'idle' && <p className="note">Fill in the title, details and email to see the report.</p>}
          {preview.state === 'loading' && <p className="note">Asking toil for the report…</p>}
          {preview.state === 'problem' && <p className="failure">{preview.message}</p>}
          {ready && (
            <p className="note">
              To <code>{ready.endpoint}</code>:
            </p>
          )}
        </div>
        {ready && (
          <pre className="feedback-report" tabIndex={0} aria-label="The report, as toil would send it">
            {JSON.stringify(ready.report, null, 2)}
          </pre>
        )}
      </section>

      {ready && (
        <div className="feedback-consent">
          <p id="feedback-disclaimer" className="feedback-disclaimer">
            {ready.disclaimer}
          </p>
          <Checkbox className="check" isSelected={agreed} onChange={setAgreed} isRequired aria-describedby="feedback-disclaimer">
            <span className="box" aria-hidden="true">
              {agreed ? '✓' : ''}
            </span>
            I have removed company data from this report and agree to send it to Imagile LLC.
          </Checkbox>
        </div>
      )}
      {api.disabled && (
        <p className="config-off">
          <strong>Sending is turned off.</strong> {api.disabled}
        </p>
      )}
      {result && !result.ok && (
        <p role="alert" className="failure">
          {result.message}
        </p>
      )}
      <div className="feedback-actions">
        <Button type="submit" className="btn btn--accent" isDisabled={!canSend}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
        <Button className="btn" onPress={close}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
