import { Button, Drawer, Group, SegmentedControl, Tabs, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useState, type ReactNode } from "react";
import "./editor.css";

export type EditorView = "build" | "schematic" | "documents";
export type InspectorTab = "issues" | "connection" | "part" | "signals" | "notes" | "recipe";
export function EditorFrame({ name, revision, status, actions, view, onView, children }: {
  name: string; revision: ReactNode; status: ReactNode; actions: ReactNode;
  view: EditorView; onView: (view: EditorView) => void; children: ReactNode;
}) {
  return <section className="engineering-editor" aria-label={`Cable editor: ${name}`}>
    <header className="engineering-editor-toolbar">
      <Text component="h1" fw={600} size="sm">{name}</Text>{revision}{status}
      <SegmentedControl size="xs" aria-label="Cable view" value={view} onChange={next => onView(next as EditorView)} data={[{ value: "build", label: "Build" }, { value: "schematic", label: "Schematic" }, { value: "documents", label: "Documents" }]} />
      <Group gap={4}>{actions}</Group>
    </header>
    {children}
  </section>;
}
export function EditorInspector({ tab, onTab, issueCount, tabs, active = true }: {
  active?: boolean; tab: InspectorTab; onTab: (tab: InspectorTab) => void; issueCount: number; tabs: Record<InspectorTab, ReactNode>;
}) {
  const phone = useMediaQuery("(max-width: 799px)", false, { getInitialValueInEffect: false });
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(() => new Set<InspectorTab>([tab]));
  if (!visited.has(tab)) setVisited(current => new Set([...current, tab]));
  const labels: Record<InspectorTab, string> = { issues: "Issues", connection: "Connection", part: "Part", signals: "Signals", notes: "Notes", recipe: "Recipe" };
  const content = <Tabs className="engineering-inspector-tabs" value={tab} onChange={value => value && onTab(value as InspectorTab)} keepMountedMode="display-none">
    <Tabs.List aria-label="Cable inspector tabs">{Object.entries(labels).map(([key, label]) => <Tabs.Tab key={key} value={key}>{label}{key === "issues" ? ` (${issueCount})` : ""}</Tabs.Tab>)}</Tabs.List>
    {(Object.keys(labels) as InspectorTab[]).map(key => <Tabs.Panel key={key} value={key} pt="xs">{visited.has(key) ? tabs[key] : null}</Tabs.Panel>)}
  </Tabs>;
  return phone ? <>
    <div className="engineering-inspector-trigger"><Button size="xs" variant="quiet" onClick={() => setOpen(true)}>Inspector · {labels[tab]}{tab === "issues" ? ` (${issueCount})` : ""}</Button></div>
    <Drawer keepMounted transitionProps={{ duration: active ? 150 : 0 }} styles={{ inner: { display: active ? undefined : "none" }, overlay: { display: active ? undefined : "none" } }} closeButtonProps={{ "aria-label": "Close cable inspector" }} opened={open && active} onClose={() => setOpen(false)} position="right" title="Cable inspector" size="min(390px, 100vw)">{content}</Drawer>
  </> : <aside className="engineering-inspector" aria-label="Cable inspector">{content}</aside>;
}
