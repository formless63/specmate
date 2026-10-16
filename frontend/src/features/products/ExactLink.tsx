import { Anchor } from '@mantine/core';
import type { ReactNode } from 'react';
import { parseLocation, useNavigation } from '../navigation';

/** Keep local record buffers mounted while ordinary exact links change the workspace route. */
export function ExactLink({ href, children }: { href: string; children: ReactNode }) {
  const nav = useNavigation();
  return <Anchor href={href} onClick={event => {
    if (!nav || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const url = new URL(href, window.location.origin);
    nav.navigate(parseLocation(url.pathname, url.search));
  }}>{children}</Anchor>;
}
