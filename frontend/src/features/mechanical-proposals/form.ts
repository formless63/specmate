import type { Face, Num, Parameters, Side } from './api';

/** Text mirror of the declarations: blank is an explicit unknown, never zero. */
export type Choice = 'mount' | 'declined' | 'undecided';
export type FormState = {
  shell: Record<keyof Parameters['shell'], string>;
  boss: Record<keyof Parameters['boss'], string>;
  mounts: Record<string, Choice>;
  connectors: ({ component_id: string; side: Side } & Record<Exclude<keyof Parameters['connectors'][number], 'component_id' | 'side'>, string>)[];
  vents: ({ local_id: string; face: Face } & Record<Exclude<keyof Parameters['vents'][number], 'local_id' | 'face'>, string>)[];
  guides: ({ local_id: string; side: Side } & Record<Exclude<keyof Parameters['cable_guides'][number], 'local_id' | 'side'>, string>)[];
};
const text = (value: Num) => (value === null ? '' : String(value));
const mapText = <T extends Record<string, Num>>(source: T) => Object.fromEntries(Object.entries(source).map(([key, value]) => [key, text(value)])) as Record<keyof T, string>;

export function toForm(p: Parameters): FormState {
  return {
    shell: mapText(p.shell), boss: mapText(p.boss),
    mounts: Object.fromEntries(p.mounts.map(m => [m.pad_id, m.use ? 'mount' : 'declined'])),
    connectors: p.connectors.map(c => ({ ...c, ...mapText({ lateral_offset_mm: c.lateral_offset_mm, width_mm: c.width_mm, height_mm: c.height_mm, center_above_board_mm: c.center_above_board_mm, clearance_mm: c.clearance_mm }) })),
    vents: p.vents.map(v => ({ ...v, ...mapText({ slot_width_mm: v.slot_width_mm, slot_length_mm: v.slot_length_mm, pitch_x_mm: v.pitch_x_mm, pitch_y_mm: v.pitch_y_mm, edge_margin_mm: v.edge_margin_mm, keepout_margin_mm: v.keepout_margin_mm }) })),
    guides: p.cable_guides.map(g => ({ ...g, ...mapText({ offset_along_wall_mm: g.offset_along_wall_mm, cable_diameter_mm: g.cable_diameter_mm, clearance_mm: g.clearance_mm, post_width_mm: g.post_width_mm, post_depth_mm: g.post_depth_mm }) })),
  };
}
function parse(raw: string, label: string, errors: string[]): Num {
  const value = raw.trim();
  if (value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) { errors.push(`${label}: enter a finite number, or leave blank for unknown.`); return null; }
  return parsed;
}
function numbers<T extends Record<string, string>>(source: T, scope: string, errors: string[]) {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, parse(value, `${scope} ${key}`, errors)])) as Record<keyof T, Num>;
}
export function fromForm(form: FormState): { parameters: Parameters; errors: string[] } {
  const errors: string[] = [];
  const parameters: Parameters = {
    shell: numbers(form.shell, 'Shell', errors), boss: numbers(form.boss, 'Boss', errors),
    mounts: Object.entries(form.mounts).filter(([, choice]) => choice !== 'undecided').map(([pad_id, choice]) => ({ pad_id, use: choice === 'mount' })).sort((a, b) => a.pad_id.localeCompare(b.pad_id)),
    connectors: form.connectors.map(c => ({ component_id: c.component_id, side: c.side, ...numbers({ lateral_offset_mm: c.lateral_offset_mm, width_mm: c.width_mm, height_mm: c.height_mm, center_above_board_mm: c.center_above_board_mm, clearance_mm: c.clearance_mm }, 'Connector', errors) })),
    vents: form.vents.map(v => ({ local_id: v.local_id.trim(), face: v.face, ...numbers({ slot_width_mm: v.slot_width_mm, slot_length_mm: v.slot_length_mm, pitch_x_mm: v.pitch_x_mm, pitch_y_mm: v.pitch_y_mm, edge_margin_mm: v.edge_margin_mm, keepout_margin_mm: v.keepout_margin_mm }, 'Vent', errors) })),
    cable_guides: form.guides.map(g => ({ local_id: g.local_id.trim(), side: g.side, ...numbers({ offset_along_wall_mm: g.offset_along_wall_mm, cable_diameter_mm: g.cable_diameter_mm, clearance_mm: g.clearance_mm, post_width_mm: g.post_width_mm, post_depth_mm: g.post_depth_mm }, 'Cable guide', errors) })),
  };
  const ids = [...parameters.vents.map(v => `vent:${v.local_id}`), ...parameters.cable_guides.map(g => `guide:${g.local_id}`)];
  if (parameters.vents.concat().some(v => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.local_id)) || parameters.cable_guides.some(g => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(g.local_id))) errors.push('Vent and cable guide IDs need letters, digits, dot, dash or underscore.');
  if (new Set(ids).size !== ids.length) errors.push('Vent IDs and cable guide IDs must each be unique.');
  const components = parameters.connectors.map(c => c.component_id);
  if (new Set(components).size !== components.length) errors.push('Each component can have one connector opening.');
  return { parameters, errors };
}
export const emptyForm = (): FormState => toForm({
  shell: { board_clearance_mm: null, wall_mm: null, corner_radius_mm: null, interior_height_mm: null, board_thickness_mm: null },
  boss: { outer_diameter_mm: null, pilot_diameter_mm: null, height_mm: null, lid_clearance_diameter_mm: null },
  mounts: [], connectors: [], vents: [], cable_guides: [],
});
