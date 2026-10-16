import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { LibraryAdvanced } from './LibraryAdvanced';
const state = vi.hoisted(() => ({ section: 'matching' }));
vi.mock('../navigation', () => ({ useNavigation: () => ({ location: { filters: { section: state.section }, project: null } }) }));
vi.mock('../catalog-matching/MatchingWorkspace', () => ({ MatchingWorkspace: () => <input aria-label="Prepared matching basis" defaultValue="" /> }));
vi.mock('../discovery/CatalogLookup', () => ({ CatalogLookup: () => <input aria-label="Lookup query" defaultValue="" /> }));
vi.mock('../revision-upgrades/RevisionUpgradeWorkspace', () => ({ RevisionUpgradeWorkspace: ({ active }: { active: boolean }) => <span>Upgrade inspection {active ? 'active' : 'inactive'}</span> }));
afterEach(cleanup);
test('legacy Advanced selection opens in Library and tool switching retains prepared input', async () => {
  render(<MantineProvider><LibraryAdvanced principalKey="p" /></MantineProvider>);
  fireEvent.change(await screen.findByLabelText('Prepared matching basis'), { target: { value: 'Reviewed connector evidence' } });
  fireEvent.click(screen.getByRole('button', { name: 'Revision upgrades' }));
  await screen.findByText('Upgrade inspection active');
  fireEvent.click(screen.getByRole('button', { name: 'Catalog matching' }));
  expect((screen.getByLabelText('Prepared matching basis') as HTMLInputElement).value).toBe('Reviewed connector evidence');
  expect(screen.getByText('Upgrade inspection inactive')).toBeTruthy();
});
