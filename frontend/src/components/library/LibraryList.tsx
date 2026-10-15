import { Alert, Button, Checkbox, Group, Menu, SegmentedControl, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { usePermission } from "../../lib/permissions";
import { ItemCard } from "../../features/library-gallery/ItemCard";
import { requestNew, useNewRequest } from "../../features/library-gallery/newRequest";
import { listLibraryTable, type LibraryTableRecord } from "../../features/library-gallery/table-api";
import { useNavigation } from "../../features/navigation";
import { useProbeOrLocal } from "../../features/probe";
import type { EditorActions } from "../../features/scope/EditingLens";
import { AddButton, useListLayout, useReferenceActions, UsedInList } from "../../features/scope/LibraryView";
import { areaOfTool } from "../../features/shell/areas";
import { LIBRARY_VIEWS, type LibraryView } from "../../features/shell/scope";
import type { LibraryRecord, Project } from "../../features/workspace/api";
import { fieldText, LibraryCompare, numberText, savedState } from "./LibraryCompare";
import "./library.css";

const definition = (kinds: string[], title: string, noun: string): LibraryView => ({ family: "definition", kinds, title, noun, create: "item.create" });
export const TYPED_LIBRARY_VIEWS: Record<string, LibraryView> = {
  interfaces: definition(["connector_body", "pinout"], "Connectors", "connector"),
  ports: definition(["port"], "Device ports", "device port"),
  "end-assemblies": definition(["end_assembly"], "Saved end stacks", "end stack"),
  pcb: LIBRARY_VIEWS.pcb!, "wire-stock": definition(["wire_stock"], "Wire stocks", "wire stock"),
  identity: definition(["part", "material"], "Parts", "part"),
  hardware: definition(["hardware"], "Shells & hardware", "hardware definition"),
  kits: definition(["kit"], "Kits", "kit definition"),
  signals: LIBRARY_VIEWS.signals!, conventions: LIBRARY_VIEWS.conventions!, "workshop-profiles": LIBRARY_VIEWS["workshop-profiles"]!,
};
const CONNECTORS = [["interfaces", "connector_body", "Bodies"], ["interfaces", "pinout", "Pinouts"], ["ports", "", "Device ports"], ["end-assemblies", "", "Saved end stacks"]];
const VOCABULARY = [["signals", "Signals"], ["conventions", "Conventions"], ["workshop-profiles", "Workshop profiles"], ["evidence-kinds", "Evidence kinds"]];

export function LibrarySections({ toolId }: { toolId: string }) {
  const nav = useNavigation();
  const connector = ["interfaces", "ports", "end-assemblies"].includes(toolId);
  const vocabulary = VOCABULARY.some(([id]) => id === toolId);
  if (!connector && !vocabulary) return null;
  const kind = nav?.location.filters?.kind === "pinout" ? "pinout" : "connector_body";
  return <Group gap={4} role="group" aria-label={connector ? "Connector sections" : "Vocabulary sections"}>
    {(connector ? CONNECTORS : VOCABULARY.map(([id, label]) => [id!, "", label!])).map(([id, section, label]) => <Button key={label} size="xs" variant="quiet"
      aria-pressed={toolId === id && (!connector || id !== "interfaces" || kind === section)}
      onClick={() => nav?.navigate({ area: "library", lens: id!, probe: null, filters: section ? { kind: section } : {} })}>{label}</Button>)}
  </Group>;
}

/** Typed collection browsing. A project filters rows; it never owns or resets an editor. */
export function LibraryList({ toolId, projectFilterId, projects, principalKey, onOpenInProject, editor }: {
  toolId: string; projectFilterId: string | null; projects: Project[]; principalKey: string;
  onOpenInProject: (projectId: string, record: LibraryRecord) => void; editor?: EditorActions;
}) {
  const view = TYPED_LIBRARY_VIEWS[toolId]!;
  const cache = useQueryClient();
  const nav = useNavigation();
  const location = nav?.location;
  const filters = location?.lens === toolId ? location.filters ?? {} : {};
  const [localQuery, setLocalQuery] = useState(filters.q ?? "");
  const [query] = useDebouncedValue(localQuery.trim(), 250);
  const [storedLayout, setStoredLayout] = useListLayout();
  const layout = filters.layout === "table" || filters.layout === "gallery" ? filters.layout : storedLayout;
  const [selected, setSelected] = useProbeOrLocal();
  const [picked, setPicked] = useState<LibraryTableRecord[]>([]);
  const [comparing, setComparing] = useState(false);
  const create = usePermission(view.create);
  const source = usePermission("source.register");
  const itemCreate = usePermission("item.create");
  const projectEdit = usePermission("project.edit");
  const actions = useReferenceActions();
  const kind = toolId === "interfaces" ? filters.kind === "pinout" ? "pinout" : "connector_body" : filters.kind && view.kinds.includes(filters.kind) ? filters.kind : null;
  const kinds = kind ? [kind] : view.kinds;
  const searchQuery = nav ? filters.q ?? "" : query;
  const noun = kind === "pinout" ? "pinout" : kind === "connector_body" ? "connector body" : view.noun;
  const records = useInfiniteQuery({
    queryKey: ["workspace", "library", "table", principalKey, toolId, kinds, searchQuery, projectFilterId],
    queryFn: ({ pageParam }) => listLibraryTable({ kinds, query: searchQuery, projectFilterId, after: pageParam }),
    initialPageParam: null as string | null, getNextPageParam: page => page.next_after, retry: false,
  });
  const rows = useMemo(() => records.isError ? [] : records.data?.pages.flatMap(page => page.results) ?? [], [records.data, records.isError]);
  const columns = [...new Map(rows.flatMap(row => row.summary.fields).map(field => [field.key, field])).values()];
  const selectedRow = rows.find(row => row.record_id === selected);
  useEffect(() => { if (location?.lens === toolId) setLocalQuery(location.filters?.q ?? ""); }, [location?.filters?.q, location?.lens, toolId]);
  useEffect(() => {
    if (nav && location?.lens === toolId && query !== (filters.q ?? "")) nav.navigate({ filters: { ...filters, q: query } }, { replace: true });
  }, [query]); // Only a debounced keystroke writes; back/forward only restores text.
  useEffect(() => { setPicked([]); setComparing(false); }, [toolId, kind, principalKey, records.isError]);
  const startNew = () => { setSelected(null); editor?.reveal(true, noun); };
  // Home sends the canonical view identity, independent of the narrower table view.
  useNewRequest(LIBRARY_VIEWS[toolId] ?? view, !!editor && create.allowed, startNew);
  const route = (lens: string, nextFilters: Record<string, string> = {}) => nav?.navigate({ area: areaOfTool(lens).id, lens, probe: null, filters: nextFilters });
  useEffect(() => { if (toolId === "pcb" && filters.view === "intake") editor?.reveal(false); }, [toolId, filters.view]);
  const open = (row: LibraryTableRecord) => {
    if (nav) nav.navigate({ probe: { object: row.record_id, rev: null, path: [] } });
    else setSelected(row.record_id);
    editor?.reveal(false);
  };
  const toggle = (row: LibraryTableRecord) => setPicked(current => current.some(p => p.record_id === row.record_id) ? current.filter(p => p.record_id !== row.record_id) : [...current, row]);
  const chooseLayout = (value: string) => { setStoredLayout(value as "gallery" | "table"); nav?.navigate({ filters: { ...filters, layout: value } }, { replace: true }); };
  const changeProject = (value: string | null) => nav?.navigate({ project: value });
  const title = toolId === "interfaces" ? kind === "pinout" ? "Pinouts" : "Connector bodies" : view.title;

  return <section className="sb-dash sb-library typed-library" aria-label={title}>
    <LibrarySections toolId={toolId} />
    <Group justify="space-between" gap="xs"><Title order={2} className="sb-dash-title">{title}</Title><Button variant="quiet" size="xs" onClick={() => route("library-home")}>Library home</Button></Group>
    <Group className="typed-library-toolbar" gap="xs" align="flex-end">
      <TextInput aria-label="Search Library" placeholder="Name or manufacturer PN" value={localQuery} onChange={event => setLocalQuery(event.currentTarget.value)} className="typed-library-search" size="xs" />
      <Select label="Project filter" aria-label="Project filter" clearable searchable placeholder="Whole library" size="xs" data={projects.map(p => ({ value: p.project_id, label: p.name }))} value={projectFilterId} onChange={changeProject} />
      {view.kinds.length > 1 && toolId !== "interfaces" && <Select aria-label="Kind filter" clearable placeholder="Every kind" size="xs" data={view.kinds.map(value => ({ value, label: value.replaceAll("_", " ") }))} value={kind} onChange={value => nav?.navigate({ filters: { ...filters, kind: value ?? "" } }, { replace: true })} />}
      {editor && create.allowed && <Button variant="commit" size="xs" onClick={startNew}>New {noun}</Button>}
      {(source.allowed || itemCreate.allowed) && <Menu><Menu.Target><Button variant="quiet" size="xs">Import</Button></Menu.Target><Menu.Dropdown>
        {source.allowed && <Menu.Item onClick={() => { requestNew(LIBRARY_VIEWS.sources!); route("sources"); }}>Register source files…</Menu.Item>}
        {source.allowed && <Menu.Item onClick={() => { route("pcb", { view: "intake" }); if (toolId === "pcb") editor?.reveal(false); }}>KiCad board intake…</Menu.Item>}
        {itemCreate.allowed && <Menu.Item onClick={() => route("catalog-packs")}>Adopt catalog pack…</Menu.Item>}
      </Menu.Dropdown></Menu>}
      <Button variant="quiet" size="xs" onClick={() => { void records.refetch(); void cache.invalidateQueries({ queryKey: ["workspace", "library", "preview", principalKey] }); }}>Refresh</Button>
      <Button variant="quiet" size="xs" disabled={picked.length !== 2} onClick={() => setComparing(true)}>Compare {picked.length}/2</Button>
      {picked.length > 0 && <Button variant="quiet" size="xs" onClick={() => setPicked([])}>Clear comparison</Button>}
      <SegmentedControl aria-label="Library layout" size="xs" value={layout} onChange={chooseLayout} data={[{ value: "gallery", label: "Gallery" }, { value: "table", label: "Table" }]} />
    </Group>
    <Text size="xs" className="sb-dash-note">PN shows manufacturer associations for the selected frozen revision. Unassigned means no number is recorded. Compare selects two items of the same kind.</Text>
    {actions.error && <Alert color="red">{actions.error}</Alert>}{actions.notice && <Text role="status">{actions.notice}</Text>}
    {records.isError && <Alert color="red" title="Library unavailable">{records.error.message}</Alert>}
    {records.isPending && <Text role="status">Reading the library…</Text>}
    {records.isSuccess && rows.length === 0 && <Text role="status">{localQuery || projectFilterId ? "No items match these filters." : `No ${noun} definitions yet.`}</Text>}
    {layout === "gallery" && rows.length > 0 && <div className="lg-grid" role="list" aria-label={`${title} gallery`}>{rows.map(row => <div key={row.record_id} role="listitem" className="typed-library-card">
      <ItemCard item={row} expectedState={{ revision: row.latest_revision, draftVersion: row.summary.draft_version }} principalKey={principalKey} onOpen={() => open(row)} selected={selected === row.record_id} status={{ led: row.summary.basis === "unknown" ? "unknown" : "info", words: savedState(row) }} note={numberText(row)} />
      <Checkbox size="xs" label={`Compare ${row.label}`} checked={picked.some(p => p.record_id === row.record_id)} disabled={!picked.some(p => p.record_id === row.record_id) && (picked.length === 2 || picked.length > 0 && picked[0]!.kind !== row.kind || row.summary.basis === "unknown")} onChange={() => toggle(row)} />
    </div>)}</div>}
    {layout === "table" && rows.length > 0 && <div className="sb-ws-scroll"><Table className="sb-ws-table" verticalSpacing={4} horizontalSpacing="sm" highlightOnHover><Table.Thead><Table.Tr>
      <Table.Th><span className="sb-visually-hidden">Compare selection</span></Table.Th><Table.Th title="Exact revision manufacturer associations; internal numbering is unassigned">PN</Table.Th><Table.Th>Name</Table.Th><Table.Th>Kind</Table.Th>{columns.map(field => <Table.Th key={field.key}>{field.label}</Table.Th>)}<Table.Th>Revision</Table.Th><Table.Th>Used</Table.Th><Table.Th>Flags</Table.Th>
    </Table.Tr></Table.Thead><Table.Tbody>{rows.map(row => <Table.Tr key={row.record_id} data-selected={selected === row.record_id || undefined}>
      <Table.Td><Checkbox aria-label={`Compare ${row.label}`} checked={picked.some(p => p.record_id === row.record_id)} disabled={!picked.some(p => p.record_id === row.record_id) && (picked.length === 2 || picked.length > 0 && picked[0]!.kind !== row.kind || row.summary.basis === "unknown")} onChange={() => toggle(row)} /></Table.Td>
      <Table.Td className="sb-mono" title={numberText(row)}>{row.summary.numbers.map(number => number.value).join(" · ") || <span className="sb-dash-note">Unassigned</span>}{row.summary.numbers_truncated && " · more"}</Table.Td>
      <Table.Td><button className="sb-ws-open" type="button" onClick={() => open(row)}>{row.label}</button></Table.Td><Table.Td>{row.kind?.replaceAll("_", " ")}</Table.Td>
      {columns.map(field => <Table.Td key={field.key} className="sb-mono">{fieldText(row.summary.fields.find(value => value.key === field.key))}</Table.Td>)}
      <Table.Td className="sb-mono">{savedState(row)}</Table.Td><Table.Td title="Active project references">{row.used_in_total} reference{row.used_in_total === 1 ? "" : "s"}</Table.Td><Table.Td>{row.summary.flags.join(" · ") || "Not evaluated"}</Table.Td>
    </Table.Tr>)}</Table.Tbody></Table></div>}
    {selectedRow && <Stack gap="xs" className="lg-detail" aria-label={`Selected ${selectedRow.label}`}><Group justify="space-between"><Text fw={600}>{selectedRow.label} · {savedState(selectedRow)}</Text><Group gap="xs">
      {editor && <Button variant="quiet" size="xs" onClick={() => editor.reveal(false)}>Show in editor</Button>}
      <AddButton record={selectedRow} projects={projects} busy={actions.busy} gate={projectEdit} label="Use in project…" onAdd={choice => actions.add(selectedRow, choice, projects.find(p => p.project_id === choice.projectId)?.name ?? "the project")} />
      <Button variant="quiet" size="xs" onClick={() => setSelected(null)}>Close selection</Button></Group></Group>
      <UsedInList record={selectedRow} currentProjectId={projectFilterId} toolLabel={title} onOpen={onOpenInProject} /></Stack>}
    <Group gap="xs"><Text role="status" size="xs">{rows.length} shown{records.hasNextPage ? " · more available" : ""}</Text>{records.hasNextPage && <Button variant="quiet" size="xs" loading={records.isFetchingNextPage} onClick={() => void records.fetchNextPage()}>Load more</Button>}</Group>
    <LibraryCompare rows={records.isError ? [] : picked} opened={comparing && !records.isError} onClose={() => setComparing(false)} />
  </section>;
}
