import { Button, Group, SegmentedControl, Select, Stack, Text, TextInput } from "@mantine/core";
import { useState, type FormEvent } from "react";
import type { Project } from "../workspace/api";

export type ReferenceChoice = { projectId: string; pin: "floating" | "exact"; role: string };

/**
 * Records that a project uses an item: floating (follows the definition) or pinned to an exact
 * revision. Pinning is always an explicit choice. The item itself is never copied or moved.
 */
export function ReferenceForm({ itemLabel, latestRevision, canPin, projects, fixedProjectId, busy, onSubmit, onCancel }: {
  itemLabel: string;
  /** Latest frozen revision number; exact pins need one. */
  latestRevision: number | null;
  /** Only definitions can be pinned to a revision. */
  canPin: boolean;
  /** Projects to choose from (ignored when fixedProjectId is set). */
  projects: Project[];
  fixedProjectId?: string;
  busy: boolean;
  onSubmit: (choice: ReferenceChoice) => void;
  onCancel?: () => void;
}) {
  const active = projects.filter((project) => !project.archived);
  const [projectId, setProjectId] = useState<string | null>(fixedProjectId ?? (active.length === 1 ? active[0]!.project_id : null));
  const [pin, setPin] = useState<"floating" | "exact">("floating");
  const [role, setRole] = useState("uses");
  const exactPossible = canPin && latestRevision !== null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (projectId && role.trim()) onSubmit({ projectId, pin: exactPossible ? pin : "floating", role: role.trim() });
  }

  return <form onSubmit={submit} aria-label={`Use ${itemLabel} in a project`}>
    <Stack gap={6} maw={360}>
      {!fixedProjectId && <Select label="Project" size="xs" searchable data={active.map((project) => ({ value: project.project_id, label: project.name }))}
        value={projectId} onChange={setProjectId} nothingFoundMessage="No project matches" comboboxProps={{ withinPortal: false }} />}
      {canPin && <div>
        <Text size="xs" className="sb-silk">Pin</Text>
        <SegmentedControl size="xs" fullWidth value={exactPossible ? pin : "floating"} onChange={(value) => setPin(value as "floating" | "exact")}
          data={[{ value: "floating", label: "Floating" }, { value: "exact", label: exactPossible ? `Exact r${latestRevision}` : "Exact (none frozen)", disabled: !exactPossible }]}
          aria-label="Reference pin" />
      </div>}
      <TextInput label="Role in the project" size="xs" value={role} onChange={(event) => setRole(event.currentTarget.value)} required maxLength={100} />
      <Text className="sb-dash-note">{pin === "exact" && exactPossible ? `Stays on r${latestRevision} until someone changes the pin.` : "Follows the definition; no revision is fixed."}</Text>
      <Group gap={6}>
        <Button type="submit" variant="commit" size="xs" loading={busy} disabled={!projectId || !role.trim()}>Add reference</Button>
        {onCancel && <Button variant="quiet" size="xs" onClick={onCancel} disabled={busy}>Cancel</Button>}
      </Group>
    </Stack>
  </form>;
}
