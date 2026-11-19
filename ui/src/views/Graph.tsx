/**
 * The dependency graph panel (#252), drawn with xyflow from the model in
 * src/model/graph.ts: columns follow the `blocks` chains, so the critical path
 * reads left to right. The drawing is for looking; it pans and zooms with its
 * own buttons, never with the page's scroll wheel, and nothing in it can be
 * dragged or connected, since a new link would be a write. The same edges are
 * listed in words underneath, so every relation is there without the picture.
 * Both sit folded under the blocker timeline, each behind a one-line summary
 * with its count (principle 11), and the drawing is only built once opened:
 * xyflow measures its nodes, and a closed section has nothing to measure.
 */

import { Background, Handle, MarkerType, Panel, Position, ReactFlow, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { Component, useState, type ReactNode } from 'react';
import { StatusChip } from '../components/bits.tsx';
import { DisclosureBody, SummaryChevron } from '../components/disclosure.tsx';
import { ItemLink } from '../components/items.tsx';
import { useData } from '../data.ts';
import { Empty, TrackerAction } from '../components/empty.tsx';
import { EDGE_WORD, dependencyGraph, type GraphNode } from '../model/graph.ts';
import { useTerm, useWords } from '../skins.tsx';
import './gantt.css';

type ItemNode = Node<{ node: GraphNode }, 'item'>;

function ItemBox({ data }: NodeProps<ItemNode>) {
  const { byId } = useData();
  const term = useTerm();
  const item = byId.get(data.node.id);
  const n = data.node;
  return (
    <div className={`gnode${n.blocked ? ' gnode--blocked' : ''}${n.blocking ? ' gnode--blocking' : ''}${n.done ? ' gnode--done' : ''}${n.known ? '' : ' gnode--unknown'}${item?.type === 'EPIC' ? ' gnode--epic' : ''}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <ItemLink id={n.id} />
      {item ? (
        <>
          <p className="gnode-title">{item.title}</p>
          <StatusChip category={item.statusCategory} status={item.status} />
          {n.blocked && <span className="gflag">{term('blocked', 'Blocked')}</span>}
        </>
      ) : (
        <p className="note">Not in this Toil project</p>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

const nodeTypes = { item: ItemBox };

/** Fit the whole graph in view, keeping the bottom clear of the zoom buttons so no node ends up under them (a covered link fails WCAG 2.5.8). */
const FIT = { padding: { top: 0.15, right: 0.15, left: 0.15, bottom: '72px' }, maxZoom: 1, duration: 0 } as const;

/** Zoom and fit, as plain labelled buttons (xyflow's own panel carries an aria-label on a div with no role). */
function Zoom() {
  const flow = useReactFlow();
  return (
    <Panel position="bottom-right">
      <div className="zoom" role="group" aria-label="Zoom the graph">
        <button type="button" onClick={() => flow.zoomIn({ duration: 0 })} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={() => flow.zoomOut({ duration: 0 })} aria-label="Zoom out">
          −
        </button>
        <button type="button" onClick={() => flow.fitView(FIT)}>
          Fit
        </button>
      </div>
    </Panel>
  );
}

/** If the drawing fails, say so where it would have been; the list of links underneath still shows every edge. */
class Drawing extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  render() {
    return this.state.error ? (
      <p role="alert" className="failure">
        The graph couldn't be drawn ({this.state.error}). Every link is listed below.
      </p>
    ) : (
      this.props.children
    );
  }
}

export function Graph() {
  const { toilProject, byId, sync } = useData();
  const words = useWords();
  const g = dependencyGraph(toilProject.items);
  // Built on the first open and kept after, so closing and opening again doesn't redraw it.
  const [drawn, setDrawn] = useState(false);
  if (!g.nodes.length) return <Empty message={words('empty.links')} action={<TrackerAction toilProject={toilProject.name} sync={sync} />} />;
  // With nothing open held up, the links are only finished work's: said plainly, and still one press away.
  const idle = !g.nodes.some((n) => n.blocked);

  const nodes: ItemNode[] = g.nodes.map((n) => ({ id: n.id, type: 'item', position: { x: n.rank * 260, y: n.row * 130 }, data: { node: n } }));
  const edges: Edge[] = g.edges.map((e) => {
    const live = e.type === 'blocks' && byId.get(e.source)?.statusCategory !== 'DONE';
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: EDGE_WORD[e.type],
      className: `gedge gedge--${e.type}${live ? ' gedge--live' : ''}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
      type: 'smoothstep',
    };
  });
  const name = (id: string) => {
    const item = byId.get(id);
    return item ? <ItemLink id={id} withTitle /> : <code className="missing">{id}</code>;
  };
  const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

  return (
    <>
      {idle && <p data-nothing-blocked="">Nothing that is still open is blocked by another story.</p>}
      {g.cycle && <p className="failure">These blocks links form a loop, so the columns are approximate.</p>}
      <details className="deps-more" data-graph-drawing="" onToggle={(e) => e.currentTarget.open && setDrawn(true)}>
        <summary>
          <SummaryChevron />
          <span>Graph of the links ({items(g.nodes.length)})</span>
        </summary>
        <DisclosureBody>
          {drawn && (
            <Drawing>
              <div className="graph">
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  nodesFocusable={false}
                  edgesFocusable={false}
                  zoomOnScroll={false}
                  panOnScroll={false}
                  preventScrolling={false}
                  zoomOnDoubleClick={false}
                  fitView
                  fitViewOptions={FIT}
                  minZoom={0.4}
                  maxZoom={1.5}
                  proOptions={{ hideAttribution: false }}
                >
                  <Background gap={24} size={1} />
                  <Zoom />
                </ReactFlow>
              </div>
            </Drawing>
          )}
        </DisclosureBody>
      </details>
      <details className="deps-more" data-graph-links="">
        <summary>
          <SummaryChevron />
          <span>Every link ({g.edges.length})</span>
        </summary>
        <DisclosureBody>
          <ul className="rows">
            {g.edges.map((e) => (
              <li key={e.id}>
                {name(e.source)} {EDGE_WORD[e.type]} {name(e.target)} <span className="field">({e.name})</span>
              </li>
            ))}
          </ul>
        </DisclosureBody>
      </details>
    </>
  );
}
