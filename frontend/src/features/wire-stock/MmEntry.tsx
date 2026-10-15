import { useState } from 'react';
import { SbQuantityField } from '../../components/sb';

/** Editable millimeter entry. Keeps the raw text so a trailing decimal point survives; only valid numbers or a cleared field reach the draft. */
export function MmEntry({ label, value, onChange }: { label: string; value: number | null; onChange: (value: number | null) => void }) {
  const [raw, setRaw] = useState(value === null ? '' : String(value));
  const parsed = raw.trim() === '' ? null : Number(raw);
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed < 0);
  if (!invalid && parsed !== value) setRaw(value === null ? '' : String(value));
  return <SbQuantityField label={label} value={raw} unit="mm" state={invalid ? 'invalid' : raw.trim() === '' ? 'unknown' : 'known'} note="Enter a non-negative number."
    onChange={next => { setRaw(next); const n = next.trim() === '' ? null : Number(next); if (n === null || (Number.isFinite(n) && n >= 0)) onChange(n); }} />;
}
