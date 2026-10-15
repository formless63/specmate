import { Spotlight, type SpotlightActionData, type SpotlightActionGroupData } from "@mantine/spotlight";
import { useDebouncedValue } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useLibraryHome } from "../library-gallery/hooks";
import { useNavigation } from "../navigation";
import { areaOfTool } from "../shell/areas";
import { toolForKind } from "../shell/scope";
import { searchLibrary, type SearchField, type SearchItem } from "./api";

type SpotlightActions = SpotlightActionData | SpotlightActionGroupData;

const DEBOUNCE_MS = 200;
const RECENT_COUNT = 8;
const ITEM_GROUPS = new Set(["Items", "Recent items"]);
const FIELD_NOTE: Record<SearchField, string> = { name: "", part_number: "part number", identifier: "identifier", connector_family: "connector family", kind: "kind" };

const words = (value: string) => value.replaceAll("_", " ");

/** An exact revision tag, or plain words when nothing is frozen; never a made-up number. */
export function revisionTag(revision: number | null): string {
  return revision === null ? "draft only" : `r${revision}`;
}

function toolMatches(query: string, action: SpotlightActionData): boolean {
  const wanted = query.trim().toLowerCase();
  return !wanted || (action.label ?? "").toLowerCase().includes(wanted) || String(action.description ?? "").toLowerCase().includes(wanted);
}

/** Item rows always stay (the server already matched them); tool rows keep the label/description match. */
export function filterPalette(query: string, actions: SpotlightActions[]): SpotlightActions[] {
  const items = actions.filter((entry): entry is SpotlightActionGroupData => "actions" in entry && ITEM_GROUPS.has(entry.group));
  const tools = actions.flatMap((entry) => ("actions" in entry && !ITEM_GROUPS.has(entry.group)
    ? [{ ...entry, actions: entry.actions.filter((action) => toolMatches(query, action)) }]
    : []));
  return [...items, ...tools.filter((group) => group.actions.length > 0)];
}

function itemAction(item: SearchItem | (Omit<SearchItem, "match"> & { match?: SearchItem["match"] }), onOpen: (item: { record_id: string; kind: string }) => void): SpotlightActionData {
  const note = item.match && item.match.field !== "name" ? `${FIELD_NOTE[item.match.field]} ${item.match.text}` : "";
  return {
    id: `item:${item.record_id}`, label: item.label, description: note || undefined,
    leftSection: <span className="sb-keycap" data-testid="palette-kind">{words(item.kind)}</span>,
    rightSection: <span className="sb-mono sb-dash-note" data-testid="palette-revision">{revisionTag(item.latest_revision)}</span>,
    onClick: () => onOpen(item),
  };
}

/**
 * The command palette with library items: typing searches the workspace library (debounced and
 * bounded, ranked exact then prefix then substring) and lists tools as a second group; empty,
 * it shows the member's recent items. Choosing an item opens it in its own lens, which shows
 * its latest frozen revision first. Everything works from the keyboard (arrows, Enter, Escape).
 */
export function ItemSpotlight({ principalKey, toolActions, extraActions, placeholder }: {
  principalKey: string; toolActions: SpotlightActionGroupData[]; extraActions: SpotlightActionGroupData[]; placeholder: string;
}) {
  const navigation = useNavigation();
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced] = useDebouncedValue(query.trim(), DEBOUNCE_MS);
  const found = useQuery({ queryKey: ["workspace", "library-search", principalKey, debounced], queryFn: () => searchLibrary(debounced),
    enabled: opened && debounced.length > 0, staleTime: 15_000, retry: false });
  const home = useLibraryHome(principalKey, opened);

  const open = (item: { record_id: string; kind: string }) => {
    const tool = toolForKind(item.kind);
    navigation?.navigate({ area: areaOfTool(tool).id, lens: tool, probe: { object: item.record_id, rev: null, path: [] } });
  };
  const searching = query.trim().length > 0;
  const settled = searching && debounced === query.trim() && found.isSuccess;
  const actions = useMemo<SpotlightActions[]>(() => {
    const items: SpotlightActionGroupData[] = [];
    if (!searching && home.data && home.data.recent.length > 0) {
      items.push({ group: "Recent items", actions: home.data.recent.slice(0, RECENT_COUNT).map((item) => itemAction(item, open)) });
    }
    if (searching && found.data && found.data.results.length > 0) {
      items.push({ group: "Items", actions: found.data.results.map((item) => itemAction(item, open)) });
    }
    return [...items, ...toolActions, ...extraActions];
    // open only reads navigation, which changes with the location.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, home.data, found.data, toolActions, extraActions, navigation]);

  const nothing = searching && !settled && !found.isError ? "Searching the library…"
    : found.isError && searching ? "Library search unavailable; tools still match." : searching ? "No matching item, area or tool" : "No matching area or tool";
  return <Spotlight actions={actions} filter={filterPalette} query={query} onQueryChange={setQuery} shortcut="mod + K" nothingFound={nothing}
    highlightQuery limit={40} onSpotlightOpen={() => setOpened(true)} onSpotlightClose={() => setOpened(false)}
    searchProps={{ placeholder, "aria-label": "Search items, tools and areas" }} />;
}
