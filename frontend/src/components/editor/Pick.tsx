import { Button, Stack } from '@mantine/core';
import { RevisionPicker } from '../../features/cables/RevisionPicker';

/** A bounded Library picker keeps exact revisions distinct from editable definitions. */
export function Pick({ label, kind, value, onChange, onNew, disabled = false }: { label: string; kind: string; value: string; onChange: (value: string) => void; onNew?: () => void; disabled?: boolean }) {
  return <Stack gap={4} className="recipe-pick"><fieldset disabled={disabled} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}><RevisionPicker label={label} kind={kind} value={value} onChange={onChange} /></fieldset>{onNew && <Button size="compact-xs" variant="quiet" disabled={disabled} onClick={onNew}>New {label.toLowerCase()}…</Button>}</Stack>;
}
