import { read } from "./api";

export { read };
export type Qty = { status: "known" | "unknown"; amount: string | null; unit: string };
export type Cost = { status: "known" | "unknown" | "not_needed"; amount?: string; currency?: string; reason: string | null };
export type OfferView = {
  offer_id: string; revision_id: string; supplier: string; supplier_ref: string; source: string; review_basis: string;
  reviewed_by: { id: number; username: string }; offered_on: string; valid_until: string | null;
  price: { amount: string | null; currency: string | null; per_unit: string } | null;
  availability: string; lead_time_days: number | null;
  substitution: { replaces_revision_id: string; basis: string } | null;
  freshness?: "current" | "stale" | "expired" | "unknown"; age_days?: number;
  estimated_cost?: Cost; counts_toward_need?: boolean; revision_name?: string;
};
export type SourcingRow = {
  revision_id: string; name: string; required: Qty; net_required: Qty;
  stock: { status: string; available: Qty; available_is_lower_bound: boolean; observed_at: string | null; issues: string[] };
  shortfall: Qty & { reason: string | null; at_most: string | null; at_least: string | null };
  offers: OfferView[]; substitutes: OfferView[]; offer_status: string;
};
export type SourcingReport = {
  revision_id: string; kind: string; purpose: string; as_of: string; max_age_days: number | null;
  rows: SourcingRow[]; unresolved: { reason: string }[];
  cost: { status: string; rows_needing_purchase: number; rows_priced: number; rows_without_price: number; rows_shortfall_unknown: number; totals: { currency: string; amount: string; rows_priced: number }[] };
  offers_after_as_of: number; superseded_offers_hidden: number; limitations: string[];
};

export function fetchReport(revisionId: string, maxAge: string, asOf: string) {
  const query = new URLSearchParams();
  if (maxAge.trim()) query.set("max_age_days", maxAge.trim());
  if (asOf.trim()) query.set("as_of", asOf.trim());
  return read<SourcingReport>(`sourcing/revisions/${revisionId}?${query}`);
}
