import { Alert, Button, Group, Menu, Text, Title } from "@mantine/core";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { usePermission } from "../../lib/permissions";
import { readLibraryRecord } from "../probe";
import { useNavigation } from "../navigation";
import { FilterInput, words } from "../scope/LibraryView";
import { areaOfTool } from "../shell/areas";
import { LIBRARY_VIEWS, toolForKind, type LibraryView } from "../shell/scope";
import { listLibrary, type LibraryRecord } from "../workspace/api";
import { requestNew } from "./newRequest";
import { attentionById, useLibraryHome, usedInWords } from "./hooks";
import { ItemCard, type CardItem } from "./ItemCard";
import "./library-gallery.css";

function ago(value: string, now = Date.now()): string {
  const minutes = Math.round((now - new Date(value).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(value).toISOString().slice(0, 10);
}

function Cell({ label, value, note, unknown = false }: { label: string; value: string; note?: string; unknown?: boolean }) {
  return <div className={`sb-cell${unknown ? " sb-hatch" : ""}`}>
    <dt className="sb-silk">{label}</dt>
    <dd data-unknown={unknown} title={value}>{value}</dd>
    {note && <Text component="span" className="sb-dash-note" size="xs">{note}</Text>}
  </div>;
}

const FAMILY_TOOL: Record<string, string> = { source_bundle: "sources", physical_unit: "physical-units", stock_account: "inventory", fact_subject: "facts" };

/** The lens that shows a library record of any family. */
export function toolForRecord(record: Pick<LibraryRecord, "family" | "kind">): string {
  return record.family === "definition" ? toolForKind(record.kind) : FAMILY_TOOL[record.family] ?? "identity";
}

function NewItem({ toolId, view, onPick }: { toolId: string; view: LibraryView; onPick: (toolId: string, view: LibraryView) => void }) {
  const gate = usePermission(view.create);
  return <Menu.Item disabled={!gate.allowed} title={gate.reason} onClick={() => onPick(toolId, view)}>{view.noun.charAt(0).toUpperCase() + view.noun.slice(1)}</Menu.Item>;
}

/** "New…": choose what to create; the item's lens opens with its New form, as its own New button does. */
function NewMenu({ onPick }: { onPick: (toolId: string, view: LibraryView) => void }) {
  const entries = Object.entries(LIBRARY_VIEWS).sort((a, b) => a[1].noun.localeCompare(b[1].noun));
  return <Menu position="bottom-end" withinPortal shadow="md">
    <Menu.Target><Button variant="commit" size="xs">New…</Button></Menu.Target>
    <Menu.Dropdown mah={360} style={{ overflowY: "auto" }}>
      <Menu.Label>Create in the library</Menu.Label>
      {entries.map(([toolId, view]) => <NewItem key={toolId} toolId={toolId} view={view} onPick={onPick} />)}
    </Menu.Dropdown>
  </Menu>;
}

/**
 * The Library home: what needs attention (from recorded checks, stale evidence, open intent
 * questions and unknown declared values), the member's recent work, and every item as a visual
 * gallery with search and kind chips. Selecting a card opens the item in its own lens, which
 * shows its latest frozen revision first. Read-only for every role.
 */
export function LibraryHome({ principalKey }: { principalKey: string }) {
  const navigation = useNavigation();
  const home = useLibraryHome(principalKey);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  // Cards of the collapsed group mount (and read previews) only once it is opened.
  const [unknownOpen, setUnknownOpen] = useState(false);
  const kinds = kind ? [kind] : [];
  const records = useInfiniteQuery({
    queryKey: ["workspace", "library", principalKey, "definition", kinds, query, null, false],
    queryFn: ({ pageParam }) => listLibrary({ family: "definition", kinds, query, projectId: null, after: pageParam, limit: 48 }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_after,
    retry: false,
  });
  const rows = useMemo(() => (records.data?.pages ?? []).flatMap((page) => page.results), [records.data]);
  const attention = useMemo(() => attentionById(home.data), [home.data]);
  const open = (item: CardItem) => {
    const tool = toolForKind(item.kind);
    navigation?.navigate({ area: areaOfTool(tool).id, lens: tool, probe: { object: item.record_id, rev: null, path: [] } });
  };
  // A deep link to an item (/library/<id>) opens it in its own lens, never on the home.
  const linked = navigation?.location.lens === "library-home" ? navigation.location.probe : null;
  const target = useQuery({ queryKey: ["workspace", "library-record", principalKey, linked?.object ?? null], queryFn: () => readLibraryRecord(linked!.object, null),
    enabled: !!linked, retry: false });
  useEffect(() => {
    if (!linked || !target.data || target.data.record_id !== linked.object) return;
    const tool = toolForRecord(target.data);
    navigation?.navigate({ area: areaOfTool(tool).id, lens: tool, probe: linked }, { replace: true });
  }, [linked, target.data, navigation]);
  const startNew = (toolId: string, view: LibraryView) => {
    const designForms: Record<string, string> = { cables: "new-cable", harnesses: "new-harness", assemblies: "new-assembly" };
    const designForm = designForms[toolId];
    navigation?.navigate({ area: areaOfTool(toolId).id, lens: designForm ?? toolId, probe: null, ...(["intents", "cable-test-intent", "facts"].includes(toolId) ? { filters: { status: "new" } } : {}) });
    if (!designForm) requestNew(view);
  };
  const data = home.data;
  const lowerBound = data?.scan_limit_reached ? "at least " : "";
  const unknownTotal = data ? data.totals.unknown_checks + data.totals.unknown_values : 0;
  const chips = [{ value: null as string | null, label: "All", count: data?.definitions_total ?? null },
    ...(data?.kinds ?? []).map((row) => ({ value: row.kind as string | null, label: words(row.kind), count: row.count as number | null }))];

  return <section className="sb-dash lg-home" aria-label="Library home">
    <Group justify="space-between" align="flex-end" gap="xs"><Title order={2} className="sb-dash-title">Library</Title><NewMenu onPick={startNew} /></Group>
    {home.isError && <Alert color="red" role="alert" title="Attention unavailable">{home.error instanceof Error ? home.error.message : "The Library home could not be read."}</Alert>}
    <dl className="sb-context lg-cells" aria-label="Library summary">
      <Cell label="Needs attention" value={data ? `${lowerBound}${data.attention_total}` : "Not reported"} unknown={!data} />
      <Cell label="Failing checks" value={data ? `${lowerBound}${data.totals.failing_checks}` : "Not reported"} unknown={!data} note="rows in recorded checks" />
      <Cell label="Unknown" value={data ? `${lowerBound}${unknownTotal}` : "Not reported"} unknown={!data} note="checks and declared values" />
      <Cell label="Open questions" value={data ? `${lowerBound}${data.totals.open_questions}` : "Not reported"} unknown={!data} note="in intent drafts" />
      <Cell label="Stale evidence" value={data ? `${lowerBound}${data.totals.stale_evidence}` : "Not reported"} unknown={!data} note="newer pinned revision" />
      <Cell label="Items" value={data ? String(data.definitions_total) : "Not reported"} unknown={!data} note={data ? `${data.kinds.length} kinds` : undefined} />
    </dl>

    <section className="lg-section" aria-label="Needs attention">
      <div className="lg-section-head"><h3>Needs attention</h3><span className="lg-section-note">failing recorded checks, open intent questions and stale evidence</span></div>
      {home.isPending && <Text role="status" className="sb-dash-note">Reading the library…</Text>}
      {data && data.attention.length === 0 && <div className="lg-empty" role="status">Nothing recorded needs attention. Items without recorded checks are not counted as passing.</div>}
      {data && data.attention.length > 0 && <div className="lg-row" role="list" aria-label="Items needing attention">
        {data.attention.map((item) => <div role="listitem" key={item.record_id} style={{ display: "contents" }}>
          <ItemCard item={item} principalKey={principalKey} attention={item} onOpen={() => open(item)} />
        </div>)}
      </div>}
      {data && data.unknowns.length > 0 && <details className="lg-unknowns" onToggle={(event) => setUnknownOpen(event.currentTarget.open)}>
        <summary>Unknown values <span className="lg-filter-n">{data.unknowns_total} item{data.unknowns_total === 1 ? "" : "s"} · {unknownTotal} unknown</span></summary>
        {unknownOpen && <div className="lg-row" role="list" aria-label="Items with unknown values">
          {data.unknowns.map((item) => <div role="listitem" key={item.record_id} style={{ display: "contents" }}>
            <ItemCard item={item} principalKey={principalKey} attention={item} onOpen={() => open(item)} />
          </div>)}
        </div>}
      </details>}
    </section>

    <section className="lg-section" aria-label="Recent">
      <div className="lg-section-head"><h3>Recent</h3><span className="lg-section-note">your last edits and freezes</span></div>
      {data && data.recent.length === 0 && <div className="lg-empty" role="status">You have not edited or frozen anything in this workspace yet.</div>}
      {data && data.recent.length > 0 && <div className="lg-row" role="list" aria-label="Your recent items">
        {data.recent.map((item) => <div role="listitem" key={item.record_id} style={{ display: "contents" }}>
          <ItemCard item={item} principalKey={principalKey} attention={attention.get(item.record_id)} onOpen={() => open(item)}
            note={`${item.activity} ${ago(item.at)}`} />
        </div>)}
      </div>}
    </section>

    <section className="lg-section" aria-label="All items">
      <div className="lg-section-head"><h3>All items</h3><span className="lg-section-note" role="status">{rows.length} shown{records.hasNextPage ? " · more available" : ""}</span></div>
      <div className="lg-toolbar" role="search" aria-label="Filter the library">
        <FilterInput onQuery={setQuery} />
        <div className="lg-chip-filter" role="group" aria-label="Kind">
          {chips.map((chip) => <button key={chip.value ?? "all"} type="button" className="lg-filter" aria-pressed={kind === chip.value}
            onClick={() => setKind(chip.value)}>{chip.label}{chip.count !== null && <span className="lg-filter-n">{chip.count}</span>}</button>)}
        </div>
      </div>
      {records.isError && <Alert color="red" role="alert" title="Library unavailable">{records.error instanceof Error ? records.error.message : "The list could not be read."}</Alert>}
      {records.isSuccess && rows.length === 0 && <div className="lg-empty" role="status">
        <span>{query || kind ? "Nothing matches. Your search is kept." : "The library is empty."}</span>
        {(query || kind) && <Button variant="quiet" size="xs" onClick={() => setKind(null)}>Show every kind</Button>}
      </div>}
      {rows.length > 0 && <div className="lg-grid" role="list" aria-label="Library items">
        {rows.map((row) => <div role="listitem" key={row.record_id} style={{ display: "contents" }}>
          <ItemCard item={row} principalKey={principalKey} attention={attention.get(row.record_id)} usedIn={usedInWords(row)} onOpen={() => open(row)} />
        </div>)}
      </div>}
      {records.hasNextPage && <div><Button variant="quiet" size="xs" onClick={() => void records.fetchNextPage()} loading={records.isFetchingNextPage}>Load more</Button></div>}
    </section>
  </section>;
}
