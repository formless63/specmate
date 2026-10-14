import { randomUUID } from "../../lib/random-id";
import { Alert, Badge, Button, Card, Checkbox, Group, MultiSelect, NativeSelect, Stack, Text, Textarea, TextInput, Title } from "@mantine/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { command, PackRequestError, read, type Decision, type Entry, type FilePin, type Manifest, type Pack, type Project, type SourceFile, type Version } from "./api";
import { revisionOptionLabel } from "../../lib/revision-labels";
import { RevisionLabel } from "../../lib/IdentityLabel";

const message = (reason: unknown) => reason instanceof Error ? reason.message : "Request failed.";
const blankEntry = (): Entry => ({ key: "", label: "", category: "content", rights: "unknown" });

export function CatalogPacksWorkspace({ projectId }: { projectId: string }) {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => { const refresh = () => setEpoch((value) => value + 1); window.addEventListener("focus", refresh); return () => window.removeEventListener("focus", refresh); }, []);
  return <Stack><Button variant="light" onClick={() => setEpoch((value) => value + 1)}>Refresh catalog pack access</Button><Workspace key={`${projectId}-${epoch}`} projectId={projectId} /></Stack>;
}

function Workspace({ projectId }: { projectId: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [nextPack, setNextPack] = useState<string | null>(null);
  const [selected, setSelected] = useState<Pack | null>(null);
  const [version, setVersion] = useState<Version | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [nextHistory, setNextHistory] = useState<number | null>(null);
  const [basis, setBasis] = useState("");
  const [entryKeys, setEntryKeys] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const canEdit = !blocked && (projects.find((project) => project.project_id === projectId)?.permissions.includes("design.edit") ?? false);
  const invalidate = (reason: unknown) => { setError(message(reason)); setBlocked(true); setProjects([]); setPacks([]); setSelected(null); setVersion(null); setDecisions([]); setEntryKeys([]); setBasis(""); setBusy(false); };

  async function loadPacks(after?: string) {
    const page = await read<{ results: Pack[]; next_after: string | null }>(`catalog-packs/projects/${projectId}?limit=25${after ? `&after=${after}` : ""}`);
    return page;
  }
  useEffect(() => {
    const token = ++generation.current;
    void Promise.all([read<Project[]>("projects"), loadPacks()]).then(([actorProjects, page]) => { if (token === generation.current) { setProjects(actorProjects); setPacks(page.results); setNextPack(page.next_after); } })
      .catch((reason) => { if (token === generation.current) invalidate(reason); });
    return () => { generation.current += 1; };
  }, []);

  async function inspect(packId: string, versionId?: string) {
    const token = ++generation.current;
    setSelected(null); setVersion(null); setDecisions([]); setEntryKeys([]); setBasis(""); setBusy(true); setError("");
    try {
      const current = await read<Pack>(`catalog-packs/packs/${packId}`);
      const history = await read<{ results: Decision[]; next_after: number | null }>(`catalog-packs/packs/${packId}/history?limit=25`);
      const pinned = versionId ?? current.installed_version_id ?? current.versions.at(-1)?.version_id;
      const detail = pinned ? await read<Version>(`catalog-packs/versions/${pinned}`) : null;
      if (token === generation.current) { setSelected(current); setDecisions(history.results); setNextHistory(history.next_after); setVersion(detail); }
    } catch (reason) { if (token === generation.current) invalidate(reason); }
    finally { if (token === generation.current) setBusy(false); }
  }
  async function morePacks() {
    if (!nextPack) return;
    const token = ++generation.current;
    try { const page = await loadPacks(nextPack); if (token === generation.current) { setPacks((current) => [...current, ...page.results]); setNextPack(page.next_after); } }
    catch (reason) { if (token === generation.current) invalidate(reason); }
  }
  async function moreHistory() {
    if (!selected || nextHistory === null) return;
    const token = ++generation.current;
    try { const page = await read<{ results: Decision[]; next_after: number | null }>(`catalog-packs/packs/${selected.pack_id}/history?after=${nextHistory}&limit=25`); if (token === generation.current) { setDecisions((current) => [...current, ...page.results]); setNextHistory(page.next_after); } }
    catch (reason) { if (token === generation.current) invalidate(reason); }
  }
  async function decide(action: "install" | "adopt" | "disable") {
    if (!selected || !version || !basis.trim()) return;
    const token = ++generation.current;
    setBusy(true); setError("");
    try {
      await command<Pack>(`catalog_pack.${action}`, { pack_id: selected.pack_id, ...(action !== "disable" ? { version_id: version.version_id } : {}), ...(action === "adopt" ? { entry_keys: entryKeys } : {}), basis }, selected.state);
      if (token !== generation.current) return;
      await inspect(selected.pack_id, version.version_id);
      const page = await loadPacks(); setPacks(page.results); setNextPack(page.next_after);
    } catch (reason) {
      if (token !== generation.current) return;
      if (reason instanceof PackRequestError && [409, 422].includes(reason.status)) { await inspect(selected.pack_id, version.version_id); setError(message(reason)); }
      else invalidate(reason);
    } finally { setBusy(false); }
  }
  async function registered(value: Version) {
    const page = await loadPacks(); setPacks(page.results); setNextPack(page.next_after); await inspect(value.pack_id, value.version_id);
  }

  return <Stack>
    <Title order={2}>Catalog packs</Title>
    <Text>Version inert catalog content, profiles, model/rule files and recipe references. Installation and adoption grant no executable authority; old consumers retain their exact pins.</Text>
    {error && <Alert color="red">{error}</Alert>}
    {blocked && <Alert color="yellow">Refresh access before continuing. Retained choices and history were cleared.</Alert>}
    {!canEdit && <Text>Read only. Pack authoring and adoption require design editing permission.</Text>}
    {!blocked && <RegisterForm projectId={projectId} projects={projects} packs={packs} canEdit={canEdit} onRegistered={registered} onDenied={invalidate} />}
    <Title order={3}>Registered packs</Title>
    {packs.map((pack) => <Card withBorder key={pack.pack_id}><Group><Text>{pack.package_key}</Text><Badge>{pack.enabled ? "Enabled" : "Not enabled"}</Badge></Group><Button variant="light" disabled={busy} onClick={() => void inspect(pack.pack_id)}>Inspect pack</Button></Card>)}
    {nextPack && <Button onClick={() => void morePacks()}>More packs</Button>}
    {selected && version && <Card withBorder><Stack>
      <Title order={3}>{version.manifest.label}</Title><Text>Pack {selected.pack_id} · {selected.state}</Text>
      <NativeSelect label="Exact pack version" value={version.version_id} data={selected.versions.map((row) => ({ value: row.version_id, label: `${row.version} · ${row.version_id} · ${row.sha256}` }))} onChange={(event) => void inspect(selected.pack_id, event.currentTarget.value)} />
      <Text>Installed version: {selected.installed_version_id ?? "none"} · {selected.enabled ? "enabled" : "disabled or not installed"}</Text>
      <VersionView version={version} />
      <Title order={4}>Deliberate use</Title>
      <Textarea label="Pack decision basis" value={basis} onChange={(event) => setBasis(event.currentTarget.value)} maxLength={4000} />
      <Text>Select content to create fresh local editable drafts; other selected entries remain inert references.</Text>
      {version.entries.map((entry) => <Checkbox key={entry.key} label={`Adopt ${entry.label} (${entry.key})`} checked={entryKeys.includes(entry.key)} disabled={!canEdit} onChange={(event) => { const checked = event.currentTarget.checked; setEntryKeys((current) => checked ? [...current, entry.key] : current.filter((key) => key !== entry.key)); }} />)}
      <Group>
        <Button disabled={!canEdit || !basis.trim() || version.compatibility !== "supported_contract"} loading={busy} onClick={() => void decide("install")}>Install selected version</Button>
        <Button disabled={!canEdit || !basis.trim() || entryKeys.length === 0 || !selected.enabled || selected.installed_version_id !== version.version_id} loading={busy} onClick={() => void decide("adopt")}>Adopt selected entries</Button>
        <Button color="orange" disabled={!canEdit || !basis.trim() || !selected.enabled} loading={busy} onClick={() => void decide("disable")}>Disable new adoption</Button>
      </Group>
      <Title order={4}>Retained decisions</Title>
      {decisions.map((decision) => <Card withBorder key={decision.decision_id}>
        <Text fw={600}>{decision.sequence}: {decision.action} · version {decision.version}</Text><Text>{decision.basis}</Text><Text size="sm">Decision {decision.decision_id} · actor {decision.decided_by_id} · {decision.decided_at}</Text>
        {decision.adoptions.map((adoption) => <Stack gap={0} key={adoption.key}><Text>Entry {adoption.key}: {adoption.status.replaceAll("_", " ")}</Text><Text size="sm">Source revision: {adoption.source_revision_id ?? "inert file/recipe reference"}</Text>{adoption.definition_id && <><Text size="sm">New local definition {adoption.definition_id} · draft {adoption.draft_id}</Text><Text size="sm">Open this definition in Identity to inspect, edit and explicitly freeze the adopted draft.</Text></>}</Stack>)}
        <Button variant="light" onClick={() => void inspect(selected.pack_id, decision.version_id)}>Inspect historical version {decision.version}</Button>
      </Card>)}
      {nextHistory !== null && <Button onClick={() => void moreHistory()}>More decision history</Button>}
    </Stack></Card>}
  </Stack>;
}

function RegisterForm({ projectId, projects, packs, canEdit, onRegistered, onDenied }: { projectId: string; projects: Project[]; packs: Pack[]; canEdit: boolean; onRegistered: (version: Version) => Promise<void>; onDenied: (reason: unknown) => void }) {
  const [packId, setPackId] = useState("");
  const [packageKey, setPackageKey] = useState("");
  const [label, setLabel] = useState("");
  const [version, setVersion] = useState("");
  const [publisher, setPublisher] = useState("");
  const [rights, setRights] = useState("unknown");
  const [contractVersion, setContractVersion] = useState("1");
  const [capabilities, setCapabilities] = useState("");
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [entries, setEntries] = useState<{ id: string; value: Entry }[]>([{ id: "first", value: blankEntry() }]);
  const [linkedManifest, setLinkedManifest] = useState(false);
  const [manifestSource, setManifestSource] = useState<FilePin | null>(null);
  const [signedClaim, setSignedClaim] = useState(false);
  const [algorithm, setAlgorithm] = useState(""); const [signer, setSigner] = useState(""); const [signature, setSignature] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const completeEntries = entries.every(({ value }) => ["content", "profile"].includes(value.category) ? !!value.revision_id && !!value.revision_sha256 : ["rule", "model"].includes(value.category) ? !!value.source : !!value.recipe?.recipe_id && !!value.recipe?.version && /^[a-f0-9]{64}$/.test(value.recipe?.digest ?? ""));
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const manifest: Manifest = { format: "specmate.catalog-pack", contract_version: contractVersion, package_key: packageKey, label, version, publisher, rights, capabilities: capabilities.split(",").map((claim) => claim.trim()).filter(Boolean), requested_authority: [], dependencies, signature_claim: signedClaim ? { algorithm, signer, signature } : null, entries: entries.map((entry) => entry.value) };
    try { const result = await command<Version>("catalog_pack.register", { project_id: projectId, pack_id: packId || null, manifest, manifest_source: linkedManifest ? manifestSource : null }); if (active.current) await onRegistered(result); }
    catch (reason) { if (active.current) { setError(message(reason)); if (!(reason instanceof PackRequestError) || ![409, 422].includes(reason.status)) onDenied(reason); } }
    finally { if (active.current) setBusy(false); }
  }
  return <Card withBorder><form onSubmit={(event) => void submit(event)}><Stack>
    <Title order={3}>Register a catalog version</Title>
    {error && <Alert color="red">{error}</Alert>}
    <NativeSelect label="Pack to extend" value={packId} data={[{ value: "", label: "Create a distinct pack" }, ...packs.map((pack) => ({ value: pack.pack_id, label: pack.package_key }))]} onChange={(event) => { setPackId(event.currentTarget.value); setPackageKey(packs.find((pack) => pack.pack_id === event.currentTarget.value)?.package_key ?? ""); }} />
    <TextInput label="Package key" value={packageKey} onChange={(event) => setPackageKey(event.currentTarget.value)} required maxLength={100} disabled={!!packId} />
    <TextInput label="Catalog label" value={label} onChange={(event) => setLabel(event.currentTarget.value)} required maxLength={200} />
    <TextInput label="Version label" value={version} onChange={(event) => setVersion(event.currentTarget.value)} required maxLength={100} />
    <TextInput label="Declared publisher" value={publisher} onChange={(event) => setPublisher(event.currentTarget.value)} required maxLength={200} />
    <TextInput label="Declared pack rights" value={rights} onChange={(event) => setRights(event.currentTarget.value)} required maxLength={200} />
    <TextInput label="Required contract version" value={contractVersion} onChange={(event) => setContractVersion(event.currentTarget.value)} required maxLength={100} />
    <TextInput label="Capability claims, separated by commas" value={capabilities} onChange={(event) => setCapabilities(event.currentTarget.value)} />
    <MultiSelect label="Exact dependency versions" data={packs.flatMap((pack) => pack.versions.map((entry) => ({ value: entry.version_id, label: `${pack.package_key} · ${entry.version} · ${entry.version_id}` })))} value={dependencies} onChange={setDependencies} searchable />
    <Checkbox label="Retain an unverified signature claim" checked={signedClaim} onChange={(event) => setSignedClaim(event.currentTarget.checked)} />
    {signedClaim && <><TextInput label="Claimed signature algorithm" value={algorithm} onChange={(event) => setAlgorithm(event.currentTarget.value)} required maxLength={100} /><TextInput label="Claimed signer" value={signer} onChange={(event) => setSigner(event.currentTarget.value)} required maxLength={200} /><Textarea label="Unverified signature text" value={signature} onChange={(event) => setSignature(event.currentTarget.value)} required maxLength={4000} /></>}
    <Text size="sm">Publisher, capability and signature claims remain unverified. Pack rights are declared metadata and do not establish redistribution permission.</Text>
    <Checkbox label="Link an exact registered manifest file" checked={linkedManifest} onChange={(event) => setLinkedManifest(event.currentTarget.checked)} />
    {linkedManifest && <SourcePicker label="Manifest" projectId={projectId} projects={projects} onChange={setManifestSource} onDenied={onDenied} />}
    {entries.map((entry, index) => <Card withBorder key={entry.id}><EntryEditor index={index + 1} value={entry.value} projectId={projectId} projects={projects} onChange={(value) => setEntries((current) => current.map((row) => row.id === entry.id ? { ...row, value } : row))} onDenied={onDenied} />{entries.length > 1 && <Button variant="light" onClick={() => setEntries((current) => current.filter((row) => row.id !== entry.id))}>Remove entry {index + 1}</Button>}</Card>)}
    <Button variant="light" disabled={entries.length >= 100} onClick={() => setEntries((current) => [...current, { id: randomUUID(), value: blankEntry() }])}>Add catalog entry</Button>
    <Button type="submit" loading={busy} disabled={!canEdit || !completeEntries || (linkedManifest && !manifestSource)}>Register exact version</Button>
  </Stack></form></Card>;
}

function EntryEditor({ index, value, projectId, projects, onChange, onDenied }: { index: number; value: Entry; projectId: string; projects: Project[]; onChange: (entry: Entry) => void; onDenied: (reason: unknown) => void }) {
  const prefix = `Entry ${index}`;
  const patch = (changes: Partial<Entry>) => onChange({ ...value, ...changes });
  return <Stack gap="xs">
    <TextInput label={`${prefix} key`} value={value.key} onChange={(event) => patch({ key: event.currentTarget.value })} required maxLength={80} />
    <TextInput label={`${prefix} label`} value={value.label} onChange={(event) => patch({ label: event.currentTarget.value })} required maxLength={200} />
    <NativeSelect label={`${prefix} category`} value={value.category} data={[{ value: "content", label: "Engineering content" }, { value: "profile", label: "Workshop profile" }, { value: "rule", label: "Inert rule file" }, { value: "model", label: "Inert model file" }, { value: "recipe_reference", label: "Inert recipe reference" }]} onChange={(event) => onChange({ key: value.key, label: value.label, rights: value.rights, category: event.currentTarget.value as Entry["category"] })} />
    <TextInput label={`${prefix} declared rights`} value={value.rights} onChange={(event) => patch({ rights: event.currentTarget.value })} required maxLength={200} />
    {["content", "profile"].includes(value.category) && <RevisionPicker key={value.category} label={prefix} projectId={projectId} projects={projects} onChange={(pin) => patch({ revision_id: pin?.revision_id ?? null, revision_sha256: pin?.sha256 ?? null })} onDenied={onDenied} />}
    {["rule", "model"].includes(value.category) && <SourcePicker key={value.category} label={prefix} projectId={projectId} projects={projects} onChange={(source) => patch({ source })} onDenied={onDenied} />}
    {value.category === "recipe_reference" && <>
      <TextInput label={`${prefix} recipe identity`} value={value.recipe?.recipe_id ?? ""} onChange={(event) => patch({ recipe: { recipe_id: event.currentTarget.value, version: value.recipe?.version ?? "", digest: value.recipe?.digest ?? "" } })} required maxLength={100} />
      <TextInput label={`${prefix} recipe version`} value={value.recipe?.version ?? ""} onChange={(event) => patch({ recipe: { recipe_id: value.recipe?.recipe_id ?? "", version: event.currentTarget.value, digest: value.recipe?.digest ?? "" } })} required maxLength={100} />
      <TextInput label={`${prefix} recipe digest`} value={value.recipe?.digest ?? ""} onChange={(event) => patch({ recipe: { recipe_id: value.recipe?.recipe_id ?? "", version: value.recipe?.version ?? "", digest: event.currentTarget.value } })} required pattern="[a-f0-9]{64}" />
      <Text size="sm">Reference metadata only. This does not install or execute a recipe.</Text>
    </>}
  </Stack>;
}

function RevisionPicker({ label, projectId, projects, onChange, onDenied }: { label: string; projectId: string; projects: Project[]; onChange: (pin: { revision_id: string; sha256: string } | null) => void; onDenied: (reason: unknown) => void }) {
  const [scope, setScope] = useState(projectId); const [definitions, setDefinitions] = useState<{ definition_id: string; name: string; kind: string }[]>([]);
  const [definitionId, setDefinitionId] = useState(""); const [revisions, setRevisions] = useState<{ revision_id: string; number: number }[]>([]); const [revisionId, setRevisionId] = useState(""); const [offset, setOffset] = useState(0); const [more, setMore] = useState(false);
  const generation = useRef(0);
  useEffect(() => { const token = ++generation.current; void read<typeof definitions>(`projects/${scope}/definitions`).then((rows) => { if (token === generation.current) setDefinitions(rows); }).catch((reason) => { if (token === generation.current) onDenied(reason); }); return () => { generation.current += 1; }; }, [scope]);
  async function chooseDefinition(value: string) { const token = ++generation.current; setDefinitionId(value); setRevisionId(""); setRevisions([]); setOffset(0); setMore(false); onChange(null); if (!value) return; try { const identity = await read<{ revisions: typeof revisions }>(`catalog/definitions/${value}?offset=0&limit=50`); if (token === generation.current) { setRevisions(identity.revisions); setMore(identity.revisions.length === 50); } } catch (reason) { if (token === generation.current) onDenied(reason); } }
  async function chooseRevision(value: string) { const token = ++generation.current; setRevisionId(value); onChange(null); if (!value) return; try { const pin = await read<{ revision_id: string; sha256: string }>(`revisions/${value}`); if (token === generation.current) onChange(pin); } catch (reason) { if (token === generation.current) onDenied(reason); } }
  async function loadMore() { const token = ++generation.current; try { const identity = await read<{ revisions: typeof revisions }>(`catalog/definitions/${definitionId}?offset=${offset + 50}&limit=50`); if (token === generation.current) { setRevisions((current) => [...current, ...identity.revisions]); setOffset(offset + 50); setMore(identity.revisions.length === 50); } } catch (reason) { if (token === generation.current) onDenied(reason); } }
  return <Stack gap="xs"><NativeSelect label={`${label} source project`} value={scope} data={projects.map((project) => ({ value: project.project_id, label: project.name }))} onChange={(event) => { setScope(event.currentTarget.value); setDefinitions([]); setDefinitionId(""); setRevisionId(""); setRevisions([]); onChange(null); }} /><NativeSelect label={`${label} source definition`} value={definitionId} data={[{ value: "", label: "Select a source definition" }, ...definitions.map((definition) => ({ value: definition.definition_id, label: `${definition.name} · ${definition.kind}` }))]} onChange={(event) => void chooseDefinition(event.currentTarget.value)} required /><NativeSelect label={`${label} exact source revision`} value={revisionId} data={[{ value: "", label: "Select a frozen revision" }, ...revisions.map((revision) => ({ value: revision.revision_id, label: revisionOptionLabel(definitions.find((d) => d.definition_id === definitionId)?.name, revision.number) }))]} onChange={(event) => void chooseRevision(event.currentTarget.value)} required />{more && <Button variant="light" onClick={() => void loadMore()}>More {label.toLowerCase()} revisions</Button>}</Stack>;
}

function SourcePicker({ label, projectId, projects, onChange, onDenied }: { label: string; projectId: string; projects: Project[]; onChange: (pin: FilePin | null) => void; onDenied: (reason: unknown) => void }) {
  const [scope, setScope] = useState(projectId); const [files, setFiles] = useState<SourceFile[]>([]); const [selected, setSelected] = useState(""); const [next, setNext] = useState<number | null>(null); const generation = useRef(0);
  useEffect(() => { const token = ++generation.current; setFiles([]); setSelected(""); setNext(null); void read<{ results: SourceFile[]; next_after: number | null }>(`catalog-packs/projects/${scope}/source-files?limit=50`).then((page) => { if (token === generation.current) { setFiles(page.results); setNext(page.next_after); } }).catch((reason) => { if (token === generation.current) onDenied(reason); }); return () => { generation.current += 1; }; }, [scope]);
  async function more() { const token = ++generation.current; try { const page = await read<{ results: SourceFile[]; next_after: number | null }>(`catalog-packs/projects/${scope}/source-files?limit=50&after=${next}`); if (token === generation.current) { setFiles((current) => [...current, ...page.results]); setNext(page.next_after); } } catch (reason) { if (token === generation.current) onDenied(reason); } }
  return <Stack gap="xs"><NativeSelect label={`${label} file project`} value={scope} data={projects.map((project) => ({ value: project.project_id, label: project.name }))} onChange={(event) => { setScope(event.currentTarget.value); onChange(null); }} /><NativeSelect label={`${label} exact registered file`} value={selected} data={[{ value: "", label: "Select a registered file" }, ...files.map((file) => ({ value: String(file.file_id), label: `${file.bundle_name} · revision ${file.bundle_number} · ${file.source_path} · ${file.sha256}` }))]} onChange={(event) => { setSelected(event.currentTarget.value); const pin = files.find((file) => String(file.file_id) === event.currentTarget.value); onChange(pin ? { source_bundle_revision_id: pin.source_bundle_revision_id, source_path: pin.source_path, sha256: pin.sha256, rights: pin.rights } : null); }} required />{next !== null && <Button variant="light" onClick={() => void more()}>More {label.toLowerCase()} files</Button>}</Stack>;
}

function FileView({ pin }: { pin: FilePin }) { return <Stack gap={0}><Text size="sm"><RevisionLabel kind="source" id={pin.source_bundle_revision_id} role="Bundle" /></Text><Text size="sm" style={{ whiteSpace: "pre-wrap" }}>Path: {pin.source_path}</Text><Text size="sm">SHA-256 {pin.sha256}</Text><Text size="sm" style={{ whiteSpace: "pre-wrap" }}>Declared file rights: {pin.rights}</Text></Stack>; }
function VersionView({ version }: { version: Version }) {
  return <Stack gap="xs"><Text>Canonical manifest SHA-256 {version.sha256}</Text><Text style={{ whiteSpace: "pre-wrap" }}>Declared publisher: {version.manifest.publisher}</Text><Text style={{ whiteSpace: "pre-wrap" }}>Declared pack rights: {version.manifest.rights}</Text><Text>Signature: {version.signature_status.replaceAll("_", " ")} · publisher claim unverified · {version.compatibility.replaceAll("_", " ")}</Text><Text>Capability claims: {version.manifest.capabilities.join(", ") || "none"}. Execution authority: none.</Text><Text>Exact dependencies: {version.manifest.dependencies.join(", ") || "none"}</Text><Text size="sm">Registered {version.registered_at} · actor {version.registered_by_id}</Text>
    {version.manifest.signature_claim && <Text style={{ whiteSpace: "pre-wrap" }}>Unverified signature claim: {version.manifest.signature_claim.algorithm} · {version.manifest.signature_claim.signer} · {version.manifest.signature_claim.signature}</Text>}
    {version.manifest_source && <><Text fw={600}>Exact manifest source</Text><FileView pin={version.manifest_source} /></>}
    {version.entries.map((entry) => <Card withBorder key={entry.key}><Text fw={600} style={{ whiteSpace: "pre-wrap" }}>{entry.label} · {entry.key} · {entry.category}</Text><Text style={{ whiteSpace: "pre-wrap" }}>Declared entry rights: {entry.rights}</Text><Text>{entry.interpretation.replaceAll("_", " ")}</Text>{entry.engineering && <><Text>Source: {entry.engineering.name} · {entry.engineering.kind} · revision {entry.engineering.number}</Text><Text size="sm"><RevisionLabel id={entry.engineering.revision_id} extraPins={[{ label: 'Definition ID', value: entry.engineering.definition_id }]} /></Text><Text size="sm">Snapshot SHA-256 {entry.engineering.sha256}</Text></>}{entry.source && <FileView pin={entry.source} />}{entry.recipe && <Text>Inert recipe {entry.recipe.recipe_id} · version {entry.recipe.version} · digest {entry.recipe.digest}</Text>}</Card>)}
  </Stack>;
}
