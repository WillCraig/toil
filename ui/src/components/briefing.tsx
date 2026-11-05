/**
 * The briefing's pieces (#494): the hook every view reads it through, and the
 * item drawer, the one step between a line on the briefing and an item's own
 * page. The drawer opens beside whatever view named the item (the briefing,
 * the Board, Pull requests) at that view's own address plus `?item=`, so a
 * peek can be shared and the view behind it stays put. It says why the item
 * is there and who said so, the next step, any change Analyze proposed, and
 * the pull requests and chain it sits in; everything else is on its page.
 * The memo, and then the file, for those who ask for the file.
 */

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { analyzeSettings } from '../../../src/core/brief/settings.ts';
import { useData } from '../data.ts';
import { dateTime, toilProjectEditHref, itemHref, peekHref, personText, shortKey, sourceLabel, STATUS_CATEGORY_LABEL, estimateText, unpeekHref } from '../format.ts';
import { usePlain } from '../plain-words.ts';
import { briefingOf, itemBriefing, type BriefingView } from '../model/briefing.ts';
import { matches, typingIn } from '../shortcuts.ts';
import { ANALYZE } from '../agent.ts';
import { useChatScope } from './ask.tsx';
import { setPrefs, useBriefingPrefs } from '../briefing-prefs.ts';
import { whoText } from './analysis.tsx';
import { Cited, ItemHrefContext, PrLink } from './items.tsx';
import { ProposalCard } from './proposal.tsx';
import './briefing.css';

/** The toil project's briefing: Analyze's when its latest is current, the code's otherwise. */
export function useBriefing(): BriefingView {
  const { toilProject, now } = useData();
  const list = useChatScope()?.history.list ?? null;
  return useMemo(
    () =>
      briefingOf({
        items: toilProject.items,
        pullRequests: toilProject.pullRequests ?? [],
        now,
        settings: analyzeSettings(toilProject.analyze ?? undefined, toilProject.wipLimit ?? null).settings,
        analyses: list ?? [],
      }),
    [toilProject, now, list],
  );
}

/** Who wrote the briefing, in words: "Analyze, Codex (gpt-5.5), 13 Oct 2026, 07:30 UTC" or "By code". */
export function briefingSource(view: BriefingView, plain = false): string {
  if (view.by === 'analyze' && view.analysis) return plain ? `Written by an AI helper, ${whoText(view.analysis)}, ${dateTime(view.analysis.at)}` : `Analyze, ${whoText(view.analysis)}, ${dateTime(view.analysis.at)}`;
  return plain ? "Worked out by the app's own rules, no AI" : 'By code, no agent';
}

/** Links inside it open the drawer over the page you're on, not the item's page. */
export function PeekLinks({ children }: { children: ReactNode }) {
  const here = typeof window === 'undefined' ? '#/' : window.location.hash;
  return <ItemHrefContext.Provider value={(_d, id) => peekHref(here, id)}>{children}</ItemHrefContext.Provider>;
}

/** The drawer for one item, beside the view; Escape or Close goes back to the view alone. */
export function ItemDrawer({ id }: { id: string }) {
  const { toilProject, byId } = useData();
  const view = useBriefing();
  const plain = usePlain();
  const heading = useRef<HTMLHeadingElement>(null);
  const here = typeof window === 'undefined' ? '#/' : window.location.hash;
  const close = unpeekHref(here);
  useEffect(() => {
    heading.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!typingIn(e.target) && matches('drawerClose', e)) window.location.hash = close;
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Focus goes back to what opened the drawer: the row or card key for this item, once the page behind has drawn.
      setTimeout(() => {
        if (window.location.hash.includes('?item=')) return;
        const key = encodeURIComponent(id);
        document.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"], [data-card-item="${CSS.escape(id)}"], a.card-key[href$="?item=${CSS.escape(key)}"]`)?.focus();
      });
    };
  }, [id, close]);
  const item = byId.get(id);
  const head = (
    <div className="drawer__top">
      <span className="drawer__key">{item ? `${sourceLabel(item.source.area)} ${shortKey(item)}` : id}</span>
      <span className="drawer__actions">
        {item && (
          <a className="btn btn--small" href={itemHref(toilProject.name, id)} data-drawer-open="">
            Open
          </a>
        )}
        <a className="btn btn--small" href={close} aria-label="Close the drawer" data-drawer-close="">
          Close
        </a>
      </span>
    </div>
  );
  if (!item) {
    return (
      <aside className="item-drawer" aria-labelledby="drawer-title" data-drawer={id}>
        {head}
        <h2 id="drawer-title" ref={heading} tabIndex={-1} className="drawer__title">
          Not in this Toil project
        </h2>
        <p className="error">
          <code>{id}</code> isn't one of {toilProject.name}'s items as Toil UI last read them. Sync the Toil project, or check where the link came from.
        </p>
      </aside>
    );
  }
  const { reason, item: briefed, code } = itemBriefing(view, id);
  const prs = (toilProject.pullRequests ?? []).filter((c) => c.workItems.includes(id));
  const proposals = view.by === 'analyze' ? (view.analysis?.proposals ?? []).filter((p) => p.item === id) : [];
  const blockedBy = item.links.filter((l) => l.type === 'blocks' && l.direction === 'inward').map((l) => l.target);
  const blocks = item.links.filter((l) => l.type === 'blocks' && l.direction === 'outward').map((l) => l.target);
  return (
    <aside className="item-drawer" aria-labelledby="drawer-title" data-drawer={id}>
      {head}
      <h2 id="drawer-title" ref={heading} tabIndex={-1} className="drawer__title">
        {item.title}
      </h2>
      <p className="drawer__facts note">
        {item.status ?? STATUS_CATEGORY_LABEL[item.statusCategory]} · {personText(item.assignee)} · {estimateText(item)}
        {item.url && (
          <>
            {' · '}
            <a href={item.url} target="_blank" rel="noreferrer" data-drawer-tracker="">
              Open in {sourceLabel(item.source.area)}
            </a>
          </>
        )}
      </p>
      <PeekLinks>
        {briefed && reason ? (
          <section className={`drawer__why drawer__why--${reason.severity}`} aria-label="Why it's here">
            <h3>{reason.label}</h3>
            <p>
              <Cited text={briefed.why} />
            </p>
            <p className="source">{view.by === 'analyze' ? `${briefingSource(view)}. Every id checked against what its tools read.` : `By code, from ${code?.evidence.join(', ') ?? 'the record'}, read with toil ${item.source.command}.`}</p>
          </section>
        ) : (
          <p className="note">Nothing flags it: it's on track.</p>
        )}
        {briefed?.next && (
          <section className="drawer__next" aria-label="Next step">
            <h3>Next step</h3>
            <p>
              <Cited text={briefed.next} />
            </p>
          </section>
        )}
        {proposals.map((p, i) => (
          <ProposalCard key={i} proposal={p} />
        ))}
        {prs.length > 0 && (
          <section aria-label={plain.pw('Pull requests', 'Code reviews')}>
            <h3 className="drawer__label" title={plain.title('Pull requests')}>
              {plain.pw('Pull requests', 'Code reviews')}
            </h3>
            <ul className="rows">
              {prs.map((c) => (
                <li key={c.id}>
                  <PrLink change={c} withTitle /> <span className="note">{[c.state.toLowerCase(), c.checks ? `checks ${c.checks.toLowerCase()}` : ''].filter(Boolean).join(', ')}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {(blockedBy.length > 0 || blocks.length > 0) && (
          <section aria-label={plain.pw('Chain', 'Linked work')}>
            <h3 className="drawer__label" title={plain.title('Chain')}>
              {plain.pw('Chain', 'Linked work')}
            </h3>
            {blockedBy.length > 0 && (
              <p>
                Blocked by <Cited text={blockedBy.map((b) => `[[${b}]]`).join(', ')} />
              </p>
            )}
            {blocks.length > 0 && (
              <p>
                Blocks <Cited text={blocks.map((b) => `[[${b}]]`).join(', ')} />
              </p>
            )}
          </section>
        )}
      </PeekLinks>
      <p className="source">
        Read {item.updated ? `as of ${dateTime(item.updated)}` : ''} with toil {item.source.command}, connection {item.source.connection}.
      </p>
    </aside>
  );
}

/**
 * Analyze after a sync (#494), when the person turned it on under Customize:
 * once per finished sync, never on the one already there when the page
 * opened, and never while the chat is busy. It uses the agent's usage, so
 * it's off unless asked for.
 */
export function AnalyzeAfterSync({ syncedAt }: { syncedAt: string | null }) {
  const prefs = useBriefingPrefs();
  const chat = useChatScope();
  useEffect(() => {
    if (!syncedAt || syncedAt === lastSync.seen) return;
    // The first sync this page sees was there before it opened: noted, never acted on.
    const first = lastSync.seen === undefined;
    lastSync.seen = syncedAt;
    if (!first && prefs.afterSync && chat && !chat.busy) void chat.ask(ANALYZE, 'Analyze');
  }, [syncedAt, prefs.afterSync, chat]);
  return null;
}

/**
 * The last finished sync the page has seen, kept outside React: the local app
 * remounts the whole page when a sync finishes (ui/src/local.tsx), and a ref
 * inside it would start again from the new sync and never see it as new.
 */
const lastSync: { seen: string | undefined } = { seen: undefined };

/** For tests: forget the syncs seen, as a freshly opened page has. */
export const forgetSyncs = () => {
  lastSync.seen = undefined;
};

/** Customize (#494): how this person likes the briefing laid out, in this browser only. */
export function Customize({ lenses }: { lenses: Array<{ lens: string; label: string }> }) {
  const prefs = useBriefingPrefs();
  const { toilProject } = useData();
  const { pw } = usePlain();
  const hide = (lens: string, shown: boolean) => setPrefs({ hidden: shown ? prefs.hidden.filter((h) => h !== lens) : [...new Set([...prefs.hidden, lens])] });
  return (
    <details className="customize">
      <summary className="btn btn--small">Customize</summary>
      <div className="customize__panel">
        <p className="source">Just for you, in this browser. What {pw('Analyze', 'a briefing')} looks for is {"the Toil project's"}: <a href={toilProjectEditHref(toilProject.name, 'analyze')}>{pw('How Analyze briefs', 'How briefings are made for')} {toilProject.name}</a>.</p>
        <fieldset>
          <legend className="briefing__label">Show</legend>
          <label className="customize__check">
            <input type="checkbox" checked={prefs.firstOpen} onChange={(e) => setPrefs({ firstOpen: e.target.checked })} /> Open the first reason
          </label>
          <label className="customize__check">
            <input type="checkbox" checked={prefs.numbersOpen} onChange={(e) => setPrefs({ numbersOpen: e.target.checked })} /> The numbers, open
          </label>
          {lenses.map((l) => (
            <label key={l.lens} className="customize__check">
              <input type="checkbox" checked={!prefs.hidden.includes(l.lens)} onChange={(e) => hide(l.lens, e.target.checked)} /> {l.label}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend className="briefing__label">An item opens</legend>
          <label className="customize__check">
            <input type="radio" name="opens-in" checked={prefs.opensIn === 'drawer'} onChange={() => setPrefs({ opensIn: 'drawer' })} /> In its drawer, beside the briefing
          </label>
          <label className="customize__check">
            <input type="radio" name="opens-in" checked={prefs.opensIn === 'page'} onChange={() => setPrefs({ opensIn: 'page' })} /> On its own page
          </label>
        </fieldset>
        <fieldset>
          <legend className="briefing__label">{pw('Analyze', 'Briefing')}</legend>
          <label className="customize__check">
            <input type="checkbox" checked={prefs.afterSync} onChange={(e) => setPrefs({ afterSync: e.target.checked })} /> {pw('Run Analyze after each sync', 'Write a briefing after each sync')}
          </label>
          <p className="source">Uses your {pw('agent', 'AI helper')}'s usage. Off, the briefing says when it is older than the data.</p>
        </fieldset>
      </div>
    </details>
  );
}
