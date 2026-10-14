/** Why a failed build failed: the program's exit-code check, never a generic message. */
export type Diagnostic = {
  code: number | null; check: string; message: string; detail: string;
  stderr_class: string | null; detail_retained: boolean;
};

export type Options = {
  available_recipe_id: string | null;
  available_recipes?: { recipe_id: string; copper_layers: number }[];
  unavailable_reason: string | null;
  builds: { build_id: string; state: string; copper_layers?: number; diagnostic?: Diagnostic }[];
  limit: number;
};

export type Companion = { path: string; sha256: string } | null;

export type Features = {
  through_vias: number; slots: number; copper_zones: number; copper_zones_without_stored_copper: number;
  rule_areas: number; zones_refilled: false; production_graphics: number; unresolved_text_variables: number;
  outlines: number; cutouts: number;
};

export type Review = {
  intake_id: string; build_id: string; recipe_id: string; image: string; report_sha256: string;
  source: { path: string; sha256: string; source_revision_id: string; manifest_sha256: string; rights: string };
  report: {
    layers: string[]; drill_format: string; source_unchanged: true;
    copper_layer_count?: number; project?: Companion; custom_rules?: Companion; features?: Features;
    drc_counts: { violations: number; unconnected_items: number; schematic_parity: number };
    unsupported: string[]; manufacturing_approval: false; physical_qualification: false;
  };
  outputs: { output_id: string; path: string; sha256: string; size: number; media_type: string; rights: string }[];
};

async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v0/pcb-fabrication/${path}`, { signal, credentials: 'same-origin' });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message ?? `Fabrication read failed (${response.status}).`);
  return data;
}

export const options = (intakeId: string, signal: AbortSignal) => read<Options>(`intakes/${encodeURIComponent(intakeId)}`, signal);
export const review = (intakeId: string, buildId: string, signal: AbortSignal) => read<Review>(`intakes/${encodeURIComponent(intakeId)}/builds/${encodeURIComponent(buildId)}`, signal);
export const outputUrl = (item: Review, outputId: string) => `/api/v0/pcb-fabrication/intakes/${encodeURIComponent(item.intake_id)}/builds/${encodeURIComponent(item.build_id)}/outputs/${encodeURIComponent(outputId)}`;
