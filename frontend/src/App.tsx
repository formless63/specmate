import { PermissionsProvider } from "./lib/permissions";
import { Alert, Button, Stack, Tabs, Text } from "@mantine/core";
import type { SpotlightActionGroupData } from "@mantine/spotlight";
import { Component, Fragment, lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from "react";

import { StatusIndicator } from "./features/diagnostics/StatusIndicator";
import { WorkspaceHome } from "./features/home/WorkspaceHome";
import { ProjectOverview } from "./features/overview/ProjectOverview";
import { ChooseProject } from "./features/scope/ChooseProject";
import { RecordFocusContext, type RecordFocus } from "./features/scope/focus";
import { LibraryView } from "./features/scope/LibraryView";
import { AREAS, DEFAULT_TOOL, SbShell, toolLabel } from "./features/shell";
import { libraryView } from "./features/shell/scope";
import { WorkspaceShell, type LibraryRecord, type Project, type ShellChrome, type WorkspaceScope } from "./features/workspace";

const BuildsPanel = lazy(() => import("./features/builds/BuildsPanel").then((module) => ({ default: module.BuildsPanel })));
const AssemblyPanel = lazy(() => import("./features/assemblies/AssemblyPanel").then((module) => ({ default: module.AssemblyPanel })));
const AgentCapabilitiesPanel = lazy(() => import("./features/agent-capabilities/AgentCapabilitiesPanel").then((module) => ({ default: module.AgentCapabilitiesPanel })));
const DiagnosticsPanel = lazy(() => import("./features/diagnostics/DiagnosticsPanel").then((module) => ({ default: module.DiagnosticsPanel })));
const WorkspaceAccessPanel = lazy(() => import("./features/project-access/WorkspaceAccessPanel").then((module) => ({ default: module.WorkspaceAccessPanel })));
const IdentityPanel = lazy(() => import("./features/identity/IdentityPanel").then((module) => ({ default: module.IdentityPanel })));
const FactsPanel = lazy(() => import("./features/facts/FactsPanel").then((module) => ({ default: module.FactsPanel })));
const EvidencePanel = lazy(() => import("./features/evidence/EvidencePanel").then((module) => ({ default: module.EvidencePanel })));
const InterfacePanel = lazy(() => import("./features/interfaces/InterfacePanel").then((module) => ({ default: module.InterfacePanel })));
const InterfaceAssessmentPanel = lazy(() => import("./features/interfaces/InterfaceAssessmentPanel").then((module) => ({ default: module.InterfaceAssessmentPanel })));
const InventoryPanel = lazy(() => import("./features/inventory/InventoryPanel").then((module) => ({ default: module.InventoryPanel })));
const PcbPanel = lazy(() => import("./features/pcb/PcbPanel").then((module) => ({ default: module.PcbPanel })));
const WireStockPanel = lazy(() => import("./features/wire-stock/WireStockPanel").then((module) => ({ default: module.WireStockPanel })));
const WorkshopProfilePanel = lazy(() => import("./features/workshop-profiles/WorkshopProfilePanel").then((module) => ({ default: module.WorkshopProfilePanel })));
const DiscoveryPanel = lazy(() => import("./features/discovery/DiscoveryPanel").then((module) => ({ default: module.DiscoveryPanel })));
const PhysicalUnitsPanel = lazy(() => import("./features/physical-units/PhysicalUnitsPanel").then((module) => ({ default: module.PhysicalUnitsPanel })));
const BomPanel = lazy(() => import("./features/bom/BomPanel").then((module) => ({ default: module.BomPanel })));
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

const SelectedPackagesPanel = lazy(() => import("./features/selected-packages/SelectedPackagesPanel").then((module) => ({ default: module.SelectedPackagesPanel })));
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
const SceneDrawingsPanel = lazy(() => import("./features/scene-drawings/SceneDrawingsPanel").then((module) => ({ default: module.SceneDrawingsPanel })));

export function App() {
  return <WorkspaceShell>{(scope) => <ScopedWorkspace scope={scope} />}</WorkspaceShell>;
}

const ALL_TOOLS = AREAS.flatMap((area) => area.tools);

/**
 * The one shell for a signed-in member. The selected area and lens survive scope changes;
 * everything below a scope (panels, their state, cached reads) is keyed to it and discarded
 * when the scope or the member's permissions change. Scope changes navigation, never access.
 */
function ScopedWorkspace({ scope }: { scope: WorkspaceScope }) {
  const [active, setActiveTool] = useState<string>(DEFAULT_TOOL);
  const [focus, setFocus] = useState<RecordFocus | null>(null);
  const [statusTick, setStatusTick] = useState(0);
  const scopeKey = `${scope.projectId ?? "library"}:${scope.role}:${scope.permissions.join(",")}`;
  const [visited, setVisited] = useState(() => ({ key: scopeKey, tools: new Set([DEFAULT_TOOL]) }));
  // A new scope mounts only the lens in view; other lenses mount on first visit again.
  const tools = visited.key === scopeKey ? visited.tools : new Set([active]);
  if (visited.key !== scopeKey) setVisited({ key: scopeKey, tools });
  // Opening any tool (from an area, a lens, the command palette or a deep link) mounts it once and keeps it mounted while hidden.
  const setActive = useCallback((value: string) => {
    setActiveTool(value);
    setVisited((current) => current.tools.has(value) ? current : { key: current.key, tools: new Set([...current.tools, value]) });
  }, []);
  const { selectProject } = scope;
  const changeScope = useCallback((projectId: string | null) => { setFocus(null); selectProject(projectId); }, [selectProject]);
  const openInProject = useCallback((projectId: string, toolId: string, record?: LibraryRecord) => {
    setActive(toolId);
    setFocus(record ? { projectId, toolId, record } : null);
    selectProject(projectId);
  }, [selectProject, setActive]);
  const scopeActions = useMemo<SpotlightActionGroupData[]>(() => [{ group: "Scope", actions: [
    { id: "scope:library", label: "Library", description: "Whole workspace library", onClick: () => changeScope(null) },
    ...scope.projects.filter((project) => !project.archived).map((project) => ({ id: `scope:${project.project_id}`, label: project.name, description: "Open project", onClick: () => changeScope(project.project_id) })),
  ] }], [scope.projects, changeScope]);
  const activeFocus = focus && focus.projectId === scope.projectId ? focus : null;
  const chrome: ShellChrome = activeFocus ? { ...scope.chrome, alert: <>{scope.chrome.alert}<FocusNote focus={activeFocus} onDismiss={() => setFocus(null)} /></> } : scope.chrome;

  return <PermissionsProvider permissions={scope.permissions}>
    <SbShell projectName={scope.project?.name ?? "Library"} permissions={scope.permissions} role={scope.role} libraryScope={!scope.project}
      activeTool={active} onToolChange={setActive} chrome={chrome} extraActions={scopeActions}
      statusIndicator={scope.projectId ? <StatusIndicator workspaceId={scope.workspaceId} refreshKey={statusTick} onOpen={() => setActive("diagnostics")} /> : undefined}>
      {scope.project && scope.projectId
        ? <Fragment key={scopeKey}><RecordFocusContext.Provider value={activeFocus}>
          <ProjectTools scope={scope} projectId={scope.projectId} project={scope.project} active={active} visited={tools} setActive={setActive}
            onStatusChanged={() => setStatusTick((n) => n + 1)} onOpenInProject={openInProject} />
        </RecordFocusContext.Provider></Fragment>
        : <Fragment key={scopeKey}>{ALL_TOOLS.map((tool) => <ToolPanel key={tool.id} value={tool.id}>
          {tools.has(tool.id) && <LibraryTool toolId={tool.id} toolLabel={tool.label} scope={scope} onOpenInProject={openInProject} />}
        </ToolPanel>)}</Fragment>}
    </SbShell>
  </PermissionsProvider>;
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
function LibraryTool({ toolId, toolLabel, scope, onOpenInProject }: { toolId: string; toolLabel: string; scope: WorkspaceScope; onOpenInProject: (projectId: string, toolId: string, record?: LibraryRecord) => void }) {
  if (toolId === "overview") {
    return <WorkspaceHome username={scope.username} role={scope.role} permissions={scope.permissions} projects={scope.projects} lastProjectId={scope.lastProjectId}
      busy={scope.busy} onOpen={(projectId) => onOpenInProject(projectId, toolId)} onCreate={scope.createProject} onChanged={scope.refresh} />;
  }
  if (toolId === "access") return <WorkspaceAccessPanel onAccessChanged={scope.refresh} />;
  const view = libraryView(toolId);
  if (view) {
    return <LibraryView view={view} toolLabel={toolLabel} projectId={null} project={null} projects={scope.projects} principalKey={scope.principalKey}
      permissions={scope.permissions} onOpenInProject={(projectId, record) => onOpenInProject(projectId, toolId, record)} />;
  }
  return <ChooseProject toolLabel={toolLabel} projects={scope.projects} lastProjectId={scope.lastProjectId} onChoose={(projectId) => onOpenInProject(projectId, toolId)} />;
}

type ProjectToolsProps = {
  scope: WorkspaceScope; projectId: string; project: Project; active: string; visited: Set<string>; setActive: (value: string) => void;
  onStatusChanged: () => void; onOpenInProject: (projectId: string, toolId: string, record?: LibraryRecord) => void;
};

/**
 * Lenses at project scope. A lens with a library list first shows the items this project references
 * (with a switch to the whole library), then its tool. Panels receive the project as context only.
 */
function ProjectTools({ scope, projectId, project, active, visited, setActive, onStatusChanged, onOpenInProject }: ProjectToolsProps) {
  const [upgradeProposalId, setUpgradeProposalId] = useState<string | null>(null);
  const { permissions, principalKey, role, workspaceId } = scope;
  const projectName = project.name;
  const onAccessChanged = scope.refresh;
  const onLeave = () => scope.selectProject(null);
  const library = (toolId: string) => {
    const view = libraryView(toolId);
    return view && <LibraryView view={view} toolLabel={toolLabel(toolId)} projectId={projectId} project={project} projects={scope.projects}
      principalKey={principalKey} permissions={permissions} onOpenInProject={(target, record) => onOpenInProject(target, toolId, record)} />;
  };
  return <>
    <ToolPanel value="overview" library={library("overview")}>{visited.has("overview") && <ProjectOverview projectId={projectId} projectName={projectName} permissions={permissions} role={role} active={active === "overview"} onOpenTool={setActive} onAccessLost={onAccessChanged} onProjectChanged={onAccessChanged} onLeave={onLeave} />}</ToolPanel>
    <ToolPanel value="builds" library={library("builds")}>{visited.has("builds") && <BuildsPanel workspaceId={workspaceId} />}</ToolPanel>
    <ToolPanel value="sources" library={library("sources")}>{visited.has("sources") && <SourcesPanel workspaceId={workspaceId} permissions={permissions} />}</ToolPanel>
    <ToolPanel value="knowledge" library={library("knowledge")}>{visited.has("knowledge") && <Stack><KnowledgePanel workspaceId={workspaceId} projectId={projectId} principalKey={principalKey} canEdit={permissions.includes("design.edit")} onAccessLost={onAccessChanged} /><KnowledgeSearchPanel workspaceId={workspaceId} projectId={projectId} principalKey={principalKey} active={active === "knowledge"} /><CollaborationPanel projectId={projectId} principalKey={principalKey} active={active === "knowledge"} canEdit={permissions.includes("design.edit")} onAccessLost={onAccessChanged} onOpenUpgrade={(id) => { setUpgradeProposalId(id); setActive("revision-upgrades"); }} /></Stack>}</ToolPanel>
    <ToolPanel value="identity" library={library("identity")}>{visited.has("identity") && <IdentityPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="discovery" library={library("discovery")}>{visited.has("discovery") && <DiscoveryPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="revision-upgrades" library={library("revision-upgrades")}>{visited.has("revision-upgrades") && <RevisionUpgradeWorkspace projectId={projectId} principalKey={principalKey} active={active === "revision-upgrades"} initialProposalId={upgradeProposalId} canEdit={permissions.includes("design.edit")} />}</ToolPanel>
    <ToolPanel value="matching" library={library("matching")}>{visited.has("matching") && <MatchingWorkspace projectId={projectId} />}</ToolPanel>
    <ToolPanel value="catalog-packs" library={library("catalog-packs")}>{visited.has("catalog-packs") && <CatalogPacksWorkspace projectId={projectId} />}</ToolPanel>
    <ToolPanel value="wire-stock" library={library("wire-stock")}>{visited.has("wire-stock") && <WireStockPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="workshop-profiles" library={library("workshop-profiles")}>{visited.has("workshop-profiles") && <WorkshopProfilePanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="material-accounting" library={library("material-accounting")}>{visited.has("material-accounting") && <MaterialAccountingPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="preparation" library={library("preparation")}>{visited.has("preparation") && <PreparationPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="end-preparation" library={library("end-preparation")}>{visited.has("end-preparation") && <EndPreparationPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="selected-packages" library={library("selected-packages")}>{visited.has("selected-packages") && <SelectedPackagesPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="occurrence-firmware" library={library("occurrence-firmware")}>{visited.has("occurrence-firmware") && <FirmwareOccurrencesPanel projectId={projectId} permissions={permissions} />}</ToolPanel>
    <ToolPanel value="firmware-impact" library={library("firmware-impact")}>{visited.has("firmware-impact") && <FirmwareImpactPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="configurations" library={library("configurations")}>{visited.has("configurations") && <ConfigurationsPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="mechanical-sources" library={library("mechanical-sources")}>{visited.has("mechanical-sources") && <MechanicalSourcesPanel workspaceId={workspaceId} permissions={permissions} />}</ToolPanel>
    <ToolPanel value="shared-scene" library={library("shared-scene")}>{visited.has("shared-scene") && <SharedScenePanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="context-selection" library={library("context-selection")}>{visited.has("context-selection") && <ContextualInspectionWorkspace projectId={projectId} principalKey={principalKey} />}</ToolPanel>
    <ToolPanel value="assemblies" library={library("assemblies")}>{visited.has("assemblies") && <AssemblyPanel projectId={projectId} permissions={permissions} onAccessLost={onAccessChanged} />}</ToolPanel>
    <ToolPanel value="facts" library={library("facts")}>{visited.has("facts") && <FactsPanel workspaceId={workspaceId} projectId={projectId} />}</ToolPanel>
    <ToolPanel value="evidence-kinds" library={library("evidence-kinds")}>{visited.has("evidence-kinds") && <EvidencePanel workspaceId={workspaceId} projectId={projectId} />}</ToolPanel>
    <ToolPanel value="mechanical-proposals" library={library("mechanical-proposals")}>{visited.has("mechanical-proposals") && <MechanicalProposalsPanel workspaceId={workspaceId} principalKey={principalKey} />}</ToolPanel>
    <ToolPanel value="scene-drawings" library={library("scene-drawings")}>{visited.has("scene-drawings") && <SceneDrawingsPanel projectId={projectId} principalKey={principalKey} active={active === "scene-drawings"} />}</ToolPanel>
    <ToolPanel value="preparation-documents" library={library("preparation-documents")}>{visited.has("preparation-documents") && <PreparationDocumentsPanel projectId={projectId} principalKey={principalKey} active={active === "preparation-documents"} canGenerate={permissions.includes("design.edit")} onAccessLost={onAccessChanged} />}</ToolPanel>
    <ToolPanel value="interfaces" library={library("interfaces")}>{visited.has("interfaces") && <Stack><InterfacePanel projectId={projectId} /><InterfaceAssessmentPanel projectId={projectId} principalKey={principalKey} active={active === "interfaces"} canEdit={permissions.includes("design.edit")} canFreeze={permissions.includes("design.freeze")} /></Stack>}</ToolPanel>
    <ToolPanel value="cables" library={library("cables")}>{visited.has("cables") && <CablePanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="cable-test-intent" library={library("cable-test-intent")}>{visited.has("cable-test-intent") && <CableTestIntentPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="harnesses" library={library("harnesses")}>{visited.has("harnesses") && <HarnessPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="passive-passages" library={library("passive-passages")}>{visited.has("passive-passages") && <PassivePassagesWorkspace projectId={projectId} canEdit={permissions.includes("design.edit")} canFreeze={permissions.includes("design.freeze")} />}</ToolPanel>
    <ToolPanel value="copper" library={library("copper")}>{visited.has("copper") && <CopperPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="pcb" library={library("pcb")}>{visited.has("pcb") && <PcbPanel workspaceId={workspaceId} permissions={permissions} />}</ToolPanel>
    <ToolPanel value="pcb-disagreement" library={library("pcb-disagreement")}>{visited.has("pcb-disagreement") && <PcbDisagreementPanel workspaceId={workspaceId} />}</ToolPanel>
    <ToolPanel value="inventory" library={library("inventory")}>{visited.has("inventory") && <InventoryPanel workspaceId={workspaceId} projectId={projectId} />}</ToolPanel>
    <ToolPanel value="bom" library={library("bom")}>{visited.has("bom") && <BomPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="physical-units" library={library("physical-units")}>{visited.has("physical-units") && <PhysicalUnitsPanel workspaceId={workspaceId} projectId={projectId} />}</ToolPanel>
    <ToolPanel value="agent-capabilities" library={library("agent-capabilities")}>{visited.has("agent-capabilities") && <AgentCapabilitiesPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="diagnostics" library={library("diagnostics")}>{visited.has("diagnostics") && <DiagnosticsPanel workspaceId={workspaceId} active={active === "diagnostics"} onChanged={onStatusChanged} />}</ToolPanel>
    <ToolPanel value="access" library={library("access")}>{visited.has("access") && <WorkspaceAccessPanel onAccessChanged={onAccessChanged} />}</ToolPanel>
  </>;
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
