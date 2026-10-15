import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HarnessEditor } from './HarnessEditor';
import { initialHarness, type Harness } from './api';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const red = { key: 'video_red', name: 'Red video', type: 'analog_video', set_name: 'AV signals', set_revision_number: 1 };
// A synthetic resolution: board pad R reaches plug contact 4 (Red video); the shell joins nothing.
const resolved = {
  layers: [
    { layer_id: 'board', kind: 'board', name: 'Adapter board r1', terminals: [{ terminal_id: 'r', label: 'R', kind: 'pad', reaches: [{ contact_id: '4', label: '4', signal: red, status: 'declared', via: ['Straight copper', 'landing'] }] }], paths: [] },
    { layer_id: 'connector', kind: 'connector', name: 'Round plug r1', variant_label: 'Console A', terminals: [{ terminal_id: '4', label: '4', kind: 'contact', signal: red, reaches: [] }] },
    { layer_id: 'shell', kind: 'shell', name: 'Shell r1', terminals: [{ terminal_id: 'body', label: 'Shell body', kind: 'shell', reaches: [] }] },
  ],
  joins: [], connector_layer_id: 'connector', body_revision_id: 'plug-1', pinout_revision_id: 'variant-1', evaluation: [], continuity: 'not_evaluated',
};

function Host({ onValue, initial }: { onValue: (v: Harness) => void; initial: Harness }) {
  const [value, setValue] = useState(initial);
  return <HarnessEditor value={value} definitions={[]} onChange={v => { setValue(v); onValue(v); }} />;
}
function wrap(node: React.ReactNode) {
  return <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider></MantineProvider>;
}

test('an endpoint pins an end assembly; joints land on its labeled stack terminals by layer', async () => {
  const resolves: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('end-stacks/resolve')) { resolves.push(JSON.parse(String(options?.body))); return response(resolved); }
    return response({ detail: 'not found' }, 404);
  }));
  const values: Harness[] = [];
  const initial: Harness = { ...initialHarness(), endpoints: [{ local_id: 'console', label: 'Console end', end_assembly_revision_id: 'assembly-1', stack: null }] };
  render(wrap(<Host initial={initial} onValue={v => values.push(v)} />));
  expect(await screen.findByRole('list', { name: 'Console end stack' })).toBeTruthy();
  expect(resolves[0]).toEqual({ end_assembly_revision_id: 'assembly-1' });
  const members = screen.getAllByLabelText('Joint exact members').find(e => e.tagName === 'INPUT' && (e as HTMLInputElement).type !== 'hidden')!;
  fireEvent.focus(members); fireEvent.click(members); fireEvent.keyDown(members, { key: 'ArrowDown' });
  const options = within(await screen.findByRole('listbox', { name: 'Joint exact members', hidden: true })).getAllByRole('option', { hidden: true }).map(o => o.textContent);
  expect(options).toContain('Console end / board R · Red video');
  expect(options).toContain('Console end / shell Shell body');
  // Switching to an ad-hoc stack starts from one connector layer, never a guessed board.
  fireEvent.click(screen.getByRole('radio', { name: 'Build the stack here' }));
  expect(values.at(-1)?.endpoints[0]).toMatchObject({ end_assembly_revision_id: null, stack: { layers: [{ kind: 'connector' }], joins: [] } });
});

test('new harnesses are content 0.2 and new endpoints start as a connector stack', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ detail: 'not found' }, 404)));
  const values: Harness[] = [];
  render(wrap(<Host initial={initialHarness()} onValue={v => values.push(v)} />));
  expect(initialHarness().schema_version).toBe('0.2');
  fireEvent.change(screen.getByLabelText('New endpoint ID'), { target: { value: 'out' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));
  expect(values.at(-1)?.endpoints[0]).toMatchObject({ local_id: 'out', end_assembly_revision_id: null, stack: { layers: [{ kind: 'connector', layer_id: 'connector' }] } });
});
