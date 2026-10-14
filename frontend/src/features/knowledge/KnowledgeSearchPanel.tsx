import { Alert, Button, Card, Checkbox, Group, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { downloadUrl, type Attachment } from "./api";
import { previewAttachment, searchKnowledge, type Preview, type SearchInput, type SearchPage, type SearchRow } from "./search-api";

/** Reusable current-project knowledge search. Retained host tabs must pass active. */
export function KnowledgeSearchPanel({ projectId, principalKey, active = true }: { projectId: string; principalKey: string; active?: boolean }) {
  return <Workspace key={`${projectId}:${principalKey}`} projectId={projectId} active={active} />;
}
function Workspace({ projectId, active }: { projectId: string; active: boolean }) {
  const [text, setText] = useState(""), [history, setHistory] = useState(false);
  const [result, setResult] = useState<SearchPage | null>(null), [preview, setPreview] = useState<Preview | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false), generation = useRef(0), controller = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null), submitted = useRef<SearchInput | null>(null);
  const fence = useCallback(() => {
    generation.current += 1; controller.current?.abort(); controller.current = null;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null; setImageUrl(null); setPreview(null); setResult(null); setBusy(false);
    return generation.current;
  }, []);
  const search = useCallback(async (input: SearchInput) => {
    const attempt = fence(), abort = new AbortController(); controller.current = abort;
    submitted.current = input; setBusy(true); setError("");
    try {
      const next = await searchKnowledge(input, abort.signal);
      if (mounted.current && generation.current === attempt && !abort.signal.aborted) setResult(next);
    } catch (reason) {
      if (mounted.current && generation.current === attempt && !abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Knowledge search unavailable.");
    } finally { if (mounted.current && generation.current === attempt) setBusy(false); }
  }, [fence]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; controller.current?.abort(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); };
  }, []);
  useEffect(() => {
    const refresh = () => { if (active && document.visibilityState !== "hidden" && submitted.current) void search(submitted.current); };
    const hide = () => { fence(); };
    const visibility = () => { if (document.visibilityState === "hidden") hide(); else refresh(); };
    window.addEventListener("focus", refresh); window.addEventListener("blur", hide); document.addEventListener("visibilitychange", visibility);
    if (active) refresh(); else hide();
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("blur", hide); document.removeEventListener("visibilitychange", visibility); };
  }, [active, fence, search]);
  async function inspect(row: SearchRow, attachment: Attachment) {
    const attempt = fence(), abort = new AbortController(); controller.current = abort;
    setBusy(true); setError("");
    try {
      const { preview: next, bytes } = await previewAttachment({ item_id: row.item_id, entry_id: row.entry_id, bundle_revision_id: attachment.bundle_revision_id, path: attachment.path }, attachment, abort.signal);
      if (!mounted.current || generation.current !== attempt || abort.signal.aborted) return;
      if (next.kind === "png" && bytes) {
        objectUrl.current = URL.createObjectURL(new Blob([bytes.buffer], { type: "image/png" })); setImageUrl(objectUrl.current);
      }
      setPreview(next);
    } catch (reason) {
      if (mounted.current && generation.current === attempt && !abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Attachment preview unavailable.");
    } finally { if (mounted.current && generation.current === attempt) setBusy(false); }
  }
  return <Stack><Title order={2}>Search notes and attachments</Title>
    <Text>Search permitted note and decision text, titles and registered attachment metadata. Results retain exact entry and source identities. File contents are not indexed. Previews do not qualify engineering content.</Text>
    <form onSubmit={event => { event.preventDefault(); if (active && text.trim()) void search({ project_id: projectId, query: text.trim(), include_history: history }); }}><Stack gap="xs">
      <TextInput label="Knowledge search text" maxLength={200} value={text} onChange={event => setText(event.currentTarget.value)} />
      <Checkbox label="Include historical knowledge entries" checked={history} onChange={event => setHistory(event.currentTarget.checked)} />
      <Group><Button type="submit" disabled={!active || busy || !text.trim()}>Search permitted knowledge</Button><Button disabled={!active || busy || !submitted.current} variant="light" onClick={() => submitted.current && void search(submitted.current)}>Refresh search authority</Button></Group>
    </Stack></form>
    {busy && <Text>Checking current search and attachment authority…</Text>}{error && <Alert color="red">{error}</Alert>}
    {active && result && <><Text>Results for {result.query}</Text>{result.results.length === 0 && <Text>No permitted matches.</Text>}
      {result.results.map(row => <Card key={row.entry_id} withBorder><Stack><Title order={3}>{row.title}</Title><Text>{row.kind} · entry {row.entry_number} · {row.current ? "current" : "historical"}{row.decision_status ? ` · ${row.decision_status}` : ""}</Text>
        <Text size="xs">Item {row.item_id} · entry {row.entry_id} · project {row.project_id}</Text>
        {row.matches.map((match, index) => <Text key={index} style={{ whiteSpace: "pre-wrap" }}>{match.field}: {match.text}</Text>)}
        {row.links.map(link => <Text key={link.link_id}>{link.label} · exact target {JSON.stringify(link.target)}</Text>)}
        {row.attachments.map(attachment => <Group key={`${attachment.bundle_revision_id}:${attachment.path}`}><Text>{attachment.label || attachment.path} · {attachment.path} · {attachment.media_type} · {attachment.size} bytes · rights {attachment.rights}</Text><Button onClick={() => void inspect(row, attachment)}>Inspect {attachment.path}</Button></Group>)}
      </Stack></Card>)}
      {result.next_after && <Button onClick={() => submitted.current && void search({ ...submitted.current, after: result.next_after! })}>Next permitted matches</Button>}
    </>}
    {active && preview && <Card withBorder><Stack><Title order={3}>Exact attachment inspection</Title>
      <Text>{preview.attachment.label || preview.attachment.path} · {preview.attachment.path}</Text><Text size="xs">Item {preview.item_id} · entry {preview.entry_id} · source {preview.attachment.bundle_revision_id} · original SHA-256 {preview.attachment.sha256}</Text>
      <Text>Owner project {preview.attachment.blob_project_id} · {preview.attachment.size} original bytes · rights {preview.attachment.rights}</Text>
      <Text>Integrity: {preview.integrity.replaceAll("_", " ")}. Physical and engineering qualification: not evaluated.</Text>
      {preview.kind === "text" && <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{preview.text}</pre>}
      {preview.kind === "png" && imageUrl && <><Text>Normalized PNG preview · {preview.width} × {preview.height} pixels · original metadata removed.</Text><img src={imageUrl} alt="Inert normalized attachment preview" style={{ maxWidth: "100%", maxHeight: 600, objectFit: "contain" }} /></>}
      {(preview.kind === "png" || preview.kind === "text") && <Text size="xs">Preview SHA-256 {preview.preview_sha256} · {preview.transformation}</Text>}
      {preview.kind === "zip" && <><Text>Inert archive listing. Member bytes were checked; files were not executed, opened or registered as new originals.</Text><Table><Table.Thead><Table.Tr><Table.Th>Member path</Table.Th><Table.Th>Bytes</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{preview.members.map(member => <Table.Tr key={member.path}><Table.Td>{member.path}{member.directory ? " (directory)" : ""}</Table.Td><Table.Td>{member.size}</Table.Td></Table.Tr>)}</Table.Tbody></Table></>}
      {preview.kind === "download_only" && <Text>Download only: {preview.reason}</Text>}
      <Button component="a" href={downloadUrl(preview.attachment)}>Download original inert bytes</Button>
      <Text size="sm">Supported previews: bounded UTF-8 text, noninterlaced 8-bit grayscale/RGB PNG and bounded classic ZIP listings. HTML, SVG, PDF, code, native and unsupported image variants remain download-only.</Text>
    </Stack></Card>}
  </Stack>;
}
