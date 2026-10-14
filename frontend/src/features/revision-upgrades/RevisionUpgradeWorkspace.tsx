import { Alert, Badge, Button, Checkbox, Group, NativeSelect, Stack, Table, Text, Textarea, TextInput, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { applyUpgrade, findConsumers, inspectAssembly, loadProposal, proposeUpgrade, reviewUpgrade } from "./api";
import type { Applied, Assembly, Consumers, Feature, Impacts, Proposal, Relation } from "./api";
import { ReadOnlyNote, useCan } from "../../lib/permissions";

type Decision = { decision: "" | "retain" | "remove"; basis: string };
const pathKey = (path: string[]) => JSON.stringify(path);
const same = (a: string[], b: string[]) => pathKey(a) === pathKey(b);
const decisionOptions = [{ value: "", label: "No decision" }, { value: "retain", label: "Retain as authored" }, { value: "remove", label: "Remove from the consuming context" }];
import { RevisionLabel } from "../../lib/IdentityLabel";

type Props = { projectId?: string | null; onApplied?: (draft: Applied) => void; initialProposalId?: string | null; principalKey?: string; active?: boolean };
const disciplines = ["electrical", "mechanical", "firmware", "manufacturing", "evidence"] as const;
const placement = (value: object | null) => {
  if (!value) return "absent";
  const p = value as { status: string; translation?: number[]; rotation_xyzw?: number[] };
  return p.status === "known" ? `Known: ${p.translation?.join(", ")} mm; rotation ${p.rotation_xyzw?.join(", ")}` : "Unknown";
};
const relationship = (value: Record<string, unknown>) => {
  const refs = Object.entries(value).flatMap(([key, ref]) => {
    if (ref && typeof ref === "object" && "kind" in ref) {
      const r = ref as { path?: string[]; revision_id?: string; feature_id?: string | null };
      return [`${key}: ${r.path?.join(" / ") || r.revision_id || "root"}${r.feature_id ? ` · ${r.feature_id}` : ""}`];
    }
    return [];
  });
  return `${(value.context_path as string[]).join(" / ") || "root"} · ${value.local_id} · ${value.kind} · ${refs.join("; ")}`;
};
const unevaluated = (): Impacts => Object.fromEntries(disciplines.map((d) => [d, { status: "not_evaluated" }])) as Impacts;

export function RevisionUpgradeWorkspace(props: Props) {
  return <Workspace key={JSON.stringify([props.projectId, props.principalKey ?? ""])} {...props} />;
}

function Workspace({ projectId, onApplied, initialProposalId, active = true }: Props) {
  const canEdit = useCan("design.edit");
  const [relation, setRelation] = useState<Relation>("later_revision");
  const [replacementBasis, setReplacementBasis] = useState("");
  const [consumers, setConsumers] = useState<Consumers>();
  const [relationshipDecisions, setRelationshipDecisions] = useState<Record<string, Decision>>({});
  const [assignmentDecisions, setAssignmentDecisions] = useState<Record<string, Decision>>({});
  const [snapshot, setSnapshot] = useState("");
  const [oldRevision, setOldRevision] = useState("");
  const [candidateRevision, setCandidateRevision] = useState("");
  const [basis, setBasis] = useState("");
  const [proposalId, setProposalId] = useState("");
  const [assembly, setAssembly] = useState<Assembly>();
  const [paths, setPaths] = useState<string[][]>([]);
  const [proposal, setProposal] = useState<Proposal>();
  const [features, setFeatures] = useState<Feature[]>([]);
  const [reviewBasis, setReviewBasis] = useState("");
  const [decision, setDecision] = useState("needs_evidence");
  const [evidenceStatus, setEvidenceStatus] = useState("unknown");
  const [citation, setCitation] = useState("");
  const [bundleRevision, setBundleRevision] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [impacts, setImpacts] = useState<Impacts>(unevaluated);
  const [mode, setMode] = useState("new_draft");
  const [draftId, setDraftId] = useState("");
  const [draftToken, setDraftToken] = useState("");
  const [applied, setApplied] = useState<Applied>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0), activeRef = useRef(active), requested = useRef<string | null | undefined>(undefined);
  activeRef.current = active;
  const invalidate = () => { epoch.current += 1; setAssembly(undefined); setPaths([]); setProposal(undefined); setFeatures([]); setApplied(undefined); setConsumers(undefined); setError(""); setBusy(false); };
  // Project/principal replacement remounts the workspace; cleanup rejects old replies.
  useEffect(() => () => { epoch.current += 1; requested.current = undefined; }, []);
  function show(p: Proposal) {
    setProposal(p); setProposalId(p.proposal_id); setApplied(undefined);
    const latest = p.reviews.at(-1);
    const key = (path: string[], feature: string) => JSON.stringify([path, feature]);
    const reviewed = new Map((latest?.features ?? []).map((f) => [key(f.path, f.old_feature_id), f]));
    const required = new Set(p.affected_features.map((f) => key(f.path, f.feature_id)));
    setFeatures([
      ...p.affected_features.map((f) => reviewed.get(key(f.path, f.feature_id)) ?? { path: f.path, old_feature_id: f.feature_id, candidate_feature_id: "", basis: "" }),
      ...(latest?.features ?? []).filter((f) => !required.has(key(f.path, f.old_feature_id))),
    ]);
    setRelationshipDecisions(Object.fromEntries((latest?.relationship_decisions ?? []).map((d) => [d.local_id, { decision: d.decision, basis: d.basis }])));
    setAssignmentDecisions(Object.fromEntries((latest?.assignment_decisions ?? []).map((d) => [pathKey(d.path), { decision: d.decision, basis: d.basis }])));
    setImpacts(p.impacts); setReviewBasis(""); setEvidenceStatus("unknown"); setCitation(""); setBundleRevision(""); setSourcePath("");
  }
  async function run(action: () => Promise<void>) {
    if (!activeRef.current) return;
    const current = ++epoch.current;
    setBusy(true); setError("");
    try { await action(); }
    catch (e) {
      if (current !== epoch.current) return;
      setProposal(undefined); setAssembly(undefined); setPaths([]); setFeatures([]); setApplied(undefined); setConsumers(undefined);
      setError(e instanceof Error ? e.message : "Request failed. Refresh exact state before continuing.");
    } finally { if (current === epoch.current) setBusy(false); }
  }
  async function receive<T>(promise: Promise<T>, apply: (result: T) => void) {
    const current = epoch.current;
    const result = await promise;
    if (current === epoch.current && activeRef.current) apply(result);
  }
  async function checkedProposal(id: string) {
    // Proposals are workspace records; the server authorizes them freshly. A project is
    // navigation context only and never decides whether a proposal is available.
    const p = await loadProposal(id);
    if (p.proposal_id !== id) throw new Error("Upgrade proposal is unavailable.");
    return p;
  }
  useEffect(() => {
    if (!active) { epoch.current++; setBusy(false); return; }
    if (initialProposalId !== requested.current) {
      requested.current = initialProposalId;
      invalidate(); setProposalId(initialProposalId ?? "");
      if (initialProposalId) void run(() => receive(checkedProposal(initialProposalId), show));
    } else if (proposalId) {
      void run(() => receive(checkedProposal(proposalId), (p) => proposal?.proposal_id === p.proposal_id && proposal.state === p.state ? setProposal(p) : show(p)));
    } else if (assembly && snapshot) {
      void run(() => receive(inspectAssembly(snapshot), setAssembly));
    }
  }, [initialProposalId, active]);
  useEffect(() => {
    const recheck = () => {
      if (proposal) void run(() => receive(checkedProposal(proposal.proposal_id), (p) => p.state === proposal.state ? setProposal(p) : show(p)));
      else if (assembly && snapshot) void run(() => receive(inspectAssembly(snapshot), setAssembly));
    };
    window.addEventListener("focus", recheck);
    return () => window.removeEventListener("focus", recheck);
  }, [proposal, assembly, snapshot]);
  function changeIdentity(set: (value: string) => void, value: string) { invalidate(); set(value); }
  const selectedContext = paths[0]?.slice(0, -1);
  const relationshipsAllowed = proposal?.relationship_decisions_allowed ?? [];
  const relationshipsRequired = new Set(proposal?.relationship_decisions_required ?? []);
  const assignmentsAllowed = proposal?.assignment_decisions_allowed ?? [];
  const assignmentsRequired = new Set((proposal?.assignment_decisions_required ?? []).map(pathKey));
  const chosen = (d?: Decision) => !!d && d.decision !== "" && !!d.basis.trim();
  const decisionsMissing = relationshipsAllowed.some((id) => relationshipsRequired.has(id) && !chosen(relationshipDecisions[id]))
    || assignmentsAllowed.some((p) => assignmentsRequired.has(pathKey(p)) && !chosen(assignmentDecisions[pathKey(p)]));
  const propagation = proposal?.parent_propagation;
  function decisionPayload() {
    const relationships = relationshipsAllowed.flatMap((id) => { const d = relationshipDecisions[id]; return chosen(d) && d ? [{ local_id: id, decision: d.decision, basis: d.basis }] : []; });
    const assignments = assignmentsAllowed.flatMap((path) => { const d = assignmentDecisions[pathKey(path)]; return chosen(d) && d ? [{ path, decision: d.decision, basis: d.basis }] : []; });
    return { ...(relationships.length ? { relationships } : {}), ...(assignments.length ? { assignments } : {}) };
  }
  return <Stack>
    <Title order={2}>Revision upgrade review</Title>
    <Text>Choose an exact old revision and either a later revision of the same definition or a declared replacement identity, then the owning assembly snapshot. Select uses of the old revision in one consuming context; adopting a reviewed proposal creates or updates a draft of that consuming definition.</Text>
    <Alert color="yellow">Electrical, mechanical, firmware, manufacturing and evidence impact begin unevaluated. A replacement is declared by a reviewer; equal labels and catalog matches are never treated as correspondence. Reviewed correspondence does not establish compatibility, engineering validity or physical qualification. Nested adoption changes only the consuming subassembly draft; outer contexts keep their frozen pins until a separate parent proposal.</Alert>
    <ReadOnlyNote permission="design.edit">Proposals, reviews and adoption are unavailable; existing proposals can be read.</ReadOnlyNote>
    {error && <Alert color="red" role="alert">{error} The cached preview was cleared; reload the proposal before continuing.</Alert>}
    <Stack inert={!active} aria-hidden={!active} style={{ display: active ? undefined : "none" }}>
    <Group align="end">
      <TextInput label="Saved proposal ID" value={proposalId} onChange={(e) => changeIdentity(setProposalId, e.currentTarget.value)} />
      <Button disabled={busy || !proposalId} onClick={() => void run(() => receive(checkedProposal(proposalId), show))}>Reload proposal</Button>
    </Group>
    <NativeSelect label="Identity relation" value={relation} data={[{ value: "later_revision", label: "Later revision of the same definition" }, { value: "declared_replacement", label: "Declared replacement by a different definition" }]} onChange={(e) => changeIdentity((v) => setRelation(v as Relation), e.currentTarget.value)} />
    <Group grow>
      <TextInput label="Old revision ID" value={oldRevision} onChange={(e) => changeIdentity(setOldRevision, e.currentTarget.value)} />
      <TextInput label={relation === "later_revision" ? "Candidate later revision ID" : "Candidate replacement revision ID"} value={candidateRevision} onChange={(e) => changeIdentity(setCandidateRevision, e.currentTarget.value)} />
    </Group>
    {relation === "declared_replacement" && <Textarea label="Replacement declaration" description="Why this different identity replaces the old use. Recorded as a reviewer declaration, not compatibility evidence." value={replacementBasis} onChange={(e) => setReplacementBasis(e.currentTarget.value)} />}
    <Button variant="quiet" disabled={busy || !oldRevision} onClick={() => void run(() => receive(findConsumers(oldRevision, projectId), setConsumers))}>Find consumers of the old revision</Button>
    {active && !busy && consumers && <Stack gap="xs">
      <Text fw={600}>Frozen consumers in this project pinning {consumers.revision.name} revision {consumers.revision.number}</Text>
      {!consumers.consumers.length && <Text>No frozen consumer in the workspace pins this exact revision.</Text>}
      {consumers.consumers.map((c) => <Group key={c.owning_snapshot_id} gap="xs"><Badge variant="frozen">{c.number === null ? "snapshot" : `revision ${c.number}`}</Badge>{c.in_project && <Badge variant="light">In this project</Badge>}<Text>{c.name} · {c.owning_snapshot_id} · uses {c.uses.map((u) => u.path.join(" / ")).join("; ")}</Text><Button variant="quiet" size="xs" aria-label={`Use owning snapshot ${c.owning_snapshot_id}`} onClick={() => { invalidate(); setSnapshot(c.owning_snapshot_id); void run(() => receive(inspectAssembly(c.owning_snapshot_id), setAssembly)); }}>Inspect uses</Button></Group>)}
      {consumers.truncated && <Text>Only the most recent consumers are listed.</Text>}
    </Stack>}
    <TextInput label="Owning assembly snapshot ID" value={snapshot} onChange={(e) => changeIdentity(setSnapshot, e.currentTarget.value)} />
    <Button disabled={busy || !snapshot} onClick={() => void run(() => receive(inspectAssembly(snapshot), (a) => { setAssembly(a); setPaths([]); setProposal(undefined); }))}>Inspect owning occurrences</Button>
    {active && !busy && assembly && <Stack gap="xs">
      {selectedContext && selectedContext.length > 0 && <Text>Consuming context: {selectedContext.join(" / ")}. Adoption edits a draft of the subassembly pinned there; the owning snapshot keeps its pins.</Text>}
      {canEdit && assembly.occurrences.filter((o) => o.address.path.length === 1 || o.revision_id === oldRevision).map((o) => <Checkbox key={o.address.path.join("/")} label={`${o.address.path.join(" / ")} · ${o.name} · ${o.display_ref || "no display reference"}`} description={<RevisionLabel id={o.revision_id} />} checked={paths.some((p) => same(p, o.address.path))} disabled={busy || o.revision_id !== oldRevision || (selectedContext !== undefined && !same(selectedContext, o.address.path.slice(0, -1)))} onChange={(e) => { const checked = e.currentTarget.checked; setProposal(undefined); setApplied(undefined); setPaths((prior) => checked ? [...prior, o.address.path] : prior.filter((p) => !same(p, o.address.path))); }} />)}
    </Stack>}
    {canEdit && <Textarea label="Proposal basis" value={basis} onChange={(e) => setBasis(e.currentTarget.value)} />}
    {canEdit && <Button disabled={busy || !paths.length || !oldRevision || !candidateRevision || !basis.trim() || (relation === "declared_replacement" && !replacementBasis.trim())} onClick={() => void run(() => receive(proposeUpgrade({ owning_snapshot_id: snapshot, old_revision_id: oldRevision, candidate_revision_id: candidateRevision, ...(relation === "declared_replacement" ? { relation, replacement_basis: replacementBasis } : {}), ...(selectedContext?.length ? { context_path: selectedContext } : {}), paths: paths.map((p) => p.slice(-1)), basis }), show))}>Save upgrade proposal</Button>}
    {active && !busy && proposal && <Stack>
      <Title order={3}>Exact proposal {proposal.proposal_id}</Title>
      <Text>Owning snapshot {proposal.owning_snapshot_id} · SHA-256 {proposal.owning_sha256}</Text>
      {proposal.relation === "declared_replacement"
        ? <Group gap="xs"><Badge variant="draft">Declared replacement</Badge><Text>Declaration: {proposal.replacement_basis}</Text></Group>
        : <Badge variant="frozen">Later revision of the same definition</Badge>}
      {proposal.consumer && <Text>Consuming context: {proposal.context_path?.length ? proposal.context_path.join(" / ") : "owning snapshot"} · {proposal.consumer.name}{proposal.consumer.number !== null ? ` revision ${proposal.consumer.number}` : ""} · {proposal.consumer.sha256}</Text>}
      {propagation?.status === "required" && <Alert color="yellow" title="Parent propagation required">Adoption creates or updates a draft of {propagation.consumer.name} only. The owning snapshot keeps revision {propagation.consumer.number} at {propagation.context_path.join(" / ")}{propagation.sibling_context_paths.length ? ` and at ${propagation.sibling_context_paths.map((p) => p.join(" / ")).join(", ")}` : ""}. A separate later-revision proposal must review {propagation.outer_relationships.length} outer relationship(s) and {propagation.outer_assignments.length} outer assignment(s) that address these uses.</Alert>}
      <Text><RevisionLabel role="Old" id={proposal.old.revision_id} sha256={proposal.old.sha256} known={{ name: proposal.old.name, number: proposal.old.number }} /></Text>
      <Text><RevisionLabel role="Candidate" id={proposal.candidate.revision_id} sha256={proposal.candidate.sha256} known={{ name: proposal.candidate.name, number: proposal.candidate.number }} /></Text>
      <Text>Decision: {proposal.decision} · {proposal.state}. Compatibility, validity and qualification: not evaluated.</Text>
      <Table><Table.Thead><Table.Tr><Table.Th>Occurrence path</Table.Th><Table.Th>Old pin</Table.Th><Table.Th>Candidate pin</Table.Th><Table.Th>Firmware old → candidate</Table.Th><Table.Th>Placement old → candidate</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{proposal.occurrences.map((o) => <Table.Tr key={o.path.join("/")}><Table.Td>{o.path.join(" / ")}{o.selected ? " (selected)" : ""}</Table.Td><Table.Td>{o.old_revision_id ?? "absent"}</Table.Td><Table.Td>{o.candidate_revision_id ?? "removed"}</Table.Td><Table.Td>{o.old_assignments?.firmware_revision_id ?? "unassigned"} → {o.candidate_assignments?.firmware_revision_id ?? "unassigned"}</Table.Td><Table.Td>{placement(o.old_placement)} → {placement(o.candidate_placement)}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
      <Title order={3}>Authored relationships before and after</Title>
      <Group align="start" grow><Stack gap="xs"><Text fw={600}>Old snapshot</Text>{proposal.old_relationships.map((r, i) => <Text key={i}>{relationship(r)}</Text>)}</Stack><Stack gap="xs"><Text fw={600}>Candidate preview</Text>{proposal.candidate_relationships.map((r, i) => <Text key={i}>{relationship(r)}</Text>)}</Stack></Group>
      {canEdit && <>
      <Title order={3}>Discipline impact</Title>
      {disciplines.map((d) => <Group key={d} grow><NativeSelect label={`${d} impact`} data={[{ value: "not_evaluated", label: "Not evaluated" }, { value: "unknown", label: "Unknown" }, { value: "reviewed", label: "Reviewed assessment" }]} value={impacts[d].status} onChange={(event) => { const status = event.currentTarget.value as Impacts[typeof d]["status"]; setImpacts((p) => ({ ...p, [d]: { ...p[d], status } })); }} /><Textarea label={`${d} basis`} value={impacts[d].basis ?? ""} onChange={(e) => { const basis = e.currentTarget.value || null; setImpacts((p) => ({ ...p, [d]: { ...p[d], basis } })); }} /></Group>)}
      <Title order={3}>Explicit feature correspondence</Title>
      {!features.length && <Text>No root-authored feature on the selected direct occurrence requires correspondence.</Text>}
      {features.map((f, i) => <Stack key={`${f.path.join("/")}:${f.old_feature_id}`} gap="xs"><Text>{f.path.join(" / ")} · old feature {f.old_feature_id}</Text><TextInput label={`Candidate feature for ${f.path.join(" / ")} ${f.old_feature_id}`} value={f.candidate_feature_id} onChange={(e) => { const candidate_feature_id = e.currentTarget.value; setFeatures((p) => p.map((v, n) => n === i ? { ...v, candidate_feature_id } : v)); }} /><Textarea label={`Correspondence basis for ${f.path.join(" / ")} ${f.old_feature_id}`} value={f.basis} onChange={(e) => { const basis = e.currentTarget.value; setFeatures((p) => p.map((v, n) => n === i ? { ...v, basis } : v)); }} /></Stack>)}
      {(relationshipsAllowed.length > 0 || assignmentsAllowed.length > 0) && <Title order={3}>Explicit relationship and assignment decisions</Title>}
      {relationshipsAllowed.map((id) => <Group key={id} grow align="start"><NativeSelect label={`Relationship ${id}${relationshipsRequired.has(id) ? " (decision required)" : ""}`} data={decisionOptions} value={relationshipDecisions[id]?.decision ?? ""} onChange={(e) => { const value = e.currentTarget.value as Decision["decision"]; setRelationshipDecisions((p) => ({ ...p, [id]: { decision: value, basis: p[id]?.basis ?? "" } })); }} /><Textarea label={`Relationship ${id} decision basis`} value={relationshipDecisions[id]?.basis ?? ""} onChange={(e) => { const value = e.currentTarget.value; setRelationshipDecisions((p) => ({ ...p, [id]: { decision: p[id]?.decision ?? "", basis: value } })); }} /></Group>)}
      {assignmentsAllowed.map((path) => { const key = pathKey(path); const label = path.join(" / "); return <Group key={key} grow align="start"><NativeSelect label={`Assignment on ${label}${assignmentsRequired.has(key) ? " (decision required)" : ""}`} data={decisionOptions} value={assignmentDecisions[key]?.decision ?? ""} onChange={(e) => { const value = e.currentTarget.value as Decision["decision"]; setAssignmentDecisions((p) => ({ ...p, [key]: { decision: value, basis: p[key]?.basis ?? "" } })); }} /><Textarea label={`Assignment on ${label} decision basis`} value={assignmentDecisions[key]?.basis ?? ""} onChange={(e) => { const value = e.currentTarget.value; setAssignmentDecisions((p) => ({ ...p, [key]: { decision: p[key]?.decision ?? "", basis: value } })); }} /></Group>; })}
      {(proposal.removed_paths?.length ?? 0) > 0 && <Text>Removed descendants: {proposal.removed_paths?.map((p) => p.join(" / ")).join(", ")}. References to them can only be removed.</Text>}
      <NativeSelect label="Review decision" value={decision} data={[{ value: "needs_evidence", label: "Needs evidence" }, { value: "accepted", label: "Accept correspondence" }, { value: "rejected", label: "Reject proposal" }]} onChange={(event) => setDecision(event.currentTarget.value)} />
      <Textarea label="Review basis" value={reviewBasis} onChange={(e) => setReviewBasis(e.currentTarget.value)} />
      <NativeSelect label="Review evidence status" value={evidenceStatus} data={[{ value: "unknown", label: "Unknown evidence" }, { value: "unverified_citation", label: "Unverified citation" }, { value: "registered_file", label: "Exact registered source file" }]} onChange={(e) => setEvidenceStatus(e.currentTarget.value)} />
      {evidenceStatus === "unverified_citation" && <Textarea label="Review citation" value={citation} onChange={(e) => setCitation(e.currentTarget.value)} />}
      {evidenceStatus === "registered_file" && <Group grow><TextInput label="Review source bundle revision ID" value={bundleRevision} onChange={(e) => setBundleRevision(e.currentTarget.value)} /><TextInput label="Review exact source path" value={sourcePath} onChange={(e) => setSourcePath(e.currentTarget.value)} /></Group>}
      <Button disabled={busy || !reviewBasis.trim() || (evidenceStatus === "unverified_citation" && !citation.trim()) || (evidenceStatus === "registered_file" && (!bundleRevision || !sourcePath)) || (decision === "accepted" && (decisionsMissing || features.some((f) => !f.candidate_feature_id.trim() || !f.basis.trim())))} onClick={() => void run(() => receive(reviewUpgrade({ proposal_id: proposal.proposal_id, decision, basis: reviewBasis, features: decision === "accepted" ? features : features.filter((f) => f.candidate_feature_id.trim() && f.basis.trim()), ...decisionPayload(), impacts, evidence: { status: evidenceStatus, ...(evidenceStatus === "unverified_citation" ? { citation } : {}), ...(evidenceStatus === "registered_file" ? { source_bundle_revision_id: bundleRevision, source_path: sourcePath } : {}) } }, proposal.state), show))}>Append review</Button>
      </>}
      <Title order={3}>Immutable review history</Title>
      {!proposal.reviews.length && <Text>Unreviewed.</Text>}
      {proposal.reviews.map((r) => <Stack key={r.review_id} gap="xs"><Text>Review {r.version}: {r.decision} · {r.basis}</Text><Text>Evidence: {r.evidence.status}{r.evidence.citation ? ` · ${r.evidence.citation}` : ""}{r.evidence.source_bundle_revision_id ? ` · bundle revision ${r.evidence.source_bundle_revision_id} · ${r.evidence.source_path}` : ""}{r.evidence.sha256 ? ` · ${r.evidence.sha256}` : ""}{r.evidence.rights ? ` · rights ${r.evidence.rights}` : ""}</Text>{disciplines.map((d) => <Text key={d}>{d}: {r.impacts[d].status}{r.impacts[d].basis ? ` · ${r.impacts[d].basis}` : ""}</Text>)}{r.features.map((f) => <Text key={`${f.path.join("/")}:${f.old_feature_id}`}>{f.path.join(" / ")} · {f.old_feature_id} → {f.candidate_feature_id} · {f.basis}</Text>)}{(r.relationship_decisions ?? []).map((d) => <Text key={`rel:${d.local_id}`}>Relationship {d.local_id}: {d.decision} · {d.basis}</Text>)}{(r.assignment_decisions ?? []).map((d) => <Text key={`asg:${pathKey(d.path)}`}>Assignment on {d.path.join(" / ")}: {d.decision} · {d.basis}</Text>)}</Stack>)}
      {canEdit && <>
      <Title order={3}>Deliberate adoption</Title>
      <NativeSelect label="Adoption target" value={mode} data={[{ value: "new_draft", label: "Create a new consuming draft" }, { value: "existing_draft", label: "Update a selected existing consuming draft" }]} onChange={(event) => { setMode(event.currentTarget.value); setApplied(undefined); }} />
      {mode === "existing_draft" && <Group grow><TextInput label="Existing consuming draft ID" value={draftId} onChange={(e) => setDraftId(e.currentTarget.value)} /><TextInput label="Existing draft state token" value={draftToken} onChange={(e) => setDraftToken(e.currentTarget.value)} /></Group>}
      <Text>Only selected pins, explicitly reviewed features and explicit relationship or assignment decisions change. Existing frozen state retains its original pins. An existing draft must belong to the consuming definition and exactly match the proposal baseline.</Text>
      <Button disabled={busy || proposal.decision !== "accepted" || (mode === "existing_draft" && (!draftId || !draftToken))} onClick={() => void run(() => receive(applyUpgrade({ proposal_id: proposal.proposal_id, mode, ...(mode === "existing_draft" ? { draft_id: draftId, draft_expected_state: draftToken } : {}) }, proposal.state), (result) => { setApplied(result); onApplied?.(result); }))}>Apply reviewed upgrade to draft</Button>
      </>}
      {applied && <Alert color="green">Applied to draft {applied.draft_id} · {applied.state}. Frozen pins retained.{applied.parent_propagation === "required" ? " Outer contexts still pin the previous consumer revision until a separate parent proposal is reviewed." : ""} Reload the proposal to inspect its application link.</Alert>}
    </Stack>}
    </Stack>
  </Stack>;
}
