export type SessionState = {
  user: { id: string; username: string } | null;
  owner_setup_required: boolean;
};
export type Project = { project_id: string; name: string };
export type OperationResult<T> = {
  operation: string;
  request_id: string;
  status: "completed" | "accepted_async";
  replayed: boolean;
  result: T;
};

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function csrfToken(): string {
  const cookie = document.cookie.split(";").map((item) => item.trim())
    .find((item) => item.startsWith("csrftoken="));
  return cookie ? decodeURIComponent(cookie.slice("csrftoken=".length)) : "";
}

export async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const method = (options.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("X-CSRFToken", csrfToken());
    if (!(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body as { error?: { message?: string } } | null;
    throw new ApiError(response.status, error?.error?.message ?? `Request failed (HTTP ${response.status}).`);
  }
  return body as T;
}

export function runOperation<T>(
  operation: string,
  payload: unknown,
  options: { expectedState?: string; idempotencyKey?: string } = {},
): Promise<OperationResult<T>> {
  return requestJson("/api/v0/operations", {
    method: "POST",
    body: JSON.stringify({ operation, payload, request_id: crypto.randomUUID(),
      expected_state: options.expectedState, idempotency_key: options.idempotencyKey }),
  });
}
