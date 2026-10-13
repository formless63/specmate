import { Tabs } from "@mantine/core";
import { useState } from "react";
import { AssemblyPanel } from "./features/assemblies/AssemblyPanel";
import { ProjectAccessPanel } from "./features/project-access/ProjectAccessPanel";
import { IdentityPanel } from "./features/identity/IdentityPanel";
import { FactsPanel } from "./features/facts/FactsPanel";
import { InterfacePanel } from "./features/interfaces/InterfacePanel";
import { InventoryPanel } from "./features/inventory/InventoryPanel";
import { PcbPanel } from "./features/pcb/PcbPanel";
import { WireStockPanel } from "./features/wire-stock/WireStockPanel";
import { WorkspaceShell } from "./features/workspace";
import { WorkshopProfilePanel } from "./features/workshop-profiles/WorkshopProfilePanel";
import { DiscoveryPanel } from "./features/discovery/DiscoveryPanel";
import { PhysicalUnitsPanel } from "./features/physical-units/PhysicalUnitsPanel";
import { BomPanel } from "./features/bom/BomPanel";
import { CablePanel } from "./features/cables/CablePanel";
import { MatchingWorkspace } from "./features/catalog-matching/MatchingWorkspace";
import { CatalogPacksWorkspace } from "./features/catalog-packs/CatalogPacksWorkspace";
import { HarnessPanel } from "./features/harnesses/HarnessPanel";

export function App() {
  return <WorkspaceShell>{(projectId, project, refreshProjects) =>
    <ProjectWorkspace key={`${projectId}:${project.permissions?.join(",") ?? ""}`}
      projectId={projectId} permissions={project.permissions ?? []} onAccessChanged={refreshProjects} />
  }</WorkspaceShell>;
}

function ProjectWorkspace({ projectId, permissions, onAccessChanged }: { projectId: string; permissions: string[]; onAccessChanged: () => Promise<void> }) {
  const [active, setActive] = useState<string | null>("identity");
  const [visited, setVisited] = useState(() => new Set(["identity"]));
  return <Tabs keepMountedMode="display-none" value={active} onChange={(value) => {
    if (value) { setActive(value); setVisited((current) => new Set([...current, value])); }
  }}>
    <Tabs.List aria-label="Project tools">
      <Tabs.Tab value="identity">Identities</Tabs.Tab>
      <Tabs.Tab value="discovery">Discovery</Tabs.Tab>
      <Tabs.Tab value="matching">Reviewed matching</Tabs.Tab>
      <Tabs.Tab value="catalog-packs">Catalog packs</Tabs.Tab>
      <Tabs.Tab value="wire-stock">Wire stock</Tabs.Tab>
      <Tabs.Tab value="workshop-profiles">Workshop profiles</Tabs.Tab>
      <Tabs.Tab value="assemblies">Assemblies</Tabs.Tab>
      <Tabs.Tab value="facts">Facts</Tabs.Tab>
      <Tabs.Tab value="interfaces">Interfaces</Tabs.Tab>
      <Tabs.Tab value="cables">Cables</Tabs.Tab>
      <Tabs.Tab value="harnesses">Harness branches</Tabs.Tab>
      <Tabs.Tab value="pcb">PCB intake</Tabs.Tab>
      <Tabs.Tab value="inventory">Inventory</Tabs.Tab>
      <Tabs.Tab value="bom">BOM planning</Tabs.Tab>
      <Tabs.Tab value="physical-units">Physical units</Tabs.Tab>
      <Tabs.Tab value="access">Project access</Tabs.Tab>
    </Tabs.List>
    <Tabs.Panel value="identity" pt="lg">{visited.has("identity") && <IdentityPanel projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="discovery" pt="lg">{visited.has("discovery") && <DiscoveryPanel projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="matching" pt="lg">{visited.has("matching") && <MatchingWorkspace projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="catalog-packs" pt="lg">{visited.has("catalog-packs") && <CatalogPacksWorkspace projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="wire-stock" pt="lg">{visited.has("wire-stock") && <WireStockPanel projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="workshop-profiles" pt="lg">{visited.has("workshop-profiles") && <WorkshopProfilePanel projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="assemblies" pt="lg">{visited.has("assemblies") && <AssemblyPanel projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="facts" pt="lg">{visited.has("facts") && <FactsPanel projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="interfaces" pt="lg">{visited.has("interfaces") && <InterfacePanel projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="cables" pt="lg">{visited.has("cables") && <CablePanel projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="harnesses" pt="lg">{visited.has("harnesses") && <HarnessPanel projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="pcb" pt="lg">{visited.has("pcb") && <PcbPanel projectId={projectId} permissions={permissions} />}</Tabs.Panel>
    <Tabs.Panel value="inventory" pt="lg">{visited.has("inventory") && <InventoryPanel projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="bom" pt="lg">{visited.has("bom") && <BomPanel projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="physical-units" pt="lg">{visited.has("physical-units") && <PhysicalUnitsPanel projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="access" pt="lg">{visited.has("access") && <ProjectAccessPanel projectId={projectId} onAccessChanged={onAccessChanged} />}</Tabs.Panel>
  </Tabs>;
}
