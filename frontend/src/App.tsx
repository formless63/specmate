import { Tabs } from "@mantine/core";
import { useState } from "react";
import { IdentityPanel } from "./features/identity/IdentityPanel";
import { InventoryPanel } from "./features/inventory/InventoryPanel";
import { PcbPanel } from "./features/pcb/PcbPanel";
import { WireStockPanel } from "./features/wire-stock/WireStockPanel";
import { WorkspaceShell } from "./features/workspace";

export function App() {
  return <WorkspaceShell>{(projectId, project) =>
    <ProjectWorkspace key={`${projectId}:${project.permissions?.join(",") ?? ""}`}
      projectId={projectId} permissions={project.permissions ?? []} />
  }</WorkspaceShell>;
}

function ProjectWorkspace({ projectId, permissions }: { projectId: string; permissions: string[] }) {
  const [active, setActive] = useState<string | null>("identity");
  const [visited, setVisited] = useState(() => new Set(["identity"]));
  return <Tabs value={active} onChange={(value) => {
    if (value) { setActive(value); setVisited((current) => new Set([...current, value])); }
  }}>
    <Tabs.List aria-label="Project tools">
      <Tabs.Tab value="identity">Identities</Tabs.Tab>
      <Tabs.Tab value="wire-stock">Wire stock</Tabs.Tab>
      <Tabs.Tab value="pcb">PCB intake</Tabs.Tab>
      <Tabs.Tab value="inventory">Inventory</Tabs.Tab>
    </Tabs.List>
    <Tabs.Panel value="identity" pt="lg">{visited.has("identity") && <IdentityPanel projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="wire-stock" pt="lg">{visited.has("wire-stock") && <WireStockPanel projectId={projectId} />}</Tabs.Panel>
    <Tabs.Panel value="pcb" pt="lg">{visited.has("pcb") && <PcbPanel projectId={projectId} permissions={permissions} />}</Tabs.Panel>
    <Tabs.Panel value="inventory" pt="lg">{visited.has("inventory") && <InventoryPanel projectId={projectId} />}</Tabs.Panel>
  </Tabs>;
}
