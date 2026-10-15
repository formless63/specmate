import { Alert, Button, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { requestJson } from '../workspace/api';
import { FrozenDefinitionPicker, type FrozenChoice } from './FrozenDefinitionPicker';
import type { Board, CarriedConnector } from './api';

export function BoardCarries({ board, onChange, editable, active, principalKey, onAccessLost }: {
  board: Board; onChange: (value: Board) => void; editable: boolean; active: boolean; principalKey: string; onAccessLost: (error: unknown) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null); const [pendingBody, setPendingBody] = useState<FrozenChoice | null>(null);
  const connector = board.carried_connectors.find(row => row.local_id === chosen) ?? board.carried_connectors[0];
  const body = useQuery({ queryKey: ['board-carried-body', principalKey, connector?.body_revision_id], enabled: active && !!connector, retry: false,
    queryFn: ({ signal }) => requestJson<{ interface: { kind: string; contacts: { contact_id: string; number: string | null; label: string; physical_role: string }[] } }>(`/api/v0/interfaces/revisions/${connector!.body_revision_id}`, { signal }) });
  useEffect(() => { if (body.isError) onAccessLost(body.error); }, [body.isError, body.error, onAccessLost]);
  const put = (value: CarriedConnector) => { if (editable) onChange({ ...board, carried_connectors: board.carried_connectors.map(row => row.local_id === value.local_id ? value : row) }); };
  const contacts = body.isError || body.isFetching ? [] : body.data?.interface.kind === 'connector_body' ? body.data.interface.contacts.filter(row => row.physical_role !== 'key') : [];
  return <Stack gap="xs"><Text size="sm">Bodies and contact-to-pad landings are exact declarations. They do not establish fit, polarity, compatibility or measured continuity.</Text>
    {!board.carried_connectors.length && <Text>No carried connectors declared.</Text>}
    {!!board.carried_connectors.length && <Select size="xs" label="Carried connector" value={connector?.local_id ?? null} onChange={setChosen} data={board.carried_connectors.map(row => ({ value: row.local_id, label: row.local_id }))} />}
    {connector && <><RevisionLabel id={connector.body_revision_id} role="Exact body" />
      {body.isError && <Alert color="red">Exact body unavailable. Retained contacts are hidden.</Alert>}
      <fieldset className="board-record-fields" disabled={!editable}><Select size="xs" label="Landing review" value={connector.review} data={['unreviewed', 'reviewed']} onChange={value => put({ ...connector, review: value as CarriedConnector['review'] })} /><TextInput size="xs" label="Landing basis" value={connector.basis ?? ''} onChange={event => put({ ...connector, basis: event.currentTarget.value || null })} />
        <Table verticalSpacing={4}><Table.Thead><Table.Tr><Table.Th>Exact contact</Table.Th><Table.Th>Pad</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{contacts.map(contact => <Table.Tr key={contact.contact_id}><Table.Td>{contact.number ?? contact.label}<Text size="xs">{contact.contact_id}</Text></Table.Td><Table.Td><Select size="xs" clearable label={`Pad for contact ${contact.number ?? contact.label}`} value={connector.correspondence.find(row => row.contact_id === contact.contact_id)?.terminal_id ?? null} data={board.terminals.map(pad => ({ value: pad.terminal_id, label: pad.label }))} onChange={terminal => put({ ...connector, correspondence: [...connector.correspondence.filter(row => row.contact_id !== contact.contact_id && row.terminal_id !== terminal), ...(terminal ? [{ contact_id: contact.contact_id, terminal_id: terminal }] : [])] })} /></Table.Td></Table.Tr>)}</Table.Tbody></Table>
        <Button size="xs" variant="quiet" onClick={() => onChange({ ...board, carried_connectors: board.carried_connectors.filter(row => row.local_id !== connector.local_id) })}>Remove carried connector</Button>
      </fieldset>
    </>}
    {editable && <><Text size="xs">Choose a frozen body to add another independently pinned connector.</Text><FrozenDefinitionPicker label="Connector body" kinds={['connector_body']} active={active} principalKey={principalKey} onPick={setPendingBody} /><Button size="xs" disabled={!pendingBody} onClick={() => {
      if (!pendingBody) return;
      let number = board.carried_connectors.length + 1; while (board.carried_connectors.some(row => row.local_id === `connector-${number}`)) number += 1;
      const local_id = `connector-${number}`; onChange({ ...board, carried_connectors: [...board.carried_connectors, { local_id, body_revision_id: pendingBody.revision_id, correspondence: [], review: 'unreviewed', basis: null }] }); setChosen(local_id);
    }}>Add exact body</Button></>}
  </Stack>;
}
