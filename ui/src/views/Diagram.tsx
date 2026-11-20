/**
 * A toil project's architecture diagram (#582): the picture of what the
 * Diagram job drew and a person chose to keep, read live from toil
 * (`projects diagram show`, a file in the person's own folder, never the
 * cache). It sits one step in from the Summary, at
 * `#/project/<name>/summary/diagram[/<view>]`: not a tab, with a breadcrumb of its
 * own that leads back.
 *
 * The first thing on the page is the picture and a switch between the model's
 * views. Everything that says how sure the diagram is (principle 4) stays on
 * screen as a legend with its counts and a provenance line (saved when, which
 * revision; where it is kept and what was left out on purpose are one step in); what each box
 * was read from, or why it is believed, is one press away (principle 11), and
 * a list says the same in text for a screen reader. No diagram yet is an
 * empty state whose action is the job that draws one. A failure stays on
 * screen with toil's own message and fix.
 *
 * Bureaucratic note: the diagram is as current as the last person who
 * remembered to press Save, which makes it exactly as current as the wiki.
 */

import { NavButton } from '../components/nav-button.tsx';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from 'react-aria-components';
import { C4Picture, layoutNotice, layoutOf } from '../components/c4-picture.tsx';
import '../components/c4-picture.css';
import { Breadcrumb } from '../components/breadcrumb.tsx';
import { SummaryChevron } from '../components/disclosure.tsx';
import { Empty, EmptyLink } from '../components/empty.tsx';
import { Help } from '../components/help.tsx';
import { jobHref } from '../components/jobs.tsx';
import { Path, Scroller } from '../components/layout.tsx';
import { useData } from '../data.ts';
import { DIAGRAM_SAVED } from '../diagram-saved.ts';
import { diagramHref, dateTime, toilProjectHref } from '../format.ts';
import { edgeName, elementsOf, howWord, pickedKey, knownText, lacksCommand, overLimit, readShown, savedAgo, countsText, type ComputedView, type Element, type Picked, type ShownDiagram, type ViewEdge } from '../model/diagram.ts';
import { typeLine } from '../../../src/areas/util/c4/view.ts';
import { CALL_OPTIONS } from '../toil.ts';

type State =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'old'; version: string }
  | { kind: 'failed'; message: string; fix: string | null }
  | { kind: 'ready'; shown: ShownDiagram; missing: string | null };

/** Reads the diagram, and the view asked for (else the first). A view that doesn't exist is said, not drawn as another. */
async function read(execute: NonNullable<ReturnType<typeof useData>['execute']>, toilProject: string, viewKey: string | null): Promise<State> {
  const ask = (view?: string) => execute('projects diagram show', { toilProject, ...(view ? { view } : {}) }, CALL_OPTIONS);
  let missing: string | null = null;
  let env = await ask(viewKey ?? undefined);
  if (!env.ok && viewKey && env.error.code === 'INVALID_INPUT' && !lacksCommand(env.error.message)) {
    missing = viewKey;
    env = await ask();
  }
  if (!env.ok) {
    if (lacksCommand(env.error.message)) return { kind: 'old', version: env.meta.version };
    if (env.error.code === 'NOT_FOUND') return { kind: 'none' };
    return { kind: 'failed', message: env.error.message, fix: env.error.fix ?? null };
  }
  let shown = readShown(env.data);
  if (!shown) return { kind: 'failed', message: 'toil answered projects diagram show with something that is not a diagram.', fix: 'Update toil and Toil UI together.' };
  const first = shown.views[0]?.key;
  if (!shown.view && first) {
    const next = await ask(first);
    shown = (next.ok ? readShown(next.data) : null) ?? shown;
  }
  return { kind: 'ready', shown, missing };
}

export function Diagram({ viewKey }: { viewKey: string | null }) {
  const { toilProject, execute, viewedAt } = useData();
  const name = toilProject.name;
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [picked, setPicked] = useState<Picked | null>(null);
  const [again, setAgain] = useState(0);

  useEffect(() => {
    const on = () => setAgain((n) => n + 1);
    window.addEventListener(DIAGRAM_SAVED, on);
    return () => window.removeEventListener(DIAGRAM_SAVED, on);
  }, []);

  useEffect(() => {
    let live = true;
    setPicked(null);
    if (!execute) {
      setState({ kind: 'failed', message: "This Toil UI has no way to read toil's stored diagrams.", fix: 'Open Toil UI from the toil-ui command.' });
      return;
    }
    read(execute, name, viewKey).then(
      (s) => live && setState(s),
      (e: unknown) => live && setState({ kind: 'failed', message: e instanceof Error ? e.message : String(e), fix: null }),
    );
    return () => {
      live = false;
    };
  }, [execute, name, viewKey, again]);

  // The same way back every page one step in from the Summary has (#567).
  const crumbs = <Breadcrumb trail={[{ label: 'Summary', href: toilProjectHref(name) }, { label: 'Architecture' }]} />;

  /** Every state but the picture: the way back, the page's heading and one thing to say. */
  const plain = (kind: string, body: ReactNode) => (
    <div className="diagram-page" data-diagram={kind}>
      {crumbs}
      <div className="view-head">
        <h1 tabIndex={-1}>Architecture</h1>
      </div>
      {body}
    </div>
  );
  if (state.kind === 'loading') {
    return plain(
      'loading',
      <p className="note" role="status">
        Reading the saved diagram.
      </p>,
    );
  }
  if (state.kind === 'none') {
    return plain('none', <Empty message={`${name} has no architecture diagram yet.`} action={<EmptyLink href={jobHref(name, 'map-codebase')}>Draw its architecture</EmptyLink>} help="diagram" />);
  }
  if (state.kind === 'old') {
    return plain(
      'old',
      <p role="alert" className="failure">
        The toil this Toil UI runs ({state.version}) has no projects diagram command, so it can&apos;t read a saved diagram. It needs a newer toil: update Toil UI and toil together.
      </p>,
    );
  }
  if (state.kind === 'failed') {
    return plain(
      'failed',
      <p role="alert" className="failure">
        {state.message} {state.fix}
      </p>,
    );
  }
  return <Ready shown={state.shown} missing={state.missing} picked={picked} onPick={setPicked} at={viewedAt ? Date.parse(viewedAt) : Date.now()} crumbs={crumbs} />;
}

function Ready({ shown, missing, picked, onPick, at, crumbs }: { shown: ShownDiagram; missing: string | null; picked: Picked | null; onPick: (p: Picked | null) => void; at: number; crumbs: ReactNode }) {
  const name = shown.toilProject;
  const view = shown.view;
  const tooBig = view ? overLimit(view) : null;
  return (
    <div className="diagram-page" data-diagram="ready">
      {crumbs}
      <div className="view-head">
        <h1 tabIndex={-1}>{view?.title ?? 'Architecture'}</h1>
      </div>
      {missing && (
        <p role="note" className="failure" data-diagram-missing="">
          This diagram has no view named {missing}, so its first view is shown.
        </p>
      )}
      {shown.views.length > 1 && (
        <nav aria-label="Views of the diagram">
          <ul className="c4-switch">
            {shown.views.map((v) => (
              <li key={v.key}>
                <a href={diagramHref(name, v.key)} {...(v.key === view?.key ? { 'aria-current': 'page' as const } : {})}>
                  {v.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {!view ? (
        <p role="note" className="failure">
          This diagram has no view to draw.
        </p>
      ) : tooBig ? (
        <p role="note" className="failure" data-diagram-limit="">
          {tooBig}
        </p>
      ) : (
        <div className={`c4-layout${picked ? ' c4-layout--detail' : ''}`}>
          <div className="c4-main">
            <Scroller label={`${view.title}, drawn`} hint="Scroll sideways for the rest of the picture.">
              <C4Picture view={view} picked={picked} onPick={onPick} />
            </Scroller>
          </div>
          {picked && <Detail view={view} picked={picked} onClose={() => onPick(null)} />}
        </div>
      )}
      <Legend shown={shown} notice={view && !tooBig ? layoutNotice(layoutOf(view)) : null} />
      <Provenance shown={shown} at={at} />
      {view && !tooBig && <TextList view={view} />}
    </div>
  );
}

/** Observed, inferred and not said, as the picture draws them, with how many of each the whole diagram holds. What the key means is in the (i). */
function Legend({ shown, notice }: { shown: ShownDiagram; notice: string | null }) {
  const c = shown.counts;
  const swatch = (dash?: string) => (
    <svg viewBox="0 0 28 14" width="28" height="14" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="26" height="12" rx="3" {...(dash ? { strokeDasharray: dash } : {})} />
    </svg>
  );
  return (
    <div data-diagram-legend="">
      <ul className="c4-legend" aria-label="How the diagram is known">
        <li>
          {swatch()}
          <span>Observed: {c.observed}</span>
        </li>
        <li>
          {swatch('4 3')}
          <span>Inferred: {c.inferred}</span>
        </li>
        {c.unmarked > 0 && (
          <li>
            {swatch()}
            <span>Not said: {c.unmarked}</span>
          </li>
        )}
        <li className="note">
          <Help topic="diagram" note={`${countsText(c)}. Observed and not said are drawn alike, so open a box to see which.`} />
        </li>
      </ul>
      {notice && (
        <p role="note" className="failure" data-diagram-notice="">
          {notice}
        </p>
      )}
    </div>
  );
}

function Provenance({ shown, at }: { shown: ShownDiagram; at: number }) {
  const { toilProject } = useData();
  return (
    <div className="c4-prov-block">
      <p className="note c4-prov" data-diagram-provenance="">
        <span title={dateTime(shown.savedAt)}>{savedAgo(shown.savedAt, at)}</span> · revision {shown.revision} <NavButton href={jobHref(toilProject.name, 'map-codebase')} kind="quiet" size="sm">
          Draw it again
        </NavButton>
      </p>
      {shown.file && (
        <details data-diagram-kept="">
          <summary>
            <SummaryChevron />
            Where is this kept?
          </summary>
          <p className="note">In your own toil folder on this computer, not in any repository.</p>
          <Path value={shown.file} what="file" />
        </details>
      )}
      {shown.notMapped.length > 0 && (
        <details>
          <summary>
            <SummaryChevron />
            Left out on purpose ({shown.notMapped.length})
          </summary>
          <ul className="plain">
            {shown.notMapped.map((p) => (
              <li key={p}>
                <code>{p}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** What one box or arrow is, how it is known and what that rests on, as plain text: a diagram holds no address, so nothing here is a link. */
function Detail({ view, picked, onClose }: { view: ComputedView; picked: Picked; onClose: () => void }) {
  const byId = useMemo(() => elementsOf(view), [view]);
  const here = useRef<HTMLElement>(null);
  // Below the picture on a narrow screen, the detail may be off screen when something is pressed: bring it into view, and no further.
  const key = pickedKey(picked);
  useEffect(() => here.current?.scrollIntoView?.({ block: 'nearest' }), [key]);
  let body;
  if (picked.kind === 'element') {
    const el = byId.get(picked.id);
    body = el ? <ElementDetail el={el} /> : <p>That box is not in this view.</p>;
  } else {
    const edge = view.edges[picked.index];
    body = edge ? <EdgeDetail edge={edge} byId={byId} /> : <p>That arrow is not in this view.</p>;
  }
  return (
    <aside ref={here} className="c4-detail" aria-label="Detail" data-diagram-detail="">
      {body}
      <Button className="btn btn--small c4-detail__close" onPress={onClose}>
        Close detail
      </Button>
    </aside>
  );
}

function ElementDetail({ el }: { el: Element }) {
  return (
    <>
      <h2>{el.name}</h2>
      <p className="note">
        {typeLine(el)}
        {el.external ? ', outside this system' : ''}
      </p>
      {el.description && <p>{el.description}</p>}
      <p className="c4-detail__how">{howWord(el.how)}</p>
      <p>{knownText(el)}</p>
    </>
  );
}

function EdgeDetail({ edge, byId }: { edge: ViewEdge; byId: ReadonlyMap<string, Element> }) {
  return (
    <>
      <h2>{edgeName(edge, byId)}</h2>
      {(edge.description || edge.technology) && (
        <p>
          {edge.description}
          {edge.technology ? ` [${edge.technology}]` : ''}
        </p>
      )}
      <p className="c4-detail__how">{howWord(edge.how)}</p>
      <p>{knownText(edge)}</p>
    </>
  );
}

/** The same view as a list, every box and arrow with how each is known: the text a picture can't give a screen reader. */
function TextList({ view }: { view: ComputedView }) {
  const byId = useMemo(() => elementsOf(view), [view]);
  const boxes = [...view.outside, ...view.inside];
  return (
    <details className="c4-list" data-diagram-list="">
      <summary>
        <SummaryChevron />
        List
      </summary>
      <h2 className="sr-only">Everything in this view</h2>
      <p className="note">
        {boxes.length} boxes and {view.edges.length} arrows.
      </p>
      <ul aria-label="Boxes">
        {boxes.map((el) => (
          <li key={el.id}>
            <strong>{el.name}</strong> {typeLine(el)}. {howWord(el.how)}. {knownText(el)}
          </li>
        ))}
      </ul>
      <ul aria-label="Arrows">
        {view.edges.map((e, i) => (
          <li key={i}>
            <strong>{edgeName(e, byId)}</strong>
            {e.description ? `: ${e.description}` : ''}. {howWord(e.how)}. {knownText(e)}
          </li>
        ))}
      </ul>
    </details>
  );
}
