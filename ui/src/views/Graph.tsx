/**
 * The dependency graph panel (#252), drawn with xyflow from the model in
 * src/model/graph.ts: columns follow the `blocks` chains, so the critical path
 * reads left to right. The drawing is for looking; it pans and zooms with its
 * own buttons, never with the page's scroll wheel, and nothing in it can be
 * dragged or connected, since a new link would be a write. The same edges are
 * listed in words underneath, so every relation is there without the picture.
 */

import { Background, Handle, MarkerType, Panel, Position, ReactFlow, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { Component, type ReactNode } from 'react';
import { StatusChip } from '../components/bits.tsx';
import { ItemLink } from '../components/items.tsx';
import { useData } from '../data.ts';
import { Empty, TrackerAction } from '../components/empty.tsx';
import { EDGE_WORD, dependencyGraph, type GraphNode } from '../model/graph.ts';
import { useTerm, useWords } from '../skins.tsx';

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
        <button type="button" onClick={() => flow.fitView({ padding: 0.15, maxZoom: 1, duration: 0 })}>
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
  if (!g.nodes.length) return <Empty message={words('empty.links')} action={<TrackerAction toilProject={toilProject.name} sync={sync} />} />;

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

  return (
    <>
      <p className="note">{words('graph.note')}</p>
      {g.cycle && <p className="failure">These blocks links form a loop, so the columns are approximate.</p>}
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
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          minZoom={0.4}
          maxZoom={1.5}
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={24} size={1} />
          <Zoom />
        </ReactFlow>
      </div>
      </Drawing>
      <h3>Every link</h3>
      <ul className="rows">
        {g.edges.map((e) => (
          <li key={e.id}>
            {name(e.source)} {EDGE_WORD[e.type]} {name(e.target)} <span className="field">({e.name})</span>
          </li>
        ))}
      </ul>
    </>
  );
}
