import { Group, Stack, Text } from "@mantine/core";
import type { ReactNode } from "react";

/** Keep the selected record readable; browsing versions never remounts its editor. */
export function RecordNavigation({ name, selected, children }: { name: string; selected: string | null; children: ReactNode }) {
  return <Stack gap="xs" style={{ minWidth: 0, maxWidth: "100%", width: "100%", overflowWrap: "anywhere" }}>
    {selected && <Group gap="xs"><Text fw={600}>{name}</Text><Text size="xs" c="dimmed">Selected record</Text></Group>}
    <details key={selected ?? "choose"} open={!selected}>
      <summary style={{ cursor: "pointer" }}>{selected ? `Choose record or version · ${name}` : `Choose ${name}`}</summary>
      <Stack gap="xs" mt="xs">{children}</Stack>
    </details>
  </Stack>;
}
