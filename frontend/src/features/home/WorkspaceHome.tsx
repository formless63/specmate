import { Alert, Button, Checkbox, Group, Popover, Table, Text, TextInput, Title } from "@mantine/core";
import { useMemo, useState, type FormEvent } from "react";
import { gateFor } from "../../lib/permissions";
import { describeAccess } from "../shell/areas";
import type { Project } from "../workspace/api";
import { deleteBlocker, deleteProject, describeDependents, setArchived } from "./projectLifecycle";

type Props = {
  username: string;
  /** Workspace role and permissions; they decide which actions are offered (the server still decides). */
  role: string | null;
  permissions: string[];
  projects: Project[];
  /** Remembered project id, already checked against the project list by the caller. */
  lastProjectId: string | null;
  busy: boolean;
  onOpen: (projectId: string) => void;
  onCreate: (name: string, purpose?: string) => Promise<boolean>;
  /** Re-reads the project list after an archive or delete. */
  onChanged: () => Promise<void>;
};

function referenceTotal(project: Project): number {
  return (project.references ?? []).reduce((sum, row) => sum + row.count, 0);
}

/**
 * The Project area at Library scope: every project in the workspace as a dense table. Projects
 * own nothing; their counts are references. Archive and delete live here and in each overview.
 */
export function WorkspaceHome({ username, role, permissions, projects, lastProjectId, busy, onOpen, onCreate, onChanged }: Props) {
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const create = gateFor(permissions, "project.edit");
  const last = projects.find((project) => project.project_id === lastProjectId && !project.archived) ?? null;
  const archivedCount = projects.filter((project) => project.archived).length;
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return projects.filter((project) => (showArchived || !project.archived) && (!needle || project.name.toLowerCase().includes(needle)))
      .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || a.name.localeCompare(b.name));
  }, [projects, filter, showArchived]);
  const access = describeAccess(permissions, role);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    if (await onCreate(trimmed, purpose.trim())) { setName(""); setPurpose(""); }
  }

  async function lifecycle(project: Project, work: () => Promise<unknown>, done: string) {
    setWorking(project.project_id); setError(null); setNotice(null);
    try { await work(); setNotice(done); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The project could not be changed."); }
    finally { setWorking(null); try { await onChanged(); } catch { /* The list error stays visible in the shell. */ } }
  }

  return <section className="sb-dash" aria-label="Projects">
    <Title order={2} className="sb-dash-title">Projects</Title>
    <dl className="sb-context sb-context-4">
      <Cell label="Signed in" value={username} />
      <Cell label="Your role" value={access.label} unknown={!access.known} />
      <Cell label="Active projects" value={String(projects.length - archivedCount)} />
      <Cell label="Archived" value={String(archivedCount)} />
    </dl>
    <Text className="sb-dash-note">Every member sees every project. A project references library items; it owns none, and nothing here changes who can read what.</Text>
    {error && <Alert color="red" role="alert" title="Project not changed">{error}</Alert>}
    {notice && <Text role="status" className="sb-dash-note">{notice}</Text>}

    {last && <div className="sb-dash-row sb-home-continue-row">
      <span className="sb-led" data-state="active" aria-hidden="true" />
      <span className="sb-dash-row-title">{last.name}</span>
      <Button variant="commit" aria-label={`Continue in ${last.name}`} onClick={() => onOpen(last.project_id)} disabled={busy}>Continue</Button>
      <span className="sb-dash-note">Last opened in this browser</span>
    </div>}

    <div className="sb-ws-toolbar" role="search" aria-label="Filter projects">
      <TextInput aria-label="Filter projects" placeholder="filter projects" size="xs" className="sb-ws-filter"
        leftSection={<span className="sb-mono" style={{ color: "var(--sb-accent)" }}>›</span>} value={filter} onChange={(event) => setFilter(event.currentTarget.value)} />
      <Checkbox size="xs" label={`Show archived (${archivedCount})`} checked={showArchived} onChange={(event) => setShowArchived(event.currentTarget.checked)} disabled={archivedCount === 0} />
    </div>

    {projects.length === 0 ? <div className="sb-dash-empty" role="status">
      <Title order={3} size="h4">No projects yet</Title>
      <Text>The library works without projects. Create one to collect the items a build or design uses.</Text>
    </div> : shown.length === 0 ? <div className="sb-dash-empty" role="status"><Text>No project matches this filter.</Text></div>
    : <div className="sb-ws-scroll"><Table className="sb-ws-table" highlightOnHover verticalSpacing={4} horizontalSpacing="sm">
      <Table.Thead><Table.Tr>
        <Table.Th>Project</Table.Th><Table.Th>Purpose</Table.Th><Table.Th>References</Table.Th><Table.Th>Depends on it</Table.Th><Table.Th>Created by</Table.Th><Table.Th>Status</Table.Th>
        <Table.Th><span className="sb-visually-hidden">Actions</span></Table.Th>
      </Table.Tr></Table.Thead>
      <Table.Tbody>{shown.map((project) => {
        const blocker = deleteBlocker(project, create.allowed);
        const dependents = describeDependents(project.dependents);
        const pending = working === project.project_id;
        return <Table.Tr key={project.project_id} data-last={project.project_id === last?.project_id || undefined}>
          <Table.Td><button type="button" className="sb-ws-open" aria-label={`Open ${project.name}`} onClick={() => onOpen(project.project_id)} disabled={busy}>
            <span className="sb-home-name">{project.name}</span></button></Table.Td>
          <Table.Td className="sb-dash-note">{project.purpose || "–"}</Table.Td>
          <Table.Td className="sb-mono sb-ws-num">{referenceTotal(project)}</Table.Td>
          <Table.Td className="sb-dash-note">{dependents.length ? dependents.join(", ") : "nothing"}</Table.Td>
          <Table.Td className="sb-mono">{project.created_by ?? "–"}</Table.Td>
          <Table.Td>{project.archived ? <span className="sb-tag">archived</span> : <span className="sb-dash-note">active</span>}</Table.Td>
          <Table.Td className="sb-ws-num"><Group gap={4} wrap="nowrap" justify="flex-end">
            <Button variant="quiet" size="xs" aria-label={`${project.archived ? "Unarchive" : "Archive"} ${project.name}`} loading={pending} {...create.props}
              onClick={() => void lifecycle(project, () => setArchived(project.project_id, !project.archived), `${project.name} ${project.archived ? "is active again" : "was archived; its references and history are kept"}.`)}>
              {project.archived ? "Unarchive" : "Archive"}</Button>
            <DeleteControl name={project.name} blocker={blocker} busy={pending}
              onDelete={() => void lifecycle(project, () => deleteProject(project.project_id), `${project.name} was deleted. Items it referenced stay in the library.`)} />
          </Group></Table.Td>
        </Table.Tr>;
      })}</Table.Tbody>
    </Table></div>}

    <form onSubmit={(event) => void submit(event)} aria-label="New project" className="sb-ws-toolbar">
      <TextInput label="New project name" size="xs" value={name} onChange={(event) => setName(event.currentTarget.value)} required disabled={busy || !create.allowed} maxLength={200} />
      <TextInput label="Purpose (optional)" size="xs" value={purpose} onChange={(event) => setPurpose(event.currentTarget.value)} disabled={busy || !create.allowed} maxLength={2000} className="sb-ws-filter" />
      <Button type="submit" variant="primary" size="xs" loading={busy} disabled={!name.trim()} {...create.props}>Create project</Button>
    </form>
  </section>;
}

/** Delete is offered only when nothing depends on the project; otherwise the reason is shown. */
export function DeleteControl({ name, blocker, busy, onDelete }: { name: string; blocker: string | null; busy: boolean; onDelete: () => void }) {
  const [opened, setOpened] = useState(false);
  if (blocker) return <Button variant="quiet" size="xs" aria-label={`Delete ${name}`} disabled title={blocker} data-readonly-reason={blocker}>Delete</Button>;
  return <Popover opened={opened} onChange={setOpened} position="bottom-end" withinPortal trapFocus>
    <Popover.Target><Button variant="quiet" size="xs" aria-label={`Delete ${name}`} loading={busy} onClick={() => setOpened((value) => !value)}>Delete</Button></Popover.Target>
    <Popover.Dropdown>
      <Text size="sm" maw={280}>Delete {name}? Its reference history goes with it; the referenced items stay in the library.</Text>
      <Group gap={6} mt={6}>
        <Button variant="commit" size="xs" onClick={() => { setOpened(false); onDelete(); }}>Delete project</Button>
        <Button variant="quiet" size="xs" onClick={() => setOpened(false)}>Keep</Button>
      </Group>
    </Popover.Dropdown>
  </Popover>;
}

function Cell({ label, value, unknown = false }: { label: string; value: string; unknown?: boolean }) {
  return <div className={`sb-cell${unknown ? " sb-hatch" : ""}`}>
    <dt className="sb-silk">{label}</dt>
    <dd data-unknown={unknown} title={value}>{value}</dd>
  </div>;
}
