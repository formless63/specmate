import { Alert, Badge, Button, Card, Group, NativeSelect, Stack, Text, TextInput, Title } from "@mantine/core";
import { useRef, useState, type FormEvent } from "react";
import { revisionsOf, searchCatalog, whereUsed, type DefinitionRevisions, type SearchKind, type SearchPage, type SearchRecord, type UsePage } from "./api";
import { RevisionImpact } from "./RevisionImpact";

const kinds: { value: SearchKind; label: string }[] = [
  { value: "definition", label: "Reusable definitions" },
  { value: "project", label: "Projects" },
  { value: "source_bundle", label: "Source bundles and paths" },
  { value: "variant", label: "Manufacturer variants" },
  { value: "lot", label: "Physical lots" },
  { value: "stock", label: "Stock accounts" },
];

export function DiscoveryPanel({ projectId }: { projectId: string }) {
  return <DiscoveryWorkspace key={projectId} projectId={projectId} />;
}

function DiscoveryWorkspace({ projectId }: { projectId: string }) {
  const [kind, setKind] = useState<SearchKind>("definition");
  const [scope, setScope] = useState("all");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState<{ kind: SearchKind; query: string; projectId?: string } | null>(null);
  const [page, setPage] = useState<SearchPage | null>(null);
  const [definition, setDefinition] = useState<DefinitionRevisions | null>(null);
  const [definitionOffset, setDefinitionOffset] = useState(0);
  const [moreRevisions, setMoreRevisions] = useState(false);
  const [uses, setUses] = useState<UsePage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  async function search(event: FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    const token = ++generation.current;
    setBusy(true); setError(""); setPage(null); setDefinition(null); setUses(null);
    const scopedProject = scope === "current" ? projectId : undefined;
    setSubmitted({ kind, query: trimmed, projectId: scopedProject });
    try {
      const result = await searchCatalog(kind, trimmed, scopedProject);
      if (token === generation.current) setPage(result);
    } catch (reason) {
      if (token === generation.current) { setPage(null); setDefinition(null); setUses(null); setError(message(reason)); }
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }

  async function moreSearch() {
    if (!page?.next_after || !submitted) return;
    const token = ++generation.current;
    setBusy(true); setError("");
    try {
      const next = await searchCatalog(submitted.kind, submitted.query, submitted.projectId, page.next_after);
      if (token === generation.current) setPage({ ...next, results: [...page.results, ...next.results] });
    } catch (reason) {
      if (token === generation.current) { setPage(null); setDefinition(null); setUses(null); setError(message(reason)); }
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }

  async function inspect(record: SearchRecord) {
    const token = ++generation.current;
    setBusy(true); setError(""); setDefinition(null); setUses(null);
    setDefinitionOffset(0); setMoreRevisions(false);
    try {
      if (record.revision_id) {
        const result = await whereUsed(record.revision_id);
        if (token === generation.current) setUses(result);
      } else if (submitted?.kind === "definition") {
        const result = await revisionsOf(record.record_id);
        if (token === generation.current) {
          setDefinition(result);
          setMoreRevisions(result.revisions.length === 50);
        }
      }
    } catch (reason) {
      if (token === generation.current) setError(message(reason));
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }

  async function loadRevisions() {
    if (!definition) return;
    const token = ++generation.current;
    const offset = definitionOffset + 50;
    setBusy(true); setError("");
    try {
      const next = await revisionsOf(definition.definition_id, offset);
      if (token === generation.current) {
        setDefinition({ ...definition, revisions: [...definition.revisions, ...next.revisions] });
        setDefinitionOffset(offset);
        setMoreRevisions(next.revisions.length === 50);
      }
    } catch (reason) {
      if (token === generation.current) { setDefinition(null); setUses(null); setError(message(reason)); }
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }

  async function inspectRevision(revisionId: string, after?: string) {
    const token = ++generation.current;
    const previous = uses;
    setBusy(true); setError(""); setUses(null);
    try {
      const next = await whereUsed(revisionId, after);
      if (token === generation.current) setUses(after && previous
        ? { ...next, results: [...previous.results, ...next.results] } : next);
    } catch (reason) {
      if (token === generation.current) setError(message(reason));
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }

  return <Stack>
    <Title order={2}>Discovery</Title>
    <Text>Search records in your accessible projects. Results and exact revision pins reflect your current access.</Text>
    <form onSubmit={(event) => void search(event)}><Group align="end">
      <NativeSelect label="Record type" value={kind} data={kinds} onChange={(event) => setKind(event.currentTarget.value as SearchKind)} />
      <NativeSelect label="Search scope" value={scope} data={[{ value: "all", label: "All accessible projects" }, { value: "current", label: "Selected project" }]} onChange={(event) => setScope(event.currentTarget.value)} />
      <TextInput label="Search terms" value={query} onChange={(event) => setQuery(event.currentTarget.value)} maxLength={200} />
      <Button type="submit" disabled={!query.trim()} loading={busy}>Search</Button>
    </Group></form>
    {error && <Alert color="red">{error}</Alert>}
    {page && <Card withBorder><Stack>
      <Title order={3}>Search results</Title>
      {page.results.length === 0 && <Text>No visible matches.</Text>}
      {page.results.map((record) => <Group key={record.record_id} justify="space-between">
        <Stack gap={0}><Text>{record.label} {record.definition_kind && <Badge>{record.definition_kind}</Badge>}</Text>
          <Text size="xs">ID {record.record_id} · project {record.project_id}</Text>
          {record.revision_id && <Text size="xs">Exact revision {record.revision_id}</Text>}
          {record.association_basis && <Text size="xs">Association: {record.association_basis}</Text>}
        </Stack>
        {(record.revision_id || submitted?.kind === "definition") && <Button size="xs" variant="light" disabled={busy} onClick={() => void inspect(record)}>Inspect uses</Button>}
      </Group>)}
      {page.next_after && <Button variant="light" disabled={busy} onClick={() => void moreSearch()}>More results</Button>}
    </Stack></Card>}
    {definition && <Card withBorder><Stack><Title order={3}>Revisions of {definition.name}</Title>
      {definition.revisions.length === 0 && <Text>No frozen revisions.</Text>}
      {definition.revisions.map((revision) => <Group key={revision.revision_id}>
        <Button size="xs" variant="light" disabled={busy} onClick={() => void inspectRevision(revision.revision_id)}>Inspect revision {revision.number}</Button>
        <Text size="xs">{revision.revision_id}</Text>
      </Group>)}
      {moreRevisions && <Button variant="light" disabled={busy} onClick={() => void loadRevisions()}>More revisions</Button>}
      <RevisionImpact key={definition.definition_id} definition={definition} />
    </Stack></Card>}
    {uses && <Card withBorder><Stack><Title order={3}>Exact revision pins</Title>
      <Text size="xs">Revision {uses.revision_id}</Text>
      {uses.results.length === 0 && <Text>No visible parent snapshots pin this revision.</Text>}
      {uses.results.map((item) => <Stack key={item.snapshot_id} gap={0}>
        <Text>{item.label}</Text><Text size="xs">Snapshot {item.snapshot_id} · definition {item.definition_id} · project {item.project_id}</Text>
      </Stack>)}
      {uses.next_after && <Button variant="light" disabled={busy} onClick={() => void inspectRevision(uses.revision_id, uses.next_after ?? undefined)}>More uses</Button>}
    </Stack></Card>}
  </Stack>;
}

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : "Discovery request failed.";
}
