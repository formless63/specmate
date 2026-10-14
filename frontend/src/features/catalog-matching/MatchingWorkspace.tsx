import { Alert, Badge, Button, Card, Group, NativeSelect, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { read, type Definition, type Identity } from "../identity/api";
import { MatchingRequestError, candidateDetail, candidates, evidenceFiles, proposeMatch, reviewMatch, type Candidate, type CandidatePage, type Evidence, type EvidenceFile, type Project } from "./api";
import { SupplierSuggestions } from "./SupplierSuggestions";
import { revisionOptionLabel } from "../../lib/revision-labels";
import { RevisionLabel } from "../../lib/IdentityLabel";

type Pin = { revision_id: string; definition_id: string };
const unknownEvidence: Evidence = { status: "unknown" };
const message = (reason: unknown) => reason instanceof Error ? reason.message : "Request failed.";

export function MatchingWorkspace({ projectId }: { projectId: string }) {
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const refreshAccess = () => setRefresh((value) => value + 1);
    window.addEventListener("focus", refreshAccess);
    return () => window.removeEventListener("focus", refreshAccess);
  }, []);
  return <Stack>
    <Button variant="light" onClick={() => setRefresh((value) => value + 1)}>Refresh matching access</Button>
    <Workspace key={`${projectId}-${refresh}`} projectId={projectId} />
  </Stack>;
}

function Workspace({ projectId }: { projectId: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [source, setSource] = useState<Pin | null>(null);
  const [target, setTarget] = useState<Pin | null>(null);
  const [targetProject, setTargetProject] = useState(projectId);
  const [kind, setKind] = useState<Candidate["association_kind"]>("supplier");
  const [sourceIdentifier, setSourceIdentifier] = useState("");
  const [targetIdentifier, setTargetIdentifier] = useState("");
  const [basis, setBasis] = useState("");
  const [evidence, setEvidence] = useState<Evidence>(unknownEvidence);
  const [page, setPage] = useState<CandidatePage | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [accessInvalid, setAccessInvalid] = useState(false);
  const [selectorEpoch, setSelectorEpoch] = useState(0);
  const generation = useRef(0);
  const canEdit = projects.find((p) => p.project_id === projectId)?.permissions.includes("design.edit") ?? false;

  function invalidateAccess(reason?: unknown) {
    setAccessInvalid(true); setSelectorEpoch((value) => value + 1);
    setSource(null); setTarget(null); setSelected(null); setPage(null); setProjects([]);
    setBusy(false);
    if (reason) setError(message(reason));
  }

  useEffect(() => {
    let active = true;
    void read<Project[]>("projects").then((value) => { if (active) setProjects(value); })
      .catch((reason) => { if (active) setError(message(reason)); });
    return () => { active = false; generation.current += 1; };
  }, []);

  useEffect(() => {
    const token = ++generation.current;
    setPage(null); setSelected(null);
    if (!source) return;
    setError("");
    void candidates(source.revision_id).then((value) => { if (token === generation.current) setPage(value); })
      .catch((reason) => { if (token === generation.current) invalidateAccess(reason); });
  }, [source]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!source || !target) return;
    const token = ++generation.current;
    setBusy(true); setError("");
    try {
      const result = await proposeMatch({
        source_revision_id: source.revision_id, target_revision_id: target.revision_id,
        association_kind: kind, observed_source_identifier: sourceIdentifier,
        observed_target_identifier: targetIdentifier, basis, evidence,
      });
      const next = await candidates(source.revision_id);
      if (token === generation.current) { setSelected(result); setPage(next); setBasis(""); }
    } catch (reason) {
      if (token === generation.current) {
        if (reason instanceof MatchingRequestError && [409, 422].includes(reason.status)) setError(message(reason));
        else invalidateAccess(reason);
      }
    } finally { if (token === generation.current) setBusy(false); }
  }

  async function inspect(candidateId: string) {
    const token = ++generation.current;
    setSelected(null); setError(""); setBusy(true);
    try {
      const current = await candidateDetail(candidateId);
      if (token === generation.current) setSelected(current);
    } catch (reason) { if (token === generation.current) invalidateAccess(reason); }
    finally { if (token === generation.current) setBusy(false); }
  }

  async function more() {
    if (!page?.next_after || !source) return;
    const token = ++generation.current;
    setBusy(true); setError("");
    try {
      const next = await candidates(source.revision_id, page.next_after);
      if (token === generation.current) setPage({ ...next, results: [...page.results, ...next.results] });
    } catch (reason) { if (token === generation.current) invalidateAccess(reason); }
    finally { if (token === generation.current) setBusy(false); }
  }

  return <Stack>
    <Title order={2}>Reviewed matching</Title>
    <Text>Review correspondence between distinct engineering definitions. Acceptance preserves exact identities and existing consumer pins; compatibility and qualification remain unevaluated.</Text>
    {error && <Alert color="red">{error}</Alert>}
    {!canEdit && <Text>Read only. Proposals and reviews require design editing permission in this project.</Text>}
    {accessInvalid && <Alert color="yellow">Access must be refreshed before continuing.</Alert>}
    <RevisionPicker key={`source-${projectId}-${selectorEpoch}`} projectId={accessInvalid ? "" : projectId} label="Source" onChange={setSource} />
    <NativeSelect label="Target project" value={targetProject} onChange={(event) => { setTargetProject(event.currentTarget.value); setTarget(null); }} data={projects.map((p) => ({ value: p.project_id, label: p.name }))} />
    <RevisionPicker key={`target-${targetProject}-${selectorEpoch}`} projectId={accessInvalid ? "" : targetProject} label="Target" onChange={setTarget} />
    {source && !accessInvalid && <SupplierSuggestions key={`${source.revision_id}-${targetProject}-${selectorEpoch}`} sourceRevisionId={source.revision_id} targetProjectId={targetProject} canEdit={canEdit} onDenied={invalidateAccess} onUse={(value) => {
      setTarget({ revision_id: value.target.revision_id, definition_id: value.target.definition_id });
      setKind("supplier"); setSourceIdentifier(value.part_number); setTargetIdentifier(value.part_number);
      setBasis(`Exact asserted manufacturer/part pair ${value.manufacturer} / ${value.part_number}; source association ${value.source_variant_id}, target association ${value.target_variant_id}. Correspondence remains unreviewed.`);
    }} />}
    {target && <Text size="sm"><RevisionLabel id={target.revision_id} role="Target proposal pin" extraPins={[{ label: 'Definition ID', value: target.definition_id }]} /></Text>}
    <Card withBorder>
      <form onSubmit={(event) => void create(event)}><Stack>
        <Title order={3}>Propose correspondence</Title>
        <NativeSelect label="Association kind" value={kind} onChange={(event) => setKind(event.currentTarget.value as Candidate["association_kind"])} data={[{ value: "import", label: "Import" }, { value: "supplier", label: "Supplier" }, { value: "model", label: "Model" }]} />
        <TextInput label="Observed source identifier" value={sourceIdentifier} onChange={(event) => setSourceIdentifier(event.currentTarget.value)} maxLength={200} required />
        <TextInput label="Observed target identifier" value={targetIdentifier} onChange={(event) => setTargetIdentifier(event.currentTarget.value)} maxLength={200} required />
        <Textarea label="Proposal basis" value={basis} onChange={(event) => setBasis(event.currentTarget.value)} maxLength={4000} required />
        <EvidenceEditor key={selectorEpoch} label="Proposal" projects={projects} projectId={projectId} onChange={setEvidence} />
        {source && target && source.definition_id === target.definition_id && <Text c="red">Select distinct definitions. Later revisions of one definition use revision adoption.</Text>}
        <Button type="submit" loading={busy} disabled={!canEdit || !source || !target || source.definition_id === target.definition_id}>Create candidate</Button>
      </Stack></form>
    </Card>
    <Title order={3}>Candidates for the selected source revision</Title>
    {page && page.results.length === 0 && <Text>No accessible candidates.</Text>}
    {page?.results.map((candidate) => <Card key={candidate.candidate_id} withBorder>
      <Group><Badge>{candidate.decision.replaceAll("_", " ")}</Badge><Text>{candidate.target.name} · revision {candidate.target.number}</Text></Group>
      <Text>{candidate.observed_source_identifier} → {candidate.observed_target_identifier} · {candidate.association_kind}</Text>
      <Button variant="light" disabled={busy} onClick={() => void inspect(candidate.candidate_id)}>Review candidate</Button>
    </Card>)}
    {page?.next_after && <Button disabled={busy} onClick={() => void more()}>More candidates</Button>}
    {selected && <ReviewPanel key={`${selected.candidate_id}-${selected.state}`} candidate={selected} projects={projects} projectId={projectId} canEdit={canEdit}
      onUpdated={(result) => { setSelected(result); setPage((current) => current && { ...current, results: current.results.map((row) => row.candidate_id === result.candidate_id ? result : row) }); }}
      onError={(reason) => setError(reason)}
      onRevoked={() => invalidateAccess(new Error("Review access changed. Refresh matching access."))} />}
  </Stack>;
}

function RevisionPicker({ projectId, label, onChange }: { projectId: string; label: string; onChange: (pin: Pin | null) => void }) {
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [definitionId, setDefinitionId] = useState("");
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [revisionId, setRevisionId] = useState("");
  const [more, setMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    if (!projectId) return;
    void read<Definition[]>(`projects/${projectId}/definitions`).then((value) => { if (active) setDefinitions(value); })
      .catch((reason) => { if (active) setError(message(reason)); });
    return () => { active = false; generation.current += 1; };
  }, [projectId]);

  async function chooseDefinition(value: string) {
    const token = ++generation.current;
    setDefinitionId(value); setRevisionId(""); setIdentity(null); setError(""); setMore(false); setOffset(0); onChange(null);
    if (!value) return;
    try {
      const result = await read<Identity>(`catalog/definitions/${value}?offset=0&limit=50`);
      if (token === generation.current) { setIdentity(result); setMore(result.revisions.length === 50); }
    } catch (reason) { if (token === generation.current) setError(message(reason)); }
  }

  async function moreRevisions() {
    const token = ++generation.current;
    const nextOffset = offset + 50;
    try {
      const result = await read<Identity>(`catalog/definitions/${definitionId}?offset=${nextOffset}&limit=50`);
      if (token === generation.current) { setIdentity((current) => current && { ...current, revisions: [...current.revisions, ...result.revisions] }); setOffset(nextOffset); setMore(result.revisions.length === 50); }
    } catch (reason) { if (token === generation.current) { setError(message(reason)); setIdentity(null); onChange(null); } }
  }

  return <Stack gap="xs">
    {error && <Alert color="red">{error}</Alert>}
    <NativeSelect label={`${label} definition`} value={definitionId} onChange={(event) => void chooseDefinition(event.currentTarget.value)} data={[{ value: "", label: "Select a definition" }, ...definitions.map((d) => ({ value: d.definition_id, label: `${d.name} · ${d.kind}` }))]} />
    <NativeSelect label={`${label} exact revision`} value={revisionId} onChange={(event) => { const value = event.currentTarget.value; setRevisionId(value); onChange(value ? { revision_id: value, definition_id: definitionId } : null); }} data={[{ value: "", label: "Select a frozen revision" }, ...(identity?.revisions ?? []).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity?.name, r.number) }))]} />
    {identity?.revisions.length === 0 && <Text>No frozen revisions. Create and freeze a revision in the identity workspace.</Text>}
    {more && <Button variant="light" onClick={() => void moreRevisions()}>More {label.toLowerCase()} revisions</Button>}
  </Stack>;
}

function EvidenceEditor({ label, projects, projectId, onChange }: { label: string; projects: Project[]; projectId: string; onChange: (evidence: Evidence) => void }) {
  const [status, setStatus] = useState<Evidence["status"]>("unknown");
  const [citation, setCitation] = useState("");
  const [scope, setScope] = useState(projectId);
  const [files, setFiles] = useState<EvidenceFile[]>([]);
  const [fileId, setFileId] = useState("");
  const [nextAfter, setNextAfter] = useState<number | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const token = ++generation.current;
    setFiles([]); setFileId(""); setNextAfter(null); setError("");
    if (status !== "registered_file") return;
    void evidenceFiles(scope).then((value) => { if (token === generation.current) { setFiles(value.results); setNextAfter(value.next_after); } })
      .catch((reason) => { if (token === generation.current) setError(message(reason)); });
    return () => { generation.current += 1; };
  }, [status, scope]);

  function chooseFile(value: string) {
    setFileId(value);
    const file = files.find((item) => String(item.file_id) === value);
    onChange(file ? { status: "registered_file", source_bundle_revision_id: file.source_bundle_revision_id, source_path: file.source_path } : unknownEvidence);
  }
  async function moreFiles() {
    if (nextAfter === null) return;
    const token = ++generation.current;
    try {
      const next = await evidenceFiles(scope, nextAfter);
      if (token === generation.current) { setFiles((current) => [...current, ...next.results]); setNextAfter(next.next_after); }
    } catch (reason) { if (token === generation.current) { setError(message(reason)); setFiles([]); chooseFile(""); } }
  }
  return <Stack gap="xs">
    <NativeSelect label={`${label} evidence status`} value={status} onChange={(event) => { const value = event.currentTarget.value as Evidence["status"]; setStatus(value); onChange(value === "unverified_citation" ? { status: value, citation } : unknownEvidence); }} data={[{ value: "unknown", label: "Unknown evidence" }, { value: "unverified_citation", label: "Unverified citation" }, { value: "registered_file", label: "Exact registered source file" }]} />
    {status === "unverified_citation" && <Textarea label={`${label} unverified citation`} value={citation} onChange={(event) => { setCitation(event.currentTarget.value); onChange({ status, citation: event.currentTarget.value }); }} required maxLength={4000} />}
    {status === "registered_file" && <>
      <NativeSelect label={`${label} evidence project`} value={scope} onChange={(event) => { setScope(event.currentTarget.value); onChange(unknownEvidence); }} data={projects.map((p) => ({ value: p.project_id, label: p.name }))} />
      <NativeSelect label={`${label} exact source file`} value={fileId} onChange={(event) => chooseFile(event.currentTarget.value)} required data={[{ value: "", label: "Select a registered file" }, ...files.map((file) => ({ value: String(file.file_id), label: `${file.bundle_name} · revision ${file.bundle_number} · ${file.source_path} · ${file.sha256}` }))]} />
      {nextAfter !== null && <Button variant="light" onClick={() => void moreFiles()}>More {label.toLowerCase()} evidence files</Button>}
      <Text size="sm">Exact bytes and declared rights identify the citation; engineering claims remain subject to review.</Text>
    </>}
    {error && <Alert color="red">{error}</Alert>}
  </Stack>;
}

function EvidenceView({ evidence }: { evidence: Evidence }) {
  return <Stack gap={0}>
    <Text>Evidence: {evidence.status.replaceAll("_", " ")}</Text>
    {evidence.citation && <Text style={{ whiteSpace: "pre-wrap" }}>{evidence.citation}</Text>}
    {evidence.source_bundle_revision_id && <>
      <Text size="sm"><RevisionLabel kind="source" id={evidence.source_bundle_revision_id} role="Bundle" /></Text>
      <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>Path: {evidence.source_path}</Text>
      <Text size="sm">SHA-256: {evidence.sha256}</Text>
      <Text size="sm">Media type: {evidence.media_type ?? "unknown"}</Text>
      <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>Declared rights: {evidence.rights}</Text>
    </>}
  </Stack>;
}

function ReviewPanel({ candidate, projects, projectId, canEdit, onUpdated, onRevoked, onError }: { candidate: Candidate; projects: Project[]; projectId: string; canEdit: boolean; onUpdated: (result: Candidate) => void; onRevoked: () => void; onError: (reason: string) => void }) {
  const [decision, setDecision] = useState("needs_evidence");
  const [basis, setBasis] = useState("");
  const [evidence, setEvidence] = useState<Evidence>(unknownEvidence);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const result = await reviewMatch({ candidate_id: candidate.candidate_id, decision, basis, evidence }, candidate.state);
      if (active.current) onUpdated(result);
    } catch (reason) {
      if (!active.current) return;
      setError(message(reason));
      onError(message(reason));
      try { const current = await candidateDetail(candidate.candidate_id); if (active.current && current.state !== candidate.state) onUpdated(current); }
      catch { if (active.current) onRevoked(); }
    } finally { if (active.current) setBusy(false); }
  }
  return <Card withBorder><Stack>
    <Title order={3}>Correspondence review</Title>
    <Text size="sm">Candidate {candidate.candidate_id}</Text>
    <Badge>{candidate.decision.replaceAll("_", " ")}</Badge>
    <Text>Accepted means reviewed correspondence only. Interchangeability and physical qualification are unevaluated.</Text>
    {([candidate.source, candidate.target] as const).map((pin, index) => <Stack gap={0} key={pin.revision_id}>
      <Text fw={600}>{index === 0 ? "Source" : "Target"}: {pin.name} · {pin.kind} · revision {pin.number}</Text>
      <Text size="sm"><RevisionLabel id={pin.revision_id} extraPins={[{ label: 'Definition ID', value: pin.definition_id }]} /></Text>
      <Text size="sm">Snapshot SHA-256 {pin.sha256}</Text>
    </Stack>)}
    <Text>{candidate.basis}</Text>
    <Text>Association: {candidate.association_kind} · observed identifiers: {candidate.observed_source_identifier} → {candidate.observed_target_identifier}</Text>
    <Text size="sm">Proposed {candidate.created_at} · actor {candidate.proposed_by_id} · {candidate.state}</Text>
    <EvidenceView evidence={candidate.evidence} />
    <Title order={4}>Review history</Title>
    {candidate.reviews.length === 0 && <Text>Unreviewed candidate.</Text>}
    {candidate.reviews.map((review) => <Card withBorder key={review.review_id}>
      <Text fw={600}>Review {review.version}: {review.decision.replaceAll("_", " ")}</Text>
      <Text>{review.basis}</Text><Text size="sm">Review {review.review_id} · {review.reviewed_at} · actor {review.reviewed_by_id}</Text>
      <EvidenceView evidence={review.evidence} />
    </Card>)}
    {error && <Alert color="red">{error}</Alert>}
    <form onSubmit={(event) => void submit(event)}><Stack>
      <NativeSelect label="Review decision" value={decision} onChange={(event) => setDecision(event.currentTarget.value)} data={[{ value: "needs_evidence", label: "Needs evidence" }, { value: "accepted", label: "Accept correspondence" }, { value: "rejected", label: "Reject correspondence" }]} />
      <Textarea label="Review basis" value={basis} onChange={(event) => setBasis(event.currentTarget.value)} required maxLength={4000} />
      <EvidenceEditor label="Review" projects={projects} projectId={projectId} onChange={setEvidence} />
      <Button type="submit" disabled={!canEdit} loading={busy}>Append review</Button>
    </Stack></form>
  </Stack></Card>;
}
