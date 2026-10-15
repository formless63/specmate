// Shared mapping of the backend error envelope ({ error: { code, message, details } }).
// Validation failures (HTTP 422) carry details.errors = [{ loc, type, msg }]; surface them
// per field where a form can place them, and as a listed summary everywhere else.
export type FieldIssue = { loc: (string | number)[]; msg: string };

export function fieldIssues(body: unknown): FieldIssue[] {
  const errors = (body as { error?: { details?: { errors?: unknown } } } | null | undefined)?.error?.details?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((e): FieldIssue[] => {
    const loc = (e as { loc?: unknown })?.loc;
    const msg = (e as { msg?: unknown })?.msg;
    return Array.isArray(loc) && typeof msg === "string" ? [{ loc: loc as (string | number)[], msg }] : [];
  });
}

export const fieldPath = (loc: (string | number)[]) => loc.join(".");

/** Readable label for a path like cable.endpoints.0.body_revision_id. */
export function fieldLabel(loc: (string | number)[]): string {
  const parts = loc.filter((p, i) => !(i === 0 && p === "cable"));
  const words = parts.map((p) => (typeof p === "number" ? `#${p + 1}` : p.replace(/_/g, " ")));
  return words.join(" ").replace(/ revision id$/, " revision") || "payload";
}

/** Map of dotted field path to the first message for that field. */
export function fieldErrorMap(body: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  for (const issue of fieldIssues(body)) map[fieldPath(issue.loc)] ??= plainIssueMessage(issue.msg);
  return map;
}

/** Error text from a response body: backend message plus a listed field summary. */
/** Plain wording for the validator's stock messages, so a form never shows library jargon. */
export function plainIssueMessage(msg: string): string {
  if (/valid UUID/i.test(msg)) return "choose a revision (nothing is selected yet)";
  return msg;
}

export function apiErrorMessage(body: unknown, fallback: string): string {
  const message = (body as { error?: { message?: unknown } } | null | undefined)?.error?.message;
  const base = typeof message === "string" && message ? message : fallback;
  const issues = fieldIssues(body);
  if (!issues.length) return base;
  return `${base} ${issues.map((i) => `${fieldLabel(i.loc)}: ${plainIssueMessage(i.msg)}`).join("; ")}`;
}
