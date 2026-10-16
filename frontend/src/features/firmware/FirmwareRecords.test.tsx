import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { NavigationProvider, useNavigation } from '../navigation';
import { ProbeProvider } from '../probe';
import type { FirmwareRecordProps } from './FirmwareRecordPage';
import { FirmwareRecords } from './FirmwareRecords';
vi.mock('./FirmwareRecordPage', () => ({ FirmwareRecordPage: (props: FirmwareRecordProps) => { const [value, setValue] = useState(''); return <div hidden={!props.active}><p>{props.definitionId ?? 'new'} revision {props.revisionNumber ?? 'latest'} {props.working ? 'working' : 'frozen'}</p><input aria-label="Prepared declaration" value={value} onChange={event => setValue(event.currentTarget.value)} /><button onClick={() => props.onSelect(null, true)}>Continue draft</button><button onClick={() => props.onCreated('created', true)}>Save new firmware</button></div>; } }));
afterEach(cleanup);
function mount(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] }), client = new QueryClient();
  function Routed({ active }: { active: boolean }) { const nav = useNavigation()!; return <ProbeProvider probe={nav.location.probe} onProbe={() => {}}><FirmwareRecords active={active} principalKey="owner" workspaceId="w1" /></ProbeProvider>; }
  const tree = (active: boolean) => <MantineProvider><QueryClientProvider client={client}><NavigationProvider history={history}><Routed active={active} /></NavigationProvider></QueryClientProvider></MantineProvider>;
  const view = render(tree(true)); return { history, rerender: (active: boolean) => view.rerender(tree(active)) };
}
test('own exact firmware and contextual link path survive working navigation and inactive visits', async () => {
  const view = mount('/designs/fw@7/~/right/board?tool=occurrence-firmware');
  await screen.findByText('fw revision 7 frozen'); fireEvent.change(screen.getByLabelText('Prepared declaration'), { target: { value: 'Independent draft fields' } });
  view.rerender(false); view.rerender(true); expect(screen.getByLabelText('Prepared declaration')).toHaveProperty('value', 'Independent draft fields');
  fireEvent.click(screen.getByRole('button', { name: 'Continue draft' })); expect(view.history.location.pathname).toBe('/designs/fw/~/right/board'); expect(view.history.location.search).toContain('status=draft');
});
test('explicit firmware New returns its own saved ID without adopting a parent Device ID', async () => {
  const view = mount('/designs?tool=occurrence-firmware&status=new&kind=firmware'); await screen.findByText('new revision latest working');
  fireEvent.click(screen.getByRole('button', { name: 'Save new firmware' }));
  expect(view.history.location.pathname).toBe('/designs/created'); expect(view.history.location.search).toContain('status=draft');
});
