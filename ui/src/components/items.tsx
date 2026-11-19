/**
 * The pieces every view shows an item with: a link that names its source and
 * key, and text with `[[id]]` citations turned into links. A citation to an id
 * the toil project doesn't hold stays visible as the id, so a wrong one is obvious
 * rather than quietly dropped (principle 4). Footnotes that actually lead
 * somewhere, a first for a status report.
 */

import { Fragment, createContext, useContext, useId, useState } from 'react';
import { Button, Link, Tooltip, TooltipTrigger } from 'react-aria-components';
import { NavButton } from './nav-button.tsx';
import { blocksOf, segments } from '../agent.ts';
import { useData } from '../data.ts';
import { STATUS_CATEGORY_LABEL, dateTime, estimateText, itemHref, personText, prName, shortKey, sourceLabel, sourceShort } from '../format.ts';
import { themed } from '../theme-context.ts';
import './analysis.css';
import type { ThemeManifest } from '../themes.ts';
import type { Change, WorkItem } from '../toil.ts';
import { cellCite, type ViewContext } from '../view-context.ts';
import { ExternalLink } from './external-link.tsx';

/**
 * Where an item link goes: its own page, unless a view says otherwise. The
 * briefing (#494) opens the item's drawer instead, one step in rather than a
 * page away, and the drawer's Open link goes on to the page.
 */
export const ItemHrefContext = createContext<((toilProject: string, id: string) => string) | null>(null);

/** The item's source and key, as a link to its page, or to its drawer where a view says so. */
export function ItemLink({ id, withTitle = false }: { id: string; withTitle?: boolean }) {
  const { byId, prById, toilProject } = useData();
  const hrefOf = useContext(ItemHrefContext);
  const item = byId.get(id);
  const pr = item ? undefined : prById?.get(id);
  if (pr) return <PrLink change={pr} withTitle={withTitle} />;
  if (!item) return <code className="missing">{id}</code>;
  return (
    <a href={hrefOf ? hrefOf(toilProject.name, id) : itemHref(toilProject.name, id)} className="item-link">
      <span className="key">
        <span className="source">{sourceLabel(item.source.area)}</span> {shortKey(item)}
      </span>
      {withTitle && <span className="title"> {item.title}</span>}
    </a>
  );
}

/**
 * An item as a row (principle 11, #657): the whole row is a quiet button to the item's page, its source and key then its
 * title, so a list of items reads as rows to press rather than a wall of underlined links. A pull request, whose page is
 * on its host, stays a link, since it leaves the app.
 */
export function ItemRow({ id }: { id: string }) {
  const { byId, prById, toilProject } = useData();
  const hrefOf = useContext(ItemHrefContext);
  const item = byId.get(id);
  const pr = item ? undefined : prById?.get(id);
  if (pr) return <PrLink change={pr} withTitle />;
  if (!item) return <code className="missing">{id}</code>;
  return (
    <NavButton href={hrefOf ? hrefOf(toilProject.name, id) : itemHref(toilProject.name, id)} kind="quiet" size="sm" row className="item-row" data-item-row={id}>
      <span className="key">
        <span className="source">{sourceLabel(item.source.area)}</span> {shortKey(item)}
      </span>{' '}
      <span className="title">{item.title}</span>
    </NavButton>
  );
}

/**
 * A list of items as rows, the first `max` shown and the rest one press away behind "Show all N" (principle 11): a count
 * and a few to act on, never a wall. Nothing is dropped, only folded.
 */
export function ItemRows({ ids, label, max = 3 }: { ids: string[]; label: string; max?: number }) {
  const [all, setAll] = useState(false);
  const listId = useId();
  const shown = all ? ids : ids.slice(0, max);
  return (
    <>
      <ul className="plain item-rows" id={listId} aria-label={label}>
        {shown.map((id) => (
          <li key={id}>
            <ItemRow id={id} />
          </li>
        ))}
      </ul>
      {ids.length > max && (
        <Button className="btn btn--secondary btn--sm item-rows__more" aria-expanded={all} aria-controls={listId} onPress={() => setAll((a) => !a)} data-show-all="">
          {all ? 'Show fewer' : `Show all ${ids.length}`}
        </Button>
      )}
    </>
  );
}

/** A pull request, linked to its page on the host where the record has one. */
export function PrLink({ change, withTitle = false }: { change: Change; withTitle?: boolean }) {
  const label = (
    <>
      <span className="key">
        <span className="source">{sourceLabel(change.source.area)}</span> {prName(change.id)}
      </span>
      {withTitle && <span className="title"> {change.title}</span>}
    </>
  );
  return change.url ? (
    <ExternalLink href={change.url} className="item-link">
      {label}
    </ExternalLink>
  ) : (
    <span className="item-link">{label}</span>
  );
}

/**
 * Text with its citations as links, or as chips (#395): an agent's answer
 * cites by id alone, so there each citation is a chip with its key, title
 * and status, and hovering or focusing it says more. Text the code wrote,
 * which already says what each id is, keeps the plain link.
 */
export function Cited({ text, chips = false, cells, onCellCitation }: { text: string; chips?: boolean; cells?: Pick<ViewContext, 'cells'> | null | undefined; onCellCitation?: ((column: string, row: string) => void) | undefined }) {
  return (
    <>
      {segments(text).map((s, i) =>
        'cite' in s ? (
          chips ? <TicketChip key={i} id={s.cite} detail /> : <ItemLink key={i} id={s.cite} />
        ) : 'cell' in s ? (
          <CellChip key={i} cite={s.cell} view={cells} onPress={onCellCitation} />
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

/**
 * One part of an agent's answer as paragraphs and lists (blocksOf): its line
 * breaks kept, and a run of `- ` lines as a real bulleted list, with the
 * citations in each linked as `Cited` links them.
 */
export function AnswerText({ text, chips = false, cells, onCellCitation }: { text: string; chips?: boolean; cells?: Pick<ViewContext, 'cells'> | null | undefined; onCellCitation?: ((column: string, row: string) => void) | undefined }) {
  const cite = (t: string) => <Cited text={t} chips={chips} cells={cells} onCellCitation={onCellCitation} />;
  return (
    <>
      {blocksOf(text).map((b, i) =>
        b.kind === 'list' ? (
          <ul key={i} className="answer-list">
            {b.items.map((item, j) => (
              <li key={j}>{cite(item)}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            {b.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {cite(line)}
              </Fragment>
            ))}
          </p>
        ),
      )}
    </>
  );
}

/**
 * A chart cell cited in an answer (#567): the row and column it names, in
 * the words the chart uses. A cell the attached chart doesn't hold stays as
 * the bare citation, marked missing, as an unknown item does. Pressing it
 * calls `onPress` with the column and row keys, so a chart that is showing
 * can highlight the cell; with no handler it is plain text in a chip.
 */
export function CellChip({ cite, view, onPress }: { cite: string; view: Pick<ViewContext, 'cells'> | null | undefined; onPress?: ((column: string, row: string) => void) | undefined }) {
  const cell = view?.cells.find((c) => cellCite(c) === cite);
  if (!cell) return <code className="missing">{`cell:${cite}`}</code>;
  const label = `${cell.rowLabel}, ${cell.columnLabel}`;
  const body = (
    <>
      <span className="ticket-chip__key">{cell.rowLabel}</span> <span className="ticket-chip__title">{cell.columnLabel}</span>
    </>
  );
  return onPress ? (
    <button type="button" className="ticket-chip" data-cell-cite={cite} title={`Chart cell: ${label}`} aria-label={`Chart cell: ${label}`} onClick={() => onPress(cell.column, cell.row)}>
      {body}
    </button>
  ) : (
    <span className="ticket-chip" data-cell-cite={cite} title={`Chart cell: ${label}`} aria-label={`Chart cell: ${label}`}>
      {body}
    </span>
  );
}

/** A title cut for running text: the whole of it is in the tooltip. */
const cut = (title: string, max = 32) => (title.length <= max ? title : `${title.slice(0, max - 1).trimEnd()}…`);

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

/** The lines a chip's detail shows: what the chip has no room for. */
function detailLines(item: WorkItem | undefined, pr: Change | undefined, theme?: ThemeManifest): string[] {
  if (item) {
    return [
      `${typeText(item, theme)}, ${item.status ?? STATUS_CATEGORY_LABEL[item.statusCategory]}${item.status && item.status.toLowerCase() !== STATUS_CATEGORY_LABEL[item.statusCategory].toLowerCase() ? ` (${STATUS_CATEGORY_LABEL[item.statusCategory]})` : ''}`,
      `Assignee: ${personText(item.assignee)}`,
      `Estimate: ${estimateText(item)}`,
      ...(item.iteration?.name ? [`Sprint: ${item.iteration.name}`] : []),
      ...(item.updated ? [`Updated ${dateTime(item.updated)}`] : []),
    ];
  }
  if (!pr) return [];
  return [
    `Pull request in ${pr.repo}, ${titleCase(pr.state)}`,
    `Author: ${personText(pr.author)}`,
    ...(pr.checks ? [`Checks: ${titleCase(pr.checks)}`] : []),
    ...(pr.workItems.length ? [`Carries ${pr.workItems.length} work ${pr.workItems.length === 1 ? 'item' : 'items'}`] : []),
  ];
}

/**
 * A ticket as a chip: its key, its title and its status, never a bare
 * number. The title is cut to the chip's width, with the whole of it in the
 * name it reads out. With `detail` (#395), hovering or focusing it shows a tooltip
 * with its type, assignee, estimate, sprint and last update (a pull
 * request's repository, author and checks); otherwise the whole line is in
 * its title. An id the toil project doesn't hold stays the bare id, marked
 * missing, as every citation does.
 */
export function TicketChip({ id, detail = false }: { id: string; detail?: boolean }) {
  const { byId, prById, toilProject } = useData();
  const item = byId.get(id);
  const pr = item ? undefined : prById?.get(id);
  if (!item && !pr) return <code className="missing">{id}</code>;
  const key = item ? `${sourceLabel(item.source.area)} ${shortKey(item)}` : prName(id);
  const title = item ? item.title : pr!.title;
  const status = item ? (item.status ?? STATUS_CATEGORY_LABEL[item.statusCategory]) : titleCase(pr!.state);
  const tone = item ? item.statusCategory.toLowerCase() : 'pr';
  const body = (
    <>
      <span className="ticket-chip__key">{key}</span>{' '}
      <span className="ticket-chip__title">{title}</span>
      <span className="sr-only">, </span>
      <span className={`ticket-chip__status ticket-chip__status--${tone}`}>{status}</span>
    </>
  );
  const label = `${key} ${title}, ${status}`;
  const href = item ? itemHref(toilProject.name, id) : pr!.url;
  if (detail && href) {
    // In running text a citation reads as a link: a short source name, the key and a cut title. The status, the full
    // title and the source are in the tooltip (hover or focus) and in the name a screen reader reads.
    const short = item ? `${sourceShort(item.source.area)} ${shortKey(item)}` : key;
    return (
      <TooltipTrigger delay={300} closeDelay={150}>
        <Link className="cite-link" href={href} data-cite={id}>
          {short} {cut(title)}
          <span className="sr-only">, {status}</span>
        </Link>
        <Tooltip className="cite-tooltip" offset={6}>
          <strong className="cite-tooltip__title">
            {key} {title}
          </strong>
          <span className="cite-tooltip__line">
            {item ? `${sourceLabel(item.source.area)}, ` : ''}
            {status}
          </span>
          {detailLines(item, pr).map((l) => (
            <span key={l} className="cite-tooltip__line">
              {l}
            </span>
          ))}
        </Tooltip>
      </TooltipTrigger>
    );
  }
  return href ? (
    <a className="ticket-chip" href={href} title={label} data-truncate="">
      {body}
    </a>
  ) : (
    <span className="ticket-chip" title={label} data-truncate="">
      {body}
    </span>
  );
}

/** The OWI type, with the source's own word beside it when they differ (#206: real field names stay visible). */
export function typeText(item: WorkItem, theme?: ThemeManifest): string {
  const owi = item.type.charAt(0) + item.type.slice(1).toLowerCase();
  const text = item.typeName && item.typeName.toLowerCase() !== owi.toLowerCase() ? `${item.typeName} (${owi})` : owi;
  // A theme may call an epic a quest, beside the source's own word.
  return theme?.terms?.epic && item.type === 'EPIC' ? themed(theme, 'epic', item.typeName ?? owi) : text;
}
