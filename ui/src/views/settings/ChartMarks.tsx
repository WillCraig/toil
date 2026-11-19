/**
 * "Simple chart marks" (#567), under Settings, Appearance: one checkbox, kept
 * in this browser only. On, every chart draws its series with plain borders
 * (solid, dashed, dotted, double ...) instead of the decorative themes'
 * picture frames. Plain and Crate have no frames, so it changes nothing there,
 * and the card isn't shown rather than offering a choice that does nothing (#657).
 * A tick-box to simplify the diagrams, itself kept simple at the committee's request.
 */

import { Checkbox } from 'react-aria-components';
import { Card } from '../../components/layout.tsx';
import { Help } from '../../components/help.tsx';
import { useSimpleMarksSetting } from '../../simple-marks.ts';
import { useTheme } from '../../theme-context.ts';
import { CheckIcon } from '../../components/icons.tsx';

export function ChartMarksSetting() {
  const theme = useTheme();
  const [simple, setSimple] = useSimpleMarksSetting();
  const framed = Object.values(theme.series).some((marks) => marks.some((m) => m.frame));
  if (!framed) return null;
  return (
    <Card as="section" className="panel chart-marks-setting" aria-labelledby="chart-marks">
      <h2 id="chart-marks">Charts</h2>
      <div className="theme-setting__row">
        <Checkbox className="check" isSelected={simple} onChange={setSimple}>
          <span className="box" aria-hidden="true">
            {simple ? <CheckIcon size={14} /> : null}
          </span>
          Simple chart marks
        </Checkbox>
        <Help topic="simple-marks" />
      </div>
    </Card>
  );
}
