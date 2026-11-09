/**
 * A labelled choice from a short list, on React Aria's Select: a button that
 * opens a listbox. The header's theme controls and Settings, General's theme
 * picker (#283) are each one of these.
 * One form, one field, a drop-down of pre-approved answers.
 */

import { Button, Label, ListBox, ListBoxItem, Popover, Select, SelectValue } from 'react-aria-components';

/** `faces` sets the font-family of an option's line, so a list of typefaces shows each in its own (Settings, Font). */
export function Choice({ label, value, options, onChange, faces }: { label: string; value: string; options: Array<{ id: string; label: string }>; onChange: (id: string) => void; faces?: Record<string, string> }) {
  return (
    <Select className="choice" selectedKey={value} onSelectionChange={(k) => k !== null && onChange(String(k))}>
      <Label>{label}</Label>
      <Button className="btn choice-button">
        {/* The chosen label from our own options: SelectValue's own text is its "Select an item"
            placeholder until its collection is built, a render later, and the header measures
            whether its row is full on that first render (#387). */}
        <SelectValue>{() => options.find((o) => o.id === value)?.label ?? value}</SelectValue>
        <span aria-hidden="true">▾</span>
      </Button>
      <Popover className="popover">
        <ListBox className="menu">
          {options.map((o) => (
            <ListBoxItem key={o.id} id={o.id} className="menu-item" {...(faces?.[o.id] ? { style: { fontFamily: faces[o.id] } } : {})}>
              {o.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}
