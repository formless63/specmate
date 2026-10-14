import { expect, test } from 'vitest';
import type { Parameters } from './api';
import { emptyForm, fromForm, toForm } from './form';

const padA = '00000000-0000-0000-0000-0000000000a1';
const padB = '00000000-0000-0000-0000-0000000000b1';

test('blank is unknown, zero is a declaration, and undecided holes are omitted', () => {
  const form = emptyForm();
  form.shell.board_clearance_mm = '0';
  form.shell.wall_mm = '  ';
  form.mounts = { [padA]: 'mount', [padB]: 'undecided' };
  const { parameters, errors } = fromForm(form);
  expect(errors).toEqual([]);
  expect(parameters.shell.board_clearance_mm).toBe(0);
  expect(parameters.shell.wall_mm).toBeNull();
  expect(parameters.mounts).toEqual([{ pad_id: padA, use: true }]);
});

test('a declined hole stays a deliberate decision', () => {
  const form = emptyForm();
  form.mounts = { [padA]: 'declined' };
  expect(fromForm(form).parameters.mounts).toEqual([{ pad_id: padA, use: false }]);
});

test('non-numeric text is reported rather than coerced to zero', () => {
  const form = emptyForm();
  form.shell.wall_mm = 'two';
  form.boss.height_mm = 'Infinity';
  const { errors, parameters } = fromForm(form);
  expect(errors).toHaveLength(2);
  expect(parameters.shell.wall_mm).toBeNull();
});

test('round trip preserves nulls and values; duplicate and malformed IDs are rejected', () => {
  const declared: Parameters = {
    shell: { board_clearance_mm: 0.5, wall_mm: null, corner_radius_mm: 0, interior_height_mm: null, board_thickness_mm: 1.6 },
    boss: { outer_diameter_mm: 6, pilot_diameter_mm: null, height_mm: 4, lid_clearance_diameter_mm: null },
    mounts: [{ pad_id: padA, use: true }],
    connectors: [{ component_id: 'c1', side: 'east', lateral_offset_mm: 0, width_mm: null, height_mm: 4, center_above_board_mm: null, clearance_mm: 0.25 }],
    vents: [{ local_id: 'v1', face: 'lid', slot_width_mm: 1.5, slot_length_mm: null, pitch_x_mm: null, pitch_y_mm: null, edge_margin_mm: null, keepout_margin_mm: null }],
    cable_guides: [],
  };
  expect(fromForm(toForm(declared)).parameters).toEqual(declared);
  const duplicate = toForm({ ...declared, vents: [declared.vents[0]!, declared.vents[0]!] });
  expect(fromForm(duplicate).errors.join(' ')).toMatch(/unique/);
  const malformed = toForm({ ...declared, vents: [{ ...declared.vents[0]!, local_id: 'bad id' }] });
  expect(fromForm(malformed).errors.join(' ')).toMatch(/letters, digits/);
});
