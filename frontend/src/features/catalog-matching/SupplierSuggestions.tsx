import { Alert, Button, Card, NativeSelect, Stack, Text, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { read } from "../identity/api";
import { supplierSuggestions, type SupplierSuggestion, type SupplierSuggestionPage } from "./api";

type Variant = { variant_id: string; manufacturer: string; part_number: string; association_basis: string };

type Props = {
  sourceRevisionId: string; targetProjectId: string; canEdit: boolean;
  onUse: (value: SupplierSuggestion) => void; onDenied: (reason: unknown) => void;
};
export function SupplierSuggestions(props: Props) {
  return <Workspace key={`${props.sourceRevisionId}:${props.targetProjectId}`} {...props} />;
}
function Workspace({ sourceRevisionId, targetProjectId, canEdit, onUse, onDenied }: Props) {
  const [variants, setVariants] = useState<Variant[]>([]);
  const [variantId, setVariantId] = useState("");
  const [offset, setOffset] = useState(0);
  const [moreVariants, setMoreVariants] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [page, setPage] = useState<SupplierSuggestionPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  function denied(reason: unknown) {
    setVariants([]); setVariantId(""); setPage(null); setBlocked(true);
    setError(reason instanceof Error ? reason.message : "Supplier suggestions could not be read.");
    onDenied(reason);
  }
  async function loadVariants(nextOffset = 0) {
    const token = ++generation.current;
    setBusy(true); setError("");
    if (nextOffset === 0) { setVariants([]); setVariantId(""); setPage(null); }
    try {
      const catalog = await read<{ variants: Variant[] }>(`catalog/revisions/${sourceRevisionId}?offset=${nextOffset}&limit=50`);
      if (token === generation.current) {
        setVariants((current) => nextOffset ? [...current, ...catalog.variants] : catalog.variants);
        setOffset(nextOffset); setMoreVariants(catalog.variants.length === 50); setLoaded(true);
      }
    } catch (reason) { if (token === generation.current) denied(reason); }
    finally { if (token === generation.current) setBusy(false); }
  }
  async function suggest(after?: string) {
    const token = ++generation.current;
    setBusy(true); setError("");
    if (!after) setPage(null);
    try {
      const value = await supplierSuggestions(sourceRevisionId, variantId, targetProjectId, after);
      if (token === generation.current) setPage(after && page ? { ...value, results: [...page.results, ...value.results] } : value);
    } catch (reason) { if (token === generation.current) denied(reason); }
    finally { if (token === generation.current) setBusy(false); }
  }
  return <Card withBorder><Stack>
    <Title order={3}>Supplier identifier suggestions</Title>
    <Text>Compare one asserted manufacturer and part-number pair with the selected target project. Suggestions remain unreviewed; reading them changes no identities or consumer pins.</Text>
    {error && <Alert color="red">{error}</Alert>}
    <Button variant="light" loading={busy} disabled={blocked} onClick={() => void loadVariants()}>Load source supplier identities</Button>
    {!blocked && !busy && loaded && <>
      {variants.length === 0 && <Text>No supplier identities are registered for this exact source revision.</Text>}
      <NativeSelect label="Exact source supplier identity" value={variantId} data={[{ value: "", label: "Select an asserted identity" }, ...variants.map((v) => ({ value: v.variant_id, label: `${v.manufacturer} · ${v.part_number} · ${v.variant_id}` }))]} onChange={(event) => { setVariantId(event.currentTarget.value); setPage(null); }} />
      {moreVariants && <Button variant="light" onClick={() => void loadVariants(offset + 50)}>More source supplier identities</Button>}
      <Button disabled={!variantId} onClick={() => void suggest()}>Suggest exact identifier matches</Button>
      {page && <>
        {page.inspection_truncated && <Alert color="yellow">The inspection bound was reached. This list does not establish complete discovery; continue if offered or narrow the target project.</Alert>}
        {page.results.length === 0 && <Text>No currently accessible exact identifier suggestions in this page.</Text>}
        {page.results.map((value) => <Card withBorder key={value.target_variant_id}><Stack gap="xs">
          <Text fw={600}>{value.target.name} · revision {value.target.number}</Text>
          <Text>{value.manufacturer} · {value.part_number} · Exact identifier pair; unreviewed, compatibility not evaluated.</Text>
          <Text size="sm">Source association {value.source_variant_id}: {value.source_association_basis}</Text>
          <Text size="sm">Target association {value.target_variant_id}: {value.target_association_basis}</Text>
          <Text size="sm">Target definition {value.target.definition_id} · revision {value.target.revision_id} · SHA-256 {value.target.sha256}</Text>
          <Button variant="light" disabled={!canEdit} onClick={() => onUse(value)}>Use exact pins in proposal</Button>
        </Stack></Card>)}
        {page.next_after && <Button onClick={() => void suggest(page.next_after!)}>More supplier suggestions</Button>}
      </>}
    </>}
  </Stack></Card>;
}
