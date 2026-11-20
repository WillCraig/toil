/**
 * "Apply board moves when I drop a card", on by default and kept in this
 * browser (src/board-moves.ts). On, a drop on another column changes the
 * item's status through toil, behind the connection's own writes setting. Off,
 * a drop only proposes the move, with the command to run yourself.
 */

import { Checkbox } from 'react-aria-components';
import { useBoardMoves } from '../../board-moves.ts';
import { Card } from '../../components/layout.tsx';
import { Help } from '../../components/help.tsx';
import { CheckIcon } from '../../components/icons.tsx';

export function BoardMovesSetting() {
  const [on, setOn] = useBoardMoves();
  return (
    <Card as="section" className="panel board-moves-setting" aria-labelledby="board-moves">
      <h2 id="board-moves">Board</h2>
      <div className="theme-setting__row">
        <Checkbox className="check" isSelected={on} onChange={setOn} data-board-moves-setting="">
          <span className="box" aria-hidden="true">
            {on ? <CheckIcon size={14} /> : null}
          </span>
          Apply board moves when I drop a card
        </Checkbox>
        <Help topic="board-moves" />
      </div>
    </Card>
  );
}
