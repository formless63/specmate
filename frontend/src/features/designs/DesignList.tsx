import { Alert, Badge, Button, Drawer, Group, Menu, Popover, SegmentedControl, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { usePermission } from "../../lib/permissions";
import { ItemCard, revisionTag } from "../library-gallery/ItemCard";
import { loadPreview } from "../library-gallery/api";
import { ItemThumb } from "../library-gallery/thumbs";
import { useNavigation } from "../navigation";
import { ApiError, type LibraryRecord, type Project } from "../workspace/api";
import { listDesigns, type DesignEnd, type DesignKind, type DesignRow } from "./api";
import "./designs.css";

const KIND_NAMES: Record<string, string> = { cable: "Cable", harness: "Harness", assembly: "Device" };
const FILTER_NAMES: Record<string, string> = { q: "Search", kind: "Kind", status: "Status", from: "From", to: "To", stock: "Stock", board: "Board" };
const STATUS_NAMES: Record<string, string> = { draft_only: "Draft only", frozen: "Has frozen revision", reviewed: "Review recorded", unreviewed: "Not reviewed", unknown: "Review unknown" };

/** Review and revision state are separate from the engineering checks, which this list does not run. */
export function designStatus(row: DesignRow) {
  return row.design.review === "reviewed" ? "Review recorded" : row.design.review === "unreviewed" ? "Not reviewed" : "Review unknown";
}

function End({ end }: { end: DesignEnd }) {
  return <span title={end.basis === "endpoint_label" ? "Cable end label; no intent port recorded" : undefined}>
    {end.label ?? <span className="design-unknown">Not declared</span>}
    {end.basis === "endpoint_label" && <small className="design-end-basis">end label</small>}
    {end.basis === "intent_pinout" && <small className="design-end-basis">pinout</small>}
  </span>;
}

export function DesignList({ principalKey, projectId, projects, onOpen, onCreate, onAccessLost, active = true }: {
  principalKey: string;
  projectId: string | null;
  projects: Project[];
  onOpen: (record: LibraryRecord) => void;
  onCreate: (kind: DesignKind) => void;
  active?: boolean;
  onAccessLost?: () => void | Promise<void>;
}) {
  const navigation = useNavigation();
  const [localFilters, setLocalFilters] = useState<Record<string, string>>({});
  const filters = navigation?.location.filters ?? localFilters;
  const [settled] = useDebouncedValue(filters, 200);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterMenu, setFilterMenu] = useState(false);
  const create = usePermission("item.create");
  const layout = filters.layout === "gallery" ? "gallery" : "table";
  const records = useInfiniteQuery({
    queryKey: ["workspace", "designs", principalKey, settled, projectId],
    queryFn: ({ pageParam }) => listDesigns(settled, projectId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_after,
    enabled: active,
    retry: false,
  });
  const denied = records.isError && records.error instanceof ApiError && [401, 403, 404].includes(records.error.status);
  // A failed authorization refetch must withdraw retained query data immediately. A server
  // outage keeps its separate error state and does not claim that membership was revoked.
  const rows = denied ? [] : records.data?.pages.flatMap((page) => page.results) ?? [];
  useEffect(() => {
    if (!denied) return;
    setSelectedId(null);
    void Promise.resolve().then(() => onAccessLost?.()).catch(() => { /* The denied list stays hidden if session refresh also fails. */ });
  }, [denied, onAccessLost]);
  const selected = rows.find((row) => row.record_id === selectedId) ?? null;
  const activeFilters = Object.entries(filters).filter(([key, value]) => FILTER_NAMES[key] && value);
  const setFilter = (key: string, value: string | null) => {
    const next = { ...filters };
    if (value) next[key] = value; else delete next[key];
    if (navigation) navigation.navigate({ filters: next }, { replace: ["q", "from", "to", "stock", "board"].includes(key) }); else setLocalFilters(next);
    setSelectedId(null);
  };

  return <section className="design-list" aria-label="Designs">
    <Group justify="space-between" gap="xs">
      <div><Title order={1} className="sb-dash-title">Designs</Title><Text size="xs" c="dimmed">Cables, harnesses and devices</Text></div>
      <Group gap="xs">
        <SegmentedControl size="xs" aria-label="Design list layout" value={layout}
          data={[{ value: "table", label: "Table" }, { value: "gallery", label: "Gallery" }]}
          onChange={(value) => setFilter("layout", value === "table" ? null : value)} />
        <Menu position="bottom-end"><Menu.Target><Button size="xs" variant="commit" {...create.props}>New design</Button></Menu.Target>
          <Menu.Dropdown>{(["cable", "harness", "assembly"] as DesignKind[]).map((kind) => <Menu.Item key={kind} onClick={() => onCreate(kind)}>{KIND_NAMES[kind]}</Menu.Item>)}</Menu.Dropdown>
        </Menu>
      </Group>
    </Group>
    <div className="design-toolbar" role="search" aria-label="Filter designs">
      <TextInput size="xs" aria-label="Search designs" placeholder="Find a design…" value={filters.q ?? ""} onChange={(event) => setFilter("q", event.currentTarget.value)} />
      <Select size="xs" aria-label="Design kind" placeholder="Every kind" clearable value={filters.kind ?? null}
        data={Object.entries(KIND_NAMES).map(([value, label]) => ({ value, label }))} onChange={(value) => setFilter("kind", value)} />
      <Select size="xs" aria-label="Design status" placeholder="Every status" clearable value={filters.status ?? null}
        data={Object.entries(STATUS_NAMES).map(([value, label]) => ({ value, label }))} onChange={(value) => setFilter("status", value)} />
      <Select size="xs" aria-label="Project filter" placeholder="All projects" searchable clearable value={projectId}
        data={projects.filter((project) => !project.archived || project.project_id === projectId).map((project) => ({ value: project.project_id, label: project.name }))}
        onChange={(value) => navigation?.navigate({ project: value })} />
      <Popover opened={filterMenu} onChange={setFilterMenu} position="bottom-end" width={270}><Popover.Target>
        <Button size="xs" variant="quiet" onClick={() => setFilterMenu(!filterMenu)}>More filters</Button>
      </Popover.Target><Popover.Dropdown><Stack gap="xs">{["from", "to", "stock", "board"].map((key) => <TextInput key={key} size="xs" label={FILTER_NAMES[key]}
        description={key === "from" || key === "to" ? "Port name or declared end label" : undefined}
        value={filters[key] ?? ""} onChange={(event) => setFilter(key, event.currentTarget.value)} />)}</Stack></Popover.Dropdown></Popover>
    </div>
    {(activeFilters.length > 0 || projectId) && <Group gap={6} aria-label="Active design filters">
      {activeFilters.map(([key, value]) => <Button key={key} size="compact-xs" variant="quiet" aria-label={`Remove ${FILTER_NAMES[key]} filter`} onClick={() => setFilter(key, null)}>
        {FILTER_NAMES[key]}: {key === "kind" ? KIND_NAMES[value] ?? value : key === "status" ? STATUS_NAMES[value] ?? value : value} ×
      </Button>)}
      {projectId && <Badge variant="outline">Project: {projects.find((project) => project.project_id === projectId)?.name ?? "Selected project"}</Badge>}
    </Group>}
    {records.isError && <Alert color="red" title="Designs could not be loaded" role="alert">{records.error.message}<Button size="xs" variant="quiet" onClick={() => void records.refetch()}>Try again</Button></Alert>}
    {records.isPending && <Text role="status" size="sm">Loading designs…</Text>}
    {records.isSuccess && rows.length === 0 && <div className="sb-dash-empty" role="status">{activeFilters.length || projectId ? "No designs match these filters." : "No designs yet. Start with a cable, harness or device."}</div>}
    {rows.length > 0 && layout === "table" && <Table.ScrollContainer minWidth={900} type="native"><Table className="design-table" highlightOnHover verticalSpacing={6}>
      <Table.Thead><Table.Tr>{["Name", "Kind", "From", "To", "Stock", "Revision", "Used in", "Status"].map((label) => <Table.Th key={label}>{label}</Table.Th>)}</Table.Tr></Table.Thead>
      <Table.Tbody>{rows.map((row) => <Table.Tr key={row.record_id} tabIndex={0} aria-label={`${row.label}, ${KIND_NAMES[row.kind ?? ""] ?? row.kind}`} aria-selected={selectedId === row.record_id}
        onClick={() => setSelectedId(row.record_id)} onDoubleClick={() => onOpen(row)}
        onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === "Enter") { event.preventDefault(); onOpen(row); } else if (event.key === " ") { event.preventDefault(); setSelectedId(row.record_id); } }}>
        <Table.Td><button type="button" className="design-name" onClick={(event) => { event.stopPropagation(); onOpen(row); }}>{row.label}</button></Table.Td>
        <Table.Td>{KIND_NAMES[row.kind ?? ""] ?? row.kind}</Table.Td>
        <Table.Td><End end={row.design.from} /></Table.Td><Table.Td><End end={row.design.to} /></Table.Td>
        <Table.Td>{row.design.stocks.map((stock) => stock.label).join(", ") || <span className="design-unknown">Not declared</span>}</Table.Td>
        <Table.Td><span className="lg-rev" data-frozen={row.latest_revision !== null || undefined} title={row.latest_revision !== null ? "Latest frozen revision; draft may have later edits" : "No frozen revision"}>{revisionTag(row)}</span></Table.Td>
        <Table.Td title={[...new Set(row.used_in.map((use) => use.project_name))].join(", ")}>{row.used_in_total} reference{row.used_in_total !== 1 ? "s" : ""}</Table.Td>
        <Table.Td><span className="lg-status"><span className="sb-led" data-state={row.design.review === "reviewed" ? "info" : "not-evaluated"} aria-hidden="true" />{designStatus(row)}</span><small className="design-end-basis">Checks not evaluated here</small></Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table></Table.ScrollContainer>}
    {rows.length > 0 && layout === "gallery" && <div className="lg-grid" role="list" aria-label="Design gallery">{rows.map((row) => <div role="listitem" key={row.record_id}>
      <ItemCard item={row} principalKey={principalKey} onOpen={() => onOpen(row)} usedIn={`${row.used_in_total} project references`} status={{ led: row.design.review === "reviewed" ? "info" : "not-evaluated", words: designStatus(row) }} note="Checks not evaluated here" />
    </div>)}</div>}
    {records.hasNextPage && <Button size="xs" variant="quiet" loading={records.isFetchingNextPage} onClick={() => void records.fetchNextPage()}>Load more designs</Button>}
    <Text size="xs" c="dimmed">Lists show the latest frozen revision, or the newest draft when none is frozen. Review status is not a check result.</Text>
    <Drawer opened={!!selected} onClose={() => setSelectedId(null)} position="right" title={selected?.label} size={380}>
      {selected && <DesignDetails row={selected} principalKey={principalKey} onOpen={() => onOpen(selected)} />}
    </Drawer>
  </section>;
}

function DesignDetails({ row, principalKey, onOpen }: { row: DesignRow; principalKey: string; onOpen: () => void }) {
  const preview = useQuery({ queryKey: ["workspace", "library", "preview", principalKey, row.record_id], queryFn: () => loadPreview(row.record_id), staleTime: 60_000, retry: false });
  return <Stack gap="sm">
    <div className="design-preview"><ItemThumb kind={row.kind ?? "cable"} label={row.label} preview={preview.isError ? null : preview.data} recordId={row.record_id} /></div>
    <Group><Badge variant="outline">{KIND_NAMES[row.kind ?? ""]}</Badge><span className="lg-rev" data-frozen={row.latest_revision !== null || undefined}>{revisionTag(row)}</span></Group>
    <Text size="sm">{designStatus(row)}. Engineering checks are not evaluated in this list; open the design to inspect its results.</Text>
    <dl className="design-detail-facts"><dt>From</dt><dd><End end={row.design.from} /></dd><dt>To</dt><dd><End end={row.design.to} /></dd>
      <dt>Stock</dt><dd>{row.design.stocks.map((stock) => `${stock.label} · r${stock.revision}`).join(", ") || "Not declared"}</dd>
      <dt>Boards</dt><dd>{row.design.boards.map((board) => `${board.label} · r${board.revision}`).join(", ") || "Not declared"}</dd>
      <dt>Used in</dt><dd>{row.used_in.map((use) => use.project_name).join(", ") || "No project references"}</dd></dl>
    <Button variant="commit" onClick={onOpen}>Open design</Button>
  </Stack>;
}
