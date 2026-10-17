import { expect, test } from 'vitest';
import { addLayer, removeLayer, type EndStack } from './api';

test('repeated layer placement versions the graph and preserves occurrence IDs and joins', () => {
  const original: EndStack = { layers: [{ kind: 'board', layer_id: 'board', board_revision_id: 'r1', carried_connector_id: null }], joins: [] };
  const next = addLayer(addLayer(original, 'board'), 'board');
  expect(next.graph_version).toBe('0.2');
  expect(next.layers.map(layer => layer.layer_id)).toEqual(['board', 'board-2', 'board-3']);
  expect(original.layers).toHaveLength(1);
});

test('removing one connector clears its explicit carried mapping and third solder joins only', () => {
  const stack: EndStack = {
    graph_version: '0.2',
    layers: [
      { kind: 'board', layer_id: 'carrier', board_revision_id: 'r1', carried_connector_id: 'plug', carried_connector_layer_id: 'plug-a' },
      { kind: 'connector', layer_id: 'plug-a', body_revision_id: 'body', pinout_revision_id: 'pins' },
      { kind: 'connector', layer_id: 'plug-b', body_revision_id: 'body', pinout_revision_id: 'pins' },
    ],
    joins: [{ local_id: 'solder', kind: 'solder', basis: 'Independent synthetic declaration', a: { layer_id: 'plug-a', terminal_id: '1' }, b: { layer_id: 'plug-b', terminal_id: '2' }, through: { layer_id: 'carrier', terminal_id: 'hole' } }],
  };
  const removed = removeLayer(stack, 'plug-a');
  expect(removed.graph_version).toBe('0.2');
  expect(removed.layers[0]).toMatchObject({ carried_connector_id: null, carried_connector_layer_id: null });
  expect(removed.layers[1]?.layer_id).toBe('plug-b');
  expect(removed.joins).toEqual([]);
  expect(removeLayer(stack, 'carrier').joins).toEqual([]);
  expect(stack.joins).toHaveLength(1);
});

test('removing a carried occurrence preserves sibling bindings on the same physical board',()=>{
 const stack:EndStack={graph_version:'0.2',layers:[{kind:'board',layer_id:'carrier',board_revision_id:'board',carried_connector_id:null,carried_connectors:[{carried_connector_id:'left',connector_layer_id:'plug-a'},{carried_connector_id:'right',connector_layer_id:'plug-b'}]},{kind:'connector',layer_id:'plug-a',body_revision_id:'body',pinout_revision_id:'pinout'},{kind:'connector',layer_id:'plug-b',body_revision_id:'body',pinout_revision_id:'pinout'}],joins:[]};
 expect(removeLayer(stack,'plug-a').layers[0]).toMatchObject({carried_connectors:[{carried_connector_id:'right',connector_layer_id:'plug-b'}]});
 expect(stack.layers[0]).toMatchObject({carried_connectors:[{carried_connector_id:'left',connector_layer_id:'plug-a'},{carried_connector_id:'right',connector_layer_id:'plug-b'}]});
});
