/**
 * The drawer that lists several items (#567): what a click on a chart segment,
 * a number on a release, or a notable change opens. Its address says how to
 * find the items (model/drill.ts), not which they are, so a shared link stays
 * short and still opens exactly the list the sender was looking at. Each row
 * opens the one-item drawer over this list, and closing that one comes back
 * here; the list's own Close takes it away and leaves the filters. Sorted by
 * any column, by its header or by a Sort by menu where the table is stacked.
 * A drill into an empty cell is a sentence, not an empty table, because a
 * list that says nothing invites a follow-up meeting.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { currentQuery, withQuery } from '../address.ts';
import { useData } from '../data.ts';
import { peekHref, personText, shortKey, sourceLabel, STATUS_CATEGORY_LABEL } from '../format.ts';
import { useWorkInsights } from '../insights-data.ts';
import { decodeDrill, resolveDrill } from '../model/drill.ts';
import { asMapped } from '../model/people.ts';
import { labelOfDimension, NOT_SORTED } from '../model/work-insights.ts';
import type { WorkItem } from '../toil.ts';
import { StatusChip } from './bits.tsx';
import { ReclassifyChip } from './reclassify.tsx';
import { Choice } from './choice.tsx';
import { DataTable, type Column } from './layout.tsx';
import { ArrowDownIcon, ArrowUpIcon } from './icons.tsx';
import './items-drawer.css';

type SortKey = 'key' | 'title' | 'status' | 'assignee' | 'estimate' | 'category' | `dim:${string}`;

/** An estimate in a few characters, for a narrow column: "3 pts", "4 h", "2 d". */
const estimateShort = (item: WorkItem): string => {
  const e = item.estimate!;
  return `${e.value} ${e.unit === 'points' ? 'pts' : e.unit === 'hours' ? 'h' : 'd'}`;
};

const tie = (a: WorkItem, b: WorkItem) => a.id.localeCompare(b.id, undefined, { numeric: true });

export function ItemsDrawer({ spec }: { spec: string }) {
  const { byId, toilProject } = useData();
  // The assignee as the toil project's people name them, so a person's two accounts sort and read as one name.
  const assigneeText = (i: WorkItem) => personText(asMapped(toilProject.people ?? [], i.source.area, i.assignee));
  const ins = useWorkInsights();
  const heading = useRef<HTMLHeadingElement>(null);
  const here = typeof window === 'undefined' ? '#/' : window.location.hash;
  const close = withQuery(here, (q) => {
    q.delete('items');
    q.delete('item');
  });
  const [sort, setSort] = useState<{ by: SortKey; down: boolean }>({ by: 'key', down: false });
  const list = useMemo(() => {
    const drill = decodeDrill(spec);
    return drill ? resolveDrill(ins, drill) : null;
  }, [ins, spec]);
  useEffect(() => {
    // Focus lands on the heading when the list opens, not each time an item drawer closes back onto it.
    if (!currentQuery().has('item')) heading.current?.focus();
  }, [spec]);

  const head = (
    <div className="drawer__top">
      <span className="drawer__key">Items</span>
      <span className="drawer__actions">
        <a className="btn btn--small" href={close} aria-label="Close the list" data-drawer-close="">
          Close
        </a>
      </span>
    </div>
  );
  if (!list) {
    return (
      <aside className="item-drawer drill-drawer" aria-labelledby="drill-title" data-drill="">
        {head}
        <h2 id="drill-title" ref={heading} tabIndex={-1} className="drawer__title">
          That list isn't here any more
        </h2>
        <p className="note">The chart it came from no longer holds that figure: the filters or the data changed since the link was made.</p>
      </aside>
    );
  }
  const items = list.ids.map((id) => byId.get(id)).filter((i): i is WorkItem => i !== undefined);
  const dims = list.dimensions;
  const categoryName = (i: WorkItem) => {
    const id = ins.verdicts.get(i.id)?.category ?? null;
    return id === null ? `\uffff${NOT_SORTED}` : (ins.definitions[id]?.name ?? id);
  };
  const text = (i: WorkItem, by: SortKey): string | number => {
    if (by === 'key') return `${sourceLabel(i.source.area)} ${shortKey(i)}`;
    if (by === 'title') return i.title;
    if (by === 'status') return i.status ?? STATUS_CATEGORY_LABEL[i.statusCategory];
    if (by === 'assignee') return assigneeText(i);
    if (by === 'estimate') return i.estimate ? i.estimate.value : -1;
    if (by === 'category') return categoryName(i);
    return ins.valueText(i, by.slice(4)) ?? '';
  };
  const sorted = [...items].sort((a, b) => {
    const x = text(a, sort.by);
    const y = text(b, sort.by);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return (sort.down ? -c : c) || tie(a, b);
  });
  // The sort header is quiet: plain header text and a small arrow on the sorted column; the table's own headings say which is sorted (aria-sort).
  const header = (label: string, by: SortKey): ReactNode => (
    <button type="button" className="drill-sort" aria-label={`Sort by ${label}`} onClick={() => setSort((s) => ({ by, down: s.by === by ? !s.down : false }))} data-sort={by}>
      {label}
      <span className="drill-sort__arrow">{sort.by === by ? sort.down ? <ArrowDownIcon size={12} /> : <ArrowUpIcon size={12} /> : null}</span>
    </button>
  );
  const sortOf = (by: SortKey): Column<WorkItem>['sort'] => (sort.by === by ? (sort.down ? 'descending' : 'ascending') : 'none');
  // A column is shown only if it says something: none with no estimate or nobody assigned, and a split's column only where its value differs from row to row
  // (a list opened from one cell of a split repeats that cell's own value in it). Category stays, first, whatever it says.
  const varies = (by: SortKey) => new Set(items.map((i) => String(text(i, by)))).size > 1;
  const shownDims = dims.filter((d) => varies(`dim:${d}`));
  const hasEstimate = items.some((i) => i.estimate);
  const hasAssignee = items.some((i) => i.assignee);
  const columns: Array<Column<WorkItem>> = [
    { header: header('Category', 'category'), label: 'Category', className: 'drill-col drill-col--category', sort: sortOf('category'), cell: (i) => <ReclassifyChip item={i} /> },
    {
      header: header('Item', 'key'),
      label: 'Item',
      rowHeader: true,
      className: 'drill-col drill-col--key',
      sort: sortOf('key'),
      cell: (i) => (
        <a className="item-link" href={peekHref(here, i.id)} data-row={i.id}>
          <span className="key">
            <span className="source">{sourceLabel(i.source.area)}</span> {shortKey(i)}
          </span>
        </a>
      ),
    },
    { header: header('Title', 'title'), label: 'Title', className: 'drill-col drill-col--title', sort: sortOf('title'), cell: (i) => <span className="drill-title" title={i.title}>{i.title}</span> },
    { header: header('Status', 'status'), label: 'Status', className: 'drill-col drill-col--status', sort: sortOf('status'), cell: (i) => <StatusChip category={i.statusCategory} status={i.status} /> },
    ...(hasAssignee ? [{ header: header('Assignee', 'assignee'), label: 'Assignee', className: 'drill-col drill-col--assignee', sort: sortOf('assignee'), cell: (i: WorkItem) => assigneeText(i) } satisfies Column<WorkItem>] : []),
    ...(hasEstimate ? [{ header: header('Estimate', 'estimate'), label: 'Estimate', className: 'drill-col drill-col--estimate', sort: sortOf('estimate'), cell: (i: WorkItem) => (i.estimate ? estimateShort(i) : <span aria-label="no estimate">–</span>) } satisfies Column<WorkItem>] : []),
    ...shownDims.map(
      (d): Column<WorkItem> => ({ header: header(labelOfDimension(d), `dim:${d}`), label: labelOfDimension(d), className: 'drill-col drill-col--dim', sort: sortOf(`dim:${d}`), cell: (i) => ins.valueText(i, d) ?? <span aria-label="not read yet">–</span> }),
    ),
  ];
  const sortOptions = [
    { id: 'category', label: 'Category' },
    { id: 'key', label: 'Item' },
    { id: 'title', label: 'Title' },
    { id: 'status', label: 'Status' },
    ...(hasAssignee ? [{ id: 'assignee', label: 'Assignee' }] : []),
    ...(hasEstimate ? [{ id: 'estimate', label: 'Estimate' }] : []),
    ...shownDims.map((d) => ({ id: `dim:${d}`, label: labelOfDimension(d) })),
  ];
  return (
    <aside className="item-drawer drill-drawer" aria-labelledby="drill-title" data-drill={list.ids.length}>
      {head}
      <h2 id="drill-title" ref={heading} tabIndex={-1} className="drawer__title">
        {list.title}
      </h2>
      <p className="note" data-drill-count="">
        {list.ids.length} {list.ids.length === 1 ? 'item' : 'items'}
        {list.about ? `, ${list.about}` : ''}
      </p>
      {items.length === 0 ? (
        <p className="note">Nothing was counted here.</p>
      ) : (
        <>
          <div className="drill-sortmenu">
            <Choice label="Sort by" value={sort.by} options={sortOptions} onChange={(id) => setSort({ by: id as SortKey, down: false })} />
          </div>
          <DataTable label="Items" caption={`${list.title}, ${items.length} items`} columns={columns} rows={sorted} rowKey={(i) => i.id} wide className={`drill-table drill-table--dims-${Math.min(shownDims.length, 2)}`} />
        </>
      )}
    </aside>
  );
}
