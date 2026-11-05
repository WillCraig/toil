/**
 * An empty panel that acts (#417, principle 11): one short line, then the
 * action that fills it, with any explanation in an (i) beside the action.
 * Every view draws its empty panels through `Empty`, never the theme's
 * `EmptyState` slot directly, and `action` is required, so an empty panel
 * can't ship with nothing to press; test/empty-states.test.tsx holds every
 * view to that. The theme's slot still draws it, with the theme's art.
 * An empty in-tray, with a form attached for filling it.
 */

import type { ReactNode } from 'react';
import { Button } from 'react-aria-components';
import { useSkins } from '../skins.tsx';
import type { HelpTopicId } from '../help.ts';
import { Help } from './help.tsx';
import { toilProjectEditHref } from '../format.ts';
import './empty.css';

export function Empty({ message, action, help }: { message: string; action: ReactNode; help?: HelpTopicId }) {
  const { EmptyState } = useSkins();
  return (
    <EmptyState message={message}>
      <p className="empty-action" data-empty-action="">
        {action}
        {help && <Help topic={help} />}
      </p>
    </EmptyState>
  );
}

/** An action that goes somewhere: Toil project setup at a section, a tab, a settings page. `edit` draws the pencil before it. */
export function EmptyLink({ href, children, edit = false }: { href: string; children: ReactNode; edit?: boolean }) {
  return (
    <a className="btn btn--small empty-action__link" href={href}>
      {edit && (
        <span aria-hidden="true" className="empty-action__pencil">
          ✎
        </span>
      )}
      {children}
    </a>
  );
}

/** An action that does something here: Sync now, Clear the filters, Analyze now. */
export function EmptyButton({ onPress, children, disabled = false }: { onPress: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <Button className="btn btn--small" onPress={onPress} isDisabled={disabled}>
      {children}
    </Button>
  );
}

/**
 * Sync now where the page can sync (the local app), else the link given: for a
 * panel a newer read of the tracker would fill, in the preview too.
 */
export function SyncOr({ sync, children }: { sync: (() => void) | undefined; children: ReactNode }) {
  return sync ? <EmptyButton onPress={sync}>Sync now</EmptyButton> : <>{children}</>;
}

/**
 * For a panel only the tracker can fill (a sprint, links between items): Sync
 * now, to read what changed there, else the pencil to the toil project's sources.
 */
export function TrackerAction({ toilProject, sync }: { toilProject: string; sync: (() => void) | undefined }) {
  return (
    <SyncOr sync={sync}>
      <EmptyLink edit href={toilProjectEditHref(toilProject, 'sources')}>
        Check the Toil project's sources
      </EmptyLink>
    </SyncOr>
  );
}
