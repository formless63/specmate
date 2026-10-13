export type Health = { status: string; version: string };

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const response = await fetch("/api/health", { signal, credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`Health request failed with HTTP ${response.status}`);
  }
  return (await response.json()) as Health;
}
