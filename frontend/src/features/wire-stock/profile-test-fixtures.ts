/** Original synthetic suggestions, with no physical qualification. Used only by tests. */
import type { EndPractice, ProfileRevision, Suggestion } from '../workshop-profiles/api';
export const suggestion = <T,>(value: T | null): Suggestion<T> => ({ value, basis: value === null ? 'unknown' : 'preference', source: null, note: value === null ? null : 'Synthetic display arithmetic' });
export const endPractice = (cut: number | null): EndPractice => ({ cutback_mm: suggestion(cut), prepend_cut_mm: suggestion<number>(null), lead: null });
export const profileRevision = (stockId = 'stock-r1', profileId = 'profile-r1'): ProfileRevision => ({
  revision_id: profileId, definition_id: 'profile-definition', name: 'Synthetic stripping', number: 1, sha256: 'a'.repeat(64),
  content: { profile: { schema_version: '1', stock_revision_id: stockId,
    foil_visibility: suggestion('show'), illustration_lay_length_mm: suggestion<number>(null), omit_occluded: suggestion(false),
    hidden_element_paths: [], element_rules: { 'stock.jacket': { a: endPractice(12), b: endPractice(9) } },
  } },
});
