import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";

/**
 * Project permissions as reported by the server for the signed-in principal.
 * This is a presentation aid only: the server remains the authority and still
 * rejects every operation the principal may not perform.
 */
export type PermissionName =
  | "project.read"
  | "project.admin"
  | "item.create"
  | "design.edit"
  | "design.freeze"
  | "source.register"
  | "build.execute"
  | "inventory.manage"
  | "inventory.reserve";

const REQUIRES: Record<PermissionName, string> = {
  "project.read": "Read",
  "project.admin": "Administration",
  "item.create": "Creating records",
  "design.edit": "Edit",
  "design.freeze": "Freeze",
  "source.register": "Source registration",
  "build.execute": "Native execution",
  "inventory.manage": "Inventory management",
  "inventory.reserve": "Inventory reservation",
};

const PermissionContext = createContext<readonly string[] | undefined>(undefined);

/** Supplies the project's reported permissions to every panel below it. */
export function PermissionsProvider({ permissions, children }: { permissions: readonly string[] | undefined; children: ReactNode }) {
  return <PermissionContext.Provider value={permissions}>{children}</PermissionContext.Provider>;
}

/**
 * Pure check. With no provider (a panel mounted on its own) permissions are unknown and the control
 * stays available, so the server decides. Once a project reports permissions - even an empty list -
 * only reported grants enable controls, matching the PCB panel. Inventory management implies
 * reservation, as the server grants it.
 */
export function holds(permissions: readonly string[] | undefined, name: PermissionName): boolean {
  if (!permissions) return true;
  if (permissions.includes(name)) return true;
  return name === "inventory.reserve" && permissions.includes("inventory.manage");
}

export function readOnlyReason(name: PermissionName): string {
  return `Read-only access: requires ${REQUIRES[name]}`;
}

export type Gate = {
  allowed: boolean;
  /** Present only when not allowed. */
  reason: string | undefined;
  /** Spread onto a button: disables it and exposes the reason as its tooltip. */
  props: { disabled?: true; title?: string; "data-readonly-reason"?: string };
};

export function gateFor(permissions: readonly string[] | undefined, name: PermissionName): Gate {
  if (holds(permissions, name)) return { allowed: true, reason: undefined, props: {} };
  const reason = readOnlyReason(name);
  return { allowed: false, reason, props: { disabled: true, title: reason, "data-readonly-reason": reason } };
}

/** `const edit = usePermission("design.edit")`; `edit.allowed`, `<Button {...edit.props}>`. */
export function usePermission(name: PermissionName): Gate {
  const permissions = useContext(PermissionContext);
  return useMemo(() => gateFor(permissions, name), [permissions, name]);
}

/** Boolean shorthand for hiding whole authoring sections. */
export function useCan(name: PermissionName): boolean {
  return usePermission(name).allowed;
}

/**
 * Visible, screen-reader-readable explanation for disabled controls in a panel.
 * Renders nothing when the permission is held.
 */
export function ReadOnlyNote({ permission, children }: { permission: PermissionName; children?: ReactNode }) {
  const gate = usePermission(permission);
  if (gate.allowed) return null;
  return <p role="note" className="sb-readonly-note" data-readonly-note={permission} style={{ margin: 0, fontSize: "0.875rem", opacity: 0.85 }}>{gate.reason}{children ? `. ${children}` : ""}</p>;
}
