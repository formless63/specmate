import { ReadOnlyNote, useCan, usePermission } from "../../lib/permissions";
import { Alert, Badge, Button, Card, Checkbox, FileInput, Group, Select, Stack, Table, Text, TextInput, Textarea, Title } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { randomUUID } from "../../lib/random-id";
import { KnowledgeScope, useKnowledgeScope, useCurrent, useIntentKey, useKnowledgeQuery } from "./lifecycle";
import { downloadUrl, lookup, operate, preserveAttachment, read, type AttachmentRef, type Content, type DecisionStatus, type Definition, type Identity, type Item, type ItemPage, type Kind, type Link, type RevisionDetail, type SourcePage, type Target, type TargetItems } from "./api";

import { newestFirst } from '../../lib/revision-labels';
const DECISIONS: DecisionStatus[] = ["proposed", "accepted", "rejected", "superseded"];

/** Notes, decisions and attachment references linked to exact objects. Pass `target` to embed it for a selection. */
/** `canCreate` (item.create) adds knowledge items; `canEdit` (design.edit) revises and links them. */
export function KnowledgePanel({ workspaceId, projectId, target, principalKey = "session", onAccessLost }: { workspaceId: string; projectId?: string; target?: Target; principalKey?: string; onAccessLost?: () => void }) {
  const canEdit = useCan("design.edit");
  const canCreate = useCan("item.create");
  return <ScopedWorkspace key={`${workspaceId}:${projectId ?? ""}:${principalKey}:${canEdit}:${canCreate}:${JSON.stringify(target ?? null)}`} workspaceId={workspaceId} projectId={projectId} canEdit={canEdit} canCreate={canCreate} target={target} onAccessLost={onAccessLost} />;
}
function ScopedWorkspace({ workspaceId, projectId, canEdit, canCreate, target, onAccessLost }: { workspaceId: string; projectId?: string; canEdit: boolean; canCreate: boolean; target?: Target; onAccessLost?: () => void }) {
  const cache = useQueryClient();
  const [id] = useState(randomUUID);
  const active = useRef(true);
  const readers = useRef(new Set<string>());
  const [pending, setPending] = useState(false);
  const reading = useCallback((key: string, waiting: boolean) => { if (waiting) readers.current.add(key); else readers.current.delete(key); setPending(readers.current.size > 0); }, []);
  const scope = useMemo(() => ({ id, pending, reading, onAccessLost: () => onAccessLost?.(), current: () => active.current }), [id, pending, reading, onAccessLost]);
  useEffect(() => {
    active.current = true;
    const refresh = () => { void cache.invalidateQueries({ predicate: query => query.queryKey[1] === id }); };
    window.addEventListener("focus", refresh);
    return () => { active.current = false; window.removeEventListener("focus", refresh); void cache.cancelQueries({ predicate: query => query.queryKey[1] === id }); cache.removeQueries({ predicate: query => query.queryKey[1] === id }); };
  }, [cache, id]);
  return <KnowledgeScope.Provider value={scope}><KnowledgeWorkspace workspaceId={workspaceId} projectId={projectId} canEdit={canEdit} canCreate={canCreate} fixedTarget={target} /></KnowledgeScope.Provider>;
}

function KnowledgeWorkspace({ workspaceId, projectId, canEdit, canCreate, fixedTarget }: { workspaceId: string; projectId?: string; canEdit: boolean; canCreate: boolean; fixedTarget?: Target }) {
  const cache = useQueryClient();
  const scope = useKnowledgeScope();
  const [chosen, setChosen] = useState<Target | null>(fixedTarget ?? null);
  const [targetReady, setTargetReady] = useState(false);
  const [projectReady, setProjectReady] = useState(false);
  const [itemId, setItemId] = useState<string | null>(null);
  return <Stack>
    <Title order={2}>Notes, decisions and attachments</Title>
    <Button onClick={() => { void cache.invalidateQueries({ predicate: query => query.queryKey[1] === scope.id }); }}>Refresh current knowledge authority</Button>
    <Text>One item keeps one identity and can be linked to several exact objects. A revision, each contextual occurrence and each physical unit are separate targets. Removing a link keeps the item, its attachments and its other links.</Text>
    {!fixedTarget && <TargetPicker workspaceId={workspaceId} projectId={projectId} onChoose={target => { setTargetReady(false); setChosen(target); }} />}
    {chosen && <TargetItemsCard key={JSON.stringify(chosen)} target={chosen} onOpen={setItemId} onReady={setTargetReady} />}
    <WorkspaceItems workspaceId={workspaceId} projectId={projectId} onOpen={setItemId} onReady={setProjectReady} />
    {canCreate && <CreateItem workspaceId={workspaceId} projectId={projectId} target={chosen} onCreated={setItemId} projectReady={projectReady} targetReady={targetReady} />}
    {itemId && <ItemDetail key={`${itemId}:${JSON.stringify(chosen)}`} itemId={itemId} workspaceId={workspaceId} canEdit={canEdit} target={chosen} targetReady={targetReady} />}
  </Stack>;
}

function TargetPicker({ workspaceId, projectId, onChoose }: { workspaceId: string; projectId?: string; onChoose: (target: Target) => void }) {
  const [kind, setKind] = useState<Target["kind"]>("revision");
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [snapshotId, setSnapshotId] = useState("");
  const [path, setPath] = useState("");
  const [unitId, setUnitId] = useState<string | null>(null);
  const [featureId, setFeatureId] = useState("");
  const definitions = useKnowledgeQuery(["knowledge-definitions", workspaceId], () => read<Definition[]>(`workspaces/${workspaceId}/definitions`), kind === "definition" || kind === "revision");
  const identity = useKnowledgeQuery(["knowledge-definition", definitionId], () => read<Identity>(`catalog/definitions/${definitionId}`), kind === "revision" && !!definitionId);
  const units = useKnowledgeQuery(["knowledge-units", workspaceId], () => read<{ units: { unit_id: string; serial: string; revision_id: string }[] }>(`physical-units/workspaces/${workspaceId}?offset=0&limit=100`), kind === "physical_unit");
  const feature = featureId || null;
  const target: Target | null = kind === "project" ? (projectId ? { kind, project_id: projectId } : null)
    : kind === "definition" ? (definitionId ? { kind, definition_id: definitionId, feature_id: feature } : null)
    : kind === "revision" ? (revisionId ? { kind, revision_id: revisionId, feature_id: feature } : null)
    : kind === "physical_unit" ? (unitId ? { kind, unit_id: unitId } : null)
    : snapshotId.trim() && path.trim() ? { kind, snapshot_id: snapshotId.trim(), path: path.split("/"), feature_id: feature } : null;
  return <Card withBorder><Stack>
    <Title order={3}>Choose an exact object</Title>
    <Select label="Knowledge target kind" value={kind} allowDeselect={false} data={[...(projectId ? [{ value: "project", label: "Project" }] : []), { value: "definition", label: "Definition (all revisions)" }, { value: "revision", label: "Exact revision" }, { value: "occurrence", label: "Contextual occurrence" }, { value: "physical_unit", label: "Physical unit" }]} onChange={(value) => setKind(value as Target["kind"])} />
    {(kind === "definition" || kind === "revision") && <Select label="Knowledge definition" searchable value={definitionId} data={(definitions.data ?? []).map((d) => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} onChange={(id) => { setDefinitionId(id); setRevisionId(null); }} />}
    {kind === "revision" && <Select label="Knowledge exact revision" value={revisionId} data={newestFirst(identity.data?.revisions ?? []).map((r) => ({ value: r.revision_id, label: `Revision ${r.number}` }))} onChange={setRevisionId} />}
    {kind === "occurrence" && <><TextInput label="Knowledge root assembly snapshot ID" value={snapshotId} onChange={(e) => setSnapshotId(e.currentTarget.value)} /><TextInput label="Knowledge occurrence path" description="Stable local occurrence IDs separated by /." value={path} onChange={(e) => setPath(e.currentTarget.value)} /></>}
    {kind === "physical_unit" && <Select label="Knowledge physical unit" searchable value={unitId} data={(units.data?.units ?? []).map((u) => ({ value: u.unit_id, label: u.serial }))} onChange={setUnitId} />}
    {kind !== "project" && kind !== "physical_unit" && <TextInput label="Knowledge feature ID" description="Optional and kept exactly; feature existence is not evaluated." value={featureId} onChange={(e) => setFeatureId(e.currentTarget.value)} />}
    {[definitions, identity, units].map((query, index) => query.isError ? <Alert key={index} color="red">{query.error.message}</Alert> : null)}
    <Button disabled={!target || (kind === "definition" && !definitions.data) || (kind === "revision" && !identity.data) || (kind === "physical_unit" && !units.data)} onClick={() => target && onChoose(target)}>Show knowledge for this object</Button>
  </Stack></Card>;
}

function TargetItemsCard({ target, onOpen, onReady }: { target: Target; onOpen: (id: string) => void; onReady: (ready: boolean) => void }) {
  const [offset, setOffset] = useState(0);
  const cache = useQueryClient();
  const scope = useKnowledgeScope();
  const items = useKnowledgeQuery(["knowledge-target", target, offset], () => lookup<TargetItems>("knowledge.for_target", { target, offset }));
  useEffect(() => { onReady(!!items.data); }, [items.data, onReady]);
  useEffect(() => { if (items.isError) void cache.invalidateQueries({ queryKey: ["knowledge-item", scope.id] }); }, [cache, scope.id, items.error, items.isError]);
  return <Card withBorder><Stack>
    <Title order={3}>Linked to {items.data?.target.label ?? "the chosen object"}</Title>
    {items.data?.target.feature_status && <Text size="sm">Feature existence: {items.data.target.feature_status.replaceAll("_", " ")}</Text>}
    {items.isError && <Alert color="red">{items.error.message}</Alert>}
    {items.data && (items.data.items.length ? <ItemTable items={items.data.items} onOpen={onOpen} /> : <Text>No readable knowledge is linked to this exact object.</Text>)}
    <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous linked items</Button><Button disabled={!items.data?.has_more} onClick={() => setOffset(offset + 50)}>Next linked items</Button></Group>
  </Stack></Card>;
}

function WorkspaceItems({ workspaceId, projectId, onOpen, onReady }: { workspaceId: string; projectId?: string; onOpen: (id: string) => void; onReady: (ready: boolean) => void }) {
  const [offset, setOffset] = useState(0);
  const [projectOnly, setProjectOnly] = useState(!!projectId);
  const filter = projectOnly && projectId ? projectId : null;
  const items = useKnowledgeQuery(["knowledge-workspace", workspaceId, filter, offset], () => read<ItemPage>(`knowledge/workspaces/${workspaceId}/items?offset=${offset}${filter ? `&project_id=${filter}` : ""}`));
  useEffect(() => { onReady(!!items.data); }, [items.data, onReady]);
  return <Card withBorder><Stack>
    <Title order={3}>{filter ? "Project knowledge" : "Workspace knowledge"}</Title>
    {projectId && <Checkbox label="Only notes and decisions held by this project" checked={projectOnly} onChange={(e) => { setProjectOnly(e.currentTarget.checked); setOffset(0); }} />}
    {items.isError && <Alert color="red">{items.error.message}</Alert>}
    {items.data && (items.data.items.length ? <ItemTable items={items.data.items} onOpen={onOpen} /> : <Text>No knowledge items yet.</Text>)}
    <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous items</Button><Button disabled={!items.data?.has_more} onClick={() => setOffset(offset + 50)}>Next items</Button></Group>
  </Stack></Card>;
}

function ItemTable({ items, onOpen }: { items: ItemPage["items"]; onOpen: (id: string) => void }) {
  return <Table><Table.Thead><Table.Tr><Table.Th>Title</Table.Th><Table.Th>Kind</Table.Th><Table.Th>Entry</Table.Th><Table.Th>Attachments</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>
    {items.map((item) => <Table.Tr key={item.link_id ?? item.item_id}><Table.Td>{item.current.title}</Table.Td><Table.Td>{item.kind}{item.current.decision_status ? ` · ${item.current.decision_status}` : ""}</Table.Td><Table.Td>{item.current.number}</Table.Td><Table.Td>{item.current.attachments.length}</Table.Td><Table.Td><Button size="xs" variant="light" onClick={() => onOpen(item.item_id)} aria-label={`Open ${item.current.title}`}>Open</Button></Table.Td></Table.Tr>)}
  </Table.Tbody></Table>;
}

function AttachmentEditor({ sourceScope, value, onChange, blocked, onBusy }: { sourceScope: string; value: AttachmentRef[]; onChange: (refs: AttachmentRef[]) => void; blocked: boolean; onBusy: (busy: boolean) => void }) {
  const registerGate = usePermission("source.register");
  const [file, setFile] = useState<File | null>(null);
  const [rights, setRights] = useState("");
  const [label, setLabel] = useState("");
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const sources = useKnowledgeQuery(["knowledge-sources", sourceScope], () => read<SourcePage>(`sources/workspaces/${sourceScope}/revisions`));
  const detail = useKnowledgeQuery(["knowledge-source", revisionId], () => read<RevisionDetail>(`sources/revisions/${revisionId}`), !!revisionId);
  const currentScope = useCurrent();
  const uploadIntent = useRef<{ file: File; rights: string; key: string } | null>(null);
  const upload = useMutation({ mutationFn: ({file, rights, label}: {file: File; rights: string; label: string}) => { if (uploadIntent.current?.file !== file || uploadIntent.current?.rights !== rights) uploadIntent.current = { file, rights, key: randomUUID() }; return preserveAttachment(sourceScope, file, rights, label, uploadIntent.current.key, currentScope); }, onSuccess: ref => { if (!currentScope()) return; uploadIntent.current = null; onChange([...value, ref]); setFile(null); setLabel(""); } });
  useEffect(() => { onBusy(upload.isPending); }, [onBusy, upload.isPending]);
  const add = (ref: AttachmentRef) => { if (!value.some((v) => v.bundle_revision_id === ref.bundle_revision_id && v.path === ref.path)) onChange([...value, ref]); };
  return <Stack gap="xs">
    <Text fw={600}>Attachments</Text>
    <Text size="sm">Files are preserved as source revisions with declared rights. An attachment references those exact bytes; it is never copied into another blob.</Text>
    {value.map((ref) => <Group key={`${ref.bundle_revision_id}/${ref.path}`}><Text size="sm">{ref.label || ref.path} · {ref.path}</Text><Button size="xs" variant="subtle" disabled={blocked || upload.isPending} onClick={() => onChange(value.filter((v) => v !== ref))} aria-label={`Remove attachment ${ref.path}`}>Remove</Button></Group>)}
    <Group align="end"><FileInput label="New attachment file" disabled={blocked || upload.isPending} value={file} onChange={setFile} clearable /><TextInput label="Declared rights" disabled={blocked || upload.isPending} description="Required, for example original-work or license name." value={rights} onChange={(e) => setRights(e.currentTarget.value)} /><TextInput label="Attachment label" disabled={blocked || upload.isPending} value={label} onChange={(e) => setLabel(e.currentTarget.value)} /><Button disabled={blocked || !file || !rights.trim()} loading={upload.isPending} onClick={() => upload.mutate({file: file!, rights: rights.trim(), label: label.trim()})} {...registerGate.props}>Preserve and attach</Button><ReadOnlyNote permission="source.register">Uploading new attachments is unavailable; existing source files can still be attached.</ReadOnlyNote></Group>
    {upload.isError && <Alert color="red">{upload.error.message}</Alert>}
    <Group align="end"><Select label="Existing source revision" searchable value={revisionId} data={newestFirst(sources.data?.revisions ?? []).map((r) => ({ value: r.revision_id, label: `${r.name} · revision ${r.number}` }))} onChange={(id) => { setRevisionId(id); setPath(null); }} /><Select label="Existing source file" value={path} data={(detail.data?.manifest.files ?? []).map((f) => ({ value: f.path, label: `${f.path} · ${f.rights}` }))} onChange={setPath} /><Button disabled={blocked || upload.isPending || !revisionId || !path || !detail.data} onClick={() => add({ bundle_revision_id: revisionId!, path: path!, label: label.trim() })}>Attach existing file</Button></Group>
    {sources.isError && <Alert color="red">{sources.error.message}</Alert>}
    {detail.isError && <Alert color="red">{detail.error.message}</Alert>}
  </Stack>;
}

function ContentForm({ sourceScope, kind, initial, submitLabel, busy, blocked = false, onSubmit }: { sourceScope: string; kind: Kind; initial?: Content; submitLabel: string; busy: boolean; blocked?: boolean; onSubmit: (content: Content) => void }) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [status, setStatus] = useState<DecisionStatus | null>(initial?.decision_status ?? (kind === "decision" ? "proposed" : null));
  const [attachments, setAttachments] = useState<AttachmentRef[]>(initial?.attachments ?? []);
  const [uploadBusy, setUploadBusy] = useState(false);
  const missing = !title.trim() || (kind === "attachment" && !attachments.length) || (kind === "note" && !body.trim() && !attachments.length);
  return <Stack>
    <TextInput label="Knowledge title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
    <Textarea label={kind === "decision" ? "Decision and rationale" : "Knowledge text"} minRows={3} value={body} onChange={(e) => setBody(e.currentTarget.value)} />
    {kind === "decision" && <Select label="Decision status" value={status} allowDeselect={false} data={DECISIONS} onChange={(value) => setStatus(value as DecisionStatus)} />}
    <AttachmentEditor sourceScope={sourceScope} value={attachments} onChange={setAttachments} blocked={blocked || busy} onBusy={setUploadBusy} />
    {kind === "attachment" && !attachments.length && <Text size="sm">An attachment item needs at least one referenced file.</Text>}
    <Button disabled={missing || blocked || uploadBusy} loading={busy} onClick={() => onSubmit({ title: title.trim(), body, decision_status: kind === "decision" ? status : null, attachments })}>{submitLabel}</Button>
  </Stack>;
}

function CreateItem({ workspaceId, projectId, target, onCreated, projectReady, targetReady }: { workspaceId: string; projectId?: string; target: Target | null; onCreated: (id: string) => void; projectReady: boolean; targetReady: boolean }) {
  const cache = useQueryClient();
  const [kind, setKind] = useState<Kind>("note");
  const [linkChosen, setLinkChosen] = useState(true);
  const [holdInProject, setHoldInProject] = useState(!!projectId);
  const currentScope = useCurrent(); const intent = useIntentKey();
  const scope = useKnowledgeScope();
  const currentTarget = useRef(JSON.stringify(target)); currentTarget.current = JSON.stringify(target);
  const create = useMutation({
    mutationFn: ({ payload }: { payload: object; targetKey: string }) => { return operate<Item>("knowledge.create", payload, undefined, intent.for("knowledge.create", payload)); },
    onSuccess: async (item, variables) => { if (!currentScope() || variables.targetKey !== currentTarget.current) return; intent.complete(); onCreated(item.item_id); await cache.invalidateQueries({ queryKey: ["knowledge-workspace", scope.id, workspaceId] }); await cache.invalidateQueries({ queryKey: ["knowledge-target", scope.id] }); },
  });
  return <Card withBorder><Stack>
    <Title order={3}>Record knowledge</Title>
    <Select label="Knowledge kind" value={kind} allowDeselect={false} data={[{ value: "note", label: "Note" }, { value: "decision", label: "Decision" }, { value: "attachment", label: "Attachment reference" }]} onChange={(value) => setKind(value as Kind)} />
    <Checkbox label={target ? "Link to the chosen object" : "No object chosen; the item is created without links"} disabled={!target} checked={!!target && linkChosen} onChange={(e) => setLinkChosen(e.currentTarget.checked)} />
    {projectId && <Checkbox label="Hold this item in the current project (otherwise it is a library note)" checked={holdInProject} onChange={(e) => setHoldInProject(e.currentTarget.checked)} />}
    <ContentForm key={kind} sourceScope={workspaceId} kind={kind} submitLabel="Create knowledge item" busy={create.isPending} blocked={!projectReady || (!!target && linkChosen && !targetReady)} onSubmit={(content) => create.mutate({ payload: { workspace_id: workspaceId, ...(projectId && holdInProject ? { project_id: projectId } : {}), kind, content, links: target && linkChosen ? [target] : [] }, targetKey: JSON.stringify(target) })} />
    {create.isError && <Alert color="red">{create.error.message}</Alert>}
  </Stack></Card>;
}

function ItemDetail({ itemId, workspaceId, canEdit, target, targetReady }: { itemId: string; workspaceId: string; canEdit: boolean; target: Target | null; targetReady: boolean }) {
  const cache = useQueryClient();
  const item = useKnowledgeQuery(["knowledge-item", itemId], () => read<Item>(`knowledge/items/${itemId}`));
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState<{ state: string; number: number; kind: Kind; workspaceId: string; content: Content } | null>(null);
  const currentScope = useCurrent();
  const scope = useKnowledgeScope();
  const linkIntent = useIntentKey(); const unlinkIntent = useIntentKey(); const reviseIntent = useIntentKey();
  const refresh = async () => { await cache.invalidateQueries({ queryKey: ["knowledge-item", scope.id, itemId] }); await cache.invalidateQueries({ queryKey: ["knowledge-target", scope.id] }); await cache.invalidateQueries({ queryKey: ["knowledge-workspace", scope.id, workspaceId] }); };
  const link = useMutation({ mutationFn: () => { const payload = { item_id: itemId, target }; return operate<Link & { created: boolean }>("knowledge.link", payload, undefined, linkIntent.for("knowledge.link", payload)); }, onSuccess: async () => { if (!currentScope()) return; linkIntent.complete(); await refresh(); }, onError: async () => { if (currentScope()) await refresh(); } });
  const unlink = useMutation({ mutationFn: (linkId: string) => { const payload = { link_id: linkId, reason: reason.trim() }; return operate<Link>("knowledge.unlink", payload, undefined, unlinkIntent.for("knowledge.unlink", payload)); }, onSuccess: async () => { if (!currentScope()) return; unlinkIntent.complete(); setReason(""); await refresh(); }, onError: async () => { if (currentScope()) await refresh(); } });
  const revise = useMutation({ mutationFn: ({content, state}: {content: Content; state: string}) => { const payload = { item_id: itemId, content }; return operate<Item>("knowledge.revise", payload, state, reviseIntent.for("knowledge.revise", payload, state)); }, onSuccess: async () => { if (!currentScope()) return; reviseIntent.complete(); setEditing(null); await refresh(); }, onError: async () => { if (currentScope()) await refresh(); } });
  const data = item.data;
  const current = data?.current;
  const editable = canEdit && data?.workspace_id === workspaceId;
  return <Card withBorder><Stack>
    {item.isError && <Alert color="red">{item.error.message}</Alert>}
    {!data && <Text>Checking current knowledge authority…</Text>}
    {data && current && <>
    {canEdit && !editable && <Text>Inspect this linked item here. Content and link editing require membership with editing rights in its workspace.</Text>}
    <Group><Title order={3}>{current.title}</Title><Badge variant="outline">{data.kind}</Badge>{current.decision_status && <Badge>Decision {current.decision_status}</Badge>}</Group>
    <Text size="sm">Item {data.item_id} · entry {current.number} · {data.state}. Attached knowledge does not change frozen design content or approve anything physically.</Text>
    {current.body && <Text style={{ whiteSpace: "pre-wrap" }}>{current.body}</Text>}
    {current.attachments.length > 0 && <Table aria-label="Current attachments"><Table.Thead><Table.Tr><Table.Th>Attachment</Table.Th><Table.Th>Source</Table.Th><Table.Th>Media type / size</Table.Th><Table.Th>Rights</Table.Th><Table.Th>SHA-256</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{current.attachments.map((a) => <Table.Tr key={`${a.bundle_revision_id}/${a.path}`}><Table.Td><a href={downloadUrl(a)}>{a.label || a.path}</a></Table.Td><Table.Td>{a.bundle_name} revision {a.revision_number} · {a.path}</Table.Td><Table.Td>{a.media_type} · {a.size} bytes</Table.Td><Table.Td>{a.rights}</Table.Td><Table.Td><Text size="xs" style={{ wordBreak: "break-all" }}>{a.sha256}</Text></Table.Td></Table.Tr>)}</Table.Tbody></Table>}
    <Title order={4}>Linked objects</Title>
    <Text size="sm">Only objects you can currently read are shown.</Text>
    {data.links.length ? <Table aria-label="Active links"><Table.Thead><Table.Tr><Table.Th>Object</Table.Th><Table.Th>Kind</Table.Th><Table.Th>Linked</Table.Th>{editable && <Table.Th />}</Table.Tr></Table.Thead><Table.Tbody>{data.links.map((l) => <Table.Tr key={l.link_id}><Table.Td>{l.label}{"feature_id" in l.target && l.target.feature_id ? ` · feature ${l.target.feature_id} (not evaluated)` : ""}</Table.Td><Table.Td>{l.target.kind.replace("_", " ")}</Table.Td><Table.Td>{l.linked_at}</Table.Td>{editable && <Table.Td><Button size="xs" color="red" variant="light" loading={unlink.isPending && unlink.variables === l.link_id} onClick={() => unlink.mutate(l.link_id)} aria-label={`Unlink ${l.label}`}>Unlink</Button></Table.Td>}</Table.Tr>)}</Table.Tbody></Table> : <Text>No visible links.</Text>}
    {editable && <TextInput label="Unlink reason" description="Recorded with the removal. The item, its attachments and its other links are kept." value={reason} onChange={(e) => setReason(e.currentTarget.value)} />}
    {editable && <Button disabled={!target || !targetReady} loading={link.isPending} onClick={() => link.mutate()}>{target ? "Link to the chosen object" : "Choose an object to link"}</Button>}
    {targetReady && link.data && !link.data.created && <Alert color="gray">Already linked to {link.data.label}; no duplicate link was created.</Alert>}
    {[link, unlink, revise].map((m, index) => m.isError ? <Alert key={index} color="red">{m.error.message}</Alert> : null)}
    {data.removed_links.length > 0 && <><Title order={4}>Removed links</Title><Table aria-label="Removed links"><Table.Tbody>{data.removed_links.map((l) => <Table.Tr key={l.link_id}><Table.Td>{l.label}</Table.Td><Table.Td>Removed {l.removed_at}</Table.Td><Table.Td>{l.removal_reason || "No reason recorded"}</Table.Td></Table.Tr>)}</Table.Tbody></Table></>}
    {editable && !editing && <Button variant="light" onClick={() => setEditing({ state: data.state, number: current.number, kind: data.kind, workspaceId: data.workspace_id, content: { title: current.title, body: current.body, decision_status: current.decision_status, attachments: current.attachments.map(a => ({ bundle_revision_id: a.bundle_revision_id, path: a.path, label: a.label })) } })}>Revise content</Button>}
    <Title order={4}>Entry history</Title>
    <Table aria-label="Entry history"><Table.Thead><Table.Tr><Table.Th>Entry</Table.Th><Table.Th>Title</Table.Th><Table.Th>Status</Table.Th><Table.Th>Attachments</Table.Th><Table.Th>Recorded</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{[...data.history].reverse().map((e) => <Table.Tr key={e.entry_id}><Table.Td>{e.number}</Table.Td><Table.Td>{e.title}</Table.Td><Table.Td>{e.decision_status ?? "—"}</Table.Td><Table.Td>{e.attachments.map((a) => a.path).join(", ") || "None"}</Table.Td><Table.Td>{e.created_at}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
    </>}
    {canEdit && editing && editing.workspaceId === workspaceId && <Card withBorder><Stack><Title order={4}>Revise from entry {editing.number}</Title><Text>Original edit basis: {editing.state}. Unsaved inputs stay attached to this basis during refresh.</Text>
      {data && data.state !== editing.state && <Alert color="yellow">The current entry changed. Review it above before deliberately choosing a new edit basis.<Button disabled={revise.isPending} onClick={() => setEditing({ ...editing, state: data.state, number: data.current.number })}>Use current entry as revision basis</Button></Alert>}
      <ContentForm sourceScope={workspaceId} kind={editing.kind} initial={editing.content} submitLabel="Save new entry" busy={revise.isPending} blocked={!data} onSubmit={content => revise.mutate({content, state: editing.state})} />
      {revise.isError && !data && <Alert color="red">{revise.error.message}</Alert>}
      <Button variant="subtle" onClick={() => setEditing(null)}>Cancel revision</Button></Stack></Card>}
  </Stack></Card>;
}
