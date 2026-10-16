import { Drawer } from '@mantine/core';
import type { ReactNode } from 'react';

/** A retained local task; hiding its parent withdraws its portal synchronously. */
export function SideSheet({ title, opened, active, onClose, children }: { title: string; opened: boolean; active: boolean; onClose: () => void; children: ReactNode }) {
  return <Drawer title={title} opened={active && opened} onClose={onClose} position="right" size="min(960px, 100vw)" keepMounted closeButtonProps={{ 'aria-label': `Close ${title}` }} transitionProps={{ duration: active ? 150 : 0 }} styles={active ? undefined : { inner: { display: 'none' }, overlay: { display: 'none' } }}>{children}</Drawer>;
}
