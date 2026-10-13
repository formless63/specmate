import { randomUUID } from "../../lib/random-id";
import { Alert, Badge, Button, Group, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import {
  associationTargets, command, type Association, type AssociationEvidence,
  type AssociationTargets, type Intake, type Population, type PopulationDecision,
  type PopulationDraft, type PopulationOption, PcbRequestError,
} from "./api";
import { PopulationReviewPanel } from "./PopulationReview";

type Props = {
  projectId: string; intake: Intake; drafts: PopulationDraft[];
  permissions?: string[]; onChanged: () => void; onAccessLost: (reason: unknown) => void;
};

const decisionLabels = [
  { value: "unknown", label: "Unresolved" },
  { value: "populate", label: "Populate" },
  { value: "omit", label: "Omit" },
];

function clone(value: Population): Population {
  return JSON.parse(JSON.stringify(value)) as Population;
}

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : "PCB population request failed.";
}

export function PopulationEditor({ projectId, intake, drafts, permissions, onChanged, onAccessLost }: Props) {
  const accessLost = useRef(onAccessLost);
  accessLost.current = onAccessLost;
  const [draftId, setDraftId] = useState<string | null>(null);
  const [optionId, setOptionId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newInterpretationId, setNewInterpretationId] = useState<string | null>(null);
  const [newOptionName, setNewOptionName] = useState("");
  const [targets, setTargets] = useState<AssociationTargets | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canEdit = !permissions || permissions.includes("design.edit");
  const canFreeze = !permissions || permissions.includes("design.freeze");
  const interpretation = intake.interpretations.find((item) => item.interpretation_id === newInterpretationId) ?? intake.interpretations.at(-1);
  const draft = drafts.find((item) => item.draft_id === draftId) ?? drafts[0];
  const population = draft?.content.pcb_population;
  const activeOption = population?.options.find((item) => item.local_id === optionId) ?? population?.options[0];
  const frozenRevision = draft?.revisions.find((item) => item.revision_id === revisionId) ?? draft?.revisions.at(-1);
  const report = intake.interpretations.find((item) => item.interpretation_id === population?.interpretation_id)?.report;

  useEffect(() => {
    const controller = new AbortController();
    let sequence = 0;
    const refresh = () => {
      const current = ++sequence;
      associationTargets(projectId, controller.signal).then((result) => {
        if (!controller.signal.aborted && current === sequence) setTargets(result);
      }).catch((reason) => {
        if (!controller.signal.aborted && current === sequence) {
          setTargets(null); setError(errorText(reason));
          if (reason instanceof PcbRequestError && [401, 403, 404].includes(reason.status)) accessLost.current(reason);
        }
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.removeEventListener("focus", refresh); };
  }, [projectId]);

  async function work(action: () => Promise<void>): Promise<boolean> {
    setBusy(true); setError("");
    try { await action(); return true; } catch (reason) {
      setError(errorText(reason));
      if (reason instanceof PcbRequestError && [401, 403, 404].includes(reason.status)) onAccessLost(reason);
      return false;
    }
    finally { setBusy(false); }
  }
  async function save(value: Population) {
    if (!draft) return false;
    return work(async () => {
      await command("pcb.population_update", { draft_id: draft.draft_id, population: value }, undefined, draft.state);
      onChanged();
    });
  }
  function freshId(name: string, existing: string[], prefix: string) {
    const stem = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 45);
    const base = /^[a-z]/.test(stem) ? stem : prefix;
    let id = base;
    for (let n = 2; existing.includes(id); n++) id = `${base}-${n}`;
    return id;
  }
  async function addOption() {
    if (!population || !report || !newOptionName.trim()) return;
    const value = clone(population);
    const id = freshId(newOptionName, value.options.map((item) => item.local_id), "option");
    value.options.push({ local_id: id, name: newOptionName.trim(), decisions: report.components.map((component) => ({ component_id: component.id, status: null, basis: null })) });
    if (await save(value)) { setOptionId(id); setNewOptionName(""); }
  }
  async function removeOption(option: PopulationOption) {
    if (!population || population.options.length <= 1) return;
    const value = clone(population);
    value.options = value.options.filter((row) => row.local_id !== option.local_id);
    if (await save(value)) setOptionId(value.options[0]?.local_id ?? null);
  }
  async function setDecision(componentId: string, status: PopulationDecision["status"], basis: string | null) {
    if (!population || !activeOption) return false;
    const value = clone(population);
    const option = value.options.find((item) => item.local_id === activeOption.local_id);
    const decision = option?.decisions.find((item) => item.component_id === componentId);
    if (!decision) return false;
    decision.status = status; decision.basis = status ? basis : null;
    return save(value);
  }
  async function setAssociation(association: Association) {
    if (!population) return false;
    const value = clone(population);
    const index = value.associations.findIndex((row) => row.local_id === association.local_id);
    if (index >= 0) value.associations[index] = association;
    else value.associations.push(association);
    return save(value);
  }
  async function removeAssociation(id: string) {
    if (!population) return;
    const value = clone(population);
    value.associations = value.associations.filter((row) => row.local_id !== id);
    await save(value);
  }

  return <Stack>
    <Title order={3}>Population and reviewed associations</Title>
    <Text size="sm">Options pin this interpretation and its original source. Native DNP remains a separate source flag. Association review records a human decision; it does not approve compatibility or manufacture.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {canEdit && interpretation && <Group align="end">
      <Select label="Exact interpretation for new set" value={interpretation.interpretation_id} onChange={setNewInterpretationId} data={intake.interpretations.map((item) => ({ value: item.interpretation_id, label: `${item.interpretation_id.slice(0, 8)} · ${item.report.source_sha256.slice(0, 12)}` }))} />
      <TextInput label="New population set" placeholder="Assembly choices" value={newName} onChange={(event) => setNewName(event.currentTarget.value)} />
      <Button disabled={!newName.trim() || busy} onClick={() => void work(async () => {
        const result = await command<{ draft_id: string }>("pcb.population_create", { interpretation_id: interpretation.interpretation_id, name: newName.trim() });
        setDraftId(result.draft_id); setNewName(""); onChanged();
      })}>Create set</Button>
    </Group>}
    <Select label="Population set" value={draft?.draft_id ?? null} onChange={setDraftId} data={drafts.map((item) => ({ value: item.draft_id, label: item.name }))} />
    {draft && population && report && <Stack>
      <Text size="sm">Exact interpretation: {population.interpretation_id} · source revision: {population.source_revision_id}</Text>
      <Group><Badge>{draft.state}</Badge><Badge>{draft.revisions.length} frozen revision(s)</Badge></Group>
      <Group align="end">
        <Select label="Population option" value={activeOption?.local_id ?? null} onChange={setOptionId} data={population.options.map((item) => ({ value: item.local_id, label: item.name }))} />
        {canEdit && <><TextInput label="New option name" value={newOptionName} onChange={(event) => setNewOptionName(event.currentTarget.value)} />
          <Button disabled={!newOptionName.trim() || busy} onClick={() => void addOption()}>Add option</Button></>}
        {canEdit && activeOption && population.options.length > 1 && <Button variant="subtle" color="red" disabled={busy} onClick={() => void removeOption(activeOption)}>Remove option</Button>}
      </Group>
      {activeOption && <Table><Table.Thead><Table.Tr><Table.Th>Component</Table.Th><Table.Th>Native DNP</Table.Th><Table.Th>Option decision</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{report.components.map((component) => {
          const decision = activeOption.decisions.find((row) => row.component_id === component.id);
          return decision && <DecisionRow key={`${draft.state}:${activeOption.local_id}:${component.id}`} reference={component.reference} nativeDnp={component.dnp} decision={decision} disabled={!canEdit || busy} onSave={(status, basis) => setDecision(component.id, status, basis)} />;
        })}</Table.Tbody>
      </Table>}
      <Text size="sm">Omitted components are excluded from this option. Unresolved components have no inclusion result.</Text>
      <Title order={4}>Port, model and library candidates</Title>
      {targets?.truncated && (targets.truncated.revisions || targets.truncated.models) && <Text size="sm">The selector shows the first 2,000 authorized {targets.truncated.revisions && targets.truncated.models ? "revisions and models" : targets.truncated.revisions ? "revisions" : "models"}. Additional targets are not shown in this selector.</Text>}
      {population.associations.map((association) => <Group key={association.local_id}>
        <Text>{association.local_id} · {association.review}</Text>
        {canEdit && <Button size="xs" variant="subtle" color="red" disabled={busy} onClick={() => void removeAssociation(association.local_id)}>Remove</Button>}
      </Group>)}
      {canEdit && <AssociationForm key={`${draft.draft_id}:${draft.state}`} report={report} intake={intake} population={population} targets={targets} disabled={busy} onSave={setAssociation} />}
      <PopulationReviewPanel key={`draft:${draft.draft_id}:${draft.state}`} kind="draft" id={draft.draft_id} onAccessLost={onAccessLost} />
      {canFreeze && <Button variant="outline" disabled={busy} onClick={() => void work(async () => {
        await command("pcb.population_freeze", { draft_id: draft.draft_id }, undefined, draft.state);
        onChanged();
      })}>Freeze reviewed population revision</Button>}
      {!!draft.revisions.length && <Stack>
        <Select label="Inspect frozen population revision" value={frozenRevision?.revision_id ?? null}
          onChange={setRevisionId} data={draft.revisions.map((item) => ({ value: item.revision_id, label: `Revision #${item.number} · ${item.revision_id}` }))} />
        {frozenRevision && <PopulationReviewPanel key={`revision:${frozenRevision.revision_id}`} kind="revision" id={frozenRevision.revision_id} onAccessLost={onAccessLost} />}
      </Stack>}
    </Stack>}
  </Stack>;
}

function DecisionRow({ reference, nativeDnp, decision, disabled, onSave }: {
  reference: string; nativeDnp: boolean; decision: PopulationDecision; disabled: boolean;
  onSave: (status: PopulationDecision["status"], basis: string | null) => Promise<boolean>;
}) {
  const [status, setStatus] = useState(decision.status ?? "unknown");
  const [basis, setBasis] = useState(decision.basis ?? "");
  const changed = status !== (decision.status ?? "unknown") || basis !== (decision.basis ?? "");
  return <Table.Tr><Table.Td>{reference}<Text size="xs">{decision.component_id}</Text></Table.Td>
    <Table.Td>{nativeDnp ? "Set in source" : "Unset in source"}</Table.Td>
    <Table.Td><Group align="end">
      <Select aria-label={`${reference} population decision`} data={decisionLabels} value={status} onChange={(value) => setStatus(value ?? "unknown")} disabled={disabled} />
      <TextInput aria-label={`${reference} decision basis`} placeholder="Reason for this option" value={basis} onChange={(event) => setBasis(event.currentTarget.value)} disabled={disabled || status === "unknown"} />
      <Button size="xs" disabled={disabled || !changed || (status !== "unknown" && !basis.trim())} onClick={() => void onSave(status === "unknown" ? null : status as "populate" | "omit", status === "unknown" ? null : basis.trim())}>Save</Button>
    </Group></Table.Td></Table.Tr>;
}

function AssociationForm({ report, intake, population, targets, disabled, onSave }: {
  report: Intake["interpretations"][number]["report"]; intake: Intake; population: Population;
  targets: AssociationTargets | null; disabled: boolean; onSave: (association: Association) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<Association["kind"]>("library");
  const [componentId, setComponentId] = useState<string | null>(null);
  const [padId, setPadId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  const [review, setReview] = useState<Association["review"]>("candidate");
  const [basis, setBasis] = useState("");
  const [evidenceKind, setEvidenceKind] = useState<"citation" | "source_file">("citation");
  const [citation, setCitation] = useState("");
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const revisionChoices = (targets?.revisions ?? []).filter((item) => kind !== "port" || item.kind === "pinout");
  const targetChoices = kind === "model"
    ? (targets?.models ?? []).map((item) => ({ value: item.representation_id, label: `${item.label} · ${item.rights}` }))
    : revisionChoices.map((item) => ({ value: item.revision_id, label: `${item.name} #${item.number} · ${item.kind}` }));
  const chosenRevision = revisionChoices.find((item) => item.revision_id === targetId);
  const componentPads = report.pads.filter((item) => item.id && item.component_id === componentId);
  const file = intake.files.find((item) => item.path === sourcePath);
  const canSave = !!componentId && !!targetId && (kind !== "port" || (!!padId && !!contactId))
    && (review === "candidate" || (!!basis.trim() && (evidenceKind === "citation" ? !!citation.trim() : !!file)));

  function edit(row: Association) {
    setEditingId(row.local_id); setKind(row.kind); setComponentId(row.component_id);
    setPadId(row.pad_id); setTargetId(row.representation_id ?? row.target_revision_id);
    setContactId(row.target_contact_id); setReview(row.review); setBasis(row.basis ?? "");
    setEvidenceKind(row.evidence?.kind ?? "citation");
    setCitation(row.evidence?.kind === "citation" ? row.evidence.citation : "");
    setSourcePath(row.evidence?.kind === "source_file" ? row.evidence.path : null);
  }
  function reset() {
    setEditingId(null); setKind("library"); setComponentId(null); setPadId(null);
    setTargetId(null); setContactId(null); setReview("candidate"); setBasis("");
    setEvidenceKind("citation"); setCitation(""); setSourcePath(null);
  }
  async function submit() {
    if (!canSave || !componentId || !targetId) return;
    const evidence: AssociationEvidence | null = review === "candidate" ? null : evidenceKind === "citation"
      ? { kind: "citation", citation: citation.trim() }
      : file ? { kind: "source_file", source_revision_id: intake.source_revision_id, path: file.path, sha256: file.sha256, rights: file.rights } : null;
    const row: Association = {
      local_id: editingId ?? `a_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      kind, component_id: componentId, pad_id: kind === "port" ? padId : null,
      target_revision_id: kind === "model" ? null : targetId,
      target_contact_id: kind === "port" ? contactId : null,
      representation_id: kind === "model" ? targetId : null,
      review, basis: review === "candidate" ? null : basis.trim(), evidence,
    };
    if (await onSave(row)) reset();
  }
  return <Stack gap="xs">
    <Title order={5}>{editingId ? "Review candidate" : "Add association candidate"}</Title>
    {population.associations.map((row) => <Button key={row.local_id} size="xs" variant="subtle" onClick={() => edit(row)}>{row.local_id} · {row.review}</Button>)}
    <Group align="end">
      <Select label="Association kind" value={kind} data={[{ value: "port", label: "Pad to port contact" }, { value: "model", label: "Component to 3D model" }, { value: "library", label: "Component to library revision" }]} onChange={(value) => { setKind(value as Association["kind"] ?? "library"); setTargetId(null); setPadId(null); setContactId(null); }} />
      <Select label="Native component" searchable data={report.components.map((item) => ({ value: item.id, label: `${item.reference} · ${item.value}` }))} value={componentId} onChange={(value) => { setComponentId(value); setPadId(null); }} />
      {kind === "port" && <Select label="Native pad" searchable data={componentPads.map((item) => ({ value: item.id, label: item.terminal }))} value={padId} onChange={setPadId} />}
      <Select label={kind === "model" ? "Exact model representation" : "Exact target revision"} searchable data={targetChoices} value={targetId} onChange={(value) => { setTargetId(value); setContactId(null); }} />
      {kind === "port" && <Select label="Connector body contact" data={(chosenRevision?.contacts ?? []).map((id) => ({ value: id, label: id }))} value={contactId} onChange={setContactId} />}
    </Group>
    <Group align="end">
      <Select label="Review decision" value={review} data={[{ value: "candidate", label: "Candidate, unreviewed" }, { value: "accepted", label: "Reviewed association" }, { value: "rejected", label: "Rejected candidate" }]} onChange={(value) => setReview(value as Association["review"] ?? "candidate")} />
      {review !== "candidate" && <><TextInput label="Review basis" value={basis} onChange={(event) => setBasis(event.currentTarget.value)} />
        <Select label="Evidence type" value={evidenceKind} data={[{ value: "citation", label: "Citation" }, { value: "source_file", label: "Preserved source file" }]} onChange={(value) => setEvidenceKind(value as "citation" | "source_file" ?? "citation")} />
        {evidenceKind === "citation" ? <TextInput label="Evidence citation" value={citation} onChange={(event) => setCitation(event.currentTarget.value)} />
          : <Select label="Preserved evidence file" searchable data={intake.files.map((item) => ({ value: item.path, label: `${item.path} · ${item.rights}` }))} value={sourcePath} onChange={setSourcePath} />}</>}
      <Button disabled={disabled || !canSave} onClick={() => void submit()}>{editingId ? "Save review" : "Add candidate"}</Button>
      {editingId && <Button variant="subtle" onClick={reset}>Cancel</Button>}
    </Group>
    <Text size="xs">A reviewed association does not assert electrical fit, model accuracy, stock identity, or manufacturing approval.</Text>
  </Stack>;
}
