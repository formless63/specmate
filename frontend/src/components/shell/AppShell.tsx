import { AppShell as MantineAppShell, Button, Group, Menu, Tabs, Text, VisuallyHidden } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { Spotlight, spotlight, type SpotlightActionData, type SpotlightActionGroupData } from "@mantine/spotlight";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ItemSpotlight } from "../../features/item-search";
import { breakpoints, rail, topBarHeight } from "../../theme/schematicBench";
import "./shell.css";
import { Brand } from "../brand/Brand";
import { ThemeControl } from "./ThemeControl";
import type { ShellChrome } from "../../features/workspace";
import { AREAS, areaOfTool, describeAccess, primaryTools, toolLabel, type AreaDef } from "../../features/shell/areas";

const STATUS_LINE_HEIGHT = 24;
const NO_ACTIONS: SpotlightActionGroupData[] = [];

type SbShellProps = {
  /** The current scope's name: "Library" or the project's name. */
  projectName: string;
  recordName?: string;
  /** Workspace permissions; they apply at every scope. */
  permissions: string[];
  /** Workspace role as reported by the server. */
  role?: string | null;
  /** True at Library scope (no project context). */
  libraryScope?: boolean;
  /** Extra palette entries, e.g. switching scope. */
  extraActions?: SpotlightActionGroupData[];
  /** Principal key of the signed-in member: with it, the palette also searches library items. */
  itemSearchKey?: string;
  activeTool: string;
  /** Called for every lens or area change; the owner mounts the tool on first visit. */
  onToolChange: (toolId: string) => void;
  onAreaChange?: (toolId: string) => void;
  chrome: ShellChrome;
  /** Live job status for the top bar; without one the bar says plainly that status is not evaluated. */
  statusIndicator?: ReactNode;
  children: ReactNode;
};

export function AppShell({ projectName, recordName, permissions, role = null, libraryScope = false, extraActions = NO_ACTIONS, itemSearchKey, activeTool, onToolChange, onAreaChange, chrome, statusIndicator, children }: SbShellProps) {
  const area = areaOfTool(activeTool);
  const visibleTools = primaryTools(area);
  const advanced = area.tools.filter(tool => !visibleTools.some(item => item.id === tool.id) && !["designs", "library-home", "history"].includes(tool.id) && !tool.id.startsWith("new-"));
  const wide = useMediaQuery(`(min-width: ${breakpoints.lg}px)`, false, { getInitialValueInEffect: false });
  const narrow = useMediaQuery(`(max-width: ${breakpoints.sm - 1}px)`, false, { getInitialValueInEffect: false });
  // The top bar switches to its compact form (project menu, account menu) before the area rail disappears.
  const compact = useMediaQuery("(max-width: 959px)", false, { getInitialValueInEffect: false });

  function openArea(target: AreaDef) {
    (onAreaChange ?? onToolChange)(target.tools[0]?.id ?? activeTool);
  }
  const openAreaRef = useRef(openArea);
  openAreaRef.current = openArea;

  // Keys 1-9 jump between areas unless the user is typing or a dialog is open.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = AREAS.find((item) => item.key === event.key);
      if (!target) return;
      const origin = event.target instanceof Element ? event.target : null;
      if (origin?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox'], [role='combobox'], [role='dialog'], [role='menu']")) return;
      event.preventDefault();
      openAreaRef.current(target);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toolActions = useMemo<SpotlightActionGroupData[]>(() => [
    { group: "Actions", actions: [{ id: "new-design", label: "Browse designs", description: "Find a cable, harness or device", onClick: () => (onAreaChange ?? onToolChange)("designs") }] },
    { group: "Areas and tools", actions: AREAS.flatMap(item => [
      { id: `area:${item.id}`, label: item.label, description: `Area ${item.key}`, onClick: () => openAreaRef.current(item) },
      ...item.tools.filter(tool => tool.id !== item.tools[0]?.id).map(tool => ({ id: `tool:${tool.id}`, label: tool.label, description: item.label, onClick: () => onToolChange(tool.id) })),
    ]) },
  ], [onToolChange]);
  const actions = useMemo<(SpotlightActionData | SpotlightActionGroupData)[]>(() => [...extraActions, ...toolActions], [toolActions, extraActions]);

  const access = describeAccess(permissions, role);
  const railWidth = narrow ? 0 : wide ? rail.expanded : rail.collapsed;

  return <MantineAppShell header={{ height: topBarHeight }} footer={{ height: STATUS_LINE_HEIGHT }}
    navbar={{ width: railWidth, breakpoint: 0 }} padding={0}>
    <MantineAppShell.Header className="sb-header" data-testid="sb-top-bar">
      <div className="sb-topbar">
        {narrow && <AreaMenu activeArea={area} onSelect={openArea} />}
        <Brand compact={narrow} onHome={() => (onAreaChange ?? onToolChange)("designs")} />
        <nav aria-label="Breadcrumb" className="sb-shell-breadcrumb"><span>{area.label}</span>{(recordName || activeTool !== area.tools[0]?.id) && <><span aria-hidden="true">/</span><span>{recordName ?? toolLabel(activeTool)}</span></>}</nav>
        {!narrow && chrome.projectMenu}
        <button type="button" className="sb-search" data-compact={compact} onClick={() => spotlight.open()} aria-label={itemSearchKey ? "Find an item or jump to a tool" : "Jump to a tool or area"} aria-keyshortcuts="Control+K">
          <span className="sb-mono" aria-hidden="true" style={{ color: "var(--sb-accent)" }}>›</span>
          {!compact && <span className="sb-search-hint">find an item, tool or area</span>}
          {!compact && <span className="sb-keycap" aria-hidden="true">Ctrl K</span>}
          {compact && <span className="sb-keycap" aria-hidden="true">K</span>}
        </button>
        {advanced.length > 0 && <Menu position="bottom-end" withinPortal><Menu.Target><Button variant="quiet" size="xs" aria-label={`${area.label} advanced tools`}>Advanced</Button></Menu.Target><Menu.Dropdown mah={480} style={{ overflowY: "auto" }}><Menu.Label>Workspace tools</Menu.Label>{advanced.map(tool => <Menu.Item key={tool.id} onClick={() => onToolChange(tool.id)}>{tool.label}</Menu.Item>)}</Menu.Dropdown></Menu>}
        <span style={{ flex: 1 }} />
        {!narrow && (statusIndicator ?? <span className="sb-status" role="status" aria-label="Job status">
          <span className="sb-led" data-state="not-evaluated" aria-hidden="true" />
          <span className="sb-silk">Status not evaluated</span>
        </span>)}
        <ThemeControl />
        {chrome.accountMenu ? chrome.accountMenu : <Group gap={6} wrap="nowrap" aria-label="Account">
          <span className="sb-account" title={chrome.username}><VisuallyHidden>Signed in as {chrome.username}</VisuallyHidden><span aria-hidden="true">{chrome.username}</span></span>
          {chrome.signOutControl}
        </Group>}
      </div>
    </MantineAppShell.Header>

    {!narrow && <MantineAppShell.Navbar className="sb-navbar">
      <nav aria-label="Workspace" className="sb-rail" data-collapsed={!wide}>
        {wide && <div className="sb-rail-title sb-silk">Workspace</div>}
        {AREAS.map((item) => <button key={item.id} type="button" className="sb-rail-item" title={`${item.label} (${item.key})`}
          aria-label={item.label} aria-keyshortcuts={item.key} aria-current={item.id === area.id ? "page" : undefined} onClick={() => openArea(item)}>
          {wide ? <><span>{item.label}</span><span className="sb-rail-key" aria-hidden="true">{item.key}</span></> : <span aria-hidden="true">{item.label.slice(0, 2).toUpperCase()}</span>}
        </button>)}
      </nav>
    </MantineAppShell.Navbar>}

    <MantineAppShell.Main className="sb-main">
      {chrome.alert && <div className="sb-view" style={{ paddingTop: 8 }}>{chrome.alert}</div>}
      <Tabs keepMountedMode="display-none" value={activeTool} className="sb-view" onChange={(value) => { if (value) onToolChange(value); }}>
        {visibleTools.length > 0 && <Tabs.List aria-label={`${area.label} sections`} className="sb-shell-tabs">
          {area.id === "library" && <Tabs.Tab value="library-home">Home</Tabs.Tab>}
          {visibleTools.map(tool => <Tabs.Tab key={tool.id} value={tool.id}>{tool.label}</Tabs.Tab>)}
        </Tabs.List>}
        {children}
      </Tabs>
    </MantineAppShell.Main>

    <MantineAppShell.Footer className="sb-footer">
      <div className="sb-statusline" data-testid="sb-status-line">
        <Text component="span" className="sb-silk">Ctrl K jump</Text>
        <Text component="span" className="sb-silk">1-9 sections</Text>
        <span className="sb-spacer" />
        <Text component="span" className="sb-silk">{access.label}{!libraryScope ? ` · ${projectName}` : ""}</Text>
      </div>
    </MantineAppShell.Footer>

    {itemSearchKey
      ? <ItemSpotlight principalKey={itemSearchKey} toolActions={toolActions} extraActions={extraActions}
        placeholder={extraActions.length ? "Find an item, or jump to an area, tool or project" : "Find an item, or jump to an area or tool"} />
      : <Spotlight actions={actions} shortcut="mod + K" nothingFound="No matching area or tool" highlightQuery
        searchProps={{ placeholder: extraActions.length ? "Jump to an area, tool or project" : "Jump to an area or tool", "aria-label": "Jump to an area or tool" }} />}
  </MantineAppShell>;
}

function AreaMenu({ activeArea, onSelect }: { activeArea: AreaDef; onSelect: (area: AreaDef) => void }) {
  const [opened, setOpened] = useState(false);
  return <nav aria-label="Workspace"><Menu opened={opened} onChange={setOpened} position="bottom-start" withinPortal>
    <Menu.Target><Button variant="quiet" aria-label="Workspace navigation" styles={{ label: { maxWidth: 76, overflow: "hidden", textOverflow: "ellipsis", display: "block" } }}>{activeArea.label}</Button></Menu.Target>
    <Menu.Dropdown>
      {AREAS.map((item) => <Menu.Item key={item.id} aria-current={item.id === activeArea.id ? "page" : undefined}
        rightSection={<span className="sb-silk">{item.key}</span>} onClick={() => onSelect(item)}
        style={item.id === activeArea.id ? { color: "var(--sb-accent)" } : undefined}>{item.label}</Menu.Item>)}
    </Menu.Dropdown>
  </Menu></nav>;
}
