/**
 * One work item, with every mapped field next to where it came from, its
 * links, its history and the changes that mention it. What OWI couldn't map is
 * listed, not hidden (principle 4). Full disclosure, without the twelve-page form.
 */

import { Avatar, Outcome, PLAIN_INSIGHT_LABEL, SourceTip, StatusChip } from '../components/bits.tsx';
import { ExternalLink } from '../components/external-link.tsx';
import { Cited, ItemLink, typeText } from '../components/items.tsx';
import { ReclassifyChip } from '../components/reclassify.tsx';
import { ReadinessPanel } from '../components/readiness.tsx';
import { Card, DataTable } from '../components/layout.tsx';
import { EditLink } from '../components/help.tsx';
import { useData, useDerived } from '../data.ts';
import { Empty, EmptyButton, EmptyLink } from '../components/empty.tsx';
import { STATUS_CATEGORY_LABEL, connectionEditHref, dateTime, toilProjectEditHref, toilProjectHref, estimateText, personText, shortKey, sourceLabel } from '../format.ts';
import { duplicateWhy, isSeedMark, possibleDuplicates } from '../model/duplicates.ts';
import { age, cycleTime } from '../model/flow.ts';
import { INSIGHT_LABEL, insights } from '../model/insights.ts';
import { entry } from '../model/sprint.ts';
import { useTerm, useTheme } from '../skins.tsx';
import { usePlain } from '../plain-words.ts';
import { ItemAssignments } from '../assign/views.tsx';
import { SummaryChevron } from '../components/disclosure.tsx';

const DUPLICATES_HOW = "By shared words in titles and bodies, title trigrams, labels, parent and links: not by meaning, so a duplicate written in other words isn't found.";

/** OWI's link type in words, by direction; the source's own wording is shown beside it. */
const LINK_WORD: Record<string, [string, string]> = {
  blocks: ['Blocks', 'Blocked by'],
  relates: ['Relates to', 'Relates to'],
  duplicates: ['Duplicates', 'Duplicated by'],
  implements: ['Implements', 'Implemented by'],
  other: ['Linked to', 'Linked from'],
};

/**
 * A field's name as a person reads it (#657): Jira's `customfield_10016` is the tracker's internal id, so it reads "a custom
 * field" with the id in its tooltip; any other name is shown as the record has it.
 */
function fieldText(field: string) {
  return /^customfield_\d+$/.test(field) ? <span title={field}>a custom field</span> : <code>{field}</code>;
}

export function ItemView({ id }: { id: string }) {
  const { byId, toilProject, now, sync } = useData();
  const theme = useTheme();
  const term = useTerm();
  const plain = usePlain();
  const { insights: prepared } = useDerived();
  const item = byId.get(id);
  if (!item) {
    return (
      <>
        <h1 tabIndex={-1}>No such item</h1>
        <Empty message={`The Toil project has no item ${id}.`} action={<EmptyLink href={toilProjectHref(toilProject.name)}>Back to {toilProject.name}</EmptyLink>} />
      </>
    );
  }
  const mine = toilProject.changes.filter((c) => c.items.includes(id));
  const deployedTo = toilProject.deployments.filter((d) => d.items.includes(id));
  const e = entry(item);
  const source = sourceLabel(item.source.area);
  const all = insights(item, prepared);
  // What blocks it is said once, at the top (#657); Worth a look and Links don't say it again, and the readiness row points up to it.
  const blockedBy = all.filter((i) => i.code === 'blocked');
  const found = all.filter((i) => i.code !== 'blocked');
  const shownAbove = new Set(blockedBy.map((i) => /\[\[([^\]]+)\]\]/.exec(i.text)?.[1]).filter(Boolean));
  const links = item.links.filter((l) => !(l.type === 'blocks' && l.direction === 'inward' && shownAbove.has(l.target)));
  // The sandboxes' seed marks are bookkeeping for the demo, not labels anyone filed the item under.
  const labels = item.labels.filter((l) => !isSeedMark(l));
  const cycle = cycleTime(item);
  const inProgress = age(item, now);
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const duplicates = possibleDuplicates(toilProject.items, id);
  const nameOf = (other: string) => {
    const it = byId.get(other);
    return it ? `${sourceLabel(it.source.area)} ${shortKey(it)}` : other;
  };

  const timeLine = (
    <p className="note" data-item-time="">
      {cycle
        ? cycle.days !== null
          ? `Cycle time ${round1(cycle.days)} days, from ${dateTime(cycle.start)} to ${dateTime(cycle.end)}.`
          : `Cycle time unknown: ${cycle.reason}.`
        : inProgress
          ? inProgress.days !== null
            ? `In progress for ${round1(inProgress.days)} days, since ${dateTime(inProgress.since)}.`
            : `Time in progress unknown: ${inProgress.reason}.`
          : 'Not started.'}
    </p>
  );
  return (
    <>
      <div className="view-head">
        <p className="eyebrow">
          {source} {shortKey(item)}
        </p>
        <h1 tabIndex={-1}>{item.title}</h1>
        <p className="item-meta">
          <StatusChip category={item.statusCategory} status={item.status} /> <ReclassifyChip item={item} /> <Avatar person={item.assignee} /> {personText(item.assignee)}
          {item.url && (
            <>
              {' '}
              {/* A control that leaves the app: a button to the eye, a link underneath, with the external mark (#657). */}
              <ExternalLink className="btn btn--secondary btn--sm item-open" href={item.url} data-open-tracker="">
                Open in {source}
              </ExternalLink>
            </>
          )}
        </p>
        {blockedBy.length > 0 && (
          <ul className="plain item-blocked" data-blocked-by="">
            {blockedBy.map((i) => (
              <li key={i.text}>
                <Cited text={i.text} />. <SourceTip source={i.evidence} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* Worth a look only when something does stand out (#657): "Nothing stands out" was a panel saying there was no panel. The time it has taken stays, as one line. */}
      {found.length > 0 ? (
        <Card as="section" className="panel insights-panel" aria-labelledby="insights">
          <h2 id="insights" title={plain.title('Insights')}>
            {plain.pw('Insights', 'Worth a look')}
          </h2>
          <ul className="rows">
            {found.map((i) => (
              <li key={i.code} className={`insight-row insight-row--w${i.weight}`}>
                <span className={`insight insight--w${i.weight}`}>{PLAIN_INSIGHT_LABEL[i.code] ?? INSIGHT_LABEL[i.code]}</span> <Cited text={i.text} />. <SourceTip source={i.evidence} />
              </li>
            ))}
          </ul>
          {timeLine}
        </Card>
      ) : (
        timeLine
      )}
      {/* Keyed by item, so a live read made on one item's page never shows on the next one's. */}
      <ReadinessPanel key={item.id} item={item} blockedAbove={blockedBy.length > 0} />
      <Card as="section" className="panel duplicates-panel" aria-labelledby="duplicates">
        {duplicates.length ? (
          // One line until it's asked for: the item is the page's focus, and a list of maybes is a step in (principle 11).
          // The chevron alone says it opens (#657): a "· Show" beside it was a second control for the same press.
          <details className="duplicates" data-duplicates="">
            <summary>
              <SummaryChevron />
              <h2 id="duplicates" className="duplicates__head">
                {duplicates.length === 1 ? '1 possible duplicate' : `${duplicates.length} possible duplicates`}
              </h2>
            </summary>
            <ul className="rows">
              {duplicates.map((d) => (
                <li key={d.id} className="duplicate">
                  <ItemLink id={d.id} withTitle /> <span className="score">· {Math.round(d.score * 100)}% alike</span>
                  <details className="duplicate-why">
                    <summary><SummaryChevron />
                      Why?<span className="sr-only"> {d.title}</span>
                    </summary>
                    <p className="note">{duplicateWhy(d.why, nameOf)}</p>
                  </details>
                </li>
              ))}
            </ul>
            <p className="note">{DUPLICATES_HOW}</p>
          </details>
        ) : (
          <>
            <h2 id="duplicates">Possible duplicates</h2>
            <p>None in {toilProject.name}: no item shares enough words with this one.</p>
            <p className="note">{DUPLICATES_HOW}</p>
          </>
        )}
      </Card>
      <ItemAssignments item={item} />
      <div className="item-grid">
        <section aria-labelledby="fields">
          <div className="edit-head">
            <h2 id="fields">Fields</h2>
            <EditLink href={toilProjectEditHref(toilProject.name, 'fields')} label={`Edit ${toilProject.name}'s field names`} />
          </div>
          <dl className="fields">
            <dt>Source</dt>
            <dd>
              {/* Plain words (principle 11): the tool, then the name it is set up under in Settings; toil's "connection" stays out of it. */}
              {source} ({item.source.connection}) <EditLink href={connectionEditHref(item.source.connection)} label={`Edit ${item.source.connection} in Settings`} />
            </dd>
            <dt>Type</dt>
            <dd>{typeText(item, theme)}</dd>
            <dt>Status</dt>
            <dd>
              {/* The status once (#657): the tracker's word, with the category it counts as one hover away. */}
              {item.status ? <span title={`Counted as ${STATUS_CATEGORY_LABEL[item.statusCategory].toLowerCase()}`}>{item.status}</span> : STATUS_CATEGORY_LABEL[item.statusCategory]}
              {item.resolution && `, resolution ${item.resolution}`}
            </dd>
            <dt>Estimate</dt>
            <dd>
              {estimateText(item)}
              {item.estimate && (
                <>
                  , from {fieldText(item.estimate.field)}
                </>
              )}
            </dd>
            <dt>Assignee</dt>
            <dd>{personText(item.assignee)}</dd>
            <dt>{term('priority', 'Priority')}</dt>
            <dd>{item.priority ?? 'None'}</dd>
            <dt>Sprint</dt>
            <dd>
              {item.iteration ? (item.iteration.path ?? item.iteration.name) : 'None'}
              {item.iteration && e.kind !== 'planned' && (
                <>
                  {' '}
                  ({e.kind === 'added' ? 'added mid-sprint' : `carried over from ${e.from}`}) <SourceTip source={e.evidence} />
                </>
              )}
            </dd>
            <dt>Parent</dt>
            <dd>{item.parent ? <ItemLink id={item.parent} withTitle /> : 'None'}</dd>
            <dt>Labels</dt>
            <dd>{labels.length ? labels.join(', ') : 'None'}</dd>
            <dt>Created</dt>
            <dd>{item.created ? dateTime(item.created) : 'Unknown'}</dd>
            <dt>Updated</dt>
            <dd>{item.updated ? dateTime(item.updated) : 'Unknown'}</dd>
            {item.resolved && (
              <>
                <dt>Resolved</dt>
                <dd>{dateTime(item.resolved)}</dd>
              </>
            )}
          </dl>
        </section>

        <section aria-labelledby="related">
          <h2 id="related">Related work</h2>
          {item.children.length > 0 && (
            <>
              <h3 title={plain.title('Children')}>{plain.pw('Children', 'Sub-items')}</h3>
              <ul className="rows">
                {item.children.map((c) => (
                  <li key={c}>
                    <ItemLink id={c} withTitle />
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>Links</h3>
          {links.length ? (
            <ul className="rows">
              {links.map((l, i) => (
                <li key={i}>
                  {LINK_WORD[l.type]![l.direction === 'outward' ? 0 : 1]} <ItemLink id={l.target} withTitle />{' '}
                  <span className="field">({l.name})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>{item.links.length ? 'Only what blocks it, named at the top.' : 'None.'}</p>
          )}
          <h3 title={plain.title('Pull requests and builds')}>{plain.pw('Pull requests and builds', 'Code reviews and builds')}</h3>
          {mine.length ? (
            <ul className="rows">
              {mine.map((c) => (
                <li key={c.id}>
                  {c.url ? <ExternalLink href={c.url}>{c.title}</ExternalLink> : c.title} <Outcome of={c} />
                </li>
              ))}
            </ul>
          ) : (
            <p>None linked.</p>
          )}
          <h3>Deployed to</h3>
          {deployedTo.length ? (
            <ul className="rows">
              {deployedTo.map((d) => (
                <li key={d.id}>
                  {d.environment}: {d.name}, commit <code>{d.commit}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p>Not deployed anywhere the Toil project names.</p>
          )}
        </section>

        <section aria-labelledby="history">
          <h2 id="history">History</h2>
          {!item.history ? (
            <p>
              No history synced for this item. {sync && <EmptyButton onPress={sync}>Sync now</EmptyButton>}
            </p>
          ) : item.history.transitions.length === 0 ? (
            <p>No status changes recorded.</p>
          ) : (
            <DataTable
              label={`${shortKey(item)}'s status changes`}
              rows={item.history.transitions.map((t, i) => ({ ...t, i }))}
              rowKey={(t) => String(t.i)}
              columns={[
                { header: 'When', label: 'When', cell: (t) => dateTime(t.at) },
                { header: 'From', label: 'From', cell: (t) => t.from ?? 'Created' },
                { header: 'To', label: 'To', cell: (t) => t.to },
                { header: 'By', label: 'By', cell: (t) => (t.by ? personText(t.by) : 'Unknown') },
              ]}
            />
          )}
          {item.unmapped.length > 0 && (
            <>
              <h3>Not mapped</h3>
              <ul className="rows">
                {item.unmapped.map((u) => (
                  <li key={u.field}>
                    {fieldText(u.field)}: {u.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </>
  );
}
