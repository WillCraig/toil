/**
 * A card's one menu, the hamburger in its top right corner (#561). Everything a
 * card can do beyond opening it lives here, so the card itself shows no pencils
 * and no row of buttons (principle 11): Edit, the order the cards sit in, and
 * Archive. A link item goes where it names; the others report their id to the
 * card, which does the work.
 */

import { Button, Menu, MenuItem, MenuTrigger, Popover, Separator } from 'react-aria-components';
import './card-menu.css';

export interface CardMenuItem {
  id: string;
  label: string;
  /** Where the item goes, for one that is a link. */
  href?: string;
  disabled?: boolean;
  /** A thin rule above it, to set a group apart. */
  separated?: boolean;
}

export function CardMenu({ name, items, onAction }: { name: string; items: CardMenuItem[]; onAction: (id: string) => void }) {
  if (items.length === 0) return null;
  return (
    <MenuTrigger>
      <Button className="btn btn--small card-menu__trigger" aria-label={`Menu for ${name}`} data-card-menu="">
        <span aria-hidden="true">☰</span>
      </Button>
      <Popover className="popover" placement="bottom end">
        <Menu className="menu" aria-label={`Actions for ${name}`} onAction={(key) => onAction(String(key))} disabledKeys={items.filter((i) => i.disabled).map((i) => i.id)}>
          {items.flatMap((i) => [
            ...(i.separated ? [<Separator key={`${i.id}-rule`} className="card-menu__rule" />] : []),
            <MenuItem key={i.id} id={i.id} className="menu-item" textValue={i.label} {...(i.href ? { href: i.href } : {})}>
              {i.label}
            </MenuItem>,
          ])}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
