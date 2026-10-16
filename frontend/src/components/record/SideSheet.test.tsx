import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { SideSheet } from './SideSheet';
afterEach(cleanup);
test('local sheet buffers survive close and inactive parents hide every portal immediately', async () => {
  const tree = (active: boolean, opened: boolean) => <MantineProvider env="test"><SideSheet title="New device port" active={active} opened={opened} onClose={vi.fn()}><input aria-label="Local port name" defaultValue="" /></SideSheet></MantineProvider>;
  const view = render(tree(true, true)); const input = await screen.findByRole('textbox', { name: 'Local port name' }); fireEvent.change(input, { target: { value: 'Retained port' } }); view.rerender(tree(false, true)); expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('textbox', { name: 'Local port name' })).toBeNull(); const overlay = document.querySelector('.mantine-Drawer-overlay'); if (overlay) expect(getComputedStyle(overlay).display).toBe('none'); view.rerender(tree(true, false)); expect(screen.queryByRole('dialog')).toBeNull(); view.rerender(tree(true, true)); expect((await screen.findByRole('textbox', { name: 'Local port name' }) as HTMLInputElement).value).toBe('Retained port');
});
