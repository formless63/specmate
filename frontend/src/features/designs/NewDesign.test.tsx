import { MantineProvider } from '@mantine/core';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import { NavigationProvider } from '../navigation';
import { NewDesign } from './NewDesign';
afterEach(() => cleanup());
function mount(editable = true) { const history = createMemoryHistory({ initialEntries: ['/designs/new'] }), create = vi.fn(); render(<MantineProvider env="test"><NavigationProvider history={history}><PermissionsProvider permissions={editable ? ['workspace.read','item.create'] : ['workspace.read']}><NewDesign onCreate={create} /></PermissionsProvider></NavigationProvider></MantineProvider>); return { history, create }; }
test('chooser offers five concrete forms without creating records and preserves distinct cable start choices', async () => { const { history, create } = mount(); for (const [name, kind] of [['cable','cable'],['harness','harness'],['device','assembly']]) { fireEvent.click(screen.getByRole('button', { name: `Prepare ${name}` })); expect(create).toHaveBeenLastCalledWith(kind); } fireEvent.click(screen.getByRole('button', { name: 'Prepare board' })); await waitFor(() => expect(history.location.pathname+history.location.search).toBe('/library/boards?status=new')); fireEvent.click(screen.getByRole('button', { name: 'Prepare printed part' })); await waitFor(() => expect(history.location.pathname+history.location.search).toBe('/library/parts?kind=part&status=new')); expect(screen.getByText(/physical qualification remain separate/)).toBeTruthy(); });
test('viewer can read choices but cannot open creation forms', () => { const { create, history } = mount(false); for (const button of screen.getAllByRole('button')) { expect((button as HTMLButtonElement).disabled).toBe(true); fireEvent.click(button); } expect(create).not.toHaveBeenCalled(); expect(history.location.pathname).toBe('/designs/new'); });
