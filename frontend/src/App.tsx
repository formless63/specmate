import { PermissionsProvider } from "./lib/permissions";
import { Alert, Button, Group, Modal, Stack, Tabs, Text } from "@mantine/core";
import type { SpotlightActionGroupData } from "@mantine/spotlight";
import { Component, Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { DesignList } from "./features/designs/DesignList";
import { useNavigation } from "./features/navigation";
import { toolForKind, toolForReference } from "./features/shell/scope";
import { requestJson } from "./features/workspace/api";
import { StatusIndicator } from "./features/diagnostics/StatusIndicator";
import { WorkspaceHome } from "./features/home/WorkspaceHome";
import { ProjectOverview } from "./features/overview/ProjectOverview";
import { ChooseProject } from "./features/scope/ChooseProject";
import { RecordFocusContext, type RecordFocus } from "./features/scope/focus";
import { ExactRevisionNotice } from "./features/scope/exactRevision";
import { EditingLens } from "./features/scope/EditingLens";
import { LibraryList, LibrarySections, TYPED_LIBRARY_VIEWS } from "./components/library/LibraryList";
import { LibraryView } from "./features/scope/LibraryView";
import { NavigationProvider, useWorkspaceUrl } from "./features/navigation";
import { ProbeInspector, ProbeProvider } from "./features/probe";
import { AREAS, SbShell, areaOfTool } from "./features/shell";
import { libraryView } from "./features/shell/scope";
import { WorkspaceShell, type LibraryRecord, type ShellChrome, type WorkspaceScope } from "./features/workspace";

const SelectedDefinitionViews = lazy(() => import("./features/cable-views/SelectedDefinitionViews").then(module => ({ default: module.SelectedDefinitionViews })));
const BuildsPanel = lazy(() => import("./features/builds/BuildsPanel").then((module) => ({ default: module.BuildsPanel })));
const AssemblyPanel = lazy(() => import("./features/assemblies/AssemblyPanel").then((module) => ({ default: module.AssemblyPanel })));
const AgentCapabilitiesPanel = lazy(() => import("./features/agent-capabilities/AgentCapabilitiesPanel").then((module) => ({ default: module.AgentCapabilitiesPanel })));
const AgentRunsPanel = lazy(() => import("./features/agent-runs/AgentRunsPanel").then((module) => ({ default: module.AgentRunsPanel })));
const RunnerPanel = lazy(() => import("./features/diagnostics/RunnerPanel").then(module => ({ default: module.RunnerPanel })));
const DiagnosticsPanel = lazy(() => import("./features/diagnostics/DiagnosticsPanel").then((module) => ({ default: module.DiagnosticsPanel })));
const ShareRecordsPanel = lazy(() => import("./features/project-access/ShareRecordsPanel").then((module) => ({ default: module.ShareRecordsPanel })));
const IntegrationsPanel = lazy(() => import("./features/integrations/IntegrationsPanel").then((module) => ({ default: module.IntegrationsPanel })));
const WorkspaceAccessPanel = lazy(() => import("./features/project-access/WorkspaceAccessPanel").then((module) => ({ default: module.WorkspaceAccessPanel })));
const IdentityPanel = lazy(() => import("./features/identity/IdentityPanel").then((module) => ({ default: module.IdentityPanel })));
const FactsPanel = lazy(() => import("./features/facts/FactsPanel").then((module) => ({ default: module.FactsPanel })));
const EvidencePanel = lazy(() => import("./features/evidence/EvidencePanel").then((module) => ({ default: module.EvidencePanel })));
const InterfacePanel = lazy(() => import("./features/interfaces/InterfacePanel").then((module) => ({ default: module.InterfacePanel })));
const PortPanel = lazy(() => import("./features/interfaces/PortPanel").then((module) => ({ default: module.PortPanel })));
const ConventionPanel = lazy(() => import("./features/interfaces/ConventionPanel").then((module) => ({ default: module.ConventionPanel })));
const SignalSetPanel = lazy(() => import("./features/interfaces/SignalSetPanel").then((module) => ({ default: module.SignalSetPanel })));
const InterfaceAssessmentPanel = lazy(() => import("./features/interfaces/InterfaceAssessmentPanel").then((module) => ({ default: module.InterfaceAssessmentPanel })));
const InventoryPanel = lazy(() => import("./features/inventory/InventoryPanel").then((module) => ({ default: module.InventoryPanel })));
const PcbPanel = lazy(() => import("./features/pcb/PcbPanel").then((module) => ({ default: module.PcbPanel })));
const IntentPanel = lazy(() => import("./features/intents/IntentPanel").then((module) => ({ default: module.IntentPanel })));
const EndAssemblyPanel = lazy(() => import("./features/end-assemblies/EndAssemblyPanel").then((module) => ({ default: module.EndAssemblyPanel })));
const BoardPanel = lazy(() => import("./features/boards/BoardPanel").then((module) => ({ default: module.BoardPanel })));
const WireStockPanel = lazy(() => import("./features/wire-stock/WireStockPanel").then((module) => ({ default: module.WireStockPanel })));
const WorkshopProfilePanel = lazy(() => import("./features/workshop-profiles/WorkshopProfilePanel").then((module) => ({ default: module.WorkshopProfilePanel })));
const PreferencesPanel = lazy(() => import("./features/preferences/PreferencesPanel").then((module) => ({ default: module.PreferencesPanel })));
const DiscoveryPanel = lazy(() => import("./features/discovery/DiscoveryPanel").then((module) => ({ default: module.DiscoveryPanel })));
const PhysicalUnitsPanel = lazy(() => import("./features/physical-units/PhysicalUnitsPanel").then((module) => ({ default: module.PhysicalUnitsPanel })));
const BomPanel = lazy(() => import("./features/bom/BomPanel").then((module) => ({ default: module.BomPanel })));
const CableRecordHost = lazy(() => import("./features/cables/CableRecordEditor").then(module => ({ default: module.CableRecordHost })));
const CablePanel = lazy(() => import("./features/cables/CablePanel").then((module) => ({ default: module.CablePanel })));
const MatchingWorkspace = lazy(() => import("./features/catalog-matching/MatchingWorkspace").then((module) => ({ default: module.MatchingWorkspace })));
const CatalogPacksWorkspace = lazy(() => import("./features/catalog-packs/CatalogPacksWorkspace").then((module) => ({ default: module.CatalogPacksWorkspace })));
const HarnessPanel = lazy(() => import("./features/harnesses/HarnessPanel").then((module) => ({ default: module.HarnessPanel })));
const CopperPanel = lazy(() => import("./features/copper/CopperPanel").then((module) => ({ default: module.CopperPanel })));
const RevisionUpgradeWorkspace = lazy(() => import("./features/revision-upgrades/RevisionUpgradeWorkspace").then((module) => ({ default: module.RevisionUpgradeWorkspace })));
const PcbDisagreementPanel = lazy(() => import("./features/pcb-disagreement/PcbDisagreementPanel").then((module) => ({ default: module.PcbDisagreementPanel })));

const PassivePassagesWorkspace = lazy(() => import("./features/passive-passages/PassivePassagesWorkspace").then((module) => ({ default: module.PassivePassagesWorkspace })));

const MaterialAccountingPanel = lazy(() => import("./features/material-accounting/MaterialAccountingPanel").then((module) => ({ default: module.MaterialAccountingPanel })));

const PreparationPanel = lazy(() => import("./features/preparation/PreparationPanel").then((module) => ({ default: module.PreparationPanel })));

const CableTestIntentPanel = lazy(() => import("./features/cable-test-intent/CableTestIntentPanel").then((module) => ({ default: module.CableTestIntentPanel })));

const EndPreparationPanel = lazy(() => import("./features/end-preparation/EndPreparationPanel").then((module) => ({ default: module.EndPreparationPanel })));

const SourcesPanel = lazy(() => import("./features/sources/SourcesPanel").then((module) => ({ default: module.SourcesPanel })));

const PrintingPanel = lazy(() => import("./features/printing/PrintingPanel").then((module) => ({ default: module.PrintingPanel })));
const SelectedPackagesPanel = lazy(() => import("./features/selected-packages/SelectedPackagesPanel").then((module) => ({ default: module.SelectedPackagesPanel })));
const ExportPackagesPanel = lazy(() => import("./features/export-packages/ExportPackagesPanel").then((module) => ({ default: module.ExportPackagesPanel })));
const ReleasesPanel = lazy(() => import("./features/releases/ReleasesPanel").then((module) => ({ default: module.ReleasesPanel })));
const FirmwarePanel = lazy(() => import("./features/firmware/FirmwarePanel").then((module) => ({ default: module.FirmwarePanel })));
const FirmwareOccurrencesPanel = lazy(() => import("./features/firmware-occurrences/FirmwareOccurrencesPanel").then((module) => ({ default: module.FirmwareOccurrencesPanel })));
const FirmwareImpactPanel = lazy(() => import("./features/firmware-impact/FirmwareImpactPanel").then((module) => ({ default: module.FirmwareImpactPanel })));
const ConfigurationsPanel = lazy(() => import("./features/configurations/ConfigurationsPanel").then((module) => ({ default: module.ConfigurationsPanel })));
const MechanicalSourcesPanel = lazy(() => import("./features/mechanical-sources/MechanicalSourcesPanel").then((module) => ({ default: module.MechanicalSourcesPanel })));
const SharedScenePanel = lazy(() => import("./features/shared-scene/SharedScenePanel").then((module) => ({ default: module.SharedScenePanel })));
const ContextualInspectionWorkspace = lazy(() => import("./features/context-selection/ContextualInspectionWorkspace").then((module) => ({ default: module.ContextualInspectionWorkspace })));
const CollaborationPanel = lazy(() => import("./features/collaboration/CollaborationPanel").then((module) => ({ default: module.CollaborationPanel })));
const KnowledgeSearchPanel = lazy(() => import("./features/knowledge/KnowledgeSearchPanel").then((module) => ({ default: module.KnowledgeSearchPanel })));
const KnowledgePanel = lazy(() => import("./features/knowledge/KnowledgePanel").then((module) => ({ default: module.KnowledgePanel })));
const PreparationDocumentsPanel = lazy(() => import("./features/preparation-documents/PreparationDocumentsPanel").then((module) => ({ default: module.PreparationDocumentsPanel })));
const MechanicalProposalsPanel = lazy(() => import("./features/mechanical-proposals/MechanicalProposalsPanel").then((module) => ({ default: module.MechanicalProposalsPanel })));
const LibraryHome = lazy(() => import("./features/library-gallery/LibraryHome").then((module) => ({ default: module.LibraryHome })));
const SceneDrawingsPanel = lazy(() => import("./features/scene-drawings/SceneDrawingsPanel").then((module) => ({ default: module.SceneDrawingsPanel })));

export function App() {
  return <NavigationProvider><WorkspaceShell>{(scope) => <ScopedWorkspace scope={scope} />}</WorkspaceShell></NavigationProvider>;
}

const ALL_TOOLS = AREAS.flatMap((area) => area.tools);

/**
 * The one shell for a signed-in member. The selected area and lens survive scope changes;
 * workspace editors retain state while project filters and pages change. Only a change in
 * session/workspace authority discards private reads and editor state.
 * Area, lens, project context and the probe (shared selection) live in the URL.
 */
function ScopedWorkspace({ scope }: { scope: WorkspaceScope }) {
  const url = useWorkspaceUrl(scope);
  const navigation = useNavigation();
  const selected = useQuery({ queryKey: ["workspace", "route-record", scope.principalKey, url.probe?.object],
    queryFn: () => requestJson<LibraryRecord>(`/api/v0/workspace/library/${encodeURIComponent(url.probe!.object)}`),
    enabled: !!url.probe, retry: false });
  // Record URLs name the item, not its implementation panel. Resolve the kind using current authority.
  const recordTool = !selected.isError && selected.data && url.probe?.object === selected.data.record_id
    ? selected.data.family === "definition" ? toolForKind(selected.data.kind)
      : ({ source_bundle: "sources", stock_account: "inventory", physical_unit: "physical-units", fact_subject: "facts" } as Record<string, string>)[selected.data.family] ?? "identity"
    : null;
  const active = url.probe && ["designs", "identity"].includes(url.lens) && recordTool ? recordTool : url.lens;
  useEffect(() => {
    if (url.lens === "identity" && recordTool && recordTool !== "identity") navigation?.navigate({ area: areaOfTool(recordTool).id, lens: recordTool }, { replace: true });
  }, [url.lens, recordTool, navigation]);
  useEffect(() => {
    if (url.lens === "discovery") { void import("@mantine/spotlight").then(module => module.spotlight.open()); }
  }, [url.lens]);
  const [focus, setFocus] = useState<RecordFocus | null>(null);
  const [createKeys, setCreateKeys] = useState<Record<string, number>>({});
  const [replaceCreate, setReplaceCreate] = useState<string | null>(null);
  const [statusTick, setStatusTick] = useState(0);
  const [upgradeProposalId, setUpgradeProposalId] = useState<string | null>(null);
  const [retainedNotesProject, setRetainedNotesProject] = useState<string | null>(null);
  const notesProject = active === "knowledge" ? navigation?.location.project ?? null : retainedNotesProject;
  useEffect(() => {
    if (active === "knowledge") setRetainedNotesProject(navigation?.location.project ?? null);
  }, [active, navigation?.location.project]);
  const scopeKey = scope.authorityKey;
  const [visited, setVisited] = useState(() => ({ key: scopeKey, tools: new Set([active]) }));
  // A new scope mounts only the lens in view; other lenses mount on first visit again.
  const tools = visited.key === scopeKey ? visited.tools : new Set([active]);
  if (visited.key !== scopeKey || !tools.has(active)) setVisited({ key: scopeKey, tools: new Set([...tools, active]) });
  // Opening any tool (from an area, a lens, the command palette or a deep link) mounts it once and keeps it mounted while hidden.
  const { openLens } = url;
  const setActive = useCallback((value: string) => {
    openLens(value);
    setVisited((current) => current.tools.has(value) ? current : { key: current.key, tools: new Set([...current.tools, value]) });
  }, [openLens]);
  const { selectProject } = scope;
  const changeScope = useCallback((projectId: string | null) => { setFocus(null); selectProject(projectId); }, [selectProject]);
  const { openInProject: openUrlInProject } = url;
  const openInProject = useCallback((projectId: string, toolId: string, record?: LibraryRecord) => {
    setFocus(record ? { projectId, toolId, record } : null);
    openUrlInProject(projectId, toolId, record?.record_id);
  }, [openUrlInProject]);
  const scopeActions = useMemo<SpotlightActionGroupData[]>(() => [{ group: "Projects", actions: [
    { id: "scope:library", label: "Library", description: "Whole workspace library", onClick: () => changeScope(null) },
    ...scope.projects.filter((project) => !project.archived).map((project) => ({ id: `scope:${project.project_id}`, label: project.name, description: "Open project", onClick: () => openUrlInProject(project.project_id, "overview") })),
  ] }], [scope.projects, changeScope, openUrlInProject]);
  const openCreate = (kind: "cable" | "harness" | "assembly") => {
    const tool = `new-${kind}`;
    if (tools.has(tool)) { setReplaceCreate(tool); return; }
    navigation?.navigate({ area: "designs", lens: tool, project: null, probe: null });
  };
  const activeFocus = focus && focus.projectId === scope.projectId ? focus : null;
  // Cable record frames already name their exact state; keep the global summary for other tools.
  const showProbe = url.malformed || (!!url.probe && recordTool !== "cables");
  const chrome: ShellChrome = !activeFocus && !url.projectLost && !showProbe ? scope.chrome : { ...scope.chrome, alert: <>
    {scope.chrome.alert}
    {url.projectLost && <ProjectLostNote onDismiss={url.dismissProjectLost} />}
    {activeFocus && <FocusNote focus={activeFocus} onDismiss={() => setFocus(null)} />}
    {showProbe && <ProbeInspector principalKey={scope.principalKey} projectId={scope.projectId} malformed={url.malformed} />}
  </> };

  return <PermissionsProvider permissions={scope.permissions}><ProbeProvider probe={url.probe} onProbe={url.setProbe}>
    <SbShell recordName={!selected.isError && active === recordTool ? selected.data?.label : undefined} projectName={scope.project?.name ?? "Library"} permissions={scope.permissions} role={scope.role} libraryScope={!scope.project}
      activeTool={active} onToolChange={setActive} onAreaChange={tool => navigation?.navigate({ area: areaOfTool(tool).id, lens: tool, project: null, probe: null })} chrome={chrome} extraActions={scopeActions} itemSearchKey={scope.principalKey}
      statusIndicator={scope.projectId ? <StatusIndicator workspaceId={scope.workspaceId} refreshKey={statusTick} onOpen={() => setActive("diagnostics")} /> : undefined}>
      <Fragment key={scopeKey}><RecordFocusContext.Provider value={activeFocus}>
        <ToolPanel value="designs">{tools.has("designs") && (url.probe ? <Text role="status">{selected.isError ? "This design is not available." : "Opening design…"}</Text> : <DesignList onAccessLost={scope.refresh} active={active === "designs"} principalKey={scope.principalKey} projectFilterId={navigation?.location.project ?? null} projects={scope.projects}
          onOpen={record => navigation?.navigate({ area: "designs", lens: toolForKind(record.kind), project: null, probe: { object: record.record_id, rev: null, path: [] } })}
          onCreate={openCreate} />)}</ToolPanel>
        <ToolPanel value="history">{tools.has("history") && <Stack><Text component="h1" fw={600}>History</Text><Text>Workspace change history is not available yet. Open a record to inspect its retained revisions.</Text></Stack>}</ToolPanel>
        {ALL_TOOLS.filter(tool => !["designs", "history"].includes(tool.id)).map(tool => <ToolPanel key={tool.id} value={tool.id}>
          {tools.has(tool.id) && <LibraryTool key={createKeys[tool.id] ?? 0} toolId={tool.id} toolLabel={tool.label} record={selected.isError ? undefined : selected.data} scope={scope} onOpenInProject={openInProject}
            lens={{ scope, projectId: tool.id === "knowledge" ? notesProject : null, active, setActive, onStatusChanged: () => setStatusTick(n => n + 1), upgradeProposalId, setUpgradeProposalId }} />}
        </ToolPanel>)}
      </RecordFocusContext.Provider></Fragment>
    </SbShell>
    <Modal opened={replaceCreate !== null} onClose={() => setReplaceCreate(null)} title="Start another design?" centered>
      <Stack><Text>The existing creation form will be replaced. Keep it to preserve any unsaved changes.</Text><Group justify="flex-end"><Button variant="quiet" onClick={() => { if (replaceCreate) navigation?.navigate({ area: "designs", lens: replaceCreate, project: null, probe: null }); setReplaceCreate(null); }}>Keep existing form</Button><Button onClick={() => { if (replaceCreate) { setCreateKeys(current => ({ ...current, [replaceCreate]: (current[replaceCreate] ?? 0) + 1 })); navigation?.navigate({ area: "designs", lens: replaceCreate, project: null, probe: null }); } setReplaceCreate(null); }}>Start new</Button></Group></Stack>
    </Modal>
  </ProbeProvider></PermissionsProvider>;
}

function ProjectLostNote({ onDismiss }: { onDismiss: () => void }) {
  return <div className="sb-focus-note" role="status">
    <span className="sb-dash-row-title">The project in this link is not available. You are in the Library.</span>
    <span style={{ flex: 1 }} />
    <Button variant="quiet" size="xs" onClick={onDismiss}>Dismiss</Button>
  </div>;
}

function FocusNote({ focus, onDismiss }: { focus: RecordFocus; onDismiss: () => void }) {
  const { record } = focus;
  const identity = [record.kind?.replaceAll("_", " "), record.latest_revision !== null ? `r${record.latest_revision}` : null].filter(Boolean).join(" · ");
  return <div className="sb-focus-note" role="status">
    <span className="sb-silk">Opened from the library</span>
    <span className="sb-dash-row-title">{record.label}</span>{identity && <span className="sb-mono sb-dash-note">{identity}</span>}
    <span style={{ flex: 1 }} />
    <Button variant="quiet" size="xs" onClick={onDismiss}>Dismiss</Button>
  </div>;
}

/** A lens at Library scope: the project list, workspace access, the lens's library, or an inline project chooser. */
function LibraryTool({ toolId, toolLabel, record, scope, onOpenInProject, lens }: { record?: LibraryRecord; toolId: string; toolLabel: string; scope: WorkspaceScope; onOpenInProject: (projectId: string, toolId: string, record?: LibraryRecord) => void; lens: LensContext }) {
  const navigation = useNavigation();
  if (toolId.startsWith("new-")) return <ProbeProvider probe={null} onProbe={() => {}}><LensEditor toolId={{ "new-cable": "cables", "new-harness": "harnesses", "new-assembly": "assemblies" }[toolId] ?? "cables"} scope={scope} projectId={null} active={lens.active} /></ProbeProvider>;
  if (toolId === "overview" && scope.project && scope.projectId) return <ProjectOverview key={scope.projectId} projectId={scope.projectId} projectName={scope.project.name} workspaceId={scope.workspaceId} permissions={scope.permissions} role={scope.role} active={lens.active === "overview"} onOpenTool={lens.setActive} onOpenReference={ref => {
    const tool = toolForReference(ref.kind, ref.item_kind);
    if (ref.kind === "release" || ref.kind === "work_batch") {
      navigation?.navigate({ area: areaOfTool(tool).id, lens: tool, project: null, probe: null, filters: { [ref.kind]: ref.target_id } });
      return;
    }
    const object = ref.definition_id ?? ref.target_id;
    navigation?.navigate({ area: areaOfTool(tool).id, lens: tool, project: null, filters: {}, probe: { object, rev: ref.pin === "exact" ? ref.revision : null, path: [] } });
  }} onAccessLost={scope.refresh} onProjectChanged={scope.refresh} onLeave={() => scope.selectProject(null)} />;
  if (toolId === "overview") {
    return <WorkspaceHome username={scope.username} role={scope.role} permissions={scope.permissions} projects={scope.projects} lastProjectId={scope.lastProjectId}
      busy={scope.busy} onOpen={(projectId) => onOpenInProject(projectId, toolId)} onCreate={scope.createProject} onChanged={scope.refresh} />;
  }
  if (toolId === "runner") return <RunnerPanel onAccessLost={scope.refresh} workspaceId={scope.workspaceId} principalKey={scope.principalKey} active={lens.active === "runner"} />;
  if (toolId === "library-home") return <LibraryHome principalKey={scope.principalKey} />;
  if (toolId === "access") return <Stack><WorkspaceAccessPanel onAccessChanged={scope.refresh} /><ShareRecordsPanel workspaceId={scope.workspaceId} /></Stack>;
  if (toolId === "integrations") return <IntegrationsPanel workspaceId={scope.workspaceId} />;
  if (toolId === "cables") return <CableRecordHost principalKey={scope.principalKey} record={record?.kind === "cable" ? record : undefined} workspaceId={scope.workspaceId} active={lens.active === "cables"} />;
  if (["harnesses", "assemblies"].includes(toolId)) return <Stack>
    {record && ["cable", "harness"].includes(record.kind ?? "") && toolForKind(record.kind) === toolId && <SelectedDefinitionViews key={record.record_id} record={record} />}
    <LensEditor toolId={toolId} scope={scope} projectId={null} active={lens.active} />
  </Stack>;
  // Make panels own their lists and purpose-specific exact selections.
  if (["inventory", "physical-units", "material-accounting", "bom"].includes(toolId)) return <LensEditor toolId={toolId} scope={scope} projectId={null} active={lens.active} />;
  const view = TYPED_LIBRARY_VIEWS[toolId] ?? libraryView(toolId);
  // Workspace-level lenses work without a project: the workspace comes from the shell scope.
  if (!view && WORKSPACE_LENSES.has(toolId)) return <Stack><LibrarySections toolId={toolId} /><WorkspaceLens {...lens} toolId={toolId} /></Stack>;
  // The Library is where items are created and edited: each collection lens mounts its editor without a project.
  if (view) {
    if (toolId === "kits") return <LibraryList toolId={toolId} projectFilterId={navigation?.location.project ?? null} projects={scope.projects} principalKey={scope.principalKey} onOpenInProject={(projectId, record) => onOpenInProject(projectId, toolId, record)} />;
    return <Stack gap="lg">{view.family === "definition" && <ExactRevisionNotice />}<EditingLens title={view.title} editor={<LensEditor toolId={toolId} scope={scope} projectId={null} active={lens.active} />}
      list={(editor) => TYPED_LIBRARY_VIEWS[toolId] ? <LibraryList toolId={toolId} projectFilterId={navigation?.location.project ?? null} projects={scope.projects} principalKey={scope.principalKey}
        onOpenInProject={(projectId, record) => onOpenInProject(projectId, toolId, record)} editor={editor} /> : <LibraryView view={view} toolLabel={toolLabel} projectId={navigation?.location.project ?? null} project={scope.projects.find(project => project.project_id === navigation?.location.project) ?? null} projects={scope.projects} principalKey={scope.principalKey}
        onOpenInProject={(projectId, record) => onOpenInProject(projectId, toolId, record)} editor={editor} />} /></Stack>;
  }
  return <Text role="status">This tool is not available.</Text>;
}

/** Lenses whose data lives in the workspace; a project is optional context, never a requirement. */
const WORKSPACE_LENSES = new Set(["knowledge", "agent-capabilities", "agent-runs", "preferences", "diagnostics", "discovery", "revision-upgrades", "matching", "catalog-packs", "firmware-impact",
  "mechanical-proposals", "builds", "evidence-kinds", "shared-scene", "context-selection", "scene-drawings", "preparation-documents", "selected-packages", "export-packages", "copper", "releases", "printing"]);

type LensContext = {
  scope: WorkspaceScope; projectId: string | null; active: string; setActive: (value: string) => void; onStatusChanged: () => void;
  upgradeProposalId: string | null; setUpgradeProposalId: (id: string | null) => void;
};

/** One workspace-level lens, mounted at Library scope (projectId null) or inside a project (projectId as context). */
function WorkspaceLens({ toolId, scope, projectId, active, setActive, onStatusChanged, upgradeProposalId, setUpgradeProposalId }: LensContext & { toolId: string }) {
  const { principalKey, workspaceId } = scope;
  const navigation = useNavigation();
  const onAccessChanged = scope.refresh;
  const optional = projectId ?? undefined;
  switch (toolId) {
    case "knowledge": return !projectId ? <ChooseProject toolLabel="Notes & files" projects={scope.projects} lastProjectId={scope.lastProjectId} onChoose={project => navigation?.navigate({ area: "projects", lens: "knowledge", project, probe: null, filters: {} })} /> : <Stack><KnowledgePanel target={{ kind: "project", project_id: projectId }} workspaceId={workspaceId} projectId={optional} principalKey={principalKey} onAccessLost={onAccessChanged} /><KnowledgeSearchPanel workspaceId={workspaceId} projectId={optional} principalKey={principalKey} active={active === "knowledge"} /><CollaborationPanel projectId={projectId} principalKey={principalKey} active={active === "knowledge"} onAccessLost={onAccessChanged} onOpenUpgrade={(id) => { setUpgradeProposalId(id); setActive("revision-upgrades"); }} /></Stack>;
    case "agent-capabilities": return <AgentCapabilitiesPanel workspaceId={workspaceId} projectId={projectId} />;
    case "agent-runs": return <AgentRunsPanel onAccessLost={onAccessChanged} active={active === "agent-runs"} workspaceId={workspaceId} projectId={projectId} username={scope.username} principalKey={principalKey} />;
    case "preferences": return <PreferencesPanel workspaceId={workspaceId} />;
    case "diagnostics": return <DiagnosticsPanel workspaceId={workspaceId} active={active === "diagnostics"} onChanged={onStatusChanged} />;
    case "discovery": return <DiscoveryPanel projectId={projectId} />;
    case "revision-upgrades": return <RevisionUpgradeWorkspace projectId={projectId} principalKey={principalKey} active={active === "revision-upgrades"} initialProposalId={upgradeProposalId} />;
    case "matching": return <MatchingWorkspace projectId={projectId} />;
    case "catalog-packs": return <CatalogPacksWorkspace projectId={projectId} />;
    case "firmware-impact": return <FirmwareImpactPanel workspaceId={workspaceId} />;
    case "mechanical-proposals": return <MechanicalProposalsPanel workspaceId={workspaceId} principalKey={principalKey} />;
    case "builds": return <BuildsPanel onAccessLost={onAccessChanged} workspaceId={workspaceId} principalKey={principalKey} active={active === "builds"} />;
    case "evidence-kinds": return <EvidencePanel workspaceId={workspaceId} projectId={optional} />;
    case "shared-scene": return <SharedScenePanel projectId={projectId} />;
    case "context-selection": return <ContextualInspectionWorkspace projectId={projectId} principalKey={principalKey} />;
    case "scene-drawings": return <SceneDrawingsPanel projectId={projectId} principalKey={principalKey} active={active === "scene-drawings"} />;
    case "preparation-documents": return <PreparationDocumentsPanel projectId={projectId} principalKey={principalKey} active={active === "preparation-documents"} onAccessLost={onAccessChanged} />;
    case "selected-packages": return <SelectedPackagesPanel projectId={projectId} />;
    case "export-packages": return <ExportPackagesPanel projectId={projectId} />;
    case "printing": return <PrintingPanel workspaceId={workspaceId} projectId={projectId} />;
    case "releases": return <ReleasesPanel workspaceId={workspaceId} projectId={projectId} username={scope.username} initialReleaseId={navigation?.location.filters?.release ?? null} />;
    case "copper": return <CopperPanel projectId={projectId} />;
    default: return null;
  }
}

/**
 * The editor of a lens with a library list (see LIBRARY_VIEWS). The same editor serves Library scope
 * (projectId null) and project scope, where the project is context only: new items are also
 * referenced by it. Items always live in the workspace library.
 */
function LensEditor({ toolId, scope, projectId, active }: { toolId: string; scope: WorkspaceScope; projectId: string | null; active: string }) {
  const navigation = useNavigation();
  const { principalKey, workspaceId } = scope;
  const editorFilters = useNavigation()?.location.filters;
  const initialInterfaceKind = editorFilters?.kind === "pinout" ? "pinout" : "connector_body";
  const onAccessChanged = scope.refresh;
  switch (toolId) {
    case "hardware": return <IdentityPanel projectId={projectId} initialKind="hardware" />;
    case "identity": return <IdentityPanel projectId={projectId} />;
    case "signals": return <SignalSetPanel projectId={projectId} />;
    case "ports": return <PortPanel projectId={projectId} />;
    case "conventions": return <ConventionPanel projectId={projectId} />;
    case "end-assemblies": return <EndAssemblyPanel projectId={projectId} />;
    case "intents": return <IntentPanel projectId={projectId} />;
    case "wire-stock": return <WireStockPanel projectId={projectId} workspaceId={workspaceId} />;
    case "workshop-profiles": return <WorkshopProfilePanel projectId={projectId} />;
    case "assemblies": return <AssemblyPanel projectId={projectId} onAccessLost={onAccessChanged} />;
    case "interfaces": return <Stack><InterfacePanel projectId={projectId} initialKind={initialInterfaceKind} /><InterfaceAssessmentPanel projectId={projectId} principalKey={principalKey} active={active === "interfaces"} /></Stack>;
    case "cables": return <CablePanel projectId={null} workspaceId={workspaceId} />;
    case "harnesses": return <HarnessPanel projectId={projectId} />;
    case "passive-passages": return <PassivePassagesWorkspace projectId={projectId} />;
    // Board pads and paths edit "board" rows; intake and populations follow.
    case "pcb": return <Stack>{editorFilters?.view === "intake" ? [<PcbPanel key="intake" workspaceId={workspaceId} projectId={projectId} />, <BoardPanel key="board" projectId={projectId} />] : [<BoardPanel key="board" projectId={projectId} />, <PcbPanel key="intake" workspaceId={workspaceId} projectId={projectId} />]}</Stack>;
    case "pcb-disagreement": return <PcbDisagreementPanel workspaceId={workspaceId} projectId={projectId} />;
    // Firmware definitions are declared here; per-occurrence firmware choices follow.
    case "occurrence-firmware": return <Stack><FirmwarePanel workspaceId={workspaceId} onAccessLost={onAccessChanged} /><FirmwareOccurrencesPanel workspaceId={workspaceId} /></Stack>;
    case "configurations": return <ConfigurationsPanel projectId={projectId} />;
    case "mechanical-sources": return <MechanicalSourcesPanel workspaceId={workspaceId} />;
    case "bom": return <BomPanel active={active === toolId} projectId={projectId} workspaceId={workspaceId} />;
    case "material-accounting": return <MaterialAccountingPanel active={active === toolId} projectId={projectId} />;
    case "preparation": return <PreparationPanel projectId={projectId} />;
    case "end-preparation": return <EndPreparationPanel projectId={projectId} />;
    case "cable-test-intent": return <CableTestIntentPanel projectId={projectId} />;
    case "sources": return <SourcesPanel workspaceId={workspaceId} projectId={projectId} />;
    // Inventory includes workspace-scoped Sourcing (plans, stock and offers all live in the workspace).
    case "inventory": return <InventoryPanel active={active === toolId} workspaceId={workspaceId} projectId={projectId ?? undefined} initialWorkId={navigation?.location.filters?.work_batch ?? null} />;
    case "physical-units": return <PhysicalUnitsPanel active={active === toolId} workspaceId={workspaceId} projectId={projectId ?? undefined} />;
    case "facts": return <FactsPanel workspaceId={workspaceId} projectId={projectId ?? undefined} />;
    default: return null;
  }
}


function ToolPanel({ value, library, children }: { value: string; /** Project-scope library list shown above the tool. */ library?: ReactNode; children: ReactNode }) {
  return <Tabs.Panel value={value} pt="lg"><ToolLoadingBoundary><Suspense fallback={<Text role="status">Loading tool…</Text>}>
    {library && children ? <Stack gap="lg">{library}{children}</Stack> : children}
  </Suspense></ToolLoadingBoundary></Tabs.Panel>;
}

export class ToolLoadingBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <Alert color="red" role="alert">
      <Text>This tool could not be opened. Reload the page to try again; unsaved edits will be lost.</Text>
      <Button mt="sm" onClick={() => window.location.reload()}>Reload page</Button>
    </Alert>;
  }
}
