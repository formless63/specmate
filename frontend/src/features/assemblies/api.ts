import { command as sourceCommand, request } from '../sources/api';
export { type Definition, type Identity } from '../identity/api';
export const read = request;
export function command<T>(operation: string, payload: object, expectedState?: string, idempotencyKey?: string) {
  return sourceCommand<T>(operation, payload, { expectedState, idempotencyKey });
}

export type Placement = { status: "known" | "unknown"; unit?: "mm"; frame?: "right_handed_z_up"; translation?: [number, number, number] | null; rotation_xyzw?: [number, number, number, number] | null };
export type Assignments = { firmware_revision_id?: string | null; population_option_id?: string | null };
export type Occurrence = { local_id: string; revision_id: string; display_ref: string; placement?: Placement; assignments?: Assignments };
export type OccurrenceRef = { kind: "occurrence"; path: string[]; feature_id?: string | null };
export type RevisionRef = { kind: "revision"; revision_id: string };
export type RelationshipKind = "containment" | "electrical" | "mating" | "mounting" | "source_derivation" | "documentation" | "procurement";
export type WiringTerminal = { kind: "contact" | "segment" | "pigtail" | "stack_terminal" } & Record<string, string>;
export type Relationship = { kind: RelationshipKind; local_id: string; a_terminal?: WiringTerminal; b_terminal?: WiringTerminal; basis?: string } & Partial<Record<"parent" | "child" | "a" | "b" | "mounted" | "support" | "subject" | "source" | "document" | "orderable", OccurrenceRef | RevisionRef>>;
export type Assembly = { schema_version?: "0.1"; occurrences: Occurrence[]; relationships: Relationship[]; assignments?: { path: string[]; assignments: Assignments }[] };
export type Draft = { definition_id: string; draft_id: string; base_revision_id?: string | null; state: string; content: { assembly: Assembly } };
export type ProjectionNode = { address: { snapshot_id: string; path: string[] }; definition_id: string; revision_id: string; kind: string; name: string; display_ref: string; placement: Placement; assignments: Assignments; snapshot_sha256: string };
export type Projection = { snapshot_id: string; definition_id: string; sha256: string; occurrences: ProjectionNode[]; relationships: (Relationship & { context_path: string[] })[] };

export function addressKey(path: string[]) { return JSON.stringify(path); }
export function relationship(kind: RelationshipKind, localId: string, a: string, b: string, featureA: string, featureB: string): Relationship {
  const ref = (path: string, feature: string): OccurrenceRef => ({ kind: "occurrence", path: path ? path.split("/") : [], feature_id: feature || null });
  const left = ref(a, featureA), right = ref(b, featureB), revision: RevisionRef = { kind: "revision", revision_id: b };
  const roles: Record<RelationshipKind, object> = {
    containment: { parent: ref(a, ""), child: ref(b, "") }, electrical: { a: left, b: right }, mating: { a: left, b: right },
    mounting: { mounted: left, support: right }, source_derivation: { subject: left, source: revision },
    documentation: { subject: left, document: right }, procurement: { subject: left, orderable: revision },
  };
  return { kind, local_id: localId, ...roles[kind] } as Relationship;
}
