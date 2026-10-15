import { Alert, Card, Stack, Table, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { SbUnknown } from "../../components/sb";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { read, useText, type StockConventions as Applicable } from "./api";
import { ConventionRows } from "./ConventionPanel";

/**
 * Read-only: the frozen conventions that apply to one frozen wire stock revision. Exact-pin
 * conventions show their rows; others are named. A convention is a preference, never a pass.
 */
export function StockConventions({ revisionId }: { revisionId: string }) {
  const [data, setData] = useState<{ id: string; value: Applicable } | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  useEffect(() => {
    let live = true;
    read<Applicable>(`interfaces/stock-revisions/${revisionId}/conventions`)
      .then((value) => { if (live) setData({ id: revisionId, value }); })
      .catch((e) => { if (live) setFailure({ id: revisionId, message: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [revisionId]);
  const found = data?.id === revisionId ? data.value : null;
  const error = failure?.id === revisionId ? failure.message : null;
  const items = found?.conventions ?? [];
  return <section aria-label="Conductor conventions"><Stack gap="xs">
    <Title order={4}>Conductor conventions</Title>
    {error && <Alert color="yellow" title="Conventions unavailable">{error}</Alert>}
    {!found && !error && <Text size="sm" role="status">Loading conventions…</Text>}
    {found && items.length === 0 && <Text size="sm">No frozen convention applies to this revision. What each conductor carries is <SbUnknown what="Use" />.</Text>}
    {items.map((item) => <Card withBorder key={item.revision_id}><Stack gap={4}>
      <Text fw={600} size="sm">{item.name} · revision {item.number} · {item.scope === "stock" ? (item.exact ? "pinned to this revision" : "pinned to another revision of this stock") : "general color code"}</Text>
      <Text size="xs"><RevisionLabel id={item.revision_id} role="convention" /></Text>
      {item.convention && <ConventionRows view={item.convention} />}
      {!item.exact && item.scope === "stock" && <Text size="sm">Its mappings are not shown here: open it to compare them with this revision.</Text>}
      {item.matches && <Table.ScrollContainer minWidth={520}><Table withTableBorder verticalSpacing={4} className="sb-signal-table">
        <Table.Thead><Table.Tr><Table.Th>Conductor</Table.Th><Table.Th>Matched color</Table.Th><Table.Th>Usually used for</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{item.matches.map((m) => <Table.Tr key={m.element_path}><Table.Td className="sb-signal-name">{m.element_label}</Table.Td><Table.Td>{m.rule.color} <Text component="span" className="sb-mono" size="xs" c="dimmed">{m.rule.color_hex}</Text></Table.Td><Table.Td>{useText(m.rule.use)} · {m.rule.preference}</Table.Td></Table.Tr>)}</Table.Tbody>
      </Table></Table.ScrollContainer>}
    </Stack></Card>)}
    {found && <Text size="xs" c="dimmed">{found.effect_note}</Text>}
  </Stack></section>;
}
