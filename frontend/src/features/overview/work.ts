import { ApiError, requestJson } from "../workspace/api";

export type Kind = { kind: string; count: number };
export type NotificationRow = { notification_id: string; review_id: string; title: string; action: string; read_at: string | null };
export type ReviewRow = { review_id: string; title: string; status: string };
type Page<T> = { results: T[]; next_after: string | null };
type Definition = { definition_id: string; kind: string; name: string };

export type WorkRead<T> = { status: "ok"; value: T } | { status: "unavailable"; message: string; denied: boolean };

const failure = (reason: unknown): { status: "unavailable"; message: string; denied: boolean } => ({
  status: "unavailable", message: reason instanceof Error ? reason.message : "Unavailable.",
  denied: reason instanceof ApiError && [401, 403, 404].includes(reason.status),
});

async function attempt<T>(work: () => Promise<T>): Promise<WorkRead<T>> {
  try { return { status: "ok", value: await work() }; } catch (reason) { return failure(reason); }
}

export type ProjectWork = {
  records: WorkRead<{ total: number; kinds: Kind[] }>;
  unread: WorkRead<{ rows: NotificationRow[]; more: boolean }>;
  reviews: WorkRead<{ open: ReviewRow[]; more: boolean }>;
  members: WorkRead<{ count: number } | null>;
};

const idOf = encodeURIComponent;

/** Recipient-owned unread notifications and open reviews: the only open work the API lists today. */
export async function readOpenWork(projectId: string): Promise<Pick<ProjectWork, "unread" | "reviews">> {
  const id = idOf(projectId);
  const [unread, reviews] = await Promise.all([
    attempt(async () => {
      const page = await requestJson<Page<NotificationRow>>(`/api/v0/collaboration/projects/${id}/inbox?limit=25&unread_only=true`);
      return { rows: page.results, more: page.next_after !== null };
    }),
    attempt(async () => {
      const page = await requestJson<Page<ReviewRow>>(`/api/v0/collaboration/projects/${id}/reviews?limit=25`);
      return { open: page.results.filter((row) => row.status === "open"), more: page.next_after !== null };
    }),
  ]);
  return { unread, reviews };
}

/** Reads only existing, permission-checked endpoints; every part succeeds or reports unavailability on its own. */
export async function readProjectWork(projectId: string, permissions: string[]): Promise<ProjectWork> {
  const id = idOf(projectId);
  const [records, open, members] = await Promise.all([
    attempt(async () => {
      const rows = await requestJson<Definition[]>(`/api/v0/projects/${id}/definitions`);
      const counts = new Map<string, number>();
      for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
      return { total: rows.length, kinds: [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)) };
    }),
    readOpenWork(projectId),
    // Membership is administrator-only; other principals see it as not reported.
    permissions.includes("project.admin")
      ? attempt(async () => ({ count: (await requestJson<{ members?: unknown[] }>(`/api/v0/access/projects/${id}`)).members?.length ?? 0 }))
      : Promise.resolve<WorkRead<{ count: number } | null>>({ status: "ok", value: null }),
  ]);
  return { records, ...open, members };
}
