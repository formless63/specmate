import { Alert, Badge, Button, Group, Stack, Tabs, createTheme, defaultVariantColorsResolver, type CSSVariablesResolver, type MantineColorsTuple, type VariantColorsResolver } from "@mantine/core";
import tokens from "./schematic-bench.tokens.json";

// Every colour, size and duration below is derived from schematic-bench.tokens.json
// (design tokens, version sb-1); nothing is a second source of truth.

type Rgb = [number, number, number];

function toRgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as Rgb;
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function mix(from: string, to: string, amount: number): string {
  const a = toRgb(from);
  const b = toRgb(to);
  return toHex([0, 1, 2].map((index) => (a[index] ?? 0) + ((b[index] ?? 0) - (a[index] ?? 0)) * amount) as Rgb);
}

const palette = tokens.primitive.colors;

/**
 * Ten-step scale whose steps 4 and 7 are the exact dark and light accent
 * (Kapton amber); the primary shade is 4 in dark and 7 in light.
 */
export function accentScale(dark: string, light: string): MantineColorsTuple {
  return [
    mix(dark, "#ffffff", 0.9), mix(dark, "#ffffff", 0.78), mix(dark, "#ffffff", 0.58), mix(dark, "#ffffff", 0.3),
    dark,
    mix(dark, light, 0.34), mix(dark, light, 0.67),
    light,
    mix(light, "#000000", 0.28), mix(light, "#000000", 0.5),
  ] as unknown as MantineColorsTuple;
}

const kapton = accentScale(palette["kapton-400"], palette["kapton-700"]);

// Mantine's `dark` scale (0 lightest, 9 darkest) from the ink primitives.
const ink: MantineColorsTuple = [
  palette["ink-100"], palette["ink-400"], palette["ink-400"], palette["ink-500"], palette["ink-600"],
  palette["ink-700"], palette["ink-800"], palette["ink-850"], palette["ink-900"], palette["black"],
] as unknown as MantineColorsTuple;

const danger = accentScale(palette["red-400"], palette["red-700"]);

export const motion = tokens.motion.durations;
export const breakpoints = tokens.layout.breakpoints;
export const rail = tokens.layout.rail;
export const topBarHeight = 38;

/** Semantic state colour for a Mantine `color` prop; amber is never a state colour. */
export function stateColor(color: string | undefined): string | null {
  switch (color) {
    case "red": return "var(--sb-invalid)";
    case "yellow": case "orange": return "var(--sb-review)";
    case "blue": case "cyan": return "var(--sb-info)";
    case "green": case "teal": return "var(--sb-ok)";
    default: return null;
  }
}

/**
 * Mantine sets --button-*, --badge-* and --alert-* inline from this resolver, so
 * the Schematic Bench look is resolved here instead of overridden in CSS.
 * Amber is reserved for primary, commit and selection.
 */
export const sbVariantColors: VariantColorsResolver = (input) => {
  const state = stateColor(input.color);
  switch (input.variant) {
    case "primary":
      return { background: "transparent", hover: "var(--sb-accent)", color: "var(--sb-accent)", hoverColor: "var(--sb-accent-ink)", border: "1px solid var(--sb-accent)" };
    case "commit":
      return { background: "var(--sb-accent)", hover: "transparent", color: "var(--sb-accent-ink)", hoverColor: "var(--sb-accent)", border: "1px solid var(--sb-accent)" };
    case "risk":
      return { background: "transparent", hover: "var(--sb-invalid)", color: "var(--sb-invalid)", hoverColor: "var(--sb-surface-canvas)", border: "1px solid var(--sb-invalid)" };
    case "subtle": case "transparent": case "white":
      return { background: "transparent", hover: "var(--sb-surface-raised)", color: state ?? "var(--sb-text-secondary)", hoverColor: state ?? "var(--sb-text-primary)", border: "1px solid transparent" };
    case "quiet": case "default": case "light": case "outline": case "filled": {
      const line = state ?? "var(--sb-border-control)";
      return { background: "transparent", hover: state ?? "var(--sb-text-primary)", color: state ?? "var(--sb-text-primary)", hoverColor: "var(--sb-surface-canvas)", border: `1px solid ${line}` };
    }
    default:
      return defaultVariantColorsResolver(input);
  }
};

export const schematicBench = createTheme({
  variantColorResolver: sbVariantColors,
  primaryColor: "kapton",
  primaryShade: { light: 7, dark: 4 },
  colors: { kapton, dark: ink, red: danger },
  fontFamily: "Geist, system-ui, sans-serif",
  fontFamilyMonospace: "Geist Mono, ui-monospace, monospace",
  headings: {
    fontFamily: "Geist, system-ui, sans-serif",
    fontWeight: "600",
    sizes: {
      h1: { fontSize: `${tokens.primitive.font_sizes.display}px`, lineHeight: "1.2" },
      h2: { fontSize: `${tokens.primitive.font_sizes.task}px`, lineHeight: "1.25" },
      h3: { fontSize: `${tokens.primitive.font_sizes.section}px`, lineHeight: "1.3" },
      h4: { fontSize: `${tokens.primitive.font_sizes.body}px`, lineHeight: "1.35" },
      h5: { fontSize: `${tokens.primitive.font_sizes.dense}px`, lineHeight: "1.35" },
      h6: { fontSize: `${tokens.primitive.font_sizes.dense}px`, lineHeight: "1.35" },
    },
  },
  fontSizes: {
    xs: `${tokens.primitive.font_sizes.micro + 1}px`,
    sm: `${tokens.primitive.font_sizes.dense}px`,
    md: `${tokens.primitive.font_sizes.body}px`,
    lg: `${tokens.primitive.font_sizes.section}px`,
    xl: `${tokens.primitive.font_sizes.task}px`,
  },
  lineHeights: { xs: "1.35", sm: "1.35", md: "1.45", lg: "1.3", xl: "1.25" },
  defaultRadius: 0,
  radius: { xs: "0", sm: "0", md: "0", lg: "0", xl: "0" },
  shadows: { xs: "none", sm: "none", md: tokens.primitive.shadows.overlay_dark, lg: tokens.primitive.shadows.overlay_dark, xl: tokens.primitive.shadows.overlay_dark },
  focusRing: "auto",
  respectReducedMotion: true,
  cursorType: "pointer",
  other: { motion: tokens.motion.durations, density: tokens.density, layout: tokens.layout },
  components: {
    Button: Button.extend({ defaultProps: { variant: "primary", size: "compact-sm" } }),
    Badge: Badge.extend({ defaultProps: { variant: "frozen", radius: 0 } }),
    // Alerts are hairline panes with a state-coloured rule and title; the words carry the state.
    Alert: Alert.extend({
      vars: (_theme, props) => ({
        root: {
          "--alert-bg": "transparent",
          "--alert-color": "var(--sb-text-primary)",
          "--alert-bd": `1px solid ${stateColor(props.color) ?? "var(--sb-border-control)"}`,
          "--sb-state": stateColor(props.color) ?? "var(--sb-text-primary)",
        },
      }),
    }),
    // Dense default rhythm (tokens.density); panels that pass an explicit gap keep it.
    Stack: Stack.extend({ defaultProps: { gap: tokens.density.compact.gap } }),
    Group: Group.extend({ defaultProps: { gap: tokens.density.compact.gap } }),
    Tabs: Tabs.extend({ defaultProps: { variant: "silk" } }),
  },
});

function roleVariables(role: typeof tokens.semantic.dark, scheme: "dark" | "light") {
  const overlay = scheme === "dark" ? tokens.primitive.shadows.overlay_dark : tokens.primitive.shadows.overlay_light;
  const status = role.status;
  return {
    "--sb-surface-canvas": role.surface.canvas,
    "--sb-surface-sunken": role.surface.sunken,
    "--sb-surface-panel": role.surface.panel,
    "--sb-surface-raised": role.surface.raised,
    "--sb-border-subtle": role.border.subtle,
    "--sb-border-strong": role.border.strong,
    "--sb-border-control": role.border.control,
    "--sb-text-primary": role.text.primary,
    "--sb-text-secondary": role.text.secondary,
    "--sb-text-tertiary": role.text.tertiary,
    "--sb-text-disabled": role.text.disabled,
    "--sb-accent": role.interaction.primary,
    "--sb-accent-glow": role.interaction.selected_glow,
    "--sb-accent-ink": scheme === "dark" ? palette["black"] : palette["white"],
    "--sb-compare": role.interaction.compare,
    "--sb-focus": role.interaction.keyboard_focus,
    "--sb-info": status.informational,
    "--sb-review": status.review_required,
    "--sb-invalid": status.invalid,
    "--sb-ok": role.text.primary,
    "--sb-hatch": scheme === "dark" ? "rgba(237,237,237,.10)" : "rgba(12,12,13,.10)",
    "--sb-overlay": overlay,
    // Native Mantine roles follow the same semantics.
    "--mantine-color-body": role.surface.canvas,
    "--mantine-color-text": role.text.primary,
    "--mantine-color-dimmed": role.text.secondary,
    "--mantine-color-placeholder": role.text.tertiary,
    "--mantine-color-default": role.surface.panel,
    "--mantine-color-default-hover": role.surface.raised,
    "--mantine-color-default-color": role.text.primary,
    "--mantine-color-default-border": role.border.control,
    "--mantine-color-error": status.invalid,
    "--mantine-color-anchor": role.interaction.primary,
  };
}

export const sbVariables: CSSVariablesResolver = () => ({
  variables: {
    "--sb-motion-snap": `${motion.snap}ms`,
    "--sb-motion-quick": `${motion.quick}ms`,
    "--sb-motion-settle": `${motion.settle}ms`,
    "--sb-motion-ease": tokens.motion.easing.out,
    "--sb-rail-expanded": `${rail.expanded}px`,
    "--sb-rail-collapsed": `${rail.collapsed}px`,
    "--sb-font-ui": tokens.primitive.font_families.ui,
    "--sb-font-data": tokens.primitive.font_families.data,
    "--mantine-font-family-monospace": tokens.primitive.font_families.data,
  },
  dark: roleVariables(tokens.semantic.dark, "dark"),
  light: roleVariables(tokens.semantic.light, "light"),
});
