import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { ProbeProvider, useProbe } from '../probe';
import { DeviceSections } from './DeviceSections';
vi.mock('../configurations/ConfigurationsPanel', () => ({ ConfigurationsPanel: () => {
  const shared = useProbe(); const [text, setText] = useState('');
  return <><input aria-label="Independent option buffer" value={text} onChange={event => setText(event.currentTarget.value)} /><button onClick={() => shared?.setProbe({ object: 'configuration', rev: 3, path: [] })}>Choose separate configuration</button><output data-testid="section-probe">{shared?.probe?.object ?? 'None'}</output></>;
} }));
afterEach(cleanup);
test('the separate option controller retains its own target and buffer while root pins or visibility change', () => {
  const onRoot = vi.fn();
  const tree = (active: boolean, revisionId: string) => <MantineProvider env="test"><ProbeProvider probe={{ object: 'device', rev: 1, path: ['right', 'board'] }} onProbe={onRoot}><DeviceSections section="options" active={active} workspaceId="workspace" principalKey="principal" definitionId="device" revisionId={revisionId} snapshotId="snapshot" /></ProbeProvider></MantineProvider>;
  const view = render(tree(true, 'r1')); fireEvent.change(screen.getByLabelText('Independent option buffer'), { target: { value: 'Unsaved secondary choices' } }); fireEvent.click(screen.getByText('Choose separate configuration'));
  view.rerender(tree(false, 'r2')); expect(screen.queryByRole('button', { name: 'Choose separate configuration' })).toBeNull(); view.rerender(tree(true, 'r2'));
  expect((screen.getByLabelText('Independent option buffer') as HTMLInputElement).value).toBe('Unsaved secondary choices'); expect(screen.getByTestId('section-probe').textContent).toBe('configuration'); expect(onRoot).not.toHaveBeenCalled();
});
