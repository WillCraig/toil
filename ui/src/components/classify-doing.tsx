/**
 * "How it's doing", folded at the top of the Classify view (#566): how often
 * people agreed with the answers they checked, which source they overrule most
 * (said in plain words, never a code name), and how many corrections have come
 * in since the categories were last improved. Once there are ten, "Improve with
 * your AI agent" runs the tune on the chosen agent and shows what it proposes
 * beside the before and after scores on corrections it never saw; a revision
 * that scores worse is shown as worse. Applying one is a person's command and
 * only a press runs it. Every share nobody has read is a dash, "not read yet",
 * never 0%: unknown is not zero (principle 12). The quarterly review of the
 * quarterly review, now with a denominator.
 */

import { useState } from 'react';
import { Button } from 'react-aria-components';
import type { AgentChoice, ClassifyStats, SaveResult, TuneResult } from '../classify-api.ts';
import { useClassify } from '../classify-state.tsx';
import { useData } from '../data.ts';
import { useWorkInsights } from '../insights-data.ts';
import { shareText, shareWords, sourceName, TUNE_AFTER, timesText } from '../model/classify.ts';
import { Help } from './help.tsx';
import { ChevronDownIcon } from './icons.tsx';
import { AgentMark } from './agent-mark.tsx';
import { AGENT_SETTINGS_HREF } from '../format.ts';
import { NavButton } from './nav-button.tsx';

const KEPT: Record<SaveResult['kept'], string> = { 'built-in': 'kept as a built-in scheme', yours: 'kept as your own copy', shared: 'saved in the repository, ready for a pull request', beside: 'saved beside this Toil project' };

/** The first sentence about the source people overrule most, or null when nobody has overruled anything. */
export function overruledLine(stats: ClassifyStats | null, scheme: Parameters<typeof sourceName>[1], names: Record<string, string>): string | null {
  const top = stats?.sources.find((s) => s.overruled > 0);
  if (!top) return null;
  const to = Object.entries(top.overruledTo).sort((a, b) => b[1] - a[1]);
  const where = to.length === 1 ? `, all to ${names[to[0]![0]] ?? to[0]![0]}` : `, to ${to.map(([id, n]) => `${names[id] ?? id} ${n}`).join(' and ')}`;
  const what = sourceName(top.source, scheme);
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} was overruled ${timesText(top.overruled, top.checked)}${where}.`;
}

export function HowItsDoing({ agents, adapter }: { agents: AgentChoice[]; adapter: string | undefined }) {
  const { toilProject, classification } = useData();
  const ins = useWorkInsights();
  const { api } = useClassify();
  const view = classification?.view ?? null;
  const stats = view?.stats ?? null;
  const [tuning, setTuning] = useState(false);
  const [tuned, setTuned] = useState<TuneResult | { error: string } | null>(null);
  const [saved, setSaved] = useState<SaveResult | { error: string } | null>(null);
  const names = Object.fromEntries(ins.scheme.categories.map((c) => [c.id, c.name]));
  const standing = view?.standing ?? {};
  const overrule = stats && view ? overruledLine(stats, view.scheme, names) : null;
  const since = stats?.sinceLastTune ?? null;
  const enough = since !== null && since >= TUNE_AFTER;
  const ready = agents.some((a) => a.ready);
  const improve = async () => {
    if (!api) return;
    setTuning(true);
    setTuned(null);
    setSaved(null);
    try {
      // The corrections' items are the ones the held-back score is read on; the server picks which are held back.
      const items = ins.items.filter((i) => Object.hasOwn(standing, i.id));
      setTuned(await api.tune(toilProject.name, items, adapter));
    } catch (e) {
      setTuned({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setTuning(false);
    }
  };
  const use = async (id: string) => {
    if (!api) return;
    try {
      const result = await api.applyRevision(id);
      setSaved(result);
      await classification?.reload();
    } catch (e) {
      setSaved({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <details className="doing" data-how-its-doing="">
      <summary>
        {/* One line (#657): the figure, or a dash and why there is none, never a 0 (principle 12). The rest is behind the expand. */}
        <span className="sr-only">How it's doing. </span>
        {stats
          ? stats.agreement.overall === null || stats.agreement.checked === 0
            ? 'Agreement: – (not checked yet)'
            : `Agreement: ${shareWords(stats.agreement.overall)} of ${stats.agreement.checked} checked`
          : 'Agreement: – (not read yet)'}
        <ChevronDownIcon size={14} className="doing__chevron" />
      </summary>
      <div className="doing__body">
        <p>
          Agreement: <strong data-share="agreement">{stats ? shareText(stats.agreement.overall) : '—'}</strong>
          {stats ? (stats.agreement.checked > 0 ? <> of {stats.agreement.checked} answers people checked.</> : <>. Nobody has checked an answer yet, so there is no figure.</>) : <>. The record could not be read, so this is not read yet.</>}{' '}
          <Help topic="classify-doing" />
        </p>
        {overrule && <p data-overruled="">{overrule}</p>}
        {stats && stats.sources.length > 0 && (
          <table className="doing__sources">
            <caption className="sr-only">How often people agreed with each source</caption>
            <thead>
              <tr>
                <th scope="col">Where the answer came from</th>
                <th scope="col">Checked</th>
                <th scope="col">Agreed</th>
              </tr>
            </thead>
            <tbody>
              {stats.sources.slice(0, 5).map((s) => (
                <tr key={s.source}>
                  <th scope="row">{sourceName(s.source, view!.scheme)}</th>
                  <td>{s.checked}</td>
                  <td data-share="source">{shareText(s.agreement)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p data-since-tune="">{since === null ? 'Corrections since the categories were last improved: not read yet.' : `${since} ${since === 1 ? 'correction' : 'corrections'} since the categories were last improved.`}</p>
        {view?.notes.map((n) => (
          <p key={n} className="note">
            {n}
          </p>
        ))}
        {enough && (
          <div className="doing__improve">
            <span className="control-row__group">
              <Button className="btn" onPress={() => void improve()} isDisabled={tuning || !ready || !api} data-improve="">
                <AgentMark />
                {tuning ? 'Asking your AI agent…' : 'Improve with your AI agent'}
              </Button>
              <Help topic="classify-improve" />
            </span>
            {!ready && (
              <p className="note">
                No AI agent is set up yet.{' '}
                <NavButton href={AGENT_SETTINGS_HREF} size="sm">
                  Set one up in Settings, AI agent
                </NavButton>
              </p>
            )}
          </div>
        )}
        {tuned && 'error' in tuned && (
          <p className="failure" role="alert">
            {tuned.error}
          </p>
        )}
        {tuned && 'changes' in tuned && (
          <section className="tune" aria-label="A proposed improvement" data-tune="">
            <h3>Proposed changes{tuned.by ? ` from ${tuned.by}` : ''}</h3>
            {tuned.changes.length === 0 ? <p className="note">It proposes no change to the categories.</p> : (
              <ul className="tune__changes">
                {tuned.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            )}
            {tuned.backtest ? (
              <p className={tuned.backtest.worse ? 'failure' : undefined} data-backtest={tuned.backtest.worse ? 'worse' : 'better'}>
                Tried on {tuned.backtest.heldBack} corrections it had not seen: today's categories agree with people on {tuned.backtest.before.agreed} ({shareWords(tuned.backtest.before.agreement)}); this version on {tuned.backtest.after.agreed} ({shareWords(tuned.backtest.after.agreement)}).
                {tuned.backtest.worse ? ' This version scores worse than today\'s, so it is not an improvement.' : ''}
              </p>
            ) : (
              <p className="note">Its score on corrections it has not seen is not read yet.</p>
            )}
            {tuned.warnings.map((w) => (
              <p key={w} className="note">
                {w}
              </p>
            ))}
            {view?.kept === 'built-in' && <p className="note">These categories are built in, so using this version saves it as your own copy.</p>}
            {api?.disabled && <p className="note" data-sample-cannot-write="">{api.disabled}</p>}
            <div className="tune__actions">
              <Button className="btn btn--accent" onPress={() => void use(tuned.id)} isDisabled={Boolean(api?.disabled) || Boolean(saved && 'revision' in saved)} data-use-revision="">
                Use this version
              </Button>
              <Button className="btn btn--quiet" onPress={() => setTuned(null)}>
                Leave it
              </Button>
            </div>
          </section>
        )}
        {saved && 'error' in saved && (
          <p className="failure" role="alert">
            {saved.error}
          </p>
        )}
        {saved && 'revision' in saved && (
          <p role="status" data-saved-revision="">
            Saved as revision {saved.revision}, {KEPT[saved.kept]}.
          </p>
        )}
      </div>
    </details>
  );
}
