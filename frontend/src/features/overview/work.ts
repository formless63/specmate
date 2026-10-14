import { ApiError, readProjectDetail, requestJson, type ProjectDetail } from "../workspace/api";

export type Kind = { kind: string; count: number };
export type NotificationRow = { notification_id: string; review_id: string; title: string; action: string; read_at: string | null };
export type ReviewRow = { review_id: string; title: string; status: string };
type Page<T> = { results: T[]; next_after: string | null };

export type WorkRead<T> = { status: "ok"; value: T } | { status: "unavailable"; message: string; denied: boolean };

const failure = (reason: unknown): { status: "unavailable"; message: string; denied: boolean } => ({
  status: "unavailable", message: reason instanceof Error ? reason.message : "Unavailable.",
  denied: reason instanceof ApiError && [401, 403, 404].includes(reason.status),
});

async function attempt<T>(work: () => Promise<T>): Promise<WorkRead<T>> {
  try { return { status: "ok", value: await work() }; } catch (reason) { return failure(reason); }
}

export type ProjectWork = {
  /** The project with its references resolved, dependents and delete eligibility. */
  detail: WorkRead<ProjectDetail>;
  unread: WorkRead<{ rows: NotificationRow[]; more: boolean }>;
  reviews: WorkRead<{ open: ReviewRow[]; more: boolean }>;
};

const idOf = encodeURIComponent;

/** Recipient-owned unread notifications and open reviews: the only open work the API lists today. */
export async function readOpenWork(projectId: string): Promise<Pick<ProjectWork, "unread" | "reviews">> {
  const id = idOf(projectId);
  const [unread, reviews] = await Promise.all([
    attempt(async () => {
      const page = await requestJson<Page<NotificationRow>>(`/api/v0/collaboration/inbox?project_id=${id}&limit=25&unread_only=true`);
      return { rows: page.results, more: page.next_after !== null };
    }),
    attempt(async () => {
      const page = await requestJson<Page<ReviewRow>>(`/api/v0/collaboration/reviews?project_id=${id}&limit=25`);
      return { open: page.results.filter((row) => row.status === "open"), more: page.next_after !== null };
    }),
  ]);
  return { unread, reviews };
}

/** Reads only existing, permission-checked endpoints; every part succeeds or reports unavailability on its own. */
export async function readProjectWork(projectId: string, includeRemoved = false): Promise<ProjectWork> {
  const [detail, open] = await Promise.all([
    attempt(() => readProjectDetail(projectId, includeRemoved)),
    readOpenWork(projectId),
  ]);
  return { detail, ...open };
}
