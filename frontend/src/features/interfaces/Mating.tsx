import { Group, Stack, Text } from "@mantine/core";
import { SbStatus } from "../../components/sb";
import type { MatedBy, MatingRow } from "./api";

/** Declared mating partners of a body, and bodies that declare mating with it. Unreviewed is unknown. */
export function MatingList({ mates, matedBy }: { mates: MatingRow[]; matedBy: MatedBy[] }) {
  const status = (s: "reviewed" | "unknown") => <SbStatus led={s === "reviewed" ? "active" : "not-evaluated"} dimension="mating" value={s === "reviewed" ? "reviewed declaration" : "unreviewed, unknown"} />;
  return <Stack gap={4}>
    <Text className="sb-silk">Mates with</Text>
    {mates.length === 0 && matedBy.length === 0 && <Text size="sm" c="dimmed">No mating is declared. Nothing is inferred from the body family.</Text>}
    {mates.map((m) => <Group key={m.body_revision_id} gap={8}><Text size="sm" fw={600}>{m.name} r{m.number}</Text><Text size="xs" c="dimmed">{m.mating_role} · {m.correspondence === "same_contact_id" ? "same contact IDs" : "explicit pairs"} · {m.pairs.length} contacts</Text>{status(m.status)}</Group>)}
    {matedBy.map((m) => <Group key={m.body_revision_id} gap={8}><Text size="sm" fw={600}>{m.name} r{m.number}</Text><Text size="xs" c="dimmed">declares mating with this body</Text>{status(m.status)}</Group>)}
  </Stack>;
}
