/**
 * Putting a Toil project away (#561), and getting it back. Nothing here deletes
 * anything: `toil projects archive` sets one flag in the person's own file and
 * `toil projects unarchive` clears it, so every screen that offers one offers
 * the other. The pieces are small on purpose (principle 11): a card's quiet
 * "more" menu, one line that says what just happened and offers the undo, and
 * an "Archived (n)" disclosure at the bottom of a list, closed until opened.
 * Each runs toil's own command through the config path, so the toil file is
 * written by toil and by nothing in this page.
 *
 * An archived Toil project is only hidden. It leaves the list, the switcher and
 * the sync counts, and the file stays where it was, so putting it back is one
 * press. The archive office is open at all hours and has never lost a file;
 * it has also never found one.
 */

import { Button, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import type { ArchivedToilProject } from '../load.ts';
import './archive.css';

/** What the line under the header says about the last archive or unarchive. */
export type ArchiveNotice = { kind: 'archived' | 'unarchived'; name: string } | { kind: 'failed'; name: string; message: string };

/** Whether the page may change anything: the preview, and a Toil UI with no config path, may not. */
export const canArchive = (config: { disabled: string | null } | null | undefined): boolean => Boolean(config && !config.disabled);

/** A card's menu: one quiet button, with Archive inside it. The only change a card offers beyond its name and description. */
export function ArchiveMenu({ name, onArchive }: { name: string; onArchive: (name: string) => void }) {
  return (
    <MenuTrigger>
      <Button className="btn btn--small archive-menu__trigger" aria-label={`More actions for ${name}`} data-archive-menu="">
        <span aria-hidden="true">⋯</span>
      </Button>
      <Popover className="popover" placement="bottom end">
        <Menu className="menu" aria-label={`Actions for ${name}`} onAction={(key) => key === 'archive' && onArchive(name)}>
          <MenuItem id="archive" className="menu-item" textValue={`Archive ${name}`}>
            Archive
          </MenuItem>
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

/** One line of what just happened, with the undo beside it. A refusal stays until dismissed: it says what to do. */
export function ArchiveNoticeLine({ notice, onUndo, onDismiss }: { notice: ArchiveNotice; onUndo: (name: string, archive: boolean) => void; onDismiss: () => void }) {
  if (notice.kind === 'failed') {
    return (
      <p className="failure archive-notice" role="alert">
        {notice.message}{' '}
        <button type="button" className="btn btn--small" onClick={onDismiss}>
          Dismiss
        </button>
      </p>
    );
  }
  const archived = notice.kind === 'archived';
  return (
    <p className="note archive-notice" role="status">
      {archived ? (
        <>
          Archived <strong>{notice.name}</strong>. It is hidden, not deleted.
        </>
      ) : (
        <>
          <strong>{notice.name}</strong> is back in the list.
        </>
      )}{' '}
      <button type="button" className="btn btn--small" onClick={() => onUndo(notice.name, !archived)}>
        Undo
      </button>{' '}
      <button type="button" className="btn btn--small" onClick={onDismiss}>
        Dismiss
      </button>
    </p>
  );
}

/**
 * "Archived (n)", at the bottom of a list: closed, so the page stays quiet. It
 * shows only what was read. Null, the archive couldn't be read, draws nothing
 * (it is unknown, not none), and so does a real zero: nothing to open.
 */
export function ArchivedDisclosure({ archived, onUnarchive }: { archived: ArchivedToilProject[] | null; onUnarchive: ((name: string) => void) | null }) {
  if (!archived || archived.length === 0) return null;
  return (
    <details className="archived">
      <summary>Archived ({archived.length})</summary>
      <ul className="archived__list">
        {archived.map((d) => (
          <li key={d.name} className="archived__item">
            <span className="archived__name">
              <code>{d.name}</code>
              {d.description && <span className="note"> {d.description}</span>}
            </span>
            {onUnarchive && (
              <button type="button" className="btn btn--small" aria-label={`Unarchive ${d.name}`} onClick={() => onUnarchive(d.name)}>
                Unarchive
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
