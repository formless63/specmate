import { Badge, Button, Group, Stack, Table, Text, Title } from "@mantine/core";
import { SbProvenance } from "../../components/sb";
import { ReadOnlyNote, useCan } from "../../lib/permissions";
import type { FormatUpgradeProvenance, UpgradeSection } from "./api";

/** "Upgraded from KiCad N format", with the exact tool, argv and hashes one disclosure away. */
export function UpgradeProvenance({ upgrade }: { upgrade: FormatUpgradeProvenance }) {
  return <Stack gap="xs">
    <SbProvenance
      label="Format upgrade"
      summary={`${upgrade.label} (${upgrade.from_format_version} → ${upgrade.to_format_version}) by KiCad ${upgrade.tool_version}; the original revision is unchanged.`}
      pins={[
        { label: "original revision", value: upgrade.original_source_revision_id },
        { label: "original manifest", value: upgrade.original_manifest_sha256 },
        { label: "upgrade build", value: upgrade.build_id },
        { label: "recipe", value: upgrade.recipe_id },
        { label: "image", value: upgrade.image },
        { label: "report", value: upgrade.report_sha256 },
      ]}
    />
    <Table aria-label="Upgraded files">
      <Table.Thead><Table.Tr><Table.Th>Upgraded file</Table.Th><Table.Th>From</Table.Th><Table.Th>To</Table.Th><Table.Th>Command</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{upgrade.files.map((file) => <Table.Tr key={file.path}>
        <Table.Td>{file.path}<Text size="xs">SHA-256 {file.source_sha256.slice(0, 12)} → {file.output_sha256.slice(0, 12)}</Text></Table.Td>
        <Table.Td>KiCad {file.from_kicad_major} {file.kind} {file.from_format_version}</Table.Td>
        <Table.Td>{file.to_format_version}</Table.Td>
        <Table.Td><Text size="xs" ff="monospace">{file.argv.length ? file.argv.join(" ") : "Already current; carried over unchanged"}</Text></Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table>
    {upgrade.unsupported.map((issue) => <Text key={issue} size="sm">{issue}</Text>)}
  </Stack>;
}

type OfferProps = {
  upgrade: UpgradeSection; busy: boolean;
  onRequest: () => void; onAccept: (attemptId: string) => void; onOpen: (intakeId: string) => void;
};

/** Explicit, recorded upgrade of an older board; never automatic, never in place. */
export function UpgradeOffer({ upgrade, busy, onRequest, onAccept, onOpen }: OfferProps) {
  const canExecute = useCan("build.execute");
  const canRegister = useCan("source.register");
  const majors = upgrade.upgradable_kicad_majors.join(", ");
  return <Stack gap="xs">
    <Title order={4}>KiCad format upgrade</Title>
    <Text size="sm">
      Boards saved by KiCad {majors} must be upgraded to the KiCad 10 format before extraction.
      The upgrade runs the pinned kicad-cli on copies and registers the result as a derivative bundle; this original stays unchanged.
    </Text>
    {canExecute && <>
      {!upgrade.available_recipe_id && <Text size="sm">The format upgrade is unavailable on this installation.</Text>}
      <Button variant="light" onClick={onRequest} loading={busy} disabled={!upgrade.available_recipe_id}>Request KiCad 10 format upgrade</Button>
    </>}
    <ReadOnlyNote permission="build.execute">Requesting a format upgrade is unavailable.</ReadOnlyNote>
    {upgrade.attempts.map((attempt) => <Group key={attempt.upgrade_attempt_id} gap="xs">
      <Text size="sm">Upgrade {attempt.upgrade_attempt_id.slice(0, 8)}</Text><Badge>{attempt.state}</Badge>
      {attempt.diagnostic && <Text size="sm" c="red">{attempt.diagnostic}</Text>}
      {attempt.state === "succeeded" && !attempt.derived_intake_id && canRegister &&
        <Button size="xs" onClick={() => onAccept(attempt.upgrade_attempt_id)} disabled={busy}>Register upgraded derivative</Button>}
      {attempt.derived_intake_id && <Button size="xs" variant="subtle" onClick={() => onOpen(attempt.derived_intake_id!)}>Open upgraded intake</Button>}
    </Group>)}
  </Stack>;
}
