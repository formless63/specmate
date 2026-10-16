import { useHistoryIdentity } from '../../features/history/HistoryScope';
import { Button, Drawer, Group, ScrollArea, Tabs, Text, Title } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { SbIdentityBadge } from "../sb";
import "./record.css";

const RecordHistory = lazy(() => import("../../features/history/History").then(module => ({ default: module.RecordHistory })));

export type RecordState = { kind: "new" } | { kind: "draft"; id: string; version: number; dirty: boolean } | { kind: "revision"; id: string; number: number };
export type RecordSection = { id: string; label: string; content: () => ReactNode };
export type RecordPageProps = {
  layout?: 'workbench' | 'section';
  active: boolean;
  identity: { id?: string; name: string; kind: string; pn?: string };
  state: RecordState;
  actions?: ReactNode;
  revisions?: ReactNode;
  facts?: ReactNode;
  notice?: ReactNode;
  views: { id: string; label: string; content: ReactNode }[];
  view: string;
  onView: (value: string) => void;
  inspector: RecordSection[];
  inspectorTab?: string;
  onInspectorTab?: (value: string) => void;
};

/** Shared drawing-first record frame. Domain state, authority and writes stay in its controller. */
export function RecordPage({ layout = 'workbench', active, identity, state, actions, revisions, facts, notice, views, view, onView, inspector: givenInspector, inspectorTab, onInspectorTab }: RecordPageProps) {
  const historyIdentity = useHistoryIdentity();
  const inspector = historyIdentity && identity.id && !givenInspector.some(section => section.id === "history") ? [...givenInspector, { id: "history", label: "History", content: () => <Suspense fallback={<Text>Reading history…</Text>}><RecordHistory definitionId={identity.id!} active={active && tab === "history" && (!compact || sheet)} /></Suspense> }] : givenInspector;
  const phone = useMediaQuery("(max-width: 48em)"), compact = layout !== 'section' && phone;
  const [sheet, setSheet] = useState(false);
  const [ownTab, setOwnTab] = useState(inspector[0]?.id ?? "");
  const requestedTab = inspectorTab ?? ownTab;
  const tab = inspector.some(section => section.id === requestedTab) ? requestedTab : inspector[0]?.id ?? "";
  const [visited, setVisited] = useState(() => new Set([tab]));
  useEffect(() => { setVisited(current => new Set([...current, tab])); }, [tab]);
  const choose = (value: string | null) => { if (value) { setOwnTab(value); onInspectorTab?.(value); } };
  const label = state.kind === "revision" ? `Frozen r${state.number}` : state.kind === "draft" ? `Draft v${state.version}${state.dirty ? " · unsaved" : ""}` : "New · unsaved";
  const panel = <Tabs value={tab} onChange={choose} className="record-inspector-tabs" keepMounted>
    <Tabs.List aria-label="Record inspector">{inspector.map(section => <Tabs.Tab key={section.id} value={section.id}>{section.label}</Tabs.Tab>)}</Tabs.List>
    {inspector.map(section => <Tabs.Panel value={section.id} key={section.id}><ScrollArea className="record-inspector-scroll" type="auto">{visited.has(section.id) && section.content()}</ScrollArea></Tabs.Panel>)}
  </Tabs>;
  return <section className={`record-page${layout === 'section' ? ' record-section-page' : ''}`} aria-label={`${identity.name} record`}>
    <header className="record-head"><div className="record-heading"><Title order={1}>{identity.name}</Title><span className="sb-tag">{identity.kind.replaceAll("_", " ")}</span><SbIdentityBadge kind={state.kind === "revision" ? "frozen" : "draft"}>{label}</SbIdentityBadge>
      {identity.pn !== undefined && <Text size="xs" className="sb-mono" title="Part number">PN {identity.pn}</Text>}</div><Group gap="xs">{compact && <Button className="record-inspector-trigger" aria-haspopup="dialog" variant="quiet" onClick={() => setSheet(true)}>Inspector · {inspector.find(section => section.id === tab)?.label}</Button>}{actions}</Group></header>
    {notice}
    {revisions && <div className="record-revisions">{revisions}</div>}
    {facts && <div className="record-facts">{facts}</div>}
    <div className="record-workbench">
      <div className="record-workspace"><Tabs value={view} onChange={value => value && onView(value)} keepMounted>
        <Tabs.List aria-label="Record views">{views.map(item => <Tabs.Tab key={item.id} value={item.id}>{item.label}</Tabs.Tab>)}</Tabs.List>
        {views.map(item => <Tabs.Panel key={item.id} value={item.id}>{item.content}</Tabs.Panel>)}
      </Tabs></div>
      {layout === 'section' ? <details className="record-section-details"><summary>Record details</summary>{panel}</details> : !compact && <aside className="record-inspector" aria-label="Record inspector panel">{panel}</aside>}
    </div>
    {compact && <><Drawer opened={active && sheet} onClose={() => setSheet(false)} position="bottom" size="72dvh" title="Record inspector" closeButtonProps={{ "aria-label": "Close record inspector" }} keepMounted transitionProps={{ duration: active ? 200 : 0 }} styles={active ? undefined : { inner: { display: "none" }, overlay: { display: "none" } }}>{panel}</Drawer></>}
  </section>;
}

/** Secondary record information is disclosed where it is used, never appended as a page stack. */
export function RecordSections({ sections }: { sections: RecordSection[] }) {
  const [visited, setVisited] = useState(new Set<string>());
  return <div className="record-sections">{sections.map(section => <details key={section.id} onToggle={event => { if (event.currentTarget.open) setVisited(current => new Set([...current, section.id])); }}>
    <summary>{section.label}</summary>{visited.has(section.id) && <div className="record-section-content">{section.content()}</div>}
  </details>)}</div>;
}
