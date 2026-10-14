import { Alert, Button, Checkbox, Group, Popover, Select, Table, Text, TextInput, Textarea, Title } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePermission, type PermissionName } from "../../lib/permissions";
import { DeleteControl } from "../home/WorkspaceHome";
import { deleteBlocker, deleteProject, describeDependents, setArchived } from "../home/projectLifecycle";
import { ReferenceForm, type ReferenceChoice } from "../scope/ReferenceForm";
import { words } from "../scope/LibraryView";
import { AREAS, describeAccess, isReadOnly } from "../shell/areas";
import { areaForReference, floatingKind, toolForReference } from "../shell/scope";
import { addReference, listLibrary, removeReference, runOperation, type LibraryFamily, type LibraryRecord, type ProjectDetail, type ResolvedReference } from "../workspace/api";
import { readProjectWork, type ProjectWork, type WorkRead } from "./work";

type Props = {
  projectId: string;
  projectName: string;
  /** Workspace permissions of the signed-in member. */
  permissions: string[];
  /** Workspace role, when the shell knows it. */
  role?: string | null;
  /** True while the overview is the visible tool; becoming visible again refreshes it. */
  active: boolean;
  /** Opens a tool through the shell's tool setter. */
  onOpenTool: (toolId: string) => void;
  /** Called when every read is denied, so the owner can re-read membership and the project list. */
  onAccessLost?: () => Promise<void> | void;
  /** Re-reads the project list after a rename, archive or delete. */
  onProjectChanged?: () => Promise<void> | void;
  /** Leaves the project (back to Library scope), e.g. after it was deleted. */
  onLeave?: () => void;
};

/** Independent starting points; each opens the tool that owns the work. */
export const START_POINTS: { tool: string; title: string; hint: string; permission: PermissionName }[] = [
  { tool: "wire-stock", title: "Stock record", hint: "Wire, cable stock, tubing. Usable on its own.", permission: "item.create" },
  { tool: "cables", title: "Cable", hint: "Ends, conductors, preparation. No device needed.", permission: "item.create" },
  { tool: "pcb", title: "Board", hint: "From a native KiCad bundle or by hand.", permission: "source.register" },
  { tool: "assemblies", title: "Assembly", hint: "Compose exact revisions; repeat uses kept apart.", permission: "item.create" },
  { tool: "sources", title: "Import source", hint: "Original files are preserved; edits make derivatives.", permission: "source.register" },
  { tool: "physical-units", title: "Physical unit", hint: "Register something actually made or obtained.", permission: "inventory.manage" },
];

function value<T>(read: WorkRead<T> | undefined): T | null {
  return read && read.status === "ok" ? read.value : null;
}

/**
 * A project's overview: its purpose, open work and the library items it references, grouped by
 * the area that opens them. Counts are counts of references, not of owned records.
 */
function StartTile({ point, onOpenTool }: { point: (typeof START_POINTS)[number]; onOpenTool: (tool: string) => void }) {
  const gate = usePermission(point.permission);
  return <button type="button" className="sb-dash-card" aria-label={`Start: ${point.title}`} onClick={() => onOpenTool(point.tool)} {...gate.props}>
    <span className="sb-dash-card-head"><b>{point.title}</b><span className="sb-mono" aria-hidden="true" style={{ color: "var(--sb-accent)" }}>+</span></span>
    <span className="sb-dash-note">{point.hint}</span>
  </button>;
}

export function ProjectOverview({ projectId, projectName, permissions, role = null, active, onOpenTool, onAccessLost, onProjectChanged, onLeave }: Props) {
  const [work, setWork] = useState<ProjectWork | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [showRemoved, setShowRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const seenActive = useRef(active);
  const onLost = useRef(onAccessLost);
  onLost.current = onAccessLost;

  // Refresh each time the overview is shown again, because other tools change what is waiting.
  useEffect(() => {
    if (active && !seenActive.current) setTick((current) => current + 1);
    seenActive.current = active;
  }, [active]);

  useEffect(() => {
    let current = true;
    setLoading(true); setFailed(null);
    readProjectWork(projectId, showRemoved).then((result) => {
      if (!current) return;
      setWork(result); setLoading(false);
      const reads = [result.detail, result.unread, result.reviews];
      if (reads.every((read) => read.status === "unavailable" && read.denied)) {
        setWork(null);
        setFailed("This project is no longer available to you.");
        void onLost.current?.();
      }
    }).catch((reason: unknown) => {
      if (!current) return;
      setWork(null); setLoading(false);
      setFailed(reason instanceof Error ? reason.message : "Overview unavailable.");
    });
    return () => { current = false; };
  }, [projectId, permissions.join(","), tick, showRemoved]);

  const detail = value(work?.detail);
  const unread = value(work?.unread);
  const reviews = value(work?.reviews);
  const access = describeAccess(permissions, role);
  const readOnly = isReadOnly(permissions);
  const edit = usePermission("project.edit");
  const archived = !!detail?.archived;
  const editGate = archived ? { allowed: false, props: { disabled: true as const, title: "Archived projects are read-only; unarchive first" } } : edit;
  const more = (flag: boolean | undefined) => flag ? "+" : "";
  const waiting = (unread?.rows.length ?? 0) + (reviews?.open.length ?? 0);
  const unavailable = (read: WorkRead<unknown> | undefined) => !loading && !!read && read.status === "unavailable";
  const activeReferences = detail?.references.filter((ref) => !ref.removed) ?? [];

  async function change(work: () => Promise<unknown>, done: string, after?: () => void) {
    setBusy(true); setError(null); setNotice(null);
    try {
      await work();
      setNotice(done);
      after?.();
      await onProjectChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The project could not be changed.");
    } finally { setBusy(false); setTick((n) => n + 1); }
  }

  return <div className="sb-dash" aria-busy={loading}>
    <Title order={2} className="sb-dash-title">Overview</Title>
    {failed && <Alert color="red" role="alert" title="Overview unavailable">{failed}</Alert>}
    <section aria-label="Project summary"><dl className="sb-context sb-context-4">
      <Cell label="Project" value={detail?.name ?? projectName} />
      <Cell label="References" value={detail ? String(activeReferences.length) : loading ? "Loading" : "Not reported"} unknown={!detail} />
      <Cell label="Status" value={detail ? (archived ? "Archived" : "Active") : "Not reported"} unknown={!detail} />
      <Cell label="Open reviews" value={reviews ? `${reviews.open.length}${more(reviews.more)}` : loading ? "Loading" : "Not reported"} unknown={!reviews} />
    </dl></section>
    {archived && <Alert color="yellow" role="status" title="Archived">This project is read-only: its name, purpose and references stay as they are until it is unarchived.</Alert>}
    {error && <Alert color="red" role="alert" title="Project not changed">{error}</Alert>}
    {notice && <Text role="status" className="sb-dash-note">{notice}</Text>}

    <div className="sb-dash-grid">
      <div className="sb-dash-main">
        <h3 className="sb-dash-h">References <span className="sb-silk">library items this project uses</span></h3>
        {detail && <ReferenceTable detail={detail} busy={busy} editGate={editGate} showRemoved={showRemoved}
          onOpen={(ref) => onOpenTool(toolForReference(ref.kind, ref.item_kind))}
          onRemove={(ref, reason) => void change(() => removeReference(detail, ref.reference_id, reason), `${ref.label} is no longer referenced. The item stays in the library.`)} />}
        <Group gap="xs" justify="space-between">
          {detail && <AddFromLibrary detail={detail} busy={busy} editGate={editGate}
            onAdd={(record, choice) => change(async () => {
              const exact = choice.pin === "exact" && !!record.latest_revision_id;
              const kind = exact ? "revision" : floatingKind(record.family);
              if (!kind) throw new Error("Projects cannot reference this record.");
              await addReference(detail, { kind, targetId: exact ? record.latest_revision_id! : record.record_id, role: choice.role });
            }, `${record.label} is now used here${choice.pin === "exact" && record.latest_revision !== null ? ` (pinned to r${record.latest_revision})` : ""}.`)} />}
          <Checkbox size="xs" label="Show removed references" checked={showRemoved} onChange={(event) => setShowRemoved(event.currentTarget.checked)} />
        </Group>

        <h3 className="sb-dash-h">Continue where you left off <span className="sb-silk">notifications and reviews only</span></h3>
        <div className="sb-dash-list" role="group" aria-label="Open work">
          {unread?.rows.map((row) => <WorkRow key={row.notification_id} led="review" title={row.title}
            detail={`Notification · ${row.action} · unread`} action="Open notification" onOpen={() => onOpenTool("knowledge")} />)}
          {reviews?.open.map((row) => <WorkRow key={row.review_id} led="active" title={row.title}
            detail="Team review · open" action="Open review" onOpen={() => onOpenTool("knowledge")} />)}
          {!loading && work && waiting === 0 && <div className="sb-dash-empty" role="status">
            <Text>Nothing is waiting on you in this project.</Text>
            <Text className="sb-silk">Drafts and builds are not listed here; open a tool to find them.</Text></div>}
          {loading && <div className="sb-dash-empty" role="status"><Text className="sb-silk">Loading open work</Text></div>}
          {unavailable(work?.unread) && <div className="sb-dash-empty sb-hatch" role="status"><Text>Notifications are unavailable right now.</Text></div>}
          {unavailable(work?.reviews) && <div className="sb-dash-empty sb-hatch" role="status"><Text>Reviews are unavailable right now.</Text></div>}
        </div>

        <h3 className="sb-dash-h">Start something on its own <span className="sb-silk">no complete device required</span></h3>
        <div className="sb-dash-start" role="group" aria-label="Start something">
          {START_POINTS.map((point) => <StartTile key={point.tool} point={point} onOpenTool={onOpenTool} />)}
        </div>
        {readOnly && <Text className="sb-dash-note" mt="xs">You have read-only access here: starting something that creates records is unavailable. Open the tools from their areas to inspect existing records.</Text>}
      </div>

      <aside className="sb-dash-side" aria-label="Project details">
        <h3 className="sb-dash-h">Project</h3>
        {detail ? <ProjectFacts detail={detail} busy={busy} editGate={editGate}
          onSave={(name, purpose) => void change(() => runOperation("project.rename", { project_id: detail.project_id, name, purpose }, { expectedState: detail.state }), "Project details saved.")} />
          : <Text className="sb-dash-note">{loading ? "Loading" : "Not reported"}</Text>}
        <dl className="sb-kv">
          <dt className="sb-silk">Your role</dt><dd data-unknown={!access.known}>{access.label}{readOnly && <> <span className="sb-tag">read-only</span></>}</dd>
          <dt className="sb-silk">Depends on it</dt><dd>{detail ? describeDependents(detail.dependents).join(", ") || "nothing" : "–"}</dd>
        </dl>
        {detail && <Group gap={4}>
          <Button variant="quiet" size="xs" loading={busy} {...edit.props}
            onClick={() => void change(() => setArchived(detail.project_id, !archived), archived ? "The project is active again." : "The project was archived; its references and history are kept.")}>
            {archived ? "Unarchive" : "Archive"}</Button>
          <DeleteControl name={detail.name} blocker={deleteBlocker(detail, edit.allowed)} busy={busy}
            onDelete={() => void change(() => deleteProject(detail.project_id), "The project was deleted.", onLeave)} />
        </Group>}
        <Button variant="quiet" size="xs" onClick={() => onOpenTool("access")}>Workspace members and roles</Button>
      </aside>
    </div>
  </div>;
}

type EditGate = { allowed: boolean; props: { disabled?: true; title?: string } };

function ProjectFacts({ detail, busy, editGate, onSave }: { detail: ProjectDetail; busy: boolean; editGate: EditGate; onSave: (name: string, purpose: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(detail.name);
  const [purpose, setPurpose] = useState(detail.purpose);
  useEffect(() => { if (!editing) { setName(detail.name); setPurpose(detail.purpose); } }, [detail, editing]);
  if (editing) return <form aria-label="Project details" onSubmit={(event) => { event.preventDefault(); if (name.trim()) { onSave(name.trim(), purpose.trim()); setEditing(false); } }}>
    <TextInput label="Project name" size="xs" value={name} onChange={(event) => setName(event.currentTarget.value)} required maxLength={200} />
    <Textarea label="Purpose" size="xs" rows={3} value={purpose} onChange={(event) => setPurpose(event.currentTarget.value)} maxLength={2000} />
    <Group gap={4} mt={6}><Button type="submit" variant="commit" size="xs" loading={busy} disabled={!name.trim()}>Save details</Button>
      <Button variant="quiet" size="xs" onClick={() => setEditing(false)}>Cancel</Button></Group>
  </form>;
  return <dl className="sb-kv">
    <dt className="sb-silk">Name</dt><dd>{detail.name}</dd>
    <dt className="sb-silk">Purpose</dt><dd data-unknown={!detail.purpose}>{detail.purpose || "not recorded"}</dd>
    <dt className="sb-silk">Created by</dt><dd className="sb-mono">{detail.created_by}</dd>
    <dt />
    <dd><Button variant="quiet" size="xs" onClick={() => setEditing(true)} {...editGate.props}>Edit details</Button></dd>
  </dl>;
}

function ReferenceTable({ detail, busy, editGate, showRemoved, onOpen, onRemove }: {
  detail: ProjectDetail; busy: boolean; editGate: EditGate; showRemoved: boolean;
  onOpen: (ref: ResolvedReference) => void; onRemove: (ref: ResolvedReference, reason: string) => void;
}) {
  const groups = useMemo(() => AREAS.map((area) => ({
    area, rows: detail.references.filter((ref) => (showRemoved || !ref.removed) && areaForReference(ref.kind, ref.item_kind) === area.id),
  })).filter((group) => group.rows.length > 0), [detail, showRemoved]);
  if (groups.length === 0) return <div className="sb-dash-empty" role="status">
    <Text>This project references nothing yet.</Text>
    <Text className="sb-silk">Add items from the library below, or with Use in project in any library lens</Text>
  </div>;
  return <div className="sb-ws-scroll" role="group" aria-label="Project references"><Table className="sb-ws-table" verticalSpacing={4} horizontalSpacing="sm">
    <Table.Thead><Table.Tr><Table.Th>Item</Table.Th><Table.Th>Kind</Table.Th><Table.Th>Pin</Table.Th><Table.Th>Role</Table.Th><Table.Th>Added by</Table.Th>
      <Table.Th><span className="sb-visually-hidden">Actions</span></Table.Th></Table.Tr></Table.Thead>
    {groups.map(({ area, rows }) => <Table.Tbody key={area.id} aria-label={`${area.label} references`}>
      <Table.Tr className="sb-ws-group"><Table.Th colSpan={6} scope="rowgroup">{area.label} <span className="sb-mono">{rows.length}</span></Table.Th></Table.Tr>
      {rows.map((ref) => <Table.Tr key={ref.reference_id} data-removed={ref.removed || undefined}>
        <Table.Td><button type="button" className="sb-ws-open" aria-label={`Open ${ref.label}`} onClick={() => onOpen(ref)}><span className="sb-home-name">{ref.label}</span></button></Table.Td>
        <Table.Td className="sb-mono">{words(ref.item_kind)}</Table.Td>
        <Table.Td className="sb-mono">{ref.pin === "exact" ? <span className="sb-tag" title="Pinned to an exact revision">{`exact r${ref.revision}`}</span>
          : <span title={ref.latest_revision ? `Latest frozen r${ref.latest_revision}` : "No frozen revision yet"}>floating</span>}</Table.Td>
        <Table.Td className="sb-mono">{ref.role}</Table.Td>
        <Table.Td className="sb-mono">{ref.added_by}</Table.Td>
        <Table.Td className="sb-ws-num">{ref.removed ? <span className="sb-dash-note" title={ref.removal_reason}>removed</span>
          : <RemoveReference label={ref.label} busy={busy} editGate={editGate} onRemove={(reason) => onRemove(ref, reason)} />}</Table.Td>
      </Table.Tr>)}
    </Table.Tbody>)}
  </Table></div>;
}

function RemoveReference({ label, busy, editGate, onRemove }: { label: string; busy: boolean; editGate: EditGate; onRemove: (reason: string) => void }) {
  const [opened, setOpened] = useState(false);
  const [reason, setReason] = useState("No longer used");
  return <Popover opened={opened} onChange={setOpened} position="bottom-end" withinPortal trapFocus>
    <Popover.Target><Button variant="quiet" size="xs" aria-label={`Remove reference to ${label}`} onClick={() => setOpened((v) => !v)} {...editGate.props}>Remove</Button></Popover.Target>
    <Popover.Dropdown>
      <form aria-label={`Remove the reference to ${label}`} onSubmit={(event) => { event.preventDefault(); if (reason.trim()) { setOpened(false); onRemove(reason.trim()); } }}>
        <TextInput label="Reason" size="xs" value={reason} onChange={(event) => setReason(event.currentTarget.value)} required maxLength={1000} />
        <Button type="submit" variant="commit" size="xs" mt={6} loading={busy} disabled={!reason.trim()}>Remove reference</Button>
      </form>
    </Popover.Dropdown>
  </Popover>;
}

const FAMILIES: { value: LibraryFamily; label: string }[] = [
  { value: "definition", label: "Definitions" }, { value: "source_bundle", label: "Source bundles" }, { value: "physical_unit", label: "Physical units" },
];

/** Search the library and add a floating or exact reference to this project. */
function AddFromLibrary({ detail, busy, editGate, onAdd }: { detail: ProjectDetail; busy: boolean; editGate: EditGate; onAdd: (record: LibraryRecord, choice: ReferenceChoice) => Promise<void> }) {
  const [opened, setOpened] = useState(false);
  const [family, setFamily] = useState<LibraryFamily>("definition");
  const [text, setText] = useState("");
  const [query] = useDebouncedValue(text.trim(), 250);
  const [rows, setRows] = useState<LibraryRecord[] | null>(null);
  const [chosen, setChosen] = useState<LibraryRecord | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (!opened) return;
    let current = true;
    setRows(null); setFailure(null);
    listLibrary({ family, kinds: [], query, projectId: detail.project_id, after: null, limit: 12 })
      .then((page) => { if (current) setRows(page.results); })
      .catch((reason: unknown) => { if (current) setFailure(reason instanceof Error ? reason.message : "Library unavailable."); });
    return () => { current = false; };
  }, [opened, family, query, detail.project_id]);
  return <Popover opened={opened} onChange={setOpened} position="bottom-start" withinPortal trapFocus width={420}>
    <Popover.Target><Button variant="primary" size="xs" onClick={() => { setChosen(null); setOpened((v) => !v); }} {...editGate.props}>Add from library…</Button></Popover.Target>
    <Popover.Dropdown>
      {chosen ? <ReferenceForm itemLabel={chosen.label} latestRevision={chosen.latest_revision} canPin={chosen.family === "definition"} projects={[]}
        fixedProjectId={detail.project_id} busy={busy} onCancel={() => setChosen(null)}
        onSubmit={(choice) => { void onAdd(chosen, choice); setOpened(false); }} />
      : <div className="sb-dash" style={{ gap: 6 }}>
        <Group gap={6} wrap="nowrap">
          <Select aria-label="Library family" size="xs" w={150} data={FAMILIES} value={family} allowDeselect={false} comboboxProps={{ withinPortal: false }}
            onChange={(value) => value && setFamily(value as LibraryFamily)} />
          <TextInput aria-label="Search the library" placeholder="search by name" size="xs" style={{ flex: 1 }} value={text} onChange={(event) => setText(event.currentTarget.value)} data-autofocus />
        </Group>
        {failure && <Text role="alert" className="sb-dash-note">{failure}</Text>}
        {rows === null && !failure && <Text role="status" className="sb-dash-note">Reading the library…</Text>}
        {rows?.length === 0 && <Text role="status" className="sb-dash-note">Nothing matches.</Text>}
        {rows && rows.length > 0 && <div className="sb-dash-list" role="list" aria-label="Library matches">{rows.map((row) => <div key={row.record_id} role="listitem" className="sb-usedin-row">
          <span className="sb-dash-row-title">{row.label}</span><span className="sb-mono sb-dash-note">{words(row.kind)}</span>
          <span style={{ flex: 1 }} />
          {row.referenced ? <span className="sb-tag">used here</span> : <Button variant="quiet" size="xs" aria-label={`Choose ${row.label}`} onClick={() => setChosen(row)}>Choose</Button>}
        </div>)}</div>}
      </div>}
    </Popover.Dropdown>
  </Popover>;
}

function Cell({ label, value, unknown = false, title }: { label: string; value: string; unknown?: boolean; title?: string }) {
  return <div className={`sb-cell${unknown ? " sb-hatch" : ""}`}>
    <dt className="sb-silk">{label}</dt>
    <dd data-unknown={unknown} title={title ?? value}>{value}</dd>
  </div>;
}

function WorkRow({ led, title, detail, action, onOpen }: { led: "review" | "active"; title: string; detail: string; action: string; onOpen: () => void }) {
  return <div className="sb-dash-row">
    <span className="sb-led" data-state={led} aria-hidden="true" />
    <span className="sb-dash-row-title" title={title}>{title}</span>
    <Button variant="quiet" size="xs" aria-label={`${action}: ${title}`} onClick={onOpen}>{action}</Button>
    <span />
    <span className="sb-dash-note">{detail}</span>
  </div>;
}
