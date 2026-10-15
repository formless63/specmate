import { Alert, Button, Card, Group, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { InspectionScope, ReadOnlyNote, usePermission } from "../../lib/permissions";
import { revisionOptionLabel } from "../../lib/revision-labels";
import { definitionIn, referenceFromProject, useOpenNewest, useOpenProbed } from "../scope/openProbed";
import { ContinueDraftButton } from "../scope/ContinueDraftButton";
import { command, emptyEndAssembly, read, type Definition, type EndAssembly, type EndAssemblyDraft, type EndAssemblyInspection, type Identity } from "./api";
import { StackEditor, StackView, useResolvedStack } from "./StackEditor";

/**
 * End assemblies lens: reusable cable ends. Each is a stack from the wire outward (board,
 * inline parts, connector with its pinout variant, shell) with the joins between layers.
 * Cable ends pin an exact frozen revision.
 */
export function EndAssemblyPanel({ projectId }: { projectId: string | null }) {
  return <EndAssemblies key={projectId ?? "library"} projectId={projectId} />;
}

function EndAssemblies({ projectId }: { projectId: string | null }) {
  const cache = useQueryClient();
  const createGate = usePermission("item.create");
  const freezeGate = usePermission("design.freeze");
  const [name, setName] = useState("");
  const [value, setValue] = useState<EndAssembly>(emptyEndAssembly);
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const definitions = useQuery({ queryKey: ["end-assembly-definitions", projectId], queryFn: () => read<Definition[]>("workspace/definitions") });
  const identity = useQuery({ queryKey: ["end-assembly-identity", definitionId], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}`), enabled: !!definitionId });
  const draft = useQuery({ queryKey: ["end-assembly-draft", draftId], queryFn: () => read<EndAssemblyDraft>(`interfaces/drafts/${draftId}`), enabled: !!draftId });
  const pick = (id: string | null) => { setDefinitionId(id); setDraftId(null); setRevisionId(null); };
  const openNewest = useOpenNewest(identity.data, setDraftId, setRevisionId);
  useOpenProbed(definitionIn(definitions.data, ["end_assembly"]), (id) => { pick(id); openNewest(id); });
  const create = useMutation({ mutationFn: () => command<EndAssemblyDraft>("interface.create", { name, interface: value }), onSuccess: async (data) => {
    setDefinitionId(data.definition_id); setDraftId(data.draft_id); setRevisionId(null);
    await referenceFromProject(projectId, data.definition_id, "end_assembly");
    await cache.invalidateQueries({ queryKey: ["end-assembly-definitions", projectId] });
  } });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string }>("interface.freeze", { draft_id: draftId }, draft.data?.state), onSuccess: async (data) => {
    setRevisionId(data.revision_id);
    await cache.invalidateQueries({ queryKey: ["end-assembly-draft", draftId] });
    await cache.invalidateQueries({ queryKey: ["end-assembly-identity", definitionId] });
  } });
  const all = definitions.data ?? [];
  const assemblies = all.filter((d) => d.kind === "end_assembly");
  return <Stack>
    <Title order={2}>End assemblies</Title>
    <Text size="sm">A reusable cable end, built from the wire outward: an optional board whose pads the wire lands on, optional hand-soldered parts, the connector with the pinout variant it uses, and a shell. Joins say how layers connect; a board's reviewed landings join it to the connector it carries. A shell joins nothing unless a bond is declared. Anything not declared stays unknown.</Text>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    <Group align="end">
      <Select label="End assembly" searchable placeholder={assemblies.length ? "Choose an end assembly" : "No end assemblies yet"} data={assemblies.map((d) => ({ value: d.definition_id, label: d.name }))} value={definitionId} onChange={pick} />
      {identity.data && <Select label="Frozen revision" value={revisionId} onChange={setRevisionId} data={(identity.data.revisions ?? []).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} />}
      {identity.data && (identity.data.drafts?.length ?? 0) > 0 && <Select label="Draft" value={draftId} onChange={setDraftId} data={(identity.data.drafts ?? []).map((d, i) => ({ value: d.draft_id, label: `Draft ${i + 1}` }))} />}
      {identity.data && <ContinueDraftButton drafts={identity.data.drafts} revisionId={revisionId} draftId={draftId} onOpen={setDraftId} />}
    </Group>
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {revisionId && <Inspector key={revisionId} revisionId={revisionId} />}
    {draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {draft.data && <><DraftEditor key={`${draft.data.draft_id}:${draft.data.state}`} draft={draft.data} definitions={all} onSaved={async () => { await cache.invalidateQueries({ queryKey: ["end-assembly-draft", draftId] }); }} />
      <Group><Button loading={freeze.isPending} disabled={!draft.data.content.interface} onClick={() => freeze.mutate()} {...freezeGate.props}>Freeze end assembly</Button><ReadOnlyNote permission="design.freeze">Freezing end assemblies is unavailable.</ReadOnlyNote></Group></>}
    {freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
    <Card withBorder><Stack gap="xs">
      <Title order={3}>New end assembly</Title>
      <InspectionScope permission="item.create">
        <TextInput label="End assembly name" placeholder="e.g. 10-pin plug + adapter board + shell" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <AssemblyEditor value={value} onChange={setValue} definitions={all} />
      </InspectionScope>
      <Group><Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()} {...createGate.props}>Create end assembly draft</Button><ReadOnlyNote permission="item.create">Creating end assemblies is unavailable.</ReadOnlyNote></Group>
      {create.isError && <Alert color="red">{create.error.message}</Alert>}
    </Stack></Card>
  </Stack>;
}

function DraftEditor({ draft, definitions, onSaved }: { draft: EndAssemblyDraft; definitions: Definition[]; onSaved: () => Promise<void> }) {
  const editGate = usePermission("design.edit");
  const [value, setValue] = useState<EndAssembly>(() => draft.content.interface ?? emptyEndAssembly());
  const save = useMutation({ mutationFn: () => command("interface.update", { draft_id: draft.draft_id, interface: value }, draft.state), onSuccess: onSaved });
  return <Card withBorder><Stack gap="xs"><Title order={3}>Edit end assembly draft</Title>
    <InspectionScope permission="design.edit"><AssemblyEditor value={value} onChange={setValue} definitions={definitions} /></InspectionScope>
    <Group><Button loading={save.isPending} onClick={() => save.mutate()} {...editGate.props}>Save end assembly draft</Button><ReadOnlyNote permission="design.edit">Saving end assemblies is unavailable.</ReadOnlyNote></Group>
    {save.isError && <Alert color="red">{save.error.message}</Alert>}
  </Stack></Card>;
}

/** Layer cards with the resolved terminals beside them, so joins pick labels, not IDs. */
export function AssemblyEditor({ value, onChange, definitions }: { value: EndAssembly; onChange: (v: EndAssembly) => void; definitions: Definition[] }) {
  const resolved = useResolvedStack({ stack: value.stack, end_assembly_revision_id: null });
  return <Stack gap="xs">
    <TextInput size="xs" label="Description" placeholder="Optional" value={value.description ?? ""} onChange={(e) => onChange({ ...value, description: e.currentTarget.value || null })} />
    <StackEditor label="End assembly" value={value.stack} onChange={(stack) => onChange({ ...value, stack })} definitions={definitions} resolved={resolved.data} />
    {resolved.isError && <Alert color="orange">{resolved.error.message}</Alert>}
    {resolved.data && <Card withBorder padding="xs"><Stack gap="xs"><Title order={5}>Pads, pins and what they reach</Title><StackView resolved={resolved.data} label="End assembly" /></Stack></Card>}
    <Group align="end">
      <Select size="xs" label="Review" data={[{ value: "unreviewed", label: "Unreviewed" }, { value: "reviewed", label: "Reviewed" }]} value={value.review} onChange={(v) => onChange({ ...value, review: (v ?? "unreviewed") as EndAssembly["review"] })} />
      <TextInput size="xs" label="Review basis" placeholder="Required when reviewed" value={value.review_basis ?? ""} onChange={(e) => onChange({ ...value, review_basis: e.currentTarget.value || null })} />
    </Group>
  </Stack>;
}

function Inspector({ revisionId }: { revisionId: string }) {
  const result = useQuery({ queryKey: ["end-assembly-inspection", revisionId], queryFn: () => read<EndAssemblyInspection>(`interfaces/revisions/${revisionId}`) });
  return <Card withBorder><Stack gap="xs">
    <Title order={3}>Frozen end assembly</Title>
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {result.data && <>
      {result.data.interface.description && <Text size="sm">{result.data.interface.description}</Text>}
      <Text size="xs">Review: {result.data.interface.review}{result.data.interface.review_basis ? `; basis: ${result.data.interface.review_basis}` : ""}. Continuity: not evaluated.</Text>
      <StackView resolved={result.data.end_stack} label="End assembly" />
    </>}
  </Stack></Card>;
}
