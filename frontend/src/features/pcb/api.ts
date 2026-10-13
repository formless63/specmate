export type IntakeSummary = { intake_id: string; board_path: string; source_revision_id: string };
type Point = [number, number];
export type NativeReport = {
  source_sha256: string;
  tool_version: string;
  units: string;
  coordinate_frame: string;
  components: { id: string; reference: string; value: string; footprint: string; position: Point; rotation_deg: number; side: string; dnp: boolean }[];
  pads: { id: string; component_id: string; terminal: string; net: string; position: Point; type: string }[];
  copper_nets: Record<string, string[]>;
  outline: Point[][];
  cutouts: Point[][];
  mounting_holes: { pad_id: string; position: Point; drill: Point; mounting_status: string }[];
  coverage: Record<string, string>;
  unsupported: string[];
  physical_qualification: false;
};
export type Intake = IntakeSummary & {
  project_id: string;
  source_manifest_sha256: string;
  available_recipe_id: string | null;
  files: { path: string; sha256: string; size: number; rights: string; coverage: string; unsupported: string | string[] | null }[];
  attempts: { attempt_id: string; build_id: string; state: string; diagnostic?: string | null }[];
  interpretations: { interpretation_id: string; attempt_id: string; output_id: string; sha256: string; report: NativeReport }[];
};

export type PopulationDecision = { component_id: string; status: "populate" | "omit" | null; basis: string | null };
export type PopulationOption = { local_id: string; name: string; decisions: PopulationDecision[] };
export type AssociationEvidence =
  | { kind: "citation"; citation: string }
  | { kind: "source_file"; source_revision_id: string; path: string; sha256: string; rights: string };
export type Association = {
  local_id: string; kind: "port" | "model" | "library"; component_id: string;
  pad_id: string | null; target_revision_id: string | null; target_contact_id: string | null;
  representation_id: string | null; review: "candidate" | "accepted" | "rejected";
  basis: string | null; evidence: AssociationEvidence | null;
};
export type Population = {
  schema_version: "1"; interpretation_id: string; interpretation_sha256: string;
  source_revision_id: string; source_manifest_sha256: string;
  options: PopulationOption[]; associations: Association[];
};
export type PopulationDraft = {
  definition_id: string; name: string; draft_id: string; state: string;
  content: { pcb_population: Population };
  revisions: { revision_id: string; number: number }[];
};
export type AssociationTargets = {
  revisions: { revision_id: string; kind: string; name: string; number: number; contacts: string[] }[];
  models: { representation_id: string; revision_id: string; label: string; rights: string; sha256: string }[];
  truncated: { revisions: boolean; models: boolean };
};

export class PcbRequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function csrfToken() {
  return document.cookie.split("; ").find((c) => c.startsWith("csrftoken="))?.split("=").slice(1).join("=") ?? "";
}

async function request<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { ...init, signal, credentials: "same-origin" });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new PcbRequestError(response.status, data?.error?.message ?? `Request failed (${response.status})`);
  if (data === null) throw new PcbRequestError(response.status, "Unexpected server response.");
  return data as T;
}

export function listIntakes(projectId: string, signal?: AbortSignal) {
  return request<IntakeSummary[]>(`/api/v0/pcb/projects/${encodeURIComponent(projectId)}/intakes`, {}, signal);
}
export function getIntake(id: string, signal?: AbortSignal) {
  return request<Intake>(`/api/v0/pcb/intakes/${encodeURIComponent(id)}`, {}, signal);
}
export function listPopulations(intakeId: string, signal?: AbortSignal) {
  return request<PopulationDraft[]>(`/api/v0/pcb/intakes/${encodeURIComponent(intakeId)}/populations`, {}, signal);
}
export function associationTargets(projectId: string, signal?: AbortSignal) {
  return request<AssociationTargets>(`/api/v0/pcb/projects/${encodeURIComponent(projectId)}/association-targets`, {}, signal);
}
export async function command<T>(operation: string, payload: object, signal?: AbortSignal, expectedState?: string) {
  const result = await request<{ result: T }>("/api/v0/operations", {
    method: "POST", headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken() },
    body: JSON.stringify({ operation, payload, request_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID(), expected_state: expectedState }),
  }, signal);
  return result.result;
}

export async function preserveFiles(projectId: string, files: File[], name: string, rights: string, boardPath: string, signal?: AbortSignal) {
  const refs = [];
  for (const file of files) {
    const content = await file.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", content);
    const sha256 = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
    const path = file.webkitRelativePath || file.name;
    const media_type = file.type || "application/octet-stream";
    const form = new FormData();
    for (const [key, value] of Object.entries({ request_id: crypto.randomUUID(), sha256, size: `${file.size}`, media_type })) form.set(key, value);
    form.set("content", file);
    await request(`/api/v0/projects/${encodeURIComponent(projectId)}/blobs`, {
      method: "POST", headers: { "X-CSRFToken": csrfToken() }, body: form,
    }, signal);
    refs.push({ path, sha256, media_type, rights });
  }
  const bundle = await command<{ revision_id: string }>("source.create_original_bundle", { project_id: projectId, name, files: refs }, signal);
  return command<{ intake_id: string }>("pcb.register_intake", { project_id: projectId, source_revision_id: bundle.revision_id, board_path: boardPath }, signal);
}
