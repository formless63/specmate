import { Alert, Button, Checkbox, Group, Popover, SegmentedControl, Select, Table, Text, TextInput, Title } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useState } from "react";
import { usePermission } from "../../lib/permissions";
import { SelectedDefinitionViews } from "../cable-views/SelectedDefinitionViews";
import { probeMark, readLibraryRecord, useProbe, useProbeOrLocal, useRelated } from "../probe";
import { floatingKind, KNOWN_KINDS, type LibraryView as View } from "../shell/scope";
import { addReference, listLibrary, readProjectDetail, removeReference, type LibraryRecord, type Project } from "../workspace/api";
import { ItemCard } from "../library-gallery/ItemCard";
import { attentionById, useLibraryHome, usedInWords } from "../library-gallery/hooks";
import { useNewRequest } from "../library-gallery/newRequest";
import { ReferenceForm, type ReferenceChoice } from "./ReferenceForm";
import type { EditorActions } from "./EditingLens";

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

export type ListLayout = "gallery" | "table";
const LAYOUT_KEY = "specmate.library.layout";

/** Gallery or table, remembered per browser; the gallery is the default and storage is optional. */
export function useListLayout(): [ListLayout, (layout: ListLayout) => void] {
  const [layout, setLayout] = useState<ListLayout>(() => {
    try { return window.localStorage.getItem(LAYOUT_KEY) === "table" ? "table" : "gallery"; } catch { return "gallery"; }
  });
  const choose = (next: ListLayout) => {
    setLayout(next);
    try { window.localStorage.setItem(LAYOUT_KEY, next); } catch { /* Private windows keep the choice for this page only. */ }
  };
  return [layout, choose];
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
 * With an editor below the list, "New" starts an item there and "Open" opens a row's item in it.
 */
export function LibraryView({ view, toolLabel, projectId, project, projects, principalKey, onOpenInProject, editor }: {
  view: View;
  toolLabel: string;
  /** Project context (navigation only); null at Library scope. */
  projectId: string | null;
  project: Project | null;
  projects: Project[];
  principalKey: string;
  onOpenInProject: (projectId: string, record: LibraryRecord) => void;
  /** The lens's editor below this list; without one the list only shows and references items. */
  editor?: EditorActions;
}) {
  // The typed text lives in FilterInput so a keystroke never re-renders the (possibly 250+ row) table;
  // only the debounced query comes back here.
  const [query, setQuery] = useState("");
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [mode, setMode] = useState<"project" | "library">("project");
  const [layout, setLayout] = useListLayout();
  // The selected row is the shared probe inside the shell, so other views and the URL follow it.
  const [selected, setSelected] = useProbeOrLocal();
  const probe = useProbe()?.probe ?? null;
  const related = useRelated();
  const kinds = kindFilter ? [kindFilter] : view.kinds;
  const referencedOnly = !!projectId && mode === "project";
  const records = useInfiniteQuery({
    queryKey: ["workspace", "library", principalKey, view.family, kinds, query, projectId, referencedOnly, includeSuperseded],
    queryFn: ({ pageParam }) => listLibrary({ family: view.family, kinds, query, projectId, referencedOnly, includeSuperseded, after: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_after,
    retry: false,
  });
  const actions = useReferenceActions();
  const showsViews = (record: LibraryRecord) => record.family === "definition" && (record.kind === "cable" || record.kind === "harness");
  const rows = useMemo(() => (records.data?.pages ?? []).flatMap((page) => page.results), [records.data]);
  const edit = usePermission("project.edit");
  const create = usePermission(view.create);
  const archived = !!project?.archived;
  const filtered = !!query || !!kindFilter;
  const showKindFilter = view.family === "definition" && view.kinds.length !== 1;
  const kindOptions = (view.kinds.length ? view.kinds : KNOWN_KINDS).map((kind) => ({ value: kind, label: words(kind) }));
  // A deep link can select an item the list does not show (another page or filter): its views still open.
  const offList = !!selected && records.isSuccess && !rows.some((row) => row.record_id === selected);
  const probed = useQuery({
    queryKey: ["workspace", "library-record", principalKey, selected, projectId],
    queryFn: () => readLibraryRecord(selected!, projectId),
    enabled: offList && view.family === "definition", retry: false,
  });
  const offListRecord = offList && probed.data && showsViews(probed.data) && (view.kinds.length === 0 || view.kinds.includes(probed.data.kind ?? "")) ? probed.data : null;
  const title = projectId && mode === "project" ? `${view.title} in this project` : `${view.title} in the library`;
  const gallery = layout === "gallery";
  const drawn = view.family === "definition";
  const home = useLibraryHome(principalKey, gallery && drawn);
  const attention = useMemo(() => attentionById(home.data), [home.data]);
  const selectedRow = gallery ? rows.find((row) => row.record_id === selected) ?? null : null;
  // "New…" on the Library home opens this list's New form, as its own New button does.
  useNewRequest(view, !!editor && create.allowed, () => { setSelected(null); editor?.reveal(true, view.noun); });
  const openCard = (row: LibraryRecord) => {
    setSelected(row.record_id);
    editor?.reveal(false);
  };
  const actionsFor = (row: LibraryRecord) => {
    if (!row.referenceable) return null;
    const here = projectId ? row.used_in.filter((use) => use.project_id === projectId) : [];
    return projectId
      ? here.length > 0
        ? <RemoveButton label={row.label} busy={actions.busy} gate={archived ? archivedGate : edit}
          onRemove={(reason) => void actions.remove(projectId, here[0]!.reference_id, row.label, reason)} />
        : <AddButton record={row} projects={projects} fixedProjectId={projectId} busy={actions.busy} gate={archived ? archivedGate : edit}
          onAdd={(choice) => actions.add(row, choice, project?.name ?? "this project")} label="Use here" />
      : <AddButton record={row} projects={projects} busy={actions.busy} gate={edit}
        onAdd={(choice) => actions.add(row, choice, projects.find((p) => p.project_id === choice.projectId)?.name ?? "the project")} label="Use in project…" />;
  };

  return <section className="sb-dash sb-library" aria-label={title}>
    <Group justify="space-between" align="flex-end" wrap="wrap" gap="xs">
      <Title order={2} className="sb-dash-title">{title}</Title>
      <Group gap="xs">
      {editor && <Button variant="commit" size="xs" onClick={() => { setSelected(null); editor.reveal(true, view.noun); }} {...create.props}>New {view.noun}</Button>}
      <SegmentedControl size="xs" value={layout} onChange={(value) => setLayout(value as ListLayout)} aria-label="List layout"
        data={[{ value: "gallery", label: "Gallery" }, { value: "table", label: "Table" }]} />
      {projectId && <SegmentedControl size="xs" value={mode} onChange={(value) => setMode(value as "project" | "library")} aria-label="List scope"
        data={[{ value: "project", label: "This project" }, { value: "library", label: "Whole library" }]} />}
      </Group>
    </Group>
    {editor && projectId && <Text className="sb-dash-note">New items are added to the library and referenced by this project.</Text>}
    <div className="sb-ws-toolbar" role="search" aria-label={`Filter ${view.title}`}>
      <FilterInput onQuery={setQuery} />
      {view.family === 'definition' && <Checkbox size="xs" label="Include superseded" checked={includeSuperseded} onChange={event => setIncludeSuperseded(event.currentTarget.checked)} />}
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
    {rows.length > 0 && gallery && <div className="lg-grid" role="list" aria-label={`${view.title} gallery`}>
      {rows.map((row) => <div role="listitem" key={`${row.family}:${row.record_id}`} style={{ display: "contents" }}>
        <ItemCard item={row} principalKey={principalKey} drawn={drawn} attention={attention.get(row.record_id)} usedIn={usedInWords(row)}
          status={drawn ? undefined : { led: "off", words: row.detail ?? words(row.family) }}
          selected={selected === row.record_id} related={probeMark(probe, related, { object: row.record_id, rev: null, path: [] }, "object") === "related"}
          onOpen={() => openCard(row)} />
      </div>)}
    </div>}
    {selectedRow && <section className="lg-detail" aria-label={`Selected ${selectedRow.label}`}>
      <Group justify="space-between" gap="xs" wrap="wrap">
        <Text className="sb-dash-row-title">{selectedRow.label}</Text>
        <Group gap="xs">{editor && <Button variant="quiet" size="xs" onClick={() => editor.reveal(false)}>Show in the editor</Button>}
          {actionsFor(selectedRow)}
          <Button variant="quiet" size="xs" aria-label={`Close ${selectedRow.label}`} onClick={() => setSelected(null)}>Close</Button></Group>
      </Group>
      <UsedInList record={selectedRow} currentProjectId={projectId} toolLabel={toolLabel} onOpen={onOpenInProject} />
      {showsViews(selectedRow) && <SelectedDefinitionViews key={selectedRow.record_id} record={selectedRow} />}
    </section>}
    {rows.length > 0 && !gallery && <div className="sb-ws-scroll"><Table className="sb-ws-table" highlightOnHover verticalSpacing={4} horizontalSpacing="sm">
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
            <Table.Td className="sb-ws-num">{editor && <Button variant="quiet" size="xs" aria-label={`Open ${row.label} in the editor`} onClick={() => { if (!open) setSelected(row.record_id); editor.reveal(false); }}>Open</Button>}
              {actionsFor(row)}</Table.Td>
          </Table.Tr>
          {open && <Table.Tr className="sb-ws-detail"><Table.Td colSpan={7}>
            <UsedInList record={row} currentProjectId={projectId} toolLabel={toolLabel} onOpen={onOpenInProject} />
            {showsViews(row) && <SelectedDefinitionViews key={row.record_id} record={row} />}
          </Table.Td></Table.Tr>}
        </Fragment>;
      })}</Table.Tbody>
    </Table></div>}
    {offListRecord && <section aria-label={`Selected ${offListRecord.label}`}><Text className="sb-silk">Selected</Text><Text className="sb-dash-row-title">{offListRecord.label}</Text>
      <SelectedDefinitionViews key={offListRecord.record_id} record={offListRecord} /></section>}
    <Group gap="xs">
      {rows.length > 0 && <Text className="sb-silk" role="status">{rows.length} shown{records.hasNextPage ? " · more available" : ""}</Text>}
      {records.hasNextPage && <Button variant="quiet" size="xs" onClick={() => void records.fetchNextPage()} loading={records.isFetchingNextPage}>Load more</Button>}
    </Group>
  </section>;
}

/** Library name filter: keeps its own text state and reports the trimmed value after a short pause. */
export function FilterInput({ onQuery, delay = 250 }: { onQuery: (query: string) => void; delay?: number }) {
  const [text, setText] = useState("");
  const [query] = useDebouncedValue(text.trim(), delay);
  useEffect(() => { onQuery(query); }, [query, onQuery]);
  return <TextInput aria-label="Filter records" placeholder="filter by name" size="xs" className="sb-ws-filter"
    leftSection={<span className="sb-mono" style={{ color: "var(--sb-accent)" }}>›</span>} value={text} onChange={(event) => setText(event.currentTarget.value)} />;
}

const archivedGate = { allowed: false, reason: "Archived projects are read-only", props: { disabled: true as const, title: "Archived projects are read-only" } };
type GateLike = { allowed: boolean; reason: string | undefined; props: { disabled?: true; title?: string } };

export function UsedInList({ record, currentProjectId, toolLabel, onOpen }: { record: LibraryRecord; currentProjectId: string | null; toolLabel: string; onOpen: (projectId: string, record: LibraryRecord) => void }) {
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

export function AddButton({ record, projects, fixedProjectId, busy, gate, onAdd, label }: {
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
