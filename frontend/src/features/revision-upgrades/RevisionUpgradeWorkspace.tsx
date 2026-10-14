import { Alert, Button, Checkbox, Group, NativeSelect, Stack, Table, Text, Textarea, TextInput, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { applyUpgrade, inspectAssembly, loadProposal, proposeUpgrade, reviewUpgrade } from "./api";
import type { Applied, Assembly, Feature, Impacts, Proposal } from "./api";
import { read, type Definition } from "../identity/api";

type Props = { projectId: string; canEdit: boolean; onApplied?: (draft: Applied) => void; initialProposalId?: string | null; principalKey?: string; active?: boolean };
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

function Workspace({ projectId, canEdit, onApplied, initialProposalId, active = true }: Props) {
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
  const invalidate = () => { epoch.current += 1; setAssembly(undefined); setPaths([]); setProposal(undefined); setFeatures([]); setApplied(undefined); setError(""); setBusy(false); };
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
    setImpacts(p.impacts); setReviewBasis(""); setEvidenceStatus("unknown"); setCitation(""); setBundleRevision(""); setSourcePath("");
  }
  async function run(action: () => Promise<void>) {
    if (!activeRef.current) return;
    const current = ++epoch.current;
    setBusy(true); setError("");
    try { await action(); }
    catch (e) {
      if (current !== epoch.current) return;
      setProposal(undefined); setAssembly(undefined); setPaths([]); setFeatures([]); setApplied(undefined);
      setError(e instanceof Error ? e.message : "Request failed. Refresh exact state before continuing.");
    } finally { if (current === epoch.current) setBusy(false); }
  }
  async function receive<T>(promise: Promise<T>, apply: (result: T) => void) {
    const current = epoch.current;
    const result = await promise;
    if (current === epoch.current && activeRef.current) apply(result);
  }
  async function checkedProposal(id: string) {
    const [p, definitions] = await Promise.all([
      loadProposal(id), read<Definition[]>(`projects/${projectId}/definitions`),
    ]);
    if (p.proposal_id !== id || !Array.isArray(definitions) || !definitions.some((d) => d.definition_id === p.owning_definition_id)) {
      throw new Error("Upgrade proposal is unavailable in the selected project.");
    }
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
  return <Stack>
    <Title order={2}>Revision upgrade review</Title>
    <Text>Choose exact old and later revisions and the owning assembly snapshot. Select direct occurrences independently; adopting a reviewed proposal creates or updates an owning draft.</Text>
    <Alert color="yellow">Electrical, mechanical, firmware, manufacturing and evidence impact begin unevaluated. Reviewed correspondence does not establish compatibility, engineering validity or physical qualification. Nested occurrence adoption and changed assigned descendants require further supported correspondence.</Alert>
    {error && <Alert color="red" role="alert">{error} The cached preview was cleared; reload the proposal before continuing.</Alert>}
    <Stack inert={!active} aria-hidden={!active} style={{ display: active ? undefined : "none" }}>
    <Group align="end">
      <TextInput label="Saved proposal ID" value={proposalId} onChange={(e) => changeIdentity(setProposalId, e.currentTarget.value)} />
      <Button disabled={busy || !proposalId} onClick={() => void run(() => receive(checkedProposal(proposalId), show))}>Reload proposal</Button>
    </Group>
    <TextInput label="Owning assembly snapshot ID" value={snapshot} onChange={(e) => changeIdentity(setSnapshot, e.currentTarget.value)} />
    <Group grow>
      <TextInput label="Old revision ID" value={oldRevision} onChange={(e) => changeIdentity(setOldRevision, e.currentTarget.value)} />
      <TextInput label="Candidate later revision ID" value={candidateRevision} onChange={(e) => changeIdentity(setCandidateRevision, e.currentTarget.value)} />
    </Group>
    <Button disabled={busy || !snapshot} onClick={() => void run(() => receive(inspectAssembly(snapshot), (a) => { setAssembly(a); setPaths([]); setProposal(undefined); }))}>Inspect owning occurrences</Button>
    {active && !busy && assembly && <Stack gap="xs">{assembly.occurrences.filter((o) => o.address.path.length === 1).map((o) => <Checkbox key={o.address.path.join("/")} label={`${o.address.path.join(" / ")} · ${o.name} · ${o.display_ref || "no display reference"} · ${o.revision_id}`} checked={paths.some((p) => p.join("/") === o.address.path.join("/"))} disabled={busy || !canEdit || o.revision_id !== oldRevision} onChange={(e) => { const checked = e.currentTarget.checked; setProposal(undefined); setApplied(undefined); setPaths((prior) => checked ? [...prior, o.address.path] : prior.filter((p) => p.join("/") !== o.address.path.join("/"))); }} />)}</Stack>}
    <Textarea label="Proposal basis" value={basis} onChange={(e) => setBasis(e.currentTarget.value)} />
    <Button disabled={busy || !canEdit || !paths.length || !oldRevision || !candidateRevision || !basis.trim()} onClick={() => void run(() => receive(proposeUpgrade({ owning_snapshot_id: snapshot, old_revision_id: oldRevision, candidate_revision_id: candidateRevision, paths, basis }), show))}>Save upgrade proposal</Button>
    {active && !busy && proposal && <Stack>
      <Title order={3}>Exact proposal {proposal.proposal_id}</Title>
      <Text>Owning snapshot {proposal.owning_snapshot_id} · SHA-256 {proposal.owning_sha256}</Text>
      <Text>Old: {proposal.old.name} revision {proposal.old.number} · {proposal.old.revision_id} · {proposal.old.sha256}</Text>
      <Text>Candidate: {proposal.candidate.name} revision {proposal.candidate.number} · {proposal.candidate.revision_id} · {proposal.candidate.sha256}</Text>
      <Text>Decision: {proposal.decision} · {proposal.state}. Compatibility, validity and qualification: not evaluated.</Text>
      <Table><Table.Thead><Table.Tr><Table.Th>Occurrence path</Table.Th><Table.Th>Old pin</Table.Th><Table.Th>Candidate pin</Table.Th><Table.Th>Firmware old → candidate</Table.Th><Table.Th>Placement old → candidate</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{proposal.occurrences.map((o) => <Table.Tr key={o.path.join("/")}><Table.Td>{o.path.join(" / ")}{o.selected ? " (selected)" : ""}</Table.Td><Table.Td>{o.old_revision_id ?? "absent"}</Table.Td><Table.Td>{o.candidate_revision_id ?? "removed"}</Table.Td><Table.Td>{o.old_assignments?.firmware_revision_id ?? "unassigned"} → {o.candidate_assignments?.firmware_revision_id ?? "unassigned"}</Table.Td><Table.Td>{placement(o.old_placement)} → {placement(o.candidate_placement)}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
      <Title order={3}>Authored relationships before and after</Title>
      <Group align="start" grow><Stack gap="xs"><Text fw={600}>Old snapshot</Text>{proposal.old_relationships.map((r, i) => <Text key={i}>{relationship(r)}</Text>)}</Stack><Stack gap="xs"><Text fw={600}>Candidate preview</Text>{proposal.candidate_relationships.map((r, i) => <Text key={i}>{relationship(r)}</Text>)}</Stack></Group>
      <Title order={3}>Discipline impact</Title>
      {disciplines.map((d) => <Group key={d} grow><NativeSelect label={`${d} impact`} data={[{ value: "not_evaluated", label: "Not evaluated" }, { value: "unknown", label: "Unknown" }, { value: "reviewed", label: "Reviewed assessment" }]} value={impacts[d].status} disabled={!canEdit} onChange={(event) => { const status = event.currentTarget.value as Impacts[typeof d]["status"]; setImpacts((p) => ({ ...p, [d]: { ...p[d], status } })); }} /><Textarea label={`${d} basis`} value={impacts[d].basis ?? ""} disabled={!canEdit} onChange={(e) => { const basis = e.currentTarget.value || null; setImpacts((p) => ({ ...p, [d]: { ...p[d], basis } })); }} /></Group>)}
      <Title order={3}>Explicit feature correspondence</Title>
      {!features.length && <Text>No root-authored feature on the selected direct occurrence requires correspondence.</Text>}
      {features.map((f, i) => <Stack key={`${f.path.join("/")}:${f.old_feature_id}`} gap="xs"><Text>{f.path.join(" / ")} · old feature {f.old_feature_id}</Text><TextInput label={`Candidate feature for ${f.path.join(" / ")} ${f.old_feature_id}`} value={f.candidate_feature_id} disabled={!canEdit} onChange={(e) => { const candidate_feature_id = e.currentTarget.value; setFeatures((p) => p.map((v, n) => n === i ? { ...v, candidate_feature_id } : v)); }} /><Textarea label={`Correspondence basis for ${f.path.join(" / ")} ${f.old_feature_id}`} value={f.basis} disabled={!canEdit} onChange={(e) => { const basis = e.currentTarget.value; setFeatures((p) => p.map((v, n) => n === i ? { ...v, basis } : v)); }} /></Stack>)}
      <NativeSelect label="Review decision" value={decision} disabled={!canEdit} data={[{ value: "needs_evidence", label: "Needs evidence" }, { value: "accepted", label: "Accept correspondence" }, { value: "rejected", label: "Reject proposal" }]} onChange={(event) => setDecision(event.currentTarget.value)} />
      <Textarea label="Review basis" value={reviewBasis} disabled={!canEdit} onChange={(e) => setReviewBasis(e.currentTarget.value)} />
      <NativeSelect label="Review evidence status" value={evidenceStatus} disabled={!canEdit} data={[{ value: "unknown", label: "Unknown evidence" }, { value: "unverified_citation", label: "Unverified citation" }, { value: "registered_file", label: "Exact registered source file" }]} onChange={(e) => setEvidenceStatus(e.currentTarget.value)} />
      {evidenceStatus === "unverified_citation" && <Textarea label="Review citation" value={citation} disabled={!canEdit} onChange={(e) => setCitation(e.currentTarget.value)} />}
      {evidenceStatus === "registered_file" && <Group grow><TextInput label="Review source bundle revision ID" value={bundleRevision} disabled={!canEdit} onChange={(e) => setBundleRevision(e.currentTarget.value)} /><TextInput label="Review exact source path" value={sourcePath} disabled={!canEdit} onChange={(e) => setSourcePath(e.currentTarget.value)} /></Group>}
      <Button disabled={busy || !canEdit || !reviewBasis.trim() || (evidenceStatus === "unverified_citation" && !citation.trim()) || (evidenceStatus === "registered_file" && (!bundleRevision || !sourcePath)) || (decision === "accepted" && features.some((f) => !f.candidate_feature_id.trim() || !f.basis.trim()))} onClick={() => void run(() => receive(reviewUpgrade({ proposal_id: proposal.proposal_id, decision, basis: reviewBasis, features: decision === "accepted" ? features : features.filter((f) => f.candidate_feature_id.trim() && f.basis.trim()), impacts, evidence: { status: evidenceStatus, ...(evidenceStatus === "unverified_citation" ? { citation } : {}), ...(evidenceStatus === "registered_file" ? { source_bundle_revision_id: bundleRevision, source_path: sourcePath } : {}) } }, proposal.state), show))}>Append review</Button>
      <Title order={3}>Immutable review history</Title>
      {!proposal.reviews.length && <Text>Unreviewed.</Text>}
      {proposal.reviews.map((r) => <Stack key={r.review_id} gap="xs"><Text>Review {r.version}: {r.decision} · {r.basis}</Text><Text>Evidence: {r.evidence.status}{r.evidence.citation ? ` · ${r.evidence.citation}` : ""}{r.evidence.source_bundle_revision_id ? ` · bundle revision ${r.evidence.source_bundle_revision_id} · ${r.evidence.source_path}` : ""}{r.evidence.sha256 ? ` · ${r.evidence.sha256}` : ""}{r.evidence.rights ? ` · rights ${r.evidence.rights}` : ""}</Text>{disciplines.map((d) => <Text key={d}>{d}: {r.impacts[d].status}{r.impacts[d].basis ? ` · ${r.impacts[d].basis}` : ""}</Text>)}{r.features.map((f) => <Text key={`${f.path.join("/")}:${f.old_feature_id}`}>{f.path.join(" / ")} · {f.old_feature_id} → {f.candidate_feature_id} · {f.basis}</Text>)}</Stack>)}
      <Title order={3}>Deliberate adoption</Title>
      <NativeSelect label="Adoption target" value={mode} data={[{ value: "new_draft", label: "Create a new owning draft" }, { value: "existing_draft", label: "Update a selected existing owning draft" }]} disabled={!canEdit} onChange={(event) => { setMode(event.currentTarget.value); setApplied(undefined); }} />
      {mode === "existing_draft" && <Group grow><TextInput label="Existing owning draft ID" value={draftId} disabled={!canEdit} onChange={(e) => setDraftId(e.currentTarget.value)} /><TextInput label="Existing draft state token" value={draftToken} disabled={!canEdit} onChange={(e) => setDraftToken(e.currentTarget.value)} /></Group>}
      <Text>Only selected pins and explicitly reviewed features change. Existing frozen state retains its original pins. An existing draft must exactly match the proposal baseline.</Text>
      <Button disabled={busy || !canEdit || proposal.decision !== "accepted" || (mode === "existing_draft" && (!draftId || !draftToken))} onClick={() => void run(() => receive(applyUpgrade({ proposal_id: proposal.proposal_id, mode, ...(mode === "existing_draft" ? { draft_id: draftId, draft_expected_state: draftToken } : {}) }, proposal.state), (result) => { setApplied(result); onApplied?.(result); }))}>Apply reviewed upgrade to draft</Button>
      {applied && <Alert color="green">Applied to draft {applied.draft_id} · {applied.state}. Frozen pins retained. Reload the proposal to inspect its application link.</Alert>}
    </Stack>}
    </Stack>
  </Stack>;
}
