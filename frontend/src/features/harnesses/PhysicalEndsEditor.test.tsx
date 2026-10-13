import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PhysicalEndsEditor } from './PhysicalEndsEditor';
import type { Section } from './api';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('persisted JSON key order preserves the selected segment end without duplicate choices', () => {
  const changed = vi.fn();
  const section: Section = {
    local_id: 'piece', stock_revision_id: 'stock', planned_cut_length_mm: null, cut_basis: null,
    physical_ends: [{
      local_id: 'cut', label: null,
      // PostgreSQL JSONB returns this order; identity is the pair, not serialized key order.
      segment_ends: [JSON.parse('{"end":"b","segment_id":"leg"}')],
      endpoint_id: null, basis: 'Declared cut', review: 'reviewed',
    }],
  };
  render(<MantineProvider><PhysicalEndsEditor section={section}
    segments={[{ local_id: 'leg', section_id: 'piece', label: null, element_paths: null }]}
    endpoints={[]} hidden={false} onChange={changed} /></MantineProvider>);
  expect(screen.getAllByText('leg / b').length).toBeGreaterThan(0);
  expect(screen.queryByText('{"end":"b","segment_id":"leg"}')).toBeNull();
  const input = screen.getByRole('combobox', { name: 'Physical end piece/cut segment ends' });
  fireEvent.click(input);
  const selected = screen.getByRole('option', { name: 'leg / b' });
  expect(selected.getAttribute('aria-selected')).toBe('true');
  fireEvent.click(selected);
  expect(changed.mock.calls[0]![0][0].segment_ends).toEqual([]);
});
