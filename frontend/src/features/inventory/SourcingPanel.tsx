import { Alert, Button, Card, Group, NativeSelect, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { InspectionScope, ReadOnlyNote, usePermission } from "../../lib/permissions";
import { SbStatus, SbUnknown, type SbLed } from "../../components/sb";
import { revisionOptionLabel } from "../../lib/revision-labels";
import type { Definition, Identity } from "../identity/api";
import { command, request } from "./api";
import { fetchReport, read, type OfferView, type Qty, type SourcingReport } from "./sourcing";

const FRESH_LED: Record<string, SbLed> = { current: "active", stale: "stale", expired: "failed", unknown: "not-evaluated" };

function Quantity({ value, what }: { value: Qty; what: string }) {
  return value.status === "known" ? <span>{value.amount} {value.unit}</span> : <SbUnknown what={what} />;
}

function OfferLine({ offer }: { offer: OfferView }) {
  const price = offer.price?.amount != null ? `${offer.price.amount} ${offer.price.currency ?? ""}`.trim() + ` per ${offer.price.per_unit}` : null;
  const cost = offer.estimated_cost;
  return <Group gap="xs" wrap="wrap">
    <Text size="sm" fw={600}>{offer.supplier}{offer.supplier_ref ? ` · ${offer.supplier_ref}` : ""}</Text>
    {price ? <Text size="sm">{price}{offer.price?.currency ? "" : " (currency unknown)"}</Text> : <SbUnknown what="price" />}
    {offer.freshness && <SbStatus led={FRESH_LED[offer.freshness] ?? "not-evaluated"} dimension="freshness" value={offer.freshness === "unknown" ? "unknown (no policy or expiry)" : `${offer.freshness}, ${offer.age_days} d old`} />}
    <Text size="xs">offered {offer.offered_on}{offer.valid_until ? `, valid to ${offer.valid_until}` : ""} · availability {offer.availability} · reviewed by {offer.reviewed_by.username}</Text>
    {cost?.status === "known" ? <Text size="sm">estimate {cost.amount} {cost.currency}</Text> : cost ? <SbUnknown what={`cost (${cost.reason})`} /> : null}
    {offer.substitution && <Text size="xs">Substitute, not counted toward the need: {offer.substitution.basis}{offer.revision_name ? ` (${offer.revision_name})` : ""}</Text>}
  </Group>;
}

function ReportView({ report }: { report: SourcingReport }) {
  return <Stack gap="xs">
    <Group gap="md">
      <SbStatus led={report.cost.status === "complete" ? "active" : "not-evaluated"} dimension="cost" value={report.cost.status.replace("_", " ")} />
      <Text size="xs">as of {report.as_of} · {report.cost.rows_needing_purchase} to buy · {report.cost.rows_without_price} without a usable price · {report.cost.rows_shortfall_unknown} shortfall unknown</Text>
      {report.cost.totals.map((total) => <Text key={total.currency} size="sm">{total.currency} {total.amount} ({total.rows_priced} rows)</Text>)}
    </Group>
    {report.unresolved.length > 0 && <Alert color="yellow">{report.unresolved.length} plan decision(s) remain unresolved, so the need itself is incomplete.</Alert>}
    <Table><Table.Thead><Table.Tr><Table.Th>Item</Table.Th><Table.Th>Required</Table.Th><Table.Th>Available</Table.Th><Table.Th>Shortfall</Table.Th><Table.Th>Offers</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{report.rows.map((row) => <Table.Tr key={row.revision_id}>
        <Table.Td>{row.name}</Table.Td>
        <Table.Td><Quantity value={row.required} what="required (waste allowance?)" /></Table.Td>
        <Table.Td><Quantity value={row.stock.available} what="available" />{row.stock.available_is_lower_bound && <Text size="xs">at least; some balances unknown</Text>}{row.stock.status === "none_recorded" && <Text size="xs">no stock account recorded</Text>}{row.stock.observed_at && <Text size="xs">as of {row.stock.observed_at.slice(0, 10)}</Text>}</Table.Td>
        <Table.Td><Quantity value={row.shortfall} what="shortfall" />{row.shortfall.reason && <Text size="xs">{row.shortfall.reason.replaceAll("_", " ")}</Text>}{row.shortfall.at_most && <Text size="xs">at most {row.shortfall.at_most}</Text>}{row.shortfall.at_least && <Text size="xs">at least {row.shortfall.at_least}</Text>}</Table.Td>
        <Table.Td><Stack gap={4}>{row.offers.length === 0 && row.substitutes.length === 0 && <SbUnknown what="offers" />}{row.offers.map((offer) => <OfferLine key={offer.offer_id} offer={offer} />)}{row.substitutes.map((offer) => <OfferLine key={offer.offer_id} offer={offer} />)}</Stack></Table.Td>
      </Table.Tr>)}</Table.Tbody></Table>
    <Text size="xs">{report.limitations.join(" ")}</Text>
  </Stack>;
}

function useRevisionChoice(workspaceId: string, kinds: string[] | null) {
  const [definition, setDefinition] = useState("");
  const [revision, setRevision] = useState("");
  const definitions = useQuery({ queryKey: ["identity-definitions", workspaceId], queryFn: () => read<Definition[]>(`workspaces/${workspaceId}/definitions`) });
  const identity = useQuery({ queryKey: ["identity", definition, 0], enabled: !!definition, queryFn: () => read<Identity>(`catalog/definitions/${definition}?offset=0`) });
  const options = (definitions.data ?? []).filter((d) => !kinds || kinds.includes(d.kind));
  return { definition, setDefinition, revision, setRevision, options, identity, error: definitions.error ?? identity.error };
}

function Chooser({ label, choice }: { label: string; choice: ReturnType<typeof useRevisionChoice> }) {
  return <>
    <NativeSelect label={`${label} definition`} value={choice.definition} onChange={(e) => { choice.setDefinition(e.currentTarget.value); choice.setRevision(""); }} data={[{ value: "", label: "Choose definition" }, ...choice.options.map((d) => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))]} />
    <NativeSelect label={`${label} exact revision`} value={choice.revision} onChange={(e) => choice.setRevision(e.currentTarget.value)} data={[{ value: "", label: "Choose frozen revision" }, ...(choice.identity.data?.revisions ?? []).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(choice.identity.data?.name, r.number) }))]} />
  </>;
}

/** Frozen need + live stock + dated, reviewed offers. Costs are optional and unknowns stay visible. */
export function SourcingPanel({ workspaceId }: { workspaceId: string }) {
  const cache = useQueryClient();
  const manageGate = usePermission("item.create");
  const plan = useRevisionChoice(workspaceId, ["bom_plan", "material_plan"]);
  const item = useRevisionChoice(workspaceId, null);
  const replaced = useRevisionChoice(workspaceId, null);
  const [maxAge, setMaxAge] = useState("");
  const [asOf, setAsOf] = useState("");
  const [supplier, setSupplier] = useState("");
  const [ref, setRef] = useState("");
  const [source, setSource] = useState("");
  const [basis, setBasis] = useState("");
  const [offeredOn, setOfferedOn] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("");
  const [perUnit, setPerUnit] = useState("ea");
  const [availability, setAvailability] = useState("unknown");
  const [substitution, setSubstitution] = useState("");
  const report = useQuery({ queryKey: ["sourcing-report", plan.revision, maxAge, asOf], enabled: !!plan.revision, queryFn: () => fetchReport(plan.revision, maxAge, asOf) });
  const record = useMutation({
    mutationFn: () => command(request("sourcing.record_offer", {
      workspace_id: workspaceId, revision_id: item.revision, supplier, supplier_ref: ref, source, review_basis: basis,
      offered_on: offeredOn, valid_until: validUntil || null,
      price: amount.trim() || currency.trim() ? { amount: amount.trim() || null, currency: currency.trim() || null, per_unit: perUnit } : null,
      availability,
      ...(substitution.trim() && replaced.revision ? { substitute_for_revision_id: replaced.revision, substitution_basis: substitution } : {}),
    })),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: ["sourcing-report"] }); },
  });
  const ready = item.revision && supplier.trim() && source.trim() && basis.trim() && offeredOn.trim();
  return <Card withBorder><Stack>
    <Title order={3}>Sourcing</Title>
    <Text size="sm">Compare a frozen BOM or material plan with live stock and dated, reviewed supplier offers. Prices and currencies are optional: an unknown price stays unknown and never blocks a build sheet. Nothing here fetches live prices.</Text>
    {(plan.error ?? report.error) && <Alert color="red">{(plan.error ?? report.error)?.message}</Alert>}
    <Chooser label="Plan" choice={plan} />
    <Group><TextInput label="Treat offers older than (days)" value={maxAge} onChange={(e) => setMaxAge(e.currentTarget.value)} /><TextInput label="As of date (YYYY-MM-DD)" value={asOf} onChange={(e) => setAsOf(e.currentTarget.value)} /></Group>
    {report.data && <ReportView report={report.data} />}
    <Title order={4}>Record a reviewed offer</Title>
    {record.isError && <Alert color="red">{record.error.message}</Alert>}
    {record.isSuccess && <Alert color="green">Offer recorded; you are its reviewer.</Alert>}
    <InspectionScope permission="item.create">
      <Chooser label="Offered item" choice={item} />
      <TextInput label="Supplier" value={supplier} onChange={(e) => setSupplier(e.currentTarget.value)} />
      <TextInput label="Supplier reference (optional)" value={ref} onChange={(e) => setRef(e.currentTarget.value)} />
      <TextInput label="Offer source (quote, page, email)" value={source} onChange={(e) => setSource(e.currentTarget.value)} />
      <TextInput label="Review basis" value={basis} onChange={(e) => setBasis(e.currentTarget.value)} />
      <Group><TextInput label="Offered on (YYYY-MM-DD)" value={offeredOn} onChange={(e) => setOfferedOn(e.currentTarget.value)} /><TextInput label="Valid until (optional)" value={validUntil} onChange={(e) => setValidUntil(e.currentTarget.value)} /></Group>
      <Group><TextInput label="Price (optional)" value={amount} onChange={(e) => setAmount(e.currentTarget.value)} /><TextInput label="Currency (optional, e.g. USD)" value={currency} onChange={(e) => setCurrency(e.currentTarget.value.toUpperCase())} /><NativeSelect label="Price per" value={perUnit} onChange={(e) => setPerUnit(e.currentTarget.value)} data={["ea", "m", "cm", "mm", "kg", "g"]} /></Group>
      <NativeSelect label="Stated availability" value={availability} onChange={(e) => setAvailability(e.currentTarget.value)} data={["unknown", "in_stock", "limited", "unavailable"]} />
      <TextInput label="Substitution basis (only for a substitute)" value={substitution} onChange={(e) => setSubstitution(e.currentTarget.value)} />
      {substitution.trim() && <Chooser label="Replaced item" choice={replaced} />}
    </InspectionScope>
    <Button disabled={!ready || (!!substitution.trim() && !replaced.revision)} loading={record.isPending} onClick={() => record.mutate()} {...manageGate.props}>Record offer</Button>
    <ReadOnlyNote permission="item.create">Recording supplier offers is unavailable.</ReadOnlyNote>
  </Stack></Card>;
}
