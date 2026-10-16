import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useState } from 'react';
import { WorkingFirmware } from './DeviceWorking';
import { emptyAssembly } from './useDeviceRecord';
import type { Assembly } from './api';
vi.mock('../cables/RevisionPicker', () => ({ RevisionPicker: ({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) => <input aria-label={label} value={value} onChange={event => onChange(event.currentTarget.value)} /> }));
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test('changing or clearing firmware preserves the exact selected population option and every sibling assignment', () => {
  const before: Assembly = { ...emptyAssembly(), assignments: [
    { path: ['left', 'board'], assignments: { firmware_revision_id: 'old-left', population_option_id: 'left-population' } },
    { path: ['right', 'board'], assignments: { firmware_revision_id: 'old-right', population_option_id: 'right-population' } },
  ] };
  function Harness() { const [assembly, setAssembly] = useState(before); return <><WorkingFirmware assembly={assembly} editable paths={['left', 'right'].map(side => ({ path: [side, 'board'], label: side }))} onChange={setAssembly} /><output data-testid="working">{JSON.stringify(assembly)}</output></>; }
  render(<MantineProvider env="test"><Harness /></MantineProvider>);
  fireEvent.click(screen.getByRole('combobox', { name: 'Firmware occurrence' })); fireEvent.click(screen.getByRole('option', { name: 'right' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Firmware' }), { target: { value: '00000000-0000-4000-8000-000000000001' } }); fireEvent.click(screen.getByRole('button', { name: 'Apply firmware to working tree' }));
  let current = JSON.parse(screen.getByTestId('working').textContent!) as Assembly;
  expect(current.assignments?.[0]).toEqual(before.assignments?.[0]); expect(current.assignments?.[1]?.assignments.population_option_id).toBe('right-population');
  fireEvent.click(screen.getByRole('button', { name: 'Clear assignment right / board' })); current = JSON.parse(screen.getByTestId('working').textContent!) as Assembly;
  expect(current.assignments?.[1]?.assignments).toEqual({ firmware_revision_id: null, population_option_id: 'right-population' }); expect(before.assignments?.[1]?.assignments.firmware_revision_id).toBe('old-right');
});
