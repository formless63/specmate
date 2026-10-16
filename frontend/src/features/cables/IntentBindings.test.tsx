import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { IntentBindings } from './IntentBindings';
import type { ResolvedStack } from '../end-assemblies/api';
const scrollIntoView = Element.prototype.scrollIntoView;
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Element.prototype.scrollIntoView = scrollIntoView; });

test('binding choices distinguish repeated contacts by endpoint and occurrence', () => {
  const onChange = vi.fn();
  const stack: ResolvedStack = { layers: ['plug-a', 'plug-b'].map(layer_id => ({ layer_id, kind: 'connector', name: 'Same catalog connector', terminals: [{ terminal_id: '1', label: 'Signal', kind: 'contact', reaches: [] }] })), joins: [], connector_layer_id: null, body_revision_id: null, pinout_revision_id: null, evaluation: [], continuity: 'not_evaluated' };
  render(<MantineProvider env="test"><IntentBindings value={{ intent_contact_bindings: [{ side: 'to', intent_contact_id: 'video', endpoint_id: 'far', layer_id: 'plug-a', terminal_id: '1', basis: 'Independent port requirement' }] }} onChange={onChange} endpoints={[{ local_id: 'far' }]} stacks={[stack]} /></MantineProvider>);
  fireEvent.click(screen.getByRole('combobox', { name: 'Binding 1 exact physical contact' }));
  fireEvent.click(screen.getByRole('option', { name: 'far / plug-b / Signal' }));
  expect(onChange).toHaveBeenLastCalledWith({ intent_endpoints: [], intent_contact_bindings: [{ side: 'to', intent_contact_id: 'video', endpoint_id: 'far', layer_id: 'plug-b', terminal_id: '1', basis: 'Independent port requirement' }] });
});
