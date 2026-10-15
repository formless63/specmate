import { Alert, Button, Collapse, Group, Menu, Select, Stack, Tabs, Text, Textarea, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { drawingSvg, exportTables, frozenSheet, labelsSvg, sheetHtml, type Sheet } from "../../../../packages/docs/src/model";
import { labelsLbx } from "../../../../packages/docs/src/lbx";
import { toCsv, toXlsx, type Table } from "../../../../packages/docs/src/table";
import type { DrawingInput } from "../../features/cable-workbench/model";
import type { CableEditorSnapshot } from "../../features/cables/CableRecordEditor";
import { BindingEditor } from "../../features/preparation-documents/PreparationDocumentsPanel";
import { RevisionChoice } from "../../features/preparation-documents/RevisionChoice";
import { ApiError, defaults, preview, generate, download, saveFile, type Configuration, type Receipt, type Preview } from "../../features/preparation-documents/api";
import { workingSheet } from "../../features/preparation-documents/working-sheet";
import { DocumentDefaults } from "../../features/settings/DocumentDefaults";
import { listLibrary } from "../../features/workspace/api";
import { usePermission } from "../../lib/permissions";
import { randomUUID } from "../../lib/random-id";
import { canonicalJson } from "./history";
import { useNavigation } from "../../features/navigation";
import { RetainedDocuments } from "./RetainedDocuments";
import { DocumentPackage } from "./DocumentPackage";
import { ContinuityAuthor } from "./ContinuityAuthor";
import "./documents.css";

type Tab = "build" | "continuity" | "bom" | "drawing" | "labels" | "export" | "formboard";
export type RootDocumentsProps = {
  name: string; snapshot: { definitionId: string; revisionId: string | null; draftId: string | null };
  draftSheet?: Sheet | null; formboard?: (sheet: Sheet) => string;
  principalKey: string; workspaceId: string; active: boolean; authorizeWorking: () => Promise<void>;
};
export type DocumentsProps = DrawingInput & {
  name: string; snapshot: CableEditorSnapshot; principalKey: string; workspaceId: string; active: boolean;
  /** Reauthorizes the viewed draft and its exact closure without replacing the working buffer. */
  authorizeWorking: () => Promise<void>;
};
const denied = (error: unknown) => error instanceof ApiError && [401, 403, 404].includes(error.status);
const messages = (error: unknown) => error instanceof Error ? error.message : "Documents are unavailable.";
const keys = ["preparation_profile", "end_preparation_profile", "cable_test_plan", "bom_plan"];

/** Opens the actual rendered sheet in the browser print dialog, without printing shell chrome. */
export function printDocument(html: string) {
  const frame = document.createElement("iframe");
  frame.title = "Print design document"; frame.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0";
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.onload = () => {
    const target = frame.contentWindow;
    if (!target) { frame.remove(); return; }
    target.addEventListener("afterprint", () => frame.remove(), { once: true });
    target.focus(); target.print();
  };
  frame.srcdoc = html; document.body.append(frame);
}

/** Selected-record documents. Prepared configuration survives view changes; authority data never authorizes itself. */
export function Documents(props: DocumentsProps) {
  const { name, snapshot, principalKey, workspaceId, active, authorizeWorking, ...input } = props;
  return <RootDocuments name={name} snapshot={snapshot} principalKey={principalKey} workspaceId={workspaceId} active={active} authorizeWorking={authorizeWorking} draftSheet={snapshot.revisionId ? null : workingSheet(name, snapshot.definitionId, { ...input, cable: snapshot.working }, snapshot.dirty)} />;
}
/** Shared frozen-root renderer. Harnesses/devices supply only their own local-draft and Formboard adapters. */
export function RootDocuments(props: RootDocumentsProps) {
  return <DocumentSession key={`${props.principalKey}:${props.workspaceId}:${props.snapshot.definitionId}:${props.snapshot.revisionId ?? props.snapshot.draftId ?? "new"}`} {...props} />;
}
function DocumentSession({ name, snapshot, principalKey, workspaceId, active, authorizeWorking, draftSheet, formboard }: RootDocumentsProps) {
  const gate = usePermission("design.edit");
  const navigation = useNavigation();
  const routeSheet = navigation?.location.filters?.sheet;
  const [focused, setFocused] = useState(true);
  const interactive = active && focused;
  useEffect(() => { const blur = () => setFocused(false), focus = () => setFocused(true); window.addEventListener("blur", blur); window.addEventListener("focus", focus); return () => { window.removeEventListener("blur", blur); window.removeEventListener("focus", focus); }; }, []);
  const recognizedSheet = routeSheet && ["build", "continuity", "bom", "drawing", "labels", "export", ...(formboard ? ["formboard"] : [])].includes(routeSheet) ? routeSheet as Tab : "build";
  const [tab, setTab] = useState<Tab>(recognizedSheet);
  useEffect(() => { setTab(recognizedSheet); }, [recognizedSheet]); const [config, setConfig] = useState<Configuration | null>(null);
  const [authorVisited, setAuthorVisited] = useState(false), [authorOpen, setAuthorOpen] = useState(false);
  const [practiceSearch, setPracticeSearch] = useState(""), [practiceAfter, setPracticeAfter] = useState<string | null>(null), [practicePages, setPracticePages] = useState<(string | null)[]>([]);
  const [quantity, setQuantity] = useState("1"), [practices, setPractices] = useState(false), [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [accessLost, setAccessLost] = useState(false);
  const [retained, setRetained] = useState<{ fingerprint: string; receipt: Receipt } | null>(null);
  const retryIntent = useRef<{ fingerprint: string; key: string } | null>(null);
  const current = useRef({ active: interactive, fingerprint: "" });
  const configFingerprint = canonicalJson(config);
  const fingerprint = canonicalJson([config, draftSheet]);
  current.current = { active: interactive, fingerprint };
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [debounced] = useDebouncedValue(config, 250);
  const boot = useQuery({ queryKey: ["document-defaults", principalKey, workspaceId, snapshot.revisionId], queryFn: () => defaults(snapshot.revisionId!), enabled: interactive && !!snapshot.revisionId, retry: false });
  useEffect(() => { if (!config && boot.data && !boot.isError) { setConfig(boot.data.configuration); setQuantity(boot.data.configuration.quantity === null ? "" : String(boot.data.configuration.quantity)); } }, [boot.data, boot.isError, config]);
  const projected = useQuery({ queryKey: ["document-preview", principalKey, workspaceId, debounced], queryFn: () => preview(debounced!), enabled: interactive && !!snapshot.revisionId && !!debounced, retry: false });
  const choices = useQuery({ queryKey: ["document-practices", principalKey, workspaceId, practiceSearch, practiceAfter], queryFn: () => listLibrary({ family: "definition", kinds: keys, query: practiceSearch, projectId: null, after: practiceAfter, limit: 100 }), enabled: interactive && practices, retry: false });
  const [choicePending, setChoicePending] = useState(0);
  const fail = (reason: unknown) => { if (denied(reason)) setAccessLost(true); setError(messages(reason)); };
  const hidden = accessLost || boot.isError || projected.isError || denied(choices.error);
  const waiting = !!snapshot.revisionId && (!config || boot.isFetching || projected.isFetching || canonicalJson(debounced) !== configFingerprint || !projected.data);
  const quantityValid = quantity === "" || /^\d+$/.test(quantity) && Number(quantity) >= 1 && Number(quantity) <= 1e6;
  const authorized = interactive && !hidden && !waiting && quantityValid && choicePending === 0;
  const frozen = projected.data && !projected.isError && !hidden ? frozenSheet(name, snapshot.revisionId!, projected.data.sections) : null;
  if (frozen && projected.data) frozen.inputsSha256 = projected.data.manifest.inputs_sha256;
  if (frozen && config?.document_settings) frozen.titleBlock = config.document_settings;
  const sheet = snapshot.revisionId ? frozen : draftSheet ?? null;
  const tableSelection = (value: Sheet): Table[] => value.tables.filter(table => tab === "continuity" ? table.name === "Continuity expectations" : tab === "bom" ? table.name === "BOM" : tab === "labels" ? table.name === "Labels" : tab === "drawing" ? false : ["Landings", "Cuts", "End preparation"].includes(table.name));
  const renderSheet = (value: Sheet) => tab === "formboard" && formboard ? formboard(value) : sheetHtml(value, tableSelection(value), tab === "drawing" ? drawingSvg(value) : tab === "labels" ? labelsSvg(value.labels, value) : "");
  const html = sheet ? renderSheet(sheet) : "";
  function change(next: Configuration) { setConfig(next); setError(null); }
  async function refresh() {
    setBusy(true); setError(null);
    try {
      if (snapshot.revisionId) { await boot.refetch({ throwOnError: true }); if (config) await projected.refetch({ throwOnError: true }); }
      else await authorizeWorking();
      if (practices) await choices.refetch({ throwOnError: true });
      if (alive.current && current.current.active) setAccessLost(false);
    } catch (reason) { if (alive.current) fail(reason); }
    finally { if (alive.current) setBusy(false); }
  }
  async function action(work: (fresh: Sheet, reviewed?: Preview) => Promise<void> | void) {
    if (!authorized || busy || !sheet) return;
    const submitted = fingerprint; setBusy(true); setError(null);
    try {
      let fresh = sheet; let reviewed: Preview | undefined;
      if (snapshot.revisionId && config) {
        const value = await preview(config); reviewed = value;
        fresh = frozenSheet(name, snapshot.revisionId, value.sections); fresh.inputsSha256 = value.manifest.inputs_sha256;
        if (config.document_settings) fresh.titleBlock = config.document_settings;
      } else await authorizeWorking();
      if (alive.current && current.current.active && current.current.fingerprint === submitted) await work(fresh, reviewed);
    } catch (reason) { if (alive.current && current.current.fingerprint === submitted) fail(reason); }
    finally { if (alive.current) setBusy(false); }
  }
  async function retain() {
    if (!config || !gate.allowed) return;
    await action(async (_fresh, reviewed) => {
      if (!reviewed) return;
      if (!alive.current || !current.current.active || current.current.fingerprint !== fingerprint) return;
      const key = canonicalJson([config, reviewed.state]);
      if (retryIntent.current?.fingerprint !== key) retryIntent.current = { fingerprint: key, key: randomUUID() };
      const result = await generate(config, reviewed.state, retryIntent.current.key);
      if (alive.current) setRetained({ fingerprint, receipt: result });
      retryIntent.current = null;
    });
  }
  const defs = !choices.isError ? choices.data?.results.map(row => ({ definition_id: row.record_id, name: row.label, kind: row.kind ?? "unknown" })) ?? [] : [];
  const subjectPins = projected.data && !projected.isError ? projected.data.manifest.inputs.rights_reviews.map(row => row.subject) : boot.data?.rights_subjects ?? [];
  const scopes = projected.data && !projected.isError ? projected.data.manifest.context_pins : boot.data?.context_pins ?? [];
  const visibleReceipt = retained?.fingerprint === fingerprint ? retained.receipt : null;
  const tabs: [Tab, string][] = [["build", "Build sheet"], ["continuity", "Continuity spec"], ["bom", "BOM"], ["drawing", "Drawing sheet"], ["labels", "Labels"], ["export", "Export"]];
  if (formboard) tabs.splice(4, 0, ["formboard", "Formboard"]);
  return <section className="editor-documents" aria-label="Design documents" hidden={!interactive}>
    <Group className="editor-documents-controls" justify="space-between"><Tabs value={tab} onChange={value => { if (value) { setTab(value as Tab); navigation?.navigate({ filters: { ...navigation.location.filters, sheet: value } }); } }}><Tabs.List aria-label="Document sheets">{tabs.map(([value, label]) => <Tabs.Tab key={value} value={value}>{label}</Tabs.Tab>)}</Tabs.List></Tabs>
      <Group gap="xs"><Button size="xs" disabled={!authorized || !sheet || busy || tab === "export"} onClick={() => void action(fresh => printDocument(renderSheet(fresh)))}>Print</Button>
        <Menu withinPortal={false}><Menu.Target><Button size="xs" disabled={!authorized || !sheet || busy}>Export…</Button></Menu.Target><Menu.Dropdown>{sheet?.tables.map(table => <Menu.Item key={table.name} onClick={() => void action(fresh => { const value = exportTables(fresh).find(t => t.name === table.name)!; saveFile(new Blob([toCsv(value)], { type: "text/csv;charset=utf-8" }), `${table.name.toLowerCase().replaceAll(" ", "-")}.csv`); })}>{table.name} CSV</Menu.Item>)}<Menu.Item onClick={() => void action(fresh => saveFile(new Blob([new Uint8Array(toXlsx(exportTables(fresh)))], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "production.xlsx"))}>Production XLSX</Menu.Item><Menu.Item disabled={!sheet?.labels.length} onClick={() => void action(fresh => saveFile(new Blob([labelsSvg(fresh.labels, fresh)], { type: "image/svg+xml" }), "labels.svg"))}>Labels SVG</Menu.Item><Menu.Item disabled={!sheet?.labels.length} onClick={() => void action(fresh => saveFile(new Blob([new Uint8Array(labelsLbx(fresh.labels, fresh))], { type: "application/zip" }), "labels-ptouch.zip"))}>P-touch labels (80 × 12 mm)</Menu.Item></Menu.Dropdown></Menu>
        <Button size="xs" variant="quiet" loading={busy} onClick={() => void refresh()}>Refresh document access</Button></Group>
    </Group>
    {(error || boot.error || projected.error) && <Alert color="red">{error ?? messages(boot.error ?? projected.error)}</Alert>}
    {hidden && <Alert color="red">Document content is hidden until current access is confirmed. Prepared inputs remain private.</Alert>}
    {!hidden && <>
      {snapshot.revisionId && config && <div className="editor-document-form"><Group align="start"><TextInput size="xs" label="Document quantity" description="Blank keeps quantity unknown" value={quantity} error={quantity !== "" && (!/^\d+$/.test(quantity) || Number(quantity) < 1 || Number(quantity) > 1e6) ? "Use 1–1000000 or blank" : undefined} onChange={event => { const raw = event.currentTarget.value; setQuantity(raw); if (raw === "" || /^\d+$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 1e6) change({ ...config, quantity: raw === "" ? null : Number(raw) }); }} />
        <Select dropdownOpened={interactive ? undefined : false} size="xs" label="Workshop disposition" data={["unknown", "make", "buy"]} value={config.standalone_decision} onChange={value => change({ ...config, standalone_decision: value as Configuration["standalone_decision"] })} /><TextInput size="xs" label="Disposition basis" value={config.standalone_basis ?? ""} onChange={event => change({ ...config, standalone_basis: event.currentTarget.value || null })} />
        <Button size="xs" variant="quiet" aria-expanded={rights} onClick={() => setRights(value => !value)}>Rights and title block</Button><Button size="xs" variant="quiet" aria-expanded={practices} onClick={() => setPractices(value => !value)}>Practice overrides</Button></Group>
        <Collapse expanded={rights && interactive} transitionDuration={interactive ? 200 : 0}><Stack gap="xs"><Select dropdownOpened={interactive ? undefined : false} label="Document purpose" data={[{ value: "authorized_review", label: "Authorized internal review" }, { value: "distribution", label: "Reviewed distribution rights" }]} value={config.purpose} onChange={value => change({ ...config, purpose: value as Configuration["purpose"] })} /><TextInput label="Generated output rights" value={config.output_rights} onChange={event => change({ ...config, output_rights: event.currentTarget.value })} /><TextInput label="Generated output rights basis" value={config.output_rights_basis ?? ""} onChange={event => change({ ...config, output_rights_basis: event.currentTarget.value || null })} />{subjectPins.map(subject => { const value = config.rights_reviews.find(row => row.subject === subject); const update = (decision: "unknown" | "permitted" | "withheld", basis: string) => change({ ...config, rights_reviews: [...config.rights_reviews.filter(row => row.subject !== subject), { subject, decision, basis }] }); return <Group key={subject}><Text size="xs">{subject}</Text><Select dropdownOpened={interactive ? undefined : false} label={`Rights for ${subject}`} data={["unknown", "permitted", "withheld"]} value={value?.decision ?? "unknown"} onChange={decision => update(decision as "unknown" | "permitted" | "withheld", value?.basis ?? "")} /><Textarea label={`Rights basis for ${subject}`} value={value?.basis ?? ""} onChange={event => update(value?.decision ?? "unknown", event.currentTarget.value)} /></Group>; })}<DocumentDefaults workspaceId={workspaceId} active={interactive && authorized} value={config.document_settings} onChange={document_settings => { const next = { ...config }; if (document_settings) next.document_settings = document_settings; else delete next.document_settings; change(next); }} /></Stack></Collapse>
        <Collapse expanded={practices && interactive} transitionDuration={interactive ? 200 : 0}><Stack gap="xs"><Text size="xs">Exact reviewed profiles and test plans only. Unbound instructions and expectations remain unknown.</Text>{choices.isError && <Alert color="red">{messages(choices.error)}</Alert>}<TextInput label="Search practice definitions" value={practiceSearch} onChange={event => { setPracticeSearch(event.currentTarget.value); setPracticeAfter(null); setPracticePages([]); }} /><Group><Button size="compact-xs" disabled={!practicePages.length || choices.isFetching} onClick={() => { setPracticeAfter(practicePages.at(-1) ?? null); setPracticePages(pages => pages.slice(0, -1)); }}>Previous practice definitions</Button><Button size="compact-xs" disabled={!choices.data?.next_after || choices.isFetching} onClick={() => { setPracticePages(pages => [...pages, practiceAfter]); setPracticeAfter(choices.data?.next_after ?? null); }}>Next practice definitions</Button></Group><RevisionChoice label="Frozen procurement BOM" kinds={["bom_plan"]} definitions={defs} value={config.bom_plan_revision_id} onChange={bom_plan_revision_id => change({ ...config, bom_plan_revision_id })} onDenied={fail} active={interactive && practices} onActivity={started => setChoicePending(count => Math.max(0, count + (started ? 1 : -1)))} />{scopes.map(scope => { const binding = config.bindings.find(value => canonicalJson(value.occurrence_path) === canonicalJson(scope.address.path)); return binding ? <BindingEditor key={canonicalJson(scope.address.path)} value={binding} context={scope} definitions={defs} onChange={value => change({ ...config, bindings: config.bindings.map(old => old === binding ? value : old) })} onDenied={fail} active={interactive && practices} disabled={busy} onActivity={started => setChoicePending(count => Math.max(0, count + (started ? 1 : -1)))} onRemove={() => change({ ...config, bindings: config.bindings.filter(old => old !== binding) })} /> : <Button key={canonicalJson(scope.address.path)} size="xs" onClick={() => change({ ...config, bindings: [...config.bindings, { occurrence_path: scope.address.path, cut_profiles: [], end_profiles: [], test_plan_revision_id: null }] })}>Bind practices · {scope.address.path.join("/") || "standalone"}</Button>; })}</Stack></Collapse>
      </div>}
      {snapshot.revisionId && boot.data?.root.kind === "cable" && config && tab === "continuity" && <Button size="xs" variant="quiet" onClick={() => { setAuthorVisited(true); setAuthorOpen(value => !value); }} aria-expanded={authorOpen}>Author expectations and labels</Button>}
      {waiting && <Text role="status">Reading exact document inputs…</Text>}
      {authorized && sheet && <>{tab === "export" ? snapshot.revisionId && config ? <Stack gap="sm"><Text size="sm">Exact frozen root · {snapshot.revisionId}. Reviewed package downloads retain their existing rights and hash checks.</Text><Button {...gate.props} loading={busy} disabled={!gate.allowed || busy} onClick={() => void retain()}>Retain reviewed document set</Button>{visibleReceipt && <Stack><Text size="xs">Retained set {visibleReceipt.document_set_id} · input SHA-256 {visibleReceipt.sha256}</Text>{visibleReceipt.manifest.outputs.map(output => <Button key={output.filename} size="xs" variant="quiet" onClick={() => void action(async () => { const blob = await download(visibleReceipt.document_set_id, output); if (alive.current && current.current.active && current.current.fingerprint === fingerprint) saveFile(blob, output.filename); })}>Download retained {output.filename}</Button>)}</Stack>}<RetainedDocuments rootRevisionId={snapshot.revisionId} principalKey={principalKey} workspaceId={workspaceId} active={interactive && authorized} onDenied={fail} /><DocumentPackage key={`${principalKey}:${snapshot.revisionId}`} active={interactive && authorized} rootRevisionId={snapshot.revisionId} config={config} documentSetId={visibleReceipt?.document_set_id ?? null} onDenied={fail} /></Stack> : <Text>Freeze a reviewed revision to prepare a hashed package. Working sheets can be printed or exported with the UNRELEASED mark.</Text> : <iframe title={`${tab === "build" ? "Build sheet" : tab === "continuity" ? "Continuity spec" : tab === "bom" ? "BOM" : tab === "drawing" ? "Drawing sheet" : tab === "formboard" ? "Formboard" : "Labels"} preview`} sandbox="" srcDoc={html} className="editor-document-paper" />}</>}
    </>}
      {snapshot.revisionId && boot.data?.root.kind === "cable" && config && authorVisited && <ContinuityAuthor name={name} revisionId={snapshot.revisionId} principalKey={principalKey} workspaceId={workspaceId} active={interactive && authorOpen && tab === "continuity" && !hidden} boundRevisionId={config.bindings.find(binding => binding.occurrence_path.length === 0)?.test_plan_revision_id} onDenied={fail} onBound={test_plan_revision_id => { const old = config.bindings.find(binding => binding.occurrence_path.length === 0) ?? { occurrence_path: [], cut_profiles: [], end_profiles: [], test_plan_revision_id: null }; change({ ...config, bindings: [...config.bindings.filter(binding => binding.occurrence_path.length !== 0), { ...old, test_plan_revision_id }] }); }} />}
  </section>;
}
