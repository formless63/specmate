import { Stack, Text } from "@mantine/core";
import { scopeLabel, type Origin } from "./api";

export function CopperProvenance({ value }: { value: Origin }) {
  const declaration = value.declaration;
  return <Stack gap={2} style={{ overflowWrap: "anywhere" }}><Text size="sm">Occurrence: {scopeLabel(value.occurrence_path)} · Revision: {value.revision_id}</Text>
    <Text size="xs">Snapshot SHA-256: {value.snapshot_sha256}</Text>
    {value.local_id != null && <Text size="sm">Local feature identity: {typeof value.local_id === "string" ? value.local_id : JSON.stringify(value.local_id)}</Text>}
    {value.section_id && <Text size="sm">Physical section: {value.section_id}</Text>}
    {value.stock_revision_id && <Text size="sm">Exact stock: {value.stock_revision_id}</Text>}
    {value.body_revision_id && <Text size="sm">Exact body: {value.body_revision_id}</Text>}
    {value.pinout_revision_id && <Text size="sm">Exact pinout: {value.pinout_revision_id}</Text>}
    {(value.native_net_name || value.native_net) && <Text size="sm">Native net: {value.native_net_name ?? value.native_net}</Text>}
    {value.native_net_id && <Text size="sm">Native net identity: {value.native_net_id}</Text>}
    {value.interpretation && <Text size="sm">Interpretation: {value.interpretation.interpretation_id} · Source revision: {value.interpretation.source_revision_id}</Text>}
    {value.interpretation && <Text size="xs">Interpretation SHA-256: {value.interpretation.sha256}</Text>}
    {declaration?.basis && <Text size="sm">Declaration basis: {declaration.basis}</Text>}
    {declaration?.condition && <Text size="sm">Unevaluated condition: {declaration.condition}</Text>}
    {declaration?.review && <Text size="sm">Association review: {declaration.review}</Text>}
    {declaration?.target_revision_id && <Text size="sm">Target revision: {declaration.target_revision_id} · Contact: {declaration.target_contact_id ?? 'unknown'}</Text>}
    {declaration?.internal && <Text size="sm">Internal target: {scopeLabel(declaration.internal.path)} · {declaration.internal.feature_id} · Revision {declaration.internal.revision_id}</Text>}
    {declaration?.evidence?.citation && <Text size="sm">Evidence: {declaration.evidence.citation}</Text>}
    {declaration?.evidence?.source_revision_id && <Text size="sm">Declaration source revision: {declaration.evidence.source_revision_id} · Path: {declaration.evidence.path ?? "unspecified"}</Text>}
  </Stack>;
}
