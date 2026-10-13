import type { StockElement, StockSpecification } from '../../../../packages/section-layout/src';
import type { DisplayProfile, ElementPreparation } from '../../../../packages/wire-geometry/src/model';
import type { ProfileRevision } from '../workshop-profiles/api';

export interface AppliedProfile { display: DisplayProfile; notices: string[] }

/** Translate depiction suggestions only, against the exact pinned construction. */
export function adaptFrozenProfile(revision: ProfileRevision, stockRevisionId: string, stock: StockSpecification): AppliedProfile {
  const profile = revision.content.profile;
  if (profile.stock_revision_id !== stockRevisionId) throw new Error('Profile and stock revision do not match.');
  const nodes = new Map<string, StockElement>();
  const visit = (node: StockElement, path: string) => {
    nodes.set(path, node);
    if (node.kind === 'group') node.children.forEach(child => visit(child, `${path}.${child.id}`));
  };
  visit(stock.structure, stock.structure.id);
  const notices: string[] = [];
  const hidden = new Set<string>();
  for (const path of profile.hidden_element_paths) {
    if (!nodes.has(path)) notices.push(`${path}: hidden target absent from pinned stock; not applied.`);
    for (const [candidate, node] of nodes) if (node.kind !== 'group' && (candidate === path || candidate.startsWith(`${path}.`))) hidden.add(candidate);
  }
  if (profile.foil_visibility.value === 'hide') {
    for (const [path, node] of nodes) if (node.kind !== 'group' && node.kind !== 'web' && node.construction === 'foil') hidden.add(path);
  } else if (profile.foil_visibility.value === null) notices.push('Foil visibility is unknown; no global foil hiding applied.');
  if (profile.foil_visibility.value === 'show' && profile.hidden_element_paths.length) notices.push('Explicit hidden paths take precedence over the global foil display preference.');
  if (profile.omit_occluded.value === null) notices.push('Occlusion preference is unknown; all interior geometry is retained for inspection.');
  const cuts: Record<string, ElementPreparation> = {};
  const groupRules: [string, typeof profile.element_rules[string]][] = [];
  for (const [path, rule] of Object.entries(profile.element_rules)) {
    const node = nodes.get(path);
    if (!node) {
      notices.push(`${path}: absent target; its cuts and leads are not applied.`);
      continue;
    }
    if (node.kind === 'group') {
      groupRules.push([path, rule]);
      notices.push(`${path}: group cutbacks apply to every descendant; overlapping cuts retain the farther removal, and an unknown applicable cut remains unresolved.`);
      for (const end of ['a', 'b'] as const) {
        if (rule[end].lead) notices.push(`${path} end ${end.toUpperCase()}: group lead is not a single conductive feature; no lead or bond is inferred.`);
        notices.push(`${path} end ${end.toUpperCase()}: prepend cut ${rule[end].prepend_cut_mm.value === null ? 'unknown' : `${rule[end].prepend_cut_mm.value} mm`} is unsupported and not applied.`);
      }
      continue;
    }
    // Null is deliberately retained: the geometry must not turn an unknown cut into zero.
    const cut: ElementPreparation = { a: rule.a.cutback_mm.value, b: rule.b.cutback_mm.value };
    cuts[path] = cut;
    for (const end of ['a', 'b'] as const) {
      const practice = rule[end];
      notices.push(`${path} end ${end.toUpperCase()}: prepend cut ${practice.prepend_cut_mm.value === null ? 'unknown' : `${practice.prepend_cut_mm.value} mm`} is unsupported and not applied.`);
      const lead = practice.lead;
      if (!lead) continue;
      if (lead.reach_mm.value === null || lead.angle_deg.value === null) {
        notices.push(`${path} end ${end.toUpperCase()}: illustrative lead reach or angle is unknown; lead omitted without substitution.`);
        continue;
      }
      cut.leads = { ...cut.leads, [end]: {
        lengthMm: lead.length_mm.value, diameterMm: lead.diameter_mm.value,
        reachMm: lead.reach_mm.value, angleDeg: lead.angle_deg.value,
      } };
    }
  }
  // Group cuts remove an entire physical subset. Child-specific stripping can remove
  // more material, but cannot restore material already removed by an ancestor rule.
  for (const [path, node] of nodes) {
    if (node.kind === 'group') continue;
    const inherited = groupRules.filter(([parent]) => path.startsWith(`${parent}.`));
    if (!inherited.length) continue;
    const existing = cuts[path];
    const effective: ElementPreparation = existing ? { ...existing } : { a: 0, b: 0 };
    for (const end of ['a', 'b'] as const) {
      const values = [...inherited.map(([, rule]) => rule[end].cutback_mm.value), ...(existing ? [existing[end]] : [])];
      effective[end] = values.some(value => value === null) ? null : Math.max(...values as number[]);
    }
    cuts[path] = effective;
  }
  const unsupported = [...nodes.values()].some(node => node.kind === 'web' || (node.kind === 'group' &&
    (['ribbon', 'figure-eight'].includes(node.role) || node.arrangement === 'figure-eight')));
  return { display: { id: revision.revision_id, label: `${revision.name} · revision ${revision.number}`,
    cuts, hiddenPaths: [...hidden], omitOccluded: profile.omit_occluded.value === true,
    illustrationLay: { lengthMm: profile.illustration_lay_length_mm.value,
      direction: profile.illustration_lay_direction?.value ?? null, construction: stock.construction,
      ...(unsupported ? { unsupportedReason: 'ribbon, figure-eight or web element present' } : {}) },
  }, notices };
}
