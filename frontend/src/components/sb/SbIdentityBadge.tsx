import { Badge } from "@mantine/core";
import type { ReactNode } from "react";
import "./sb-components.css";

export type IdentityKind = "definition" | "draft" | "frozen" | "occurrence" | "unit";

/** The five identity tags. They differ by border style as well as color: plain, dashed, solid, accent, double. */
export function SbIdentityBadge({ kind, children }: { kind: IdentityKind; children?: ReactNode }) {
  const fallback = { definition: "Definition", draft: "Draft", frozen: "Frozen", occurrence: "Occurrence", unit: "Unit" }[kind];
  return <Badge variant={kind} data-identity={kind}>{children ?? fallback}</Badge>;
}
