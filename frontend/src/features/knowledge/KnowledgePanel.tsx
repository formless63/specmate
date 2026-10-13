import { Alert, Badge, Button, Card, Checkbox, FileInput, Group, Select, Stack, Table, Text, TextInput, Textarea, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { downloadUrl, lookup, operate, preserveAttachment, read, type AttachmentRef, type Content, type DecisionStatus, type Definition, type Identity, type Item, type ItemPage, type Kind, type Link, type RevisionDetail, type SourcePage, type Target, type TargetItems } from "./api";

const DECISIONS: DecisionStatus[] = ["proposed", "accepted", "rejected", "superseded"];

/** Notes, decisions and attachment references linked to exact objects. Pass `target` to embed it for a selection. */
export function KnowledgePanel({ projectId, canEdit, target }: { projectId: string; canEdit: boolean; target?: Target }) {
  return <KnowledgeWorkspace key={`${projectId}:${JSON.stringify(target ?? null)}`} projectId={projectId} canEdit={canEdit} fixedTarget={target} />;
}

function KnowledgeWorkspace({ projectId, canEdit, fixedTarget }: { projectId: string; canEdit: boolean; fixedTarget?: Target }) {
  const [chosen, setChosen] = useState<Target | null>(fixedTarget ?? null);
  const [itemId, setItemId] = useState<string | null>(null);
  return <Stack>
    <Title order={2}>Notes, decisions and attachments</Title>
    <Text>One item keeps one identity and can be linked to several exact objects. A revision, each contextual occurrence and each physical unit are separate targets. Removing a link keeps the item, its attachments and its other links.</Text>
    {!fixedTarget && <TargetPicker projectId={projectId} onChoose={setChosen} />}
    {chosen && <TargetItemsCard target={chosen} onOpen={setItemId} />}
    <ProjectItems projectId={projectId} onOpen={setItemId} />
    {canEdit && <CreateItem projectId={projectId} target={chosen} onCreated={setItemId} />}
    {itemId && <ItemDetail key={itemId} itemId={itemId} projectId={projectId} canEdit={canEdit} target={chosen} />}
  </Stack>;
}

function TargetPicker({ projectId, onChoose }: { projectId: string; onChoose: (target: Target) => void }) {
  const [kind, setKind] = useState<Target["kind"]>("revision");
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [snapshotId, setSnapshotId] = useState("");
  const [path, setPath] = useState("");
  const [unitId, setUnitId] = useState<string | null>(null);
  const [featureId, setFeatureId] = useState("");
  const definitions = useQuery({ queryKey: ["knowledge-definitions", projectId], queryFn: () => read<Definition[]>(`projects/${projectId}/definitions`), enabled: kind === "definition" || kind === "revision" });
  const identity = useQuery({ queryKey: ["knowledge-definition", definitionId], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}`), enabled: kind === "revision" && !!definitionId });
  const units = useQuery({ queryKey: ["knowledge-units", projectId], queryFn: () => read<{ units: { unit_id: string; serial: string; revision_id: string }[] }>(`physical-units/projects/${projectId}?offset=0&limit=100`), enabled: kind === "physical_unit" });
  const feature = featureId || null;
  const target: Target | null = kind === "project" ? { kind, project_id: projectId }
    : kind === "definition" ? (definitionId ? { kind, definition_id: definitionId, feature_id: feature } : null)
    : kind === "revision" ? (revisionId ? { kind, revision_id: revisionId, feature_id: feature } : null)
    : kind === "physical_unit" ? (unitId ? { kind, unit_id: unitId } : null)
    : snapshotId.trim() && path.trim() ? { kind, snapshot_id: snapshotId.trim(), path: path.split("/"), feature_id: feature } : null;
  return <Card withBorder><Stack>
    <Title order={3}>Choose an exact object</Title>
    <Select label="Knowledge target kind" value={kind} allowDeselect={false} data={[{ value: "project", label: "Project" }, { value: "definition", label: "Definition (all revisions)" }, { value: "revision", label: "Exact revision" }, { value: "occurrence", label: "Contextual occurrence" }, { value: "physical_unit", label: "Physical unit" }]} onChange={(value) => setKind(value as Target["kind"])} />
    {(kind === "definition" || kind === "revision") && <Select label="Knowledge definition" searchable value={definitionId} data={(definitions.data ?? []).map((d) => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} onChange={(id) => { setDefinitionId(id); setRevisionId(null); }} />}
    {kind === "revision" && <Select label="Knowledge exact revision" value={revisionId} data={(identity.data?.revisions ?? []).map((r) => ({ value: r.revision_id, label: `Revision ${r.number}` }))} onChange={setRevisionId} />}
    {kind === "occurrence" && <><TextInput label="Knowledge root assembly snapshot ID" value={snapshotId} onChange={(e) => setSnapshotId(e.currentTarget.value)} /><TextInput label="Knowledge occurrence path" description="Stable local occurrence IDs separated by /." value={path} onChange={(e) => setPath(e.currentTarget.value)} /></>}
    {kind === "physical_unit" && <Select label="Knowledge physical unit" searchable value={unitId} data={(units.data?.units ?? []).map((u) => ({ value: u.unit_id, label: u.serial }))} onChange={setUnitId} />}
    {kind !== "project" && kind !== "physical_unit" && <TextInput label="Knowledge feature ID" description="Optional and kept exactly; feature existence is not evaluated." value={featureId} onChange={(e) => setFeatureId(e.currentTarget.value)} />}
    {[definitions, identity, units].map((query, index) => query.isError ? <Alert key={index} color="red">{query.error.message}</Alert> : null)}
    <Button disabled={!target} onClick={() => target && onChoose(target)}>Show knowledge for this object</Button>
  </Stack></Card>;
}

function TargetItemsCard({ target, onOpen }: { target: Target; onOpen: (id: string) => void }) {
  const [offset, setOffset] = useState(0);
  const items = useQuery({ queryKey: ["knowledge-target", target, offset], queryFn: () => lookup<TargetItems>("knowledge.for_target", { target, offset }) });
  return <Card withBorder><Stack>
    <Title order={3}>Linked to {items.data?.target.label ?? "the chosen object"}</Title>
    {items.data?.target.feature_status && <Text size="sm">Feature existence: {items.data.target.feature_status.replaceAll("_", " ")}</Text>}
    {items.isError && <Alert color="red">{items.error.message}</Alert>}
    {items.data && (items.data.items.length ? <ItemTable items={items.data.items} onOpen={onOpen} /> : <Text>No readable knowledge is linked to this exact object.</Text>)}
    <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous linked items</Button><Button disabled={!items.data?.has_more} onClick={() => setOffset(offset + 50)}>Next linked items</Button></Group>
  </Stack></Card>;
}

function ProjectItems({ projectId, onOpen }: { projectId: string; onOpen: (id: string) => void }) {
  const [offset, setOffset] = useState(0);
  const items = useQuery({ queryKey: ["knowledge-project", projectId, offset], queryFn: () => read<ItemPage>(`knowledge/projects/${projectId}/items?offset=${offset}`) });
  return <Card withBorder><Stack>
    <Title order={3}>Project knowledge</Title>
    {items.isError && <Alert color="red">{items.error.message}</Alert>}
    {items.data && (items.data.items.length ? <ItemTable items={items.data.items} onOpen={onOpen} /> : <Text>No knowledge items yet.</Text>)}
    <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous project items</Button><Button disabled={!items.data?.has_more} onClick={() => setOffset(offset + 50)}>Next project items</Button></Group>
  </Stack></Card>;
}

function ItemTable({ items, onOpen }: { items: ItemPage["items"]; onOpen: (id: string) => void }) {
  return <Table><Table.Thead><Table.Tr><Table.Th>Title</Table.Th><Table.Th>Kind</Table.Th><Table.Th>Entry</Table.Th><Table.Th>Attachments</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>
    {items.map((item) => <Table.Tr key={item.link_id ?? item.item_id}><Table.Td>{item.current.title}</Table.Td><Table.Td>{item.kind}{item.current.decision_status ? ` · ${item.current.decision_status}` : ""}</Table.Td><Table.Td>{item.current.number}</Table.Td><Table.Td>{item.current.attachments.length}</Table.Td><Table.Td><Button size="xs" variant="light" onClick={() => onOpen(item.item_id)} aria-label={`Open ${item.current.title}`}>Open</Button></Table.Td></Table.Tr>)}
  </Table.Tbody></Table>;
}

function AttachmentEditor({ projectId, value, onChange }: { projectId: string; value: AttachmentRef[]; onChange: (refs: AttachmentRef[]) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [rights, setRights] = useState("");
  const [label, setLabel] = useState("");
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const sources = useQuery({ queryKey: ["knowledge-sources", projectId], queryFn: () => read<SourcePage>(`sources/projects/${projectId}/revisions`) });
  const detail = useQuery({ queryKey: ["knowledge-source", revisionId], queryFn: () => read<RevisionDetail>(`sources/revisions/${revisionId}`), enabled: !!revisionId });
  const upload = useMutation({ mutationFn: () => preserveAttachment(projectId, file!, rights.trim(), label.trim()), onSuccess: (ref) => { onChange([...value, ref]); setFile(null); setLabel(""); } });
  const add = (ref: AttachmentRef) => { if (!value.some((v) => v.bundle_revision_id === ref.bundle_revision_id && v.path === ref.path)) onChange([...value, ref]); };
  return <Stack gap="xs">
    <Text fw={600}>Attachments</Text>
    <Text size="sm">Files are preserved as source revisions with declared rights. An attachment references those exact bytes; it is never copied into another blob.</Text>
    {value.map((ref) => <Group key={`${ref.bundle_revision_id}/${ref.path}`}><Text size="sm">{ref.label || ref.path} · {ref.path}</Text><Button size="xs" variant="subtle" onClick={() => onChange(value.filter((v) => v !== ref))} aria-label={`Remove attachment ${ref.path}`}>Remove</Button></Group>)}
    <Group align="end"><FileInput label="New attachment file" value={file} onChange={setFile} clearable /><TextInput label="Declared rights" description="Required, for example original-work or licence name." value={rights} onChange={(e) => setRights(e.currentTarget.value)} /><TextInput label="Attachment label" value={label} onChange={(e) => setLabel(e.currentTarget.value)} /><Button disabled={!file || !rights.trim()} loading={upload.isPending} onClick={() => upload.mutate()}>Preserve and attach</Button></Group>
    {upload.isError && <Alert color="red">{upload.error.message}</Alert>}
    <Group align="end"><Select label="Existing source revision" searchable value={revisionId} data={(sources.data?.revisions ?? []).map((r) => ({ value: r.revision_id, label: `${r.name} · revision ${r.number}` }))} onChange={(id) => { setRevisionId(id); setPath(null); }} /><Select label="Existing source file" value={path} data={(detail.data?.manifest.files ?? []).map((f) => ({ value: f.path, label: `${f.path} · ${f.rights}` }))} onChange={setPath} /><Button disabled={!revisionId || !path} onClick={() => add({ bundle_revision_id: revisionId!, path: path!, label: label.trim() })}>Attach existing file</Button></Group>
    {sources.isError && <Alert color="red">{sources.error.message}</Alert>}
  </Stack>;
}

function ContentForm({ projectId, kind, initial, submitLabel, busy, onSubmit }: { projectId: string; kind: Kind; initial?: Content; submitLabel: string; busy: boolean; onSubmit: (content: Content) => void }) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [status, setStatus] = useState<DecisionStatus | null>(initial?.decision_status ?? (kind === "decision" ? "proposed" : null));
  const [attachments, setAttachments] = useState<AttachmentRef[]>(initial?.attachments ?? []);
  const missing = !title.trim() || (kind === "attachment" && !attachments.length) || (kind === "note" && !body.trim() && !attachments.length);
  return <Stack>
    <TextInput label="Knowledge title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
    <Textarea label={kind === "decision" ? "Decision and rationale" : "Knowledge text"} minRows={3} value={body} onChange={(e) => setBody(e.currentTarget.value)} />
    {kind === "decision" && <Select label="Decision status" value={status} allowDeselect={false} data={DECISIONS} onChange={(value) => setStatus(value as DecisionStatus)} />}
    <AttachmentEditor projectId={projectId} value={attachments} onChange={setAttachments} />
    {kind === "attachment" && !attachments.length && <Text size="sm">An attachment item needs at least one referenced file.</Text>}
    <Button disabled={missing} loading={busy} onClick={() => onSubmit({ title: title.trim(), body, decision_status: kind === "decision" ? status : null, attachments })}>{submitLabel}</Button>
  </Stack>;
}

function CreateItem({ projectId, target, onCreated }: { projectId: string; target: Target | null; onCreated: (id: string) => void }) {
  const cache = useQueryClient();
  const [kind, setKind] = useState<Kind>("note");
  const [linkChosen, setLinkChosen] = useState(true);
  const create = useMutation({
    mutationFn: (content: Content) => operate<Item>("knowledge.create", { project_id: projectId, kind, content, links: target && linkChosen ? [target] : [] }),
    onSuccess: async (item) => { onCreated(item.item_id); await cache.invalidateQueries({ queryKey: ["knowledge-project", projectId] }); await cache.invalidateQueries({ queryKey: ["knowledge-target"] }); },
  });
  return <Card withBorder><Stack>
    <Title order={3}>Record knowledge</Title>
    <Select label="Knowledge kind" value={kind} allowDeselect={false} data={[{ value: "note", label: "Note" }, { value: "decision", label: "Decision" }, { value: "attachment", label: "Attachment reference" }]} onChange={(value) => setKind(value as Kind)} />
    <Checkbox label={target ? "Link to the chosen object" : "No object chosen; the item is created without links"} disabled={!target} checked={!!target && linkChosen} onChange={(e) => setLinkChosen(e.currentTarget.checked)} />
    <ContentForm key={kind} projectId={projectId} kind={kind} submitLabel="Create knowledge item" busy={create.isPending} onSubmit={(content) => create.mutate(content)} />
    {create.isError && <Alert color="red">{create.error.message}</Alert>}
  </Stack></Card>;
}

function ItemDetail({ itemId, projectId, canEdit, target }: { itemId: string; projectId: string; canEdit: boolean; target: Target | null }) {
  const cache = useQueryClient();
  const item = useQuery({ queryKey: ["knowledge-item", itemId], queryFn: () => read<Item>(`knowledge/items/${itemId}`) });
  const [reason, setReason] = useState("");
  const [revising, setRevising] = useState(false);
  const refresh = async () => { await cache.invalidateQueries({ queryKey: ["knowledge-item", itemId] }); await cache.invalidateQueries({ queryKey: ["knowledge-target"] }); await cache.invalidateQueries({ queryKey: ["knowledge-project", projectId] }); };
  const link = useMutation({ mutationFn: () => operate<Link & { created: boolean }>("knowledge.link", { item_id: itemId, target }), onSuccess: refresh });
  const unlink = useMutation({ mutationFn: (linkId: string) => operate<Link>("knowledge.unlink", { link_id: linkId, reason: reason.trim() }), onSuccess: async () => { setReason(""); await refresh(); }, onError: refresh });
  const revise = useMutation({ mutationFn: (content: Content) => operate<Item>("knowledge.revise", { item_id: itemId, content }, item.data?.state), onSuccess: async () => { setRevising(false); await refresh(); }, onError: refresh });
  if (item.isError) return <Alert color="red">{item.error.message}</Alert>;
  if (!item.data) return <Text>Loading knowledge item…</Text>;
  const data = item.data;
  const current = data.current;
  return <Card withBorder><Stack>
    <Group><Title order={3}>{current.title}</Title><Badge variant="outline">{data.kind}</Badge>{current.decision_status && <Badge>Decision {current.decision_status}</Badge>}</Group>
    <Text size="sm">Item {data.item_id} · entry {current.number} · {data.state}. Attached knowledge does not change frozen design content or approve anything physically.</Text>
    {current.body && <Text style={{ whiteSpace: "pre-wrap" }}>{current.body}</Text>}
    {current.attachments.length > 0 && <Table aria-label="Current attachments"><Table.Thead><Table.Tr><Table.Th>Attachment</Table.Th><Table.Th>Source</Table.Th><Table.Th>Media type / size</Table.Th><Table.Th>Rights</Table.Th><Table.Th>SHA-256</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{current.attachments.map((a) => <Table.Tr key={`${a.bundle_revision_id}/${a.path}`}><Table.Td><a href={downloadUrl(a)}>{a.label || a.path}</a></Table.Td><Table.Td>{a.bundle_name} revision {a.revision_number} · {a.path}</Table.Td><Table.Td>{a.media_type} · {a.size} bytes</Table.Td><Table.Td>{a.rights}</Table.Td><Table.Td><Text size="xs" style={{ wordBreak: "break-all" }}>{a.sha256}</Text></Table.Td></Table.Tr>)}</Table.Tbody></Table>}
    <Title order={4}>Linked objects</Title>
    <Text size="sm">Only objects you can currently read are shown.</Text>
    {data.links.length ? <Table aria-label="Active links"><Table.Thead><Table.Tr><Table.Th>Object</Table.Th><Table.Th>Kind</Table.Th><Table.Th>Linked</Table.Th>{canEdit && <Table.Th />}</Table.Tr></Table.Thead><Table.Tbody>{data.links.map((l) => <Table.Tr key={l.link_id}><Table.Td>{l.label}{"feature_id" in l.target && l.target.feature_id ? ` · feature ${l.target.feature_id} (not evaluated)` : ""}</Table.Td><Table.Td>{l.target.kind.replace("_", " ")}</Table.Td><Table.Td>{l.linked_at}</Table.Td>{canEdit && <Table.Td><Button size="xs" color="red" variant="light" loading={unlink.isPending && unlink.variables === l.link_id} onClick={() => unlink.mutate(l.link_id)} aria-label={`Unlink ${l.label}`}>Unlink</Button></Table.Td>}</Table.Tr>)}</Table.Tbody></Table> : <Text>No visible links.</Text>}
    {canEdit && <TextInput label="Unlink reason" description="Recorded with the removal. The item, its attachments and its other links are kept." value={reason} onChange={(e) => setReason(e.currentTarget.value)} />}
    {canEdit && <Button disabled={!target} loading={link.isPending} onClick={() => link.mutate()}>{target ? "Link to the chosen object" : "Choose an object to link"}</Button>}
    {link.data && !link.data.created && <Alert color="gray">Already linked to {link.data.label}; no duplicate link was created.</Alert>}
    {[link, unlink, revise].map((m, index) => m.isError ? <Alert key={index} color="red">{m.error.message}</Alert> : null)}
    {data.removed_links.length > 0 && <><Title order={4}>Removed links</Title><Table aria-label="Removed links"><Table.Tbody>{data.removed_links.map((l) => <Table.Tr key={l.link_id}><Table.Td>{l.label}</Table.Td><Table.Td>Removed {l.removed_at}</Table.Td><Table.Td>{l.removal_reason || "No reason recorded"}</Table.Td></Table.Tr>)}</Table.Tbody></Table></>}
    {canEdit && (revising ? <Card withBorder><Stack><Title order={4}>Revise as entry {current.number + 1}</Title><ContentForm projectId={projectId} kind={data.kind} initial={{ title: current.title, body: current.body, decision_status: current.decision_status, attachments: current.attachments.map((a) => ({ bundle_revision_id: a.bundle_revision_id, path: a.path, label: a.label })) }} submitLabel="Save new entry" busy={revise.isPending} onSubmit={(content) => revise.mutate(content)} /><Button variant="subtle" onClick={() => setRevising(false)}>Cancel revision</Button></Stack></Card> : <Button variant="light" onClick={() => setRevising(true)}>Revise content</Button>)}
    <Title order={4}>Entry history</Title>
    <Table aria-label="Entry history"><Table.Thead><Table.Tr><Table.Th>Entry</Table.Th><Table.Th>Title</Table.Th><Table.Th>Status</Table.Th><Table.Th>Attachments</Table.Th><Table.Th>Recorded</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{[...data.history].reverse().map((e) => <Table.Tr key={e.entry_id}><Table.Td>{e.number}</Table.Td><Table.Td>{e.title}</Table.Td><Table.Td>{e.decision_status ?? "—"}</Table.Td><Table.Td>{e.attachments.map((a) => a.path).join(", ") || "None"}</Table.Td><Table.Td>{e.created_at}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
  </Stack></Card>;
}
