import { AppShell, Button, Group, Menu, Tabs, Text, VisuallyHidden } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { Spotlight, spotlight, type SpotlightActionData, type SpotlightActionGroupData } from "@mantine/spotlight";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { breakpoints, rail, topBarHeight } from "../../theme/schematicBench";
import type { ShellChrome } from "../workspace";
import { AREAS, areaOfTool, describeAccess, toolLabel, type AreaDef } from "./areas";

const STATUS_LINE_HEIGHT = 24;
const NO_ACTIONS: SpotlightActionGroupData[] = [];

type SbShellProps = {
  /** The current scope's name: "Library" or the project's name. */
  projectName: string;
  /** Workspace permissions; they apply at every scope. */
  permissions: string[];
  /** Workspace role as reported by the server. */
  role?: string | null;
  /** True at Library scope (no project context). */
  libraryScope?: boolean;
  /** Extra palette entries, e.g. switching scope. */
  extraActions?: SpotlightActionGroupData[];
  activeTool: string;
  /** Called for every lens or area change; the owner mounts the tool on first visit. */
  onToolChange: (toolId: string) => void;
  chrome: ShellChrome;
  /** Live job status for the top bar; without one the bar says plainly that status is not evaluated. */
  statusIndicator?: ReactNode;
  children: ReactNode;
};

export function SbShell({ projectName, permissions, role = null, libraryScope = false, extraActions = NO_ACTIONS, activeTool, onToolChange, chrome, statusIndicator, children }: SbShellProps) {
  const area = areaOfTool(activeTool);
  const wide = useMediaQuery(`(min-width: ${breakpoints.lg}px)`, false, { getInitialValueInEffect: false });
  const narrow = useMediaQuery(`(max-width: ${breakpoints.sm - 1}px)`, false, { getInitialValueInEffect: false });
  // The top bar switches to its compact form (project menu, account menu) before the area rail disappears.
  const compact = useMediaQuery("(max-width: 959px)", false, { getInitialValueInEffect: false });
  const lastTool = useRef<Record<string, string>>({});
  lastTool.current[area.id] = activeTool;

  function openArea(target: AreaDef) {
    onToolChange(lastTool.current[target.id] ?? target.tools[0]?.id ?? activeTool);
  }
  const openAreaRef = useRef(openArea);
  openAreaRef.current = openArea;

  // Keys 1-7 jump between areas unless the user is typing or a dialog is open.
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

  const actions = useMemo<(SpotlightActionData | SpotlightActionGroupData)[]>(() => [
    { group: "Areas", actions: AREAS.map((item) => ({
      id: `area:${item.id}`, label: item.label, description: `Area ${item.key} · ${item.tools.length} tools`,
      onClick: () => openAreaRef.current(item),
    })) },
    ...AREAS.map((item) => ({ group: item.label, actions: item.tools.map((tool) => ({
      id: `tool:${tool.id}`, label: tool.label, description: `${item.label} area`,
      onClick: () => onToolChange(tool.id),
    })) })),
    ...extraActions,
  ], [onToolChange, extraActions]);

  const access = describeAccess(permissions, role);
  const railWidth = narrow ? 0 : wide ? rail.expanded : rail.collapsed;

  return <AppShell header={{ height: topBarHeight }} footer={{ height: STATUS_LINE_HEIGHT }}
    navbar={{ width: railWidth, breakpoint: 0 }} padding={0}>
    <AppShell.Header className="sb-header" data-testid="sb-top-bar">
      <div className="sb-topbar">
        {narrow && <AreaMenu activeArea={area} onSelect={openArea} />}
        {!narrow && <span className="sb-wordmark">SPECMATE</span>}
        {!compact && chrome.projectControl}
        {compact && (chrome.projectMenu ?? <span className="sb-project-button"><span className="sb-project-name">{projectName}</span></span>)}
        <button type="button" className="sb-search" data-compact={compact} onClick={() => spotlight.open()} aria-label="Jump to a tool or area" aria-keyshortcuts="Control+K">
          <span className="sb-mono" aria-hidden="true" style={{ color: "var(--sb-accent)" }}>›</span>
          {!compact && <span className="sb-search-hint">jump, search or command</span>}
          {!compact && <span className="sb-keycap" aria-hidden="true">Ctrl K</span>}
          {compact && <span className="sb-keycap" aria-hidden="true">K</span>}
        </button>
        <span style={{ flex: 1 }} />
        {!narrow && (statusIndicator ?? <span className="sb-status" role="status" aria-label="Job status">
          <span className="sb-led" data-state="not-evaluated" aria-hidden="true" />
          <span className="sb-silk">Status not evaluated</span>
        </span>)}
        {compact && chrome.accountMenu ? chrome.accountMenu : <Group gap={6} wrap="nowrap" aria-label="Account">
          <span className="sb-account" title={chrome.username}><VisuallyHidden>Signed in as {chrome.username}</VisuallyHidden><span aria-hidden="true">{chrome.username}</span></span>
          {chrome.signOutControl}
        </Group>}
      </div>
    </AppShell.Header>

    {!narrow && <AppShell.Navbar className="sb-navbar">
      <nav aria-label="Areas" className="sb-rail" data-collapsed={!wide}>
        {wide && <div className="sb-rail-title sb-silk">Areas</div>}
        {AREAS.map((item) => <button key={item.id} type="button" className="sb-rail-item" title={`${item.label} (${item.key})`}
          aria-label={item.label} aria-keyshortcuts={item.key} aria-current={item.id === area.id ? "page" : undefined} onClick={() => openArea(item)}>
          {wide ? <><span>{item.label}</span><span className="sb-rail-key" aria-hidden="true">{item.key}</span></> : <span aria-hidden="true">{item.label.slice(0, 2).toUpperCase()}</span>}
        </button>)}
      </nav>
    </AppShell.Navbar>}

    <AppShell.Main className="sb-main">
      <section aria-label="Context"><dl className="sb-context">
        <Cell label={libraryScope ? "Scope" : "Project"} value={projectName} selected={libraryScope} />
        <Cell label="Area" value={area.label} />
        <Cell label="Tool" value={toolLabel(activeTool)} selected={!libraryScope} />
        <Cell label="Your role" value={access.label} unknown={!access.known} />
      </dl></section>
      {chrome.alert && <div className="sb-view" style={{ paddingTop: 8 }}>{chrome.alert}</div>}
      <Tabs keepMountedMode="display-none" value={activeTool} className="sb-view" onChange={(value) => { if (value) onToolChange(value); }}>
        <Tabs.List aria-label={`${area.label} tools`} style={{ marginInline: -16, paddingInline: 16 }}>
          {area.tools.map((tool) => <Tabs.Tab key={tool.id} value={tool.id}>{tool.label}</Tabs.Tab>)}
        </Tabs.List>
        {children}
      </Tabs>
    </AppShell.Main>

    <AppShell.Footer className="sb-footer">
      <div className="sb-statusline" data-testid="sb-status-line">
        <Text component="span" className="sb-silk">Ctrl K jump</Text>
        <Text component="span" className="sb-silk">1-7 areas</Text>
        <span className="sb-spacer" />
        <Text component="span" className="sb-silk">{`${projectName} / ${area.label} / ${toolLabel(activeTool)}`}</Text>
      </div>
    </AppShell.Footer>

    <Spotlight actions={actions} shortcut="mod + K" nothingFound="No matching area or tool" highlightQuery
      searchProps={{ placeholder: extraActions.length ? "Jump to an area, tool or project" : "Jump to an area or tool", "aria-label": "Jump to an area or tool" }} />
  </AppShell>;
}

function Cell({ label, value, selected = false, unknown = false }: { label: string; value: string; selected?: boolean; unknown?: boolean }) {
  return <div className={`sb-cell${unknown ? " sb-hatch" : ""}`} data-selected={selected}>
    <dt className="sb-silk">{label}</dt>
    <dd data-unknown={unknown} title={value}>{value}</dd>
  </div>;
}

function AreaMenu({ activeArea, onSelect }: { activeArea: AreaDef; onSelect: (area: AreaDef) => void }) {
  const [opened, setOpened] = useState(false);
  return <nav aria-label="Areas"><Menu opened={opened} onChange={setOpened} position="bottom-start" withinPortal>
    <Menu.Target><Button variant="quiet" aria-label="Areas menu">{activeArea.label}</Button></Menu.Target>
    <Menu.Dropdown>
      {AREAS.map((item) => <Menu.Item key={item.id} aria-current={item.id === activeArea.id ? "page" : undefined}
        rightSection={<span className="sb-silk">{item.key}</span>} onClick={() => onSelect(item)}
        style={item.id === activeArea.id ? { color: "var(--sb-accent)" } : undefined}>{item.label}</Menu.Item>)}
    </Menu.Dropdown>
  </Menu></nav>;
}
