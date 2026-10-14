import { Badge, Button, Group } from "@mantine/core";
import { useEffect, useState } from "react";
import { requestJson } from "../workspace/api";
import { readPreferences, type Effective } from "./api";

/**
 * Form pre-fill from the effective workspace/user preferences.
 *
 * Preferences carry names and units only. This module is the single place forms read them,
 * and it only ever offers values for the fields in `PREFILL_TARGETS`: naming/convention
 * fields, never an engineering fact or rating (dimensions, quantities, facts, limits).
 */
export const PREFILL_TARGETS = {
  wire_colours: "new stock element colour",
  default_wire_gauge_system: "stock conductor size system",
  default_length_unit: "new BOM need quantity unit",
  connector_families: "cable connector body filter",
  preferred_suppliers: "BOM supplier shortlist",
} as const;

export type Defaults = {
  list: (key: string) => string[];
  text: (key: string) => string | null;
};
const none: Defaults = { list: () => [], text: () => null };

export function defaultsFrom(effective: Effective | null): Defaults {
  if (!effective) return none;
  return {
    list: (key) => { const v = effective[key]?.value; return Array.isArray(v) ? v : []; },
    text: (key) => { const v = effective[key]?.value; return typeof v === "string" ? v : null; },
  };
}

/** Reads effective preferences once; any failure (or no access) simply means nothing is pre-filled. */
export function usePreferenceDefaults(): Defaults {
  const [effective, setEffective] = useState<Effective | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const page = await requestJson<{ workspace_id?: string }>("/api/v0/workspace/projects?include_archived=true&limit=1");
        if (!page?.workspace_id) return;
        const prefs = await readPreferences(page.workspace_id);
        if (live && prefs?.effective) setEffective(prefs.effective);
      } catch { /* no preference defaults */ }
    })();
    return () => { live = false; };
  }, []);
  return defaultsFrom(effective);
}

/** Marks a pre-filled value and lets the user clear it. */
export function FromPreference({ what, onClear }: { what: string; onClear: () => void }) {
  return <Group gap={4} wrap="nowrap" data-from-preference={what}>
    <Badge variant="light" size="xs">from preference</Badge>
    <Button size="compact-xs" variant="subtle" onClick={onClear} aria-label={`Clear ${what} preference`}>Clear</Button>
  </Group>;
}
