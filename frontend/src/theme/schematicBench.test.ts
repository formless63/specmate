import { DEFAULT_THEME, mergeMantineTheme } from "@mantine/core";
import { expect, test } from "vitest";
import { accentScale, motion, sbVariables, schematicBench } from "./schematicBench";
import tokens from "./schematic-bench.tokens.json";

test("accent scale places the exact dark and light accent at the primary shades", () => {
  const scale = schematicBench.colors?.kapton;
  expect(scale).toHaveLength(10);
  expect(scale?.[4]?.toLowerCase()).toBe(tokens.primitive.colors["kapton-400"].toLowerCase());
  expect(scale?.[7]?.toLowerCase()).toBe(tokens.primitive.colors["kapton-700"].toLowerCase());
  expect(schematicBench.primaryColor).toBe("kapton");
  expect(schematicBench.primaryShade).toEqual({ light: 7, dark: 4 });
  expect(accentScale("#000000", "#ffffff")).toHaveLength(10);
});

test("theme follows the design tokens for shape, type and motion", () => {
  expect(schematicBench.defaultRadius).toBe(0);
  expect(schematicBench.respectReducedMotion).toBe(true);
  expect(schematicBench.fontFamily).toBe(tokens.primitive.font_families.ui);
  expect(schematicBench.fontFamilyMonospace).toBe(tokens.primitive.font_families.data);
  expect(motion).toMatchObject({ snap: 80, quick: 140, settle: 220 });
  expect(schematicBench.components?.Button?.defaultProps).toMatchObject({ variant: "primary" });
  expect(schematicBench.components?.Tabs?.defaultProps).toMatchObject({ variant: "silk" });
});

test("variables resolve semantic roles for both colour schemes with a non-accent focus ring", () => {
  const resolved = sbVariables(mergeMantineTheme(DEFAULT_THEME, schematicBench));
  expect(resolved.variables["--sb-motion-snap"]).toBe("80ms");
  for (const [scheme, role] of [["dark", tokens.semantic.dark], ["light", tokens.semantic.light]] as const) {
    const values = resolved[scheme];
    expect(values["--sb-surface-canvas"]).toBe(role.surface.canvas);
    expect(values["--sb-accent"]).toBe(role.interaction.primary);
    expect(values["--sb-focus"]).toBe(role.interaction.keyboard_focus);
    expect(values["--sb-focus"]).not.toBe(values["--sb-accent"]);
    expect(values["--sb-border-control"]).toBe(role.border.control);
    expect(values["--mantine-color-body"]).toBe(role.surface.canvas);
  }
});
