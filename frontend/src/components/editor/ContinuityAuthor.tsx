import { Alert, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { PlanEditor } from "../../features/cable-test-intent/PlanEditor";
import { initialPlan, read, type Draft, type Identity, type Inspection, type TestPlan } from "../../features/cable-test-intent/api";
import { runOperation } from "../../features/workspace/api";
import { usePermission } from "../../lib/permissions";
import { randomUUID } from "../../lib/random-id";
import { canonicalJson } from "./history";

/** Independent CAS buffer: a cable's draft is never changed by test-plan authoring. */
export function ContinuityAuthor({ name, revisionId, workspaceId, principalKey, active, boundRevisionId, onBound, onDenied }: {
  name: string; revisionId: string; workspaceId: string; principalKey: string; active: boolean;
  boundRevisionId?: string | null;
  onBound: (revisionId: string) => void; onDenied: (error: unknown) => void;
}) {
  const createGate = usePermission("item.create"), editGate = usePermission("design.edit"), freezeGate = usePermission("design.freeze");
  const [plan, setPlan] = useState<TestPlan>(() => ({ ...initialPlan(), root_revision_id: revisionId, cable_revision_id: revisionId }));
  const [label, setLabel] = useState(`${name} test plan`), [base, setBase] = useState<Draft | null>(null);
  const [targetDenied, setTargetDenied] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [pendingFrozen, setPendingFrozen] = useState<string | null>(null);
  const alive = useRef(false), current = useRef(active); current.current = active;
  const intents = useRef(new Map<string, string>());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const dirty = !!base && canonicalJson(base.content.test_plan) !== canonicalJson(plan);
  const readonly = base ? !editGate.allowed : !createGate.allowed;
  async function operation<T>(name: string, payload: unknown, expectedState?: string): Promise<T> {
    const fingerprint = canonicalJson([name, payload, expectedState]);
    const key = intents.current.get(fingerprint) ?? randomUUID(); intents.current.set(fingerprint, key);
    const result = await runOperation<T>(name, payload, { expectedState, idempotencyKey: key });
    intents.current.delete(fingerprint); return result.result;
  }
  async function act(work: () => Promise<void>) {
    if (!active || busy || targetDenied) return;
    setBusy(true); setError("");
    try { await work(); } catch (reason) { if (alive.current) { setError(reason instanceof Error ? reason.message : "Test plan unavailable."); onDenied(reason); } }
    finally { if (alive.current) setBusy(false); }
  }
  async function openBound(copy: boolean) {
    if (!boundRevisionId || base || plan.pairs.length || plan.labels.length) return;
    await act(async () => {
      const frozen = await read<Inspection & { definition_id: string }>(`cable-test-intent/revisions/${boundRevisionId}`);
      if (!alive.current || !current.current) return;
      let value = frozen.test_plan; let saved: Draft | null = null;
      if (!copy) {
        const identity = await read<Identity>(`catalog/definitions/${frozen.definition_id}?offset=0`);
        const draftId = identity.drafts.at(-1)?.draft_id;
        if (!draftId) throw new Error("No editable draft is available. Copy frozen expectations into a new plan.");
        saved = await read<Draft>(`cable-test-intent/drafts/${draftId}`); value = saved.content.test_plan;
      }
      if (value.root_revision_id !== revisionId || value.cable_revision_id !== revisionId || value.occurrence_path.length) throw new Error("This plan draft targets another exact context. Copy matching frozen expectations into a new plan.");
      if (alive.current && current.current) { setPlan(value); setBase(saved); }
    });
  }
  return <Stack gap="xs" hidden={!active}><Text fw={600}>Author test expectations and labels</Text><Text size="xs">Exact frozen cable {revisionId}. Proposed pairs replace local intent only when chosen. No physical test is recorded.</Text>
    {!base && <><TextInput label="Test-plan name" disabled={busy || readonly} value={label} onChange={event => { if (!busy) setLabel(event.currentTarget.value); }} />{boundRevisionId && <Group><Button size="xs" variant="quiet" disabled={busy || !editGate.allowed || !!plan.pairs.length || !!plan.labels.length} onClick={() => void openBound(false)}>Continue bound plan draft</Button><Button size="xs" variant="quiet" disabled={busy || !createGate.allowed || !!plan.pairs.length || !!plan.labels.length} onClick={() => void openBound(true)}>Copy frozen expectations into new plan</Button></Group>}</>}
    <PlanEditor fixedTarget principalKey={principalKey} active={active} hidden={!active} disabled={busy || readonly} value={plan} onChange={value => { if (!busy && !readonly) setPlan(value); }} onAuthorityChange={setTargetDenied} onAccessDenied={onDenied} />
    {error && <Alert color="red">{error}</Alert>}
    <Group>{!base ? <Button {...createGate.props} disabled={!createGate.allowed || busy || targetDenied || !label.trim()} onClick={() => void act(async () => { const saved = await operation<Draft>("cable_test_plan.create", { workspace_id: workspaceId, name: label.trim(), test_plan: plan }); if (alive.current) setBase(saved); })}>Create test-plan draft</Button> : <><Button {...editGate.props} disabled={!editGate.allowed || busy || targetDenied || !dirty} onClick={() => void act(async () => { const saved = await operation<Draft>("cable_test_plan.update", { draft_id: base.draft_id, test_plan: plan }, base.state); if (alive.current) setBase(saved); })}>Save test-plan draft</Button><Button {...freezeGate.props} disabled={!freezeGate.allowed || busy || targetDenied || dirty} onClick={() => void act(async () => { const frozen = await operation<{ revision_id: string; draft: Draft }>("cable_test_plan.freeze", { draft_id: base.draft_id }, base.state); if (alive.current) { setBase(frozen.draft); setPendingFrozen(frozen.revision_id); if (current.current) { onBound(frozen.revision_id); setPendingFrozen(null); } } })}>Freeze and bind saved test plan</Button><Text size="xs">{dirty ? "Unsaved expectations. Save before freezing." : "Saved draft · independent state token"}</Text></>}</Group>
    {pendingFrozen && <Button disabled={!active || busy} onClick={() => { onBound(pendingFrozen); setPendingFrozen(null); }}>Bind completed frozen test plan</Button>}
  </Stack>;
}
