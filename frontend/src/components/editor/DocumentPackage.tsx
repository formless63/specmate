import { Alert, Button, Checkbox, Group, Stack, Text } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import type { Configuration } from "../../features/preparation-documents/api";
import { review, download, saveArchive, type Review, type ExportRequest } from "../../features/export-packages/api";
import * as selected from "../../features/selected-packages/api";
import { canonicalJson } from "./history";

/** Root identity is supplied by the editor. No second picker or workspace-history request. */
export function DocumentPackage({ active, rootRevisionId, config, documentSetId, onDenied }: {
  active: boolean; rootRevisionId: string; config: Configuration; documentSetId: string | null; onDenied: (error: unknown) => void;
}) {
  const payload: ExportRequest = { root_revision_id: rootRevisionId, quantity: config.quantity, bom_plan_revision_id: config.bom_plan_revision_id, bom_purpose: "procurement", preparation_document_set_ids: documentSetId ? [documentSetId] : [], test_plan_revision_ids: config.bindings.flatMap(binding => binding.test_plan_revision_id ? [binding.test_plan_revision_id] : []), pcb_fabrication_builds: [], firmware_builds: [], scene_drawing_ids: [], purpose: "authorized_review" };
  const selection: selected.Selection = { root_revision_id: rootRevisionId, occurrence_path: [], purpose: config.purpose, rights_reviews: config.rights_reviews };
  const fingerprint = canonicalJson([payload, selection]);
  const [checked, setChecked] = useState<{ fingerprint: string; value: Review } | null>(null);
  const [selectedReview, setSelectedReview] = useState<{ fingerprint: string; value: selected.Review } | null>(null);
  const [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(false); const current = useRef({ active, fingerprint }); current.current = { active, fingerprint };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const valid = () => alive.current && current.current.active && current.current.fingerprint === fingerprint;
  async function act(work: () => Promise<void>) {
    if (!active || busy) return;
    setBusy(true); setError("");
    try { await work(); } catch (reason) { if (valid()) { setChecked(null); setSelectedReview(null); setError(reason instanceof Error ? reason.message : "Package unavailable."); onDenied(reason); } }
    finally { if (alive.current) setBusy(false); }
  }
  const value = active && checked?.fingerprint === fingerprint ? checked.value : null;
  const selectionValue = active && selectedReview?.fingerprint === fingerprint ? selectedReview.value : null;
  return <Stack gap="xs"><Group><Button disabled={!active || busy} onClick={() => void act(async () => { const result = await review(payload); if (valid()) { setChecked({ fingerprint, value: result }); setAck(false); } })}>Review export package</Button><Button disabled={!active || busy} variant="quiet" onClick={() => void act(async () => { const result = await selected.review(selection); if (valid()) setSelectedReview({ fingerprint, value: result }); })}>Review selected design package</Button></Group>
    {error && <Alert color="red">{error}</Alert>}
    {value && <><Text fw={600}>Package review · {value.manifest.coherence} · {value.manifest.completeness}</Text><Text size="xs" className="sb-mono">Manifest SHA-256 {value.sha256}</Text><Text size="sm">Declared rights: {Object.entries(value.manifest.rights.counts).map(([key, count]) => `${count} ${key}`).join(" · ")}</Text>{value.manifest.unresolved.map((row, index) => <Text key={index} size="xs">{row.output}: {row.reason}</Text>)}{value.manifest.rights.acknowledgement_required && <Checkbox label="Unknown or restricted rights: I acknowledge authorized internal review only" checked={ack} onChange={event => setAck(event.currentTarget.checked)} />}<Button disabled={!active || busy || value.manifest.coherence === "incoherent" || value.manifest.rights.acknowledgement_required && !ack} onClick={() => void act(async () => { const blob = await download(payload, value.sha256, ack); if (valid()) saveArchive(blob); })}>Download reviewed export package</Button></>}
    {selectionValue && <><Text size="sm">Selected design · {selectionValue.manifest.completeness} · rights {selectionValue.manifest.rights}</Text><Text size="xs" className="sb-mono">Manifest SHA-256 {selectionValue.sha256}</Text><Button disabled={!active || busy} onClick={() => void act(async () => { const blob = await selected.download(selection, selectionValue.sha256); if (valid()) selected.saveArchive(blob); })}>Download reviewed selected design</Button></>}
  </Stack>;
}
