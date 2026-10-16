import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { NavigationProvider, useNavigation } from '../navigation';
import { ProbeProvider } from '../probe';
import { PermissionsProvider } from '../../lib/permissions';
import { ConnectorLibrary } from './ConnectorLibrary';
import type { ConnectorRecordProps } from './ConnectorRecordPage';
import { blankConnector } from './useConnectorSession';
import type { Port } from './api';
vi.mock('../../components/library/LibraryList', () => ({ LibraryList: () => <p>Connector collection</p> }));
vi.mock('./ConnectorRecordPage', () => ({ ConnectorRecordPage: (props: ConnectorRecordProps) => <section aria-label={props.active ? 'Active record' : 'Hidden record'}><p>{JSON.stringify(props.initial?.value)}</p><button onClick={() => props.onNew('port', { ...blankConnector('port') as Port, kind: 'port', pinout_revision_id: 'exact-pinout-r7', device_label: '', role: 'unknown', selected_conditions: {}, pins: [], review: 'unreviewed', review_basis: null })}>Prepared port</button><button onClick={() => props.onNew('end_assembly', { kind: 'end_assembly', description: null, stack: { layers: [{ kind: 'connector', layer_id: 'connector', body_revision_id: 'exact-body-r2', pinout_revision_id: 'exact-pinout-r7' }], joins: [] }, review: 'unreviewed', review_basis: null })}>Prepared stack</button><button onClick={props.onBack}>Back to connector list</button></section> }));
afterEach(cleanup);
function mount() {
  const history = createMemoryHistory({ initialEntries: ['/library/connectors/body@2'] });
  function Routed() { const nav = useNavigation()!; return <ProbeProvider probe={nav.location.probe} onProbe={probe => nav.navigate({ probe })}><ConnectorLibrary recordKind={nav.location.probe?.object === 'body' ? 'connector_body' : null} active={['interfaces', 'ports', 'end-assemblies'].includes(nav.location.lens)} toolId={nav.location.lens} principalKey="owner" workspaceId="w1" projectFilterId={nav.location.project} projects={[]} onOpenInProject={vi.fn()} /></ProbeProvider>; }
  render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient()}><PermissionsProvider permissions={['workspace.read', 'item.create']}><NavigationProvider history={history}><Routed /></NavigationProvider></PermissionsProvider></QueryClientProvider></MantineProvider>); return history;
}
test('new device port changes canonical route and retains exact prepared pinout through rail/list navigation', async () => {
  const history = mount(); fireEvent.click(await screen.findByRole('button', { name: 'Prepared port' })); expect(history.location.pathname).toBe('/library/connectors'); expect(history.location.search).toContain('tool=ports'); expect(history.location.search).toContain('status=new');
  expect(screen.getByRole('region', { name: 'Active record' }).textContent).toContain('exact-pinout-r7');
  await act(async () => history.push('/library/parts')); await act(async () => history.push('/library/connectors?tool=ports&status=new'));
  expect(screen.getByRole('region', { name: 'Active record' }).textContent).toContain('exact-pinout-r7');
});
test('new saved end stack crosses canonical route with exact body and pinout, without substitutes', async () => {
  const history = mount(); fireEvent.click(await screen.findByRole('button', { name: 'Prepared stack' })); expect(history.location.pathname).toBe('/library/connectors'); expect(history.location.search).toContain('tool=end-assemblies');
  const active = screen.getByRole('region', { name: 'Active record' }); expect(active.textContent).toContain('exact-body-r2'); expect(active.textContent).toContain('exact-pinout-r7');
});

test('an unrelated New kind gets its own buffer instead of reusing a prepared device port', async () => {
  const history = mount(); fireEvent.click(await screen.findByRole('button', { name: 'Prepared port' }));
  await act(async () => history.push('/library/connectors?kind=pinout&status=new'));
  expect(screen.getByRole('region', { name: 'Active record' }).textContent).not.toContain('exact-pinout-r7');
  await act(async () => history.push('/library/connectors?tool=ports&kind=port&status=new'));
  expect(screen.getByRole('region', { name: 'Active record' }).textContent).toContain('exact-pinout-r7');
});
