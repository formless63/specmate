import { Button, Group, Select, Stack, Text, TextInput } from '@mantine/core';
import type { ResolvedStack } from '../end-assemblies/api';

export type IntentEndpointChoice = { side: 'from' | 'to'; endpoint_id: string; layer_id: string };
export type IntentContactBinding = IntentEndpointChoice & { intent_contact_id: string; terminal_id: string; basis: string };
export type IntentBindingsValue = { intent_endpoints?: IntentEndpointChoice[]; intent_contact_bindings?: IntentContactBinding[] };
/** Physical targets retain endpoint/layer/contact IDs, including repeated connector bodies. */
export function IntentBindings({ value, onChange, endpoints, stacks }: { value: IntentBindingsValue; onChange: (patch: IntentBindingsValue) => void; endpoints: { local_id: string }[]; stacks: (ResolvedStack | undefined)[] }) {
  const bindings = value.intent_contact_bindings ?? [];
  const layers = endpoints.flatMap((end, index) => (stacks[index]?.layers ?? []).filter(layer => layer.kind === 'connector').map(layer => ({ value: JSON.stringify([end.local_id, layer.layer_id]), label: `${end.local_id} / ${layer.layer_id} · ${layer.name ?? 'connector'}` })));
  const targets = endpoints.flatMap((end, index) => (stacks[index]?.layers ?? []).filter(layer => layer.kind === 'connector').flatMap(layer => layer.terminals.map(terminal => ({ value: JSON.stringify([end.local_id, layer.layer_id, terminal.terminal_id]), label: `${end.local_id} / ${layer.layer_id} / ${terminal.label}` }))));
  const change = (index: number, patch: Partial<IntentContactBinding>) => onChange({ intent_endpoints: [], intent_contact_bindings: bindings.map((binding, i) => i === index ? { ...binding, ...patch } : binding) });
  return <Stack gap="xs">
    <Text size="xs">Bind logical intent contacts to exact connector occurrences when an end contains several connectors. These declarations do not establish physical mating or measured continuity.</Text>
    {!bindings.length && (value.intent_endpoints ?? []).map(choice => <Select key={choice.side} label={`Intent ${choice.side} connector occurrence`} data={layers} value={JSON.stringify([choice.endpoint_id, choice.layer_id])} onChange={selected => { if (!selected) return; const [endpoint_id, layer_id] = JSON.parse(selected) as string[]; onChange({ intent_endpoints: value.intent_endpoints!.map(item => item.side === choice.side ? { ...item, endpoint_id: endpoint_id!, layer_id: layer_id! } : item) }); }} />)}
    {bindings.map((binding, index) => <Stack gap={4} key={index}>
      <Group grow><Select label={`Binding ${index + 1} intent side`} data={['from', 'to']} value={binding.side} onChange={side => change(index, { side: side as 'from' | 'to' })} /><TextInput label={`Binding ${index + 1} logical contact ID`} value={binding.intent_contact_id} onChange={event => change(index, { intent_contact_id: event.currentTarget.value })} /></Group>
      <Select searchable label={`Binding ${index + 1} exact physical contact`} data={targets} value={JSON.stringify([binding.endpoint_id, binding.layer_id, binding.terminal_id])} onChange={selected => { if (!selected) return; const [endpoint_id, layer_id, terminal_id] = JSON.parse(selected) as string[]; change(index, { endpoint_id: endpoint_id!, layer_id: layer_id!, terminal_id: terminal_id! }); }} />
      <TextInput label={`Binding ${index + 1} basis`} value={binding.basis} onChange={event => change(index, { basis: event.currentTarget.value })} />
      <Button size="compact-xs" variant="quiet" onClick={() => onChange({ intent_contact_bindings: bindings.filter((_, i) => i !== index) })}>Remove binding {index + 1}</Button>
    </Stack>)}
    <Group><Button size="compact-xs" variant="default" onClick={() => onChange({ intent_endpoints: [], intent_contact_bindings: [...bindings, { side: 'from', intent_contact_id: '', endpoint_id: '', layer_id: '', terminal_id: '', basis: '' }] })}>Add exact intent contact binding</Button>
      {!bindings.length && !value.intent_endpoints?.length && layers.length >= 2 && <Button size="compact-xs" variant="quiet" onClick={() => onChange({ intent_endpoints: [{ side: 'from', endpoint_id: '', layer_id: '' }, { side: 'to', endpoint_id: '', layer_id: '' }] })}>Choose whole-end connector occurrences</Button>}
    </Group>
  </Stack>;
}
