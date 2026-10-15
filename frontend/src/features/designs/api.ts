import { requestJson, type LibraryRecord } from "../workspace/api";

export type DesignKind = "cable" | "harness" | "assembly";
export type DesignPin = { definition_id: string; revision_id: string; revision: number; label: string };
export type DesignEnd = { label: string | null; basis: "intent_port" | "intent_pinout" | "endpoint_label" | "unknown"; revision_id: string | null };
export type DesignRow = LibraryRecord & {
  design: {
    basis: "latest_frozen" | "newest_draft" | "unknown";
    revision_id: string | null;
    revision: number | null;
    draft_id: string | null;
    review: "reviewed" | "unreviewed" | "unknown";
    from: DesignEnd;
    to: DesignEnd;
    stocks: DesignPin[];
    boards: DesignPin[];
    checks: "not_evaluated";
  };
};
export type DesignPage = { workspace_id: string; family: "definition"; project_id: string | null; results: DesignRow[]; next_after: string | null };

export function listDesigns(filters: Record<string, string>, projectId: string | null, after: string | null): Promise<DesignPage> {
  const params = new URLSearchParams({ limit: "50" });
  for (const key of ["q", "kind", "status", "from", "to", "stock", "board"]) if (filters[key]) params.set(key, filters[key]);
  if (projectId) params.set("project_id", projectId);
  if (after) params.set("after", after);
  return requestJson(`/api/v0/workspace/designs?${params}`);
}
