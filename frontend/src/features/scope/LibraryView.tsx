import { Alert, Button, Group, Popover, SegmentedControl, Select, Table, Text, TextInput, Title } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { usePermission } from "../../lib/permissions";
import { probeMark, useProbe, useProbeOrLocal, useRelated } from "../probe";
import { floatingKind, KNOWN_KINDS, type LibraryView as View } from "../shell/scope";
import { addReference, listLibrary, readProjectDetail, removeReference, type LibraryRecord, type Project } from "../workspace/api";
import { ReferenceForm, type ReferenceChoice } from "./ReferenceForm";

const KIND_HEADER: Record<View["family"], string> = {
  definition: "Kind", source_bundle: "Role", stock_account: "Dimension", physical_unit: "Origin", fact_subject: "Subject",
};

export function words(value: string | null): string {
  return value ? value.replaceAll("_", " ") : "–";
}

function when(value: string | null): string {
  if (!value) return "–";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "–" : date.toISOString().slice(0, 10);
}

/** Adds and retires project references under each project's current state token. */
export function useReferenceActions() {
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function run(work: () => Promise<string>) {
    setBusy(true); setError(null); setNotice(null);
    try {
      setNotice(await work());
      await cache.invalidateQueries({ queryKey: ["workspace"] });
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The reference could not be changed.");
      return false;
    } finally { setBusy(false); }
  }
  return {
    busy, error, notice,
    add: (record: LibraryRecord, choice: ReferenceChoice, projectName: string) => run(async () => {
      const project = await readProjectDetail(choice.projectId);
      const exact = choice.pin === "exact" && record.family === "definition";
      if (exact) {
        if (!record.latest_revision_id) throw new Error("No frozen revision to pin.");
        await addReference(project, { kind: "revision", targetId: record.latest_revision_id, role: choice.role });
      } else {
        const kind = floatingKind(record.family);
        if (!kind) throw new Error("Projects cannot reference this record.");
        await addReference(project, { kind, targetId: record.record_id, role: choice.role });
      }
      return `${record.label} is now used in ${projectName}${exact ? ` (pinned to r${record.latest_revision})` : ""}.`;
    }),
    remove: (projectId: string, referenceId: string, label: string, reason: string) => run(async () => {
      const project = await readProjectDetail(projectId);
      await removeReference(project, referenceId, reason);
      return `${label} is no longer referenced by ${project.name}. The item stays in the library.`;
    }),
  };
}

/**
 * A lens's workspace collection as a dense, paginated table. Rows have no owning project; the
 * Used in column lists the projects that reference each item. At project scope the project's
 * referenced items come first and the lens can switch between them and the whole library.
 */
export function LibraryView({ view, toolLabel, projectId, project, projects, principalKey, onOpenInProject }: {
  view: View;
  toolLabel: string;
  /** Project context (navigation only); null at Library scope. */
  projectId: string | null;
  project: Project | null;
  projects: Project[];
  principalKey: string;
  onOpenInProject: (projectId: string, record: LibraryRecord) => void;
}) {
  const [text, setText] = useState("");
  const [query] = useDebouncedValue(text.trim(), 250);
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [mode, setMode] = useState<"project" | "library">("project");
  // The selected row is the shared probe inside the shell, so other views and the URL follow it.
  const [selected, setSelected] = useProbeOrLocal();
  const probe = useProbe()?.probe ?? null;
  const related = useRelated();
  const kinds = kindFilter ? [kindFilter] : view.kinds;
  const referencedOnly = !!projectId && mode === "project";
  const records = useInfiniteQuery({
    queryKey: ["workspace", "library", principalKey, view.family, kinds, query, projectId, referencedOnly],
    queryFn: ({ pageParam }) => listLibrary({ family: view.family, kinds, query, projectId, referencedOnly, after: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_after,
    retry: false,
  });
  const actions = useReferenceActions();
  const rows = useMemo(() => (records.data?.pages ?? []).flatMap((page) => page.results), [records.data]);
  const edit = usePermission("project.edit");
  const archived = !!project?.archived;
  const filtered = !!query || !!kindFilter;
  const showKindFilter = view.family === "definition" && view.kinds.length !== 1;
  const kindOptions = (view.kinds.length ? view.kinds : KNOWN_KINDS).map((kind) => ({ value: kind, label: words(kind) }));
  const title = projectId && mode === "project" ? `${view.title} in this project` : `${view.title} in the library`;

  return <section className="sb-dash sb-library" aria-label={title}>
    <Group justify="space-between" align="flex-end" wrap="wrap" gap="xs">
      <Title order={2} className="sb-dash-title">{title}</Title>
      {projectId && <SegmentedControl size="xs" value={mode} onChange={(value) => setMode(value as "project" | "library")} aria-label="List scope"
        data={[{ value: "project", label: "This project" }, { value: "library", label: "Whole library" }]} />}
    </Group>
    <div className="sb-ws-toolbar" role="search" aria-label={`Filter ${view.title}`}>
      <TextInput aria-label="Filter records" placeholder="filter by name" size="xs" className="sb-ws-filter"
        leftSection={<span className="sb-mono" style={{ color: "var(--sb-accent)" }}>›</span>} value={text} onChange={(event) => setText(event.currentTarget.value)} />
      {showKindFilter && <Select aria-label="Kind filter" size="xs" w={200} searchable clearable placeholder="every kind"
        data={kindOptions} value={kindFilter} onChange={setKindFilter} />}
    </div>
    {actions.error && <Alert color="red" role="alert" title="Reference not changed">{actions.error}</Alert>}
    {actions.notice && <Text role="status" className="sb-dash-note">{actions.notice}</Text>}
    {records.isError && <Alert color="red" role="alert" title="Library unavailable">{records.error instanceof Error ? records.error.message : "The list could not be read."}</Alert>}
    {records.isPending && <Text role="status" className="sb-dash-note">Reading the library…</Text>}
    {records.isSuccess && rows.length === 0 && <div className="sb-dash-empty" role="status">
      <Text>{filtered ? "No item matches these filters." : referencedOnly ? `This project references no ${view.noun} yet.` : `No ${view.noun} in the library yet.`}</Text>
      {referencedOnly && <Button variant="quiet" size="xs" onClick={() => setMode("library")}>Show the whole library</Button>}
    </div>}
    {rows.length > 0 && <div className="sb-ws-scroll"><Table className="sb-ws-table" highlightOnHover verticalSpacing={4} horizontalSpacing="sm">
      <Table.Thead><Table.Tr>
        <Table.Th>Name</Table.Th>
        <Table.Th>{KIND_HEADER[view.family]}</Table.Th>
        <Table.Th>Revision</Table.Th>
        <Table.Th>Used in</Table.Th>
        <Table.Th>Detail</Table.Th>
        <Table.Th>Changed</Table.Th>
        <Table.Th><span className="sb-visually-hidden">Actions</span></Table.Th>
      </Table.Tr></Table.Thead>
      <Table.Tbody>{rows.map((row) => {
        const open = selected === row.record_id;
        const mark = probeMark(probe, related, { object: row.record_id, rev: null, path: [] }, "object");
        const here = projectId ? row.used_in.filter((use) => use.project_id === projectId) : [];
        return <Fragment key={`${row.family}:${row.record_id}`}>
          <Table.Tr data-referenced={row.referenced || undefined} data-selected={open || undefined} data-probe={mark ?? undefined}>
            <Table.Td><button type="button" className="sb-ws-open" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} uses of ${row.label}`} onClick={() => setSelected(open ? null : row.record_id)}>
              <span className="sb-home-name">{row.label}</span></button>{mark === "related" && <span className="sb-tag" style={{ marginLeft: 6 }}>related</span>}</Table.Td>
            <Table.Td className="sb-mono">{words(row.kind)}</Table.Td>
            <Table.Td className="sb-mono" data-unknown={row.latest_revision === null || undefined}>
              {row.latest_revision !== null ? `r${row.latest_revision}` : row.family === "definition" ? <span className="sb-tag" title="No frozen revision yet">draft</span> : "–"}</Table.Td>
            <Table.Td className="sb-mono">{!row.referenceable ? "–" : row.used_in_total === 0 ? <span className="sb-dash-note">unused</span>
              : <span title={row.used_in.map((use) => use.project_name).join(", ")}>{row.used_in_total} project{row.used_in_total === 1 ? "" : "s"}</span>}</Table.Td>
            <Table.Td className="sb-dash-note">{row.detail ?? ""}</Table.Td>
            <Table.Td className="sb-mono sb-ws-when">{when(row.changed_at ?? row.created_at)}</Table.Td>
            <Table.Td className="sb-ws-num">{row.referenceable && (projectId
              ? here.length > 0
                ? <RemoveButton label={row.label} busy={actions.busy} gate={archived ? archivedGate : edit}
                  onRemove={(reason) => void actions.remove(projectId, here[0]!.reference_id, row.label, reason)} />
                : <AddButton record={row} projects={projects} fixedProjectId={projectId} busy={actions.busy} gate={archived ? archivedGate : edit}
                  onAdd={(choice) => actions.add(row, choice, project?.name ?? "this project")} label="Use here" />
              : <AddButton record={row} projects={projects} busy={actions.busy} gate={edit}
                onAdd={(choice) => actions.add(row, choice, projects.find((p) => p.project_id === choice.projectId)?.name ?? "the project")} label="Use in project…" />)}</Table.Td>
          </Table.Tr>
          {open && <Table.Tr className="sb-ws-detail"><Table.Td colSpan={7}>
            <UsedInList record={row} currentProjectId={projectId} toolLabel={toolLabel} onOpen={onOpenInProject} />
          </Table.Td></Table.Tr>}
        </Fragment>;
      })}</Table.Tbody>
    </Table></div>}
    <Group gap="xs">
      {rows.length > 0 && <Text className="sb-silk" role="status">{rows.length} shown{records.hasNextPage ? " · more available" : ""}</Text>}
      {records.hasNextPage && <Button variant="quiet" size="xs" onClick={() => void records.fetchNextPage()} loading={records.isFetchingNextPage}>Load more</Button>}
    </Group>
  </section>;
}

const archivedGate = { allowed: false, reason: "Archived projects are read-only", props: { disabled: true as const, title: "Archived projects are read-only" } };
type GateLike = { allowed: boolean; reason: string | undefined; props: { disabled?: true; title?: string } };

function UsedInList({ record, currentProjectId, toolLabel, onOpen }: { record: LibraryRecord; currentProjectId: string | null; toolLabel: string; onOpen: (projectId: string, record: LibraryRecord) => void }) {
  if (!record.referenceable) return <Text className="sb-dash-note">Projects do not reference {record.family.replaceAll("_", " ")} records directly.</Text>;
  if (record.used_in.length === 0) return <Text className="sb-dash-note">No project references {record.label}. It stays available in the library.</Text>;
  return <div className="sb-usedin" role="list" aria-label={`Projects using ${record.label}`}>
    {record.used_in.map((use) => <div key={use.reference_id} role="listitem" className="sb-usedin-row">
      <span className="sb-dash-row-title">{use.project_name}</span>
      <span className="sb-tag">{use.pin === "exact" ? `exact r${use.revision}` : "floating"}</span>
      <span className="sb-mono sb-dash-note">{use.role}</span>
      {use.archived && <span className="sb-tag">archived</span>}
      <span style={{ flex: 1 }} />
      {use.project_id !== currentProjectId && <Button variant="quiet" size="xs" aria-label={`Open ${toolLabel} in ${use.project_name}`} onClick={() => onOpen(use.project_id, record)}>Open in project</Button>}
    </div>)}
    {record.used_in_total > record.used_in.length && <Text className="sb-dash-note">and {record.used_in_total - record.used_in.length} more</Text>}
  </div>;
}

function AddButton({ record, projects, fixedProjectId, busy, gate, onAdd, label }: {
  record: LibraryRecord; projects: Project[]; fixedProjectId?: string; busy: boolean; gate: GateLike; label: string;
  onAdd: (choice: ReferenceChoice) => Promise<boolean>;
}) {
  const [opened, setOpened] = useState(false);
  return <Popover opened={opened} onChange={setOpened} position="bottom-end" withinPortal trapFocus>
    <Popover.Target>
      <Button variant="quiet" size="xs" aria-label={`${label} ${record.label}`} onClick={() => setOpened((value) => !value)} {...gate.props}>{label}</Button>
    </Popover.Target>
    <Popover.Dropdown>
      <ReferenceForm itemLabel={record.label} latestRevision={record.latest_revision} canPin={record.family === "definition"} projects={projects}
        fixedProjectId={fixedProjectId} busy={busy} onCancel={() => setOpened(false)}
        onSubmit={(choice) => void onAdd(choice).then((done) => { if (done) setOpened(false); })} />
    </Popover.Dropdown>
  </Popover>;
}

function RemoveButton({ label, busy, gate, onRemove }: { label: string; busy: boolean; gate: GateLike; onRemove: (reason: string) => void }) {
  const [opened, setOpened] = useState(false);
  const [reason, setReason] = useState("No longer used");
  return <Popover opened={opened} onChange={setOpened} position="bottom-end" withinPortal trapFocus>
    <Popover.Target>
      <Button variant="quiet" size="xs" aria-label={`Stop using ${label} here`} onClick={() => setOpened((value) => !value)} {...gate.props}>Remove</Button>
    </Popover.Target>
    <Popover.Dropdown>
      <form aria-label={`Remove the reference to ${label}`} onSubmit={(event) => { event.preventDefault(); if (reason.trim()) { onRemove(reason.trim()); setOpened(false); } }}>
        <TextInput label="Reason" size="xs" value={reason} onChange={(event) => setReason(event.currentTarget.value)} required maxLength={1000} />
        <Text className="sb-dash-note" mt={4} maw={280}>The removal is recorded; the item and its other uses are unchanged.</Text>
        <Button type="submit" variant="commit" size="xs" mt={6} loading={busy} disabled={!reason.trim()}>Remove reference</Button>
      </form>
    </Popover.Dropdown>
  </Popover>;
}
