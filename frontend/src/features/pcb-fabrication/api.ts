export type Options = {
  available_recipe_id: string | null;
  unavailable_reason: string | null;
  builds: { build_id: string; state: string }[];
  limit: number;
};

export type Review = {
  intake_id: string; build_id: string; recipe_id: string; image: string; report_sha256: string;
  source: { path: string; sha256: string; source_revision_id: string; manifest_sha256: string; rights: string };
  report: {
    layers: string[]; drill_format: string; source_unchanged: true;
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
