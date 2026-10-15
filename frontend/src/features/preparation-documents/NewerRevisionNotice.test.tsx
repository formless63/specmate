import { MantineProvider } from '@mantine/core';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { NavigationProvider } from '../navigation/NavigationProvider';
import { NewerRevisionNotice } from './NewerRevisionNotice';
import type { RootCurrency } from './api';

afterEach(cleanup);

const superseded: RootCurrency = { root_revision_number: 1, status: 'superseded', newer_revision: { revision_id: 'rev-2', number: 2, definition_id: 'cable-def', kind: 'cable', name: 'Synthetic jumper', frozen_at: '2026-10-14T00:00:00+00:00' } };

test('superseded retained set links to the newer frozen root revision in the same project context', () => {
  const history = createMemoryHistory({ initialEntries: ['/make?lens=preparation-documents&project=p1'] });
  render(<MantineProvider><NavigationProvider history={history}><NewerRevisionNotice currency={superseded} /></NavigationProvider></MantineProvider>);
  expect(screen.getByText('Newer revision r2 exists')).toBeTruthy();
  expect(screen.getByText(/generated from Synthetic jumper r1/)).toBeTruthy();
  const link = screen.getByRole('link', { name: 'Open Synthetic jumper r2' });
  expect(link.getAttribute('href')).toBe('/designs/cable-def@2?project=p1');
  fireEvent.click(link);
  expect(`${history.location.pathname}${history.location.search}`).toBe('/designs/cable-def@2?project=p1');
});

test('latest or absent currency shows no notice', () => {
  render(<MantineProvider><NewerRevisionNotice currency={{ root_revision_number: 2, status: 'latest', newer_revision: null }} /><NewerRevisionNotice currency={undefined} /></MantineProvider>);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/Newer revision/)).toBeNull();
});
