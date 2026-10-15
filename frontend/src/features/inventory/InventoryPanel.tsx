import { useNewFormRequest } from "../make/useNewFormRequest";
import { ReadOnlyNote, usePermission, InspectionScope } from "../../lib/permissions";
import { useOpenProbed } from "../scope/openProbed";
import { Alert, Button, Card, Group, NativeSelect, Stack, Switch, Table, Text, TextInput, Title } from "@mantine/core";
import { SbQuantity } from "../../components/sb";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { WorkPanel, UsageForm } from "./WorkPanel";
import { command, read, request, type Account, type Command, type Detail, type Inventory, type WorkBatch } from "./api";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { SourcingPanel } from "./SourcingPanel";

const units: Record<string, string[]> = { count: ["ea"], length: ["m", "cm", "mm"], mass: ["kg", "g"] };

/** Stock lives in the workspace; the optional project is only the context new work is filed under. */
export function InventoryPanel({ workspaceId, projectId, initialWorkId = null, active = true }: { workspaceId: string; projectId?: string; initialWorkId?: string | null; active?: boolean }) {
  return <Workspace key={`${workspaceId}:${projectId ?? ""}`} workspaceId={workspaceId} projectId={projectId} initialWorkId={initialWorkId} active={active} />;
}

function Workspace({ workspaceId, projectId, initialWorkId, active }: { workspaceId: string; projectId?: string; initialWorkId: string | null; active: boolean }) {
  const cache = useQueryClient();
  const manageGate = usePermission("inventory.manage");
  const [offset, setOffset] = useState(0);
  const [projectOnly, setProjectOnly] = useState(false);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [lot, setLot] = useState("");
  const [location, setLocation] = useState("");
  const [dimension, setDimension] = useState("count");
  const [known, setKnown] = useState("unknown");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState("ea");
  const [reason, setReason] = useState("");
  const [source, setSource] = useState("");
  const [pendingRequest, setPendingRequest] = useState<Command | null>(null);
  const inventory = useQuery({ queryKey: ["inventory", workspaceId, projectOnly ? projectId : null, offset], queryFn: () => read<Inventory>(`inventory/workspaces/${workspaceId}?offset=${offset}&limit=50${projectOnly && projectId ? `&project_id=${projectId}` : ""}`) });
  const mutation = useMutation({ mutationFn: command, onSuccess: async () => {
    setPendingRequest(null);
    await cache.invalidateQueries({ queryKey: ["inventory", workspaceId] });
    await cache.invalidateQueries({ queryKey: ["inventory-account"] });
    await cache.invalidateQueries({ queryKey: ["inventory-work"] });
  }, onError: async () => {
    await cache.invalidateQueries({ queryKey: ["inventory", workspaceId] });
    await cache.invalidateQueries({ queryKey: ["inventory-account"] });
    await cache.invalidateQueries({ queryKey: ["inventory-work"] });
  } });
  function submit(operation: string, payload: object, state?: string) {
    const envelope = request(operation, payload, state);
    setPendingRequest(envelope); mutation.mutate(envelope);
  }
  const newForm = useNewFormRequest("inventory", active && manageGate.allowed);
  const data = inventory.data;
  // A Library row or deep link opens its stock account on the listed page.
  useOpenProbed(inventory.data ? (id) => inventory.data.accounts.some((account) => account.account_id === id) : null, setSelected);
  return <Stack>
    <Title order={2}>Inventory</Title>
    <Text>Stock lots remain pinned to their exact design revision. Reservations hold availability while the physical balance stays on hand.</Text>
    {inventory.isError && <Alert color="red">{inventory.error.message}</Alert>}
    {mutation.isError && <Alert color="red"><Stack><Text>{mutation.error.message}</Text><Text size="sm">The current ledger has been refreshed. Retrying this request uses its original key and state.</Text>{pendingRequest && <Button loading={mutation.isPending} onClick={() => mutation.mutate(pendingRequest)}>Retry same request</Button>}</Stack></Alert>}
    {mutation.isSuccess && <Alert color="green">Inventory operation completed.</Alert>}
    <Card withBorder><Stack>
      <Title order={3}>Locations</Title>
      <InspectionScope permission="inventory.manage">
      <TextInput label="New location name" value={name} onChange={(event) => setName(event.currentTarget.value)} />
      </InspectionScope>
      <Button disabled={!name.trim()} loading={mutation.isPending} onClick={() => submit("inventory.create_location", { workspace_id: workspaceId, name })} {...manageGate.props}>Create location</Button><ReadOnlyNote permission="inventory.manage">Opening locations and accounts is unavailable.</ReadOnlyNote>
    </Stack></Card>
    <div ref={newForm}><Card withBorder><Stack>
      <Title order={3}>Open stock account</Title>
      <Text size="sm">Choose a registered physical lot and location. An unknown balance remains unavailable until an explicit quantity assertion is recorded.</Text>
      <InspectionScope permission="inventory.manage">
      <NativeSelect label="Physical lot" value={lot} onChange={(event) => setLot(event.currentTarget.value)} data={[{ value: "", label: "Choose lot" }, ...(data?.lots ?? []).map((item) => ({ value: item.lot_id, label: `${item.label} · ${item.lot_id}` }))]} />
      <NativeSelect label="Stock location" value={location} onChange={(event) => setLocation(event.currentTarget.value)} data={[{ value: "", label: "Choose location" }, ...(data?.locations ?? []).map((item) => ({ value: item.location_id, label: item.name }))]} />
      <NativeSelect label="Quantity dimension" value={dimension} onChange={(event) => { setDimension(event.currentTarget.value); setUnit(units[event.currentTarget.value]?.[0] ?? "ea"); }} data={["count", "length", "mass"]} />
      <NativeSelect label="Opening balance status" value={known} onChange={(event) => setKnown(event.currentTarget.value)} data={["unknown", "known"]} />
      {known === "known" && <><TextInput label="Opening quantity" value={amount} onChange={(event) => setAmount(event.currentTarget.value)} /><NativeSelect label="Opening unit" value={unit} onChange={(event) => setUnit(event.currentTarget.value)} data={units[dimension]} /></>}
      <TextInput label="Opening reason" value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
      <TextInput label="Opening assertion source" value={source} onChange={(event) => setSource(event.currentTarget.value)} />
      </InspectionScope>
      <Button disabled={!lot || !location || !reason.trim() || !source.trim() || (known === "known" && !amount.trim())} loading={mutation.isPending} onClick={() => submit("inventory.open_stock", { lot_id: lot, location_id: location, dimension, quantity: known === "known" ? { amount, unit } : null, reason, assertion_source: source, assertion_status: "declared" })} {...manageGate.props}>Open account</Button>
    </Stack></Card></div>
    {projectId && <Switch label="Only work filed under this project" checked={projectOnly} onChange={(event) => { setProjectOnly(event.currentTarget.checked); setOffset(0); }} />}
    <WorkPanel initialWorkId={initialWorkId} workspaceId={workspaceId} projectId={projectId} batches={data?.work_batches ?? []} pending={mutation.isPending} submit={submit} />
    <SourcingPanel workspaceId={workspaceId} />
    <Title order={3}>Current stock</Title>
    <Table><Table.Thead><Table.Tr><Table.Th>Lot / location</Table.Th><Table.Th>Physical</Table.Th><Table.Th>Reserved</Table.Th><Table.Th>Available</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>{data?.accounts.map((account) => <Table.Tr key={account.account_id}><Table.Td>{account.lot_label} / {account.location_name}</Table.Td><Table.Td><SbQuantity value={account.physical_quantity} unit={account.unit} /></Table.Td><Table.Td>{account.reserved_quantity} {account.unit}</Table.Td><Table.Td><SbQuantity value={account.available_quantity} unit={account.unit} /></Table.Td><Table.Td><Button size="xs" onClick={() => setSelected(account.account_id)}>Manage {account.lot_label}</Button></Table.Td></Table.Tr>)}</Table.Tbody></Table>
    <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous inventory</Button><Text>Page {offset / 50 + 1}</Text><Button disabled={Math.max(data?.accounts.length ?? 0, data?.lots.length ?? 0, data?.locations.length ?? 0, data?.work_batches?.length ?? 0) < 50} onClick={() => setOffset(offset + 50)}>Next inventory</Button></Group>
    {selected && <AccountEditor key={selected} accountId={selected} projectId={projectId} batches={data?.work_batches ?? []} pending={mutation.isPending} submit={submit} />}
  </Stack>;
}

function AccountEditor({ accountId, projectId, batches, pending, submit }: { accountId: string; projectId?: string; batches: WorkBatch[]; pending: boolean; submit: (operation: string, payload: object, state?: string) => void }) {
  const reserveGate = usePermission("inventory.reserve");
  const [offset, setOffset] = useState(0);
  const detail = useQuery({ queryKey: ["inventory-account", accountId, offset], queryFn: () => read<Detail>(`inventory/accounts/${accountId}?offset=${offset}&limit=50`) });
  return <Card withBorder><Stack>
    {detail.isError && <Alert color="red">{detail.error.message}</Alert>}
    {detail.data && <>
      <StockForm key={detail.data.account.account_id} account={detail.data.account} projectId={projectId} pending={pending} submit={submit} />
      <Title order={4}>Reservations</Title>
      {detail.data.reservations.map((reservation) => <Group key={reservation.reservation_id}><Text>{reservation.amount} {reservation.unit} · {reservation.purpose} · {reservation.status}{reservation.remaining_quantity ? ` · remaining ${reservation.remaining_quantity} ${detail.data!.account.unit}` : ""}{reservation.release ? ` · ${reservation.release.reason}` : ""}</Text>{reservation.status === "active" && <Button disabled={pending} onClick={() => submit("inventory.release", { reservation_id: reservation.reservation_id, reason: "Released from inventory workspace" }, detail.data!.account.state)} {...reserveGate.props}>Release reservation</Button>}</Group>)}
      <UsageForm detail={detail.data} batches={batches} pending={pending} submit={submit} />
      <Title order={4}>Stock history</Title>
      {detail.data.entries.map((entry) => <Text key={entry.entry_id}>{entry.kind}: <SbQuantity value={entry.amount} unit={entry.unit} /> · balance <SbQuantity value={entry.after} unit={detail.data!.account.unit} /> · {entry.reason}{entry.work_batch_id ? ` · work ${entry.work_batch_id}` : ""}{entry.consumption_origin_id ? ` · return of ${entry.consumption_origin_id}` : ""} · {entry.assertion_status}: {entry.assertion_source} · {new Date(entry.created_at).toLocaleString()}</Text>)}
      <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous history</Button><Button disabled={Math.max(detail.data.entries.length, detail.data.reservations.length) < 50} onClick={() => setOffset(offset + 50)}>Next history</Button></Group>
    </>}
  </Stack></Card>;
}

function StockForm({ account, projectId, pending, submit }: { account: Account; projectId?: string; pending: boolean; submit: (operation: string, payload: object, state?: string) => void }) {
  const [action, setAction] = useState("establish_quantity");
  const manageGate = usePermission("inventory.manage");
  const reserveGate = usePermission("inventory.reserve");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState(account.unit);
  const [reason, setReason] = useState("");
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("declared");
  const unknown = account.quantity_status === "unknown";
  const blocked = unknown && action !== "establish_quantity";
  return <Stack>
    <Title order={3}>{account.lot_label} at {account.location_name}</Title>
    <Text size="sm"><RevisionLabel id={account.revision_id} />. Current assertion: {account.assertion_status} · {account.assertion_source}. Stock observations do not qualify a physical item.</Text>
    {unknown && <Alert color="yellow">Stock quantity is unknown. Record an explicit quantity assertion before receiving, adjusting or reserving stock.</Alert>}
    <InspectionScope permission={action === "reserve" ? "inventory.reserve" : "inventory.manage"}>
    <NativeSelect label="Stock operation" value={action} onChange={(event) => setAction(event.currentTarget.value)} data={[{ value: "establish_quantity", label: "Record quantity assertion" }, { value: "receive", label: "Receive stock" }, { value: "adjust", label: "Adjust stock" }, { value: "reserve", label: "Reserve stock" }]} />
    <TextInput label="Operation quantity" value={amount} onChange={(event) => setAmount(event.currentTarget.value)} />
    <NativeSelect label="Operation unit" value={unit} onChange={(event) => setUnit(event.currentTarget.value)} data={units[account.dimension]} />
    <TextInput label={action === "reserve" ? "Reservation purpose" : "Operation reason"} value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
    {action !== "reserve" && <><TextInput label="Assertion source" value={source} onChange={(event) => setSource(event.currentTarget.value)} /><NativeSelect label="Assertion status" value={status} onChange={(event) => setStatus(event.currentTarget.value)} data={["declared", "observed", "measured"]} /></>}
    </InspectionScope>
    <Button disabled={blocked || !amount.trim() || !reason.trim() || (action !== "reserve" && !source.trim())} loading={pending} onClick={() => submit(`inventory.${action}`, { account_id: account.account_id, quantity: { amount, unit }, ...(action === "reserve" ? { purpose: reason, ...(projectId ? { project_id: projectId } : {}) } : { reason, assertion_source: source, assertion_status: status }) }, account.state)} {...(action === "reserve" ? reserveGate : manageGate).props}>Apply stock operation</Button><ReadOnlyNote permission={action === "reserve" ? "inventory.reserve" : "inventory.manage"}>Stock operations are unavailable.</ReadOnlyNote>
  </Stack>;
}
