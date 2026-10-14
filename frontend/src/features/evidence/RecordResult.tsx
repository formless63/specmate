import { Alert, Button, Group, Text } from "@mantine/core";
import { QueryClientContext } from "@tanstack/react-query";
import { useContext, useEffect, useRef, useState } from "react";
import { usePermission } from "../../lib/permissions";
import { randomUUID } from "../../lib/random-id";
import type { RecordedResult } from "./api";

/**
 * Deliberately records the result on screen as an immutable evidence snapshot. One
 * idempotency key per shown result makes a retry return the same record.
 */
export function RecordResult({ fingerprint, record, partial }: { fingerprint: string; record: (idempotencyKey: string) => Promise<RecordedResult>; partial?: string | null }) {
  const gate = usePermission("item.create");
  // Panels mounted without a query cache still record; the evidence list refreshes when present.
  const cache = useContext(QueryClientContext);
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const [saved, setSaved] = useState<RecordedResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setSaved(null); setError(""); }, [fingerprint]);
  async function submit() {
    if (intent.current?.fingerprint !== fingerprint) intent.current = { fingerprint, key: randomUUID() };
    setBusy(true); setError("");
    try {
      const value = await record(intent.current.key);
      if (!active.current) return;
      setSaved(value);
      void cache?.invalidateQueries({ queryKey: ["evidence"] });
    } catch (failure) { if (active.current) setError((failure as Error).message); }
    finally { if (active.current) setBusy(false); }
  }
  return <>
    <Group>
      <Button {...gate.props} disabled={gate.props.disabled || busy || !!saved} onClick={() => { void submit(); }}>Record result as evidence</Button>
      <Text size="xs">Stores this exact result with its input pins. It is never rewritten; newer input revisions mark it stale.</Text>
    </Group>
    {partial && <Text size="sm">Partial record: observations {partial}. Other observations in scope are not recorded.</Text>}
    {saved && <Text size="sm">Recorded {saved.recorded_at} · record {saved.record_id} · SHA-256 {saved.result_sha256}</Text>}
    {error && <Alert color="red">{error}</Alert>}
  </>;
}
