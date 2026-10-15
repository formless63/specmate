import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";

/**
 * Workspace permissions as reported by the server for the signed-in principal. The workspace
 * role (viewer, contributor, editor, admin) plus explicit grants decide them; projects are
 * not separate access scopes. This is a presentation aid only: the server remains the
 * authority and still rejects every operation the principal may not perform.
 */
export type PermissionName =
  | "workspace.read"
  | "workspace.admin"
  | "item.create"
  | "project.edit"
  | "design.edit"
  | "design.freeze"
  | "source.register"
  | "build.execute"
  | "inventory.manage"
  | "inventory.reserve";

const REQUIRES: Record<PermissionName, string> = {
  "workspace.read": "Read",
  "workspace.admin": "Administration",
  "item.create": "Contributor access",
  "project.edit": "Project editing",
  "design.edit": "Edit",
  "design.freeze": "Freeze",
  "source.register": "Source registration",
  "build.execute": "Native execution",
  "inventory.manage": "Inventory management",
  "inventory.reserve": "Inventory reservation",
};

const PermissionContext = createContext<readonly string[] | undefined>(undefined);

/** Supplies the reported workspace permissions to every panel below it. */
export function PermissionsProvider({ permissions, children }: { permissions: readonly string[] | undefined; children: ReactNode }) {
  return <PermissionContext.Provider value={permissions}>{children}</PermissionContext.Provider>;
}

/**
 * Pure check. With no provider (a panel mounted on its own) permissions are unknown and the control
 * stays available, so the server decides. Once the workspace reports permissions - even an empty list -
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

const TEXT_LIKE = (input: HTMLInputElement) => !["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "hidden"].includes(input.type);

/** Marks every field below `root` read-only in place: text stays visible, selectable and copyable. */
function lockFields(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("input, textarea, select").forEach((field) => {
    if (field.hasAttribute("data-inspect-locked")) return;
    field.setAttribute("data-inspect-locked", "");
    field.setAttribute("aria-readonly", "true");
    // A field disabled by form state (e.g. an orientation datum while the side is unknown) is shown as read-only
    // inspection too, never as a gray disabled box; the original state is restored on unlock.
    if ((field as HTMLInputElement).disabled) {
      field.setAttribute("data-inspect-was-disabled", "");
      (field as HTMLInputElement).disabled = false;
      field.removeAttribute("data-disabled");
    }
    if (field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && TEXT_LIKE(field))) field.readOnly = true;
    // Choice controls have no readonly state; take them out of pointer and tab order instead of graying them.
    if (field instanceof HTMLSelectElement || (field instanceof HTMLInputElement && !TEXT_LIKE(field)) || field.getAttribute("aria-haspopup")) field.tabIndex = -1;
  });
}

function unlockFields(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("[data-inspect-locked]").forEach((field) => {
    field.removeAttribute("data-inspect-locked");
    field.removeAttribute("aria-readonly");
    if (field.hasAttribute("data-inspect-was-disabled")) {
      field.removeAttribute("data-inspect-was-disabled");
      (field as HTMLInputElement).disabled = true;
    }
    if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) field.readOnly = false;
    field.removeAttribute("tabindex");
  });
}

/**
 * Renders an authoring form as an inspection view when the permission is missing: every field below it
 * is read-only (values stay as text with a dotted rule) instead of a wall of disabled inputs. With the
 * permission it is transparent. Wrap only the authoring fields, never the filters or selectors a
 * read-only member still uses to look things up. The server stays the authority.
 */
export function InspectionScope({ permission, children }: { permission: PermissionName; children?: ReactNode }) {
  const allowed = usePermission(permission).allowed;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root || allowed) return;
    lockFields(root);
    const watch = new MutationObserver(() => lockFields(root));
    // `disabled` flips with form state after the first lock (React re-applies it), so watch the attribute as well.
    watch.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    return () => { watch.disconnect(); unlockFields(root); };
  }, [allowed]);
  return <div ref={ref} style={{ display: "contents" }} {...(allowed ? {} : { "data-inspect": permission })}>{children}</div>;
}
