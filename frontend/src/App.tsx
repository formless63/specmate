import { Alert, Button, Stack, Tabs, Text } from "@mantine/core";
import { Component, lazy, Suspense, useState, type ReactNode } from "react";

import { WorkspaceShell } from "./features/workspace";

const AssemblyPanel = lazy(() => import("./features/assemblies/AssemblyPanel").then((module) => ({ default: module.AssemblyPanel })));
const ProjectAccessPanel = lazy(() => import("./features/project-access/ProjectAccessPanel").then((module) => ({ default: module.ProjectAccessPanel })));
const IdentityPanel = lazy(() => import("./features/identity/IdentityPanel").then((module) => ({ default: module.IdentityPanel })));
const FactsPanel = lazy(() => import("./features/facts/FactsPanel").then((module) => ({ default: module.FactsPanel })));
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
const MechanicalSourcesPanel = lazy(() => import("./features/mechanical-sources/MechanicalSourcesPanel").then((module) => ({ default: module.MechanicalSourcesPanel })));
const SharedScenePanel = lazy(() => import("./features/shared-scene/SharedScenePanel").then((module) => ({ default: module.SharedScenePanel })));
const ContextualInspectionWorkspace = lazy(() => import("./features/context-selection/ContextualInspectionWorkspace").then((module) => ({ default: module.ContextualInspectionWorkspace })));
const CollaborationPanel = lazy(() => import("./features/collaboration/CollaborationPanel").then((module) => ({ default: module.CollaborationPanel })));
const KnowledgePanel = lazy(() => import("./features/knowledge/KnowledgePanel").then((module) => ({ default: module.KnowledgePanel })));
const PreparationDocumentsPanel = lazy(() => import("./features/preparation-documents/PreparationDocumentsPanel").then((module) => ({ default: module.PreparationDocumentsPanel })));
const SceneDrawingsPanel = lazy(() => import("./features/scene-drawings/SceneDrawingsPanel").then((module) => ({ default: module.SceneDrawingsPanel })));

export function App() {
  return <WorkspaceShell>{(projectId, project, refreshProjects, principalKey) =>
    <ProjectWorkspace key={`${projectId}:${project.permissions?.join(",") ?? ""}`}
      projectId={projectId} principalKey={principalKey} permissions={project.permissions ?? []} onAccessChanged={refreshProjects} />
  }</WorkspaceShell>;
}

function ProjectWorkspace({ projectId, principalKey, permissions, onAccessChanged }: { projectId: string; principalKey: string; permissions: string[]; onAccessChanged: () => Promise<void> }) {
  const [active, setActive] = useState<string | null>("identity");
  const [visited, setVisited] = useState(() => new Set(["identity"]));
  return <Tabs keepMountedMode="display-none" value={active} onChange={(value) => {
    if (value) { setActive(value); setVisited((current) => new Set([...current, value])); }
  }}>
    <Tabs.List aria-label="Project tools">
      <Tabs.Tab value="identity">Identities</Tabs.Tab>
      <Tabs.Tab value="sources">Sources</Tabs.Tab>
      <Tabs.Tab value="discovery">Discovery</Tabs.Tab>
      <Tabs.Tab value="revision-upgrades">Revision upgrades</Tabs.Tab>
      <Tabs.Tab value="matching">Reviewed matching</Tabs.Tab>
      <Tabs.Tab value="catalog-packs">Catalog packs</Tabs.Tab>
      <Tabs.Tab value="wire-stock">Wire stock</Tabs.Tab>
      <Tabs.Tab value="workshop-profiles">Workshop profiles</Tabs.Tab>
      <Tabs.Tab value="material-accounting">Material accounting</Tabs.Tab>
      <Tabs.Tab value="preparation">Cut preparation</Tabs.Tab>
      <Tabs.Tab value="end-preparation">End preparation</Tabs.Tab>
      <Tabs.Tab value="assemblies">Assemblies</Tabs.Tab>
      <Tabs.Tab value="occurrence-firmware">Board firmware</Tabs.Tab>
      <Tabs.Tab value="firmware-impact">Firmware impact</Tabs.Tab>
      <Tabs.Tab value="mechanical-sources">Mechanical sources</Tabs.Tab>
      <Tabs.Tab value="shared-scene">Shared scene</Tabs.Tab>
      <Tabs.Tab value="context-selection">Connected views</Tabs.Tab>
      <Tabs.Tab value="scene-drawings">Scene drawings</Tabs.Tab>
      <Tabs.Tab value="preparation-documents">Bench documents</Tabs.Tab>
      <Tabs.Tab value="knowledge">Notes &amp; files</Tabs.Tab>
      <Tabs.Tab value="selected-packages">Selected packages</Tabs.Tab>
      <Tabs.Tab value="facts">Facts</Tabs.Tab>
      <Tabs.Tab value="interfaces">Interfaces</Tabs.Tab>
      <Tabs.Tab value="cables">Cables</Tabs.Tab>
      <Tabs.Tab value="cable-test-intent">Cable test intent</Tabs.Tab>
      <Tabs.Tab value="harnesses">Harness branches</Tabs.Tab>
      <Tabs.Tab value="copper">Copper graph</Tabs.Tab>
      <Tabs.Tab value="passive-passages">Passive models</Tabs.Tab>
      <Tabs.Tab value="pcb">PCB intake</Tabs.Tab>
      <Tabs.Tab value="pcb-disagreement">PCB source review</Tabs.Tab>
      <Tabs.Tab value="inventory">Inventory</Tabs.Tab>
      <Tabs.Tab value="bom">BOM planning</Tabs.Tab>
      <Tabs.Tab value="physical-units">Physical units</Tabs.Tab>
      <Tabs.Tab value="access">Project access</Tabs.Tab>
    </Tabs.List>
    <ToolPanel value="sources">{visited.has("sources") && <SourcesPanel projectId={projectId} permissions={permissions} />}</ToolPanel>
    <ToolPanel value="knowledge">{visited.has("knowledge") && <Stack><KnowledgePanel projectId={projectId} principalKey={principalKey} canEdit={permissions.includes("design.edit")} onAccessLost={onAccessChanged} /><CollaborationPanel projectId={projectId} principalKey={principalKey} active={active === "knowledge"} canEdit={permissions.includes("design.edit")} onAccessLost={onAccessChanged} /></Stack>}</ToolPanel>
    <ToolPanel value="identity">{visited.has("identity") && <IdentityPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="discovery">{visited.has("discovery") && <DiscoveryPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="revision-upgrades">{visited.has("revision-upgrades") && <RevisionUpgradeWorkspace projectId={projectId} canEdit={permissions.includes("design.edit")} />}</ToolPanel>
    <ToolPanel value="matching">{visited.has("matching") && <MatchingWorkspace projectId={projectId} />}</ToolPanel>
    <ToolPanel value="catalog-packs">{visited.has("catalog-packs") && <CatalogPacksWorkspace projectId={projectId} />}</ToolPanel>
    <ToolPanel value="wire-stock">{visited.has("wire-stock") && <WireStockPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="workshop-profiles">{visited.has("workshop-profiles") && <WorkshopProfilePanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="material-accounting">{visited.has("material-accounting") && <MaterialAccountingPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="preparation">{visited.has("preparation") && <PreparationPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="end-preparation">{visited.has("end-preparation") && <EndPreparationPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="selected-packages">{visited.has("selected-packages") && <SelectedPackagesPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="occurrence-firmware">{visited.has("occurrence-firmware") && <FirmwareOccurrencesPanel projectId={projectId} permissions={permissions} />}</ToolPanel>
    <ToolPanel value="firmware-impact">{visited.has("firmware-impact") && <FirmwareImpactPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="mechanical-sources">{visited.has("mechanical-sources") && <MechanicalSourcesPanel projectId={projectId} permissions={permissions} />}</ToolPanel>
    <ToolPanel value="shared-scene">{visited.has("shared-scene") && <SharedScenePanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="context-selection">{visited.has("context-selection") && <ContextualInspectionWorkspace projectId={projectId} principalKey={principalKey} />}</ToolPanel>
    <ToolPanel value="assemblies">{visited.has("assemblies") && <AssemblyPanel projectId={projectId} permissions={permissions} onAccessLost={onAccessChanged} />}</ToolPanel>
    <ToolPanel value="facts">{visited.has("facts") && <FactsPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="scene-drawings">{visited.has("scene-drawings") && <SceneDrawingsPanel projectId={projectId} principalKey={principalKey} active={active === "scene-drawings"} />}</ToolPanel>
    <ToolPanel value="preparation-documents">{visited.has("preparation-documents") && <PreparationDocumentsPanel projectId={projectId} principalKey={principalKey} active={active === "preparation-documents"} canGenerate={permissions.includes("design.edit")} onAccessLost={onAccessChanged} />}</ToolPanel>
    <ToolPanel value="interfaces">{visited.has("interfaces") && <Stack><InterfacePanel projectId={projectId} /><InterfaceAssessmentPanel projectId={projectId} principalKey={principalKey} active={active === "interfaces"} canEdit={permissions.includes("design.edit")} canFreeze={permissions.includes("design.freeze")} /></Stack>}</ToolPanel>
    <ToolPanel value="cables">{visited.has("cables") && <CablePanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="cable-test-intent">{visited.has("cable-test-intent") && <CableTestIntentPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="harnesses">{visited.has("harnesses") && <HarnessPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="passive-passages">{visited.has("passive-passages") && <PassivePassagesWorkspace projectId={projectId} canEdit={permissions.includes("design.edit")} canFreeze={permissions.includes("design.freeze")} />}</ToolPanel>
    <ToolPanel value="copper">{visited.has("copper") && <CopperPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="pcb">{visited.has("pcb") && <PcbPanel projectId={projectId} permissions={permissions} />}</ToolPanel>
    <ToolPanel value="pcb-disagreement">{visited.has("pcb-disagreement") && <PcbDisagreementPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="inventory">{visited.has("inventory") && <InventoryPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="bom">{visited.has("bom") && <BomPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="physical-units">{visited.has("physical-units") && <PhysicalUnitsPanel projectId={projectId} />}</ToolPanel>
    <ToolPanel value="access">{visited.has("access") && <ProjectAccessPanel projectId={projectId} onAccessChanged={onAccessChanged} />}</ToolPanel>
  </Tabs>;
}

function ToolPanel({ value, children }: { value: string; children: ReactNode }) {
  return <Tabs.Panel value={value} pt="lg"><ToolLoadingBoundary><Suspense fallback={<Text role="status">Loading tool…</Text>}>{children}</Suspense></ToolLoadingBoundary></Tabs.Panel>;
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
