import { useQuery } from "@tanstack/react-query";
import type { LibraryRecord } from "../workspace/api";
import { readLibraryHome, type AttentionItem, type LibraryHome } from "./api";

/** The cached Library home read; lens galleries use its attention list for their status LEDs. */
export function useLibraryHome(principalKey: string, enabled = true) {
  return useQuery({ queryKey: ["workspace", "library", "home", principalKey], queryFn: () => readLibraryHome(24), enabled, retry: false, staleTime: 30_000 });
}

export function attentionById(home: LibraryHome | undefined): Map<string, AttentionItem> {
  return new Map((home?.attention ?? []).map((item) => [item.record_id, item]));
}

/** "used in 2 projects", "unused", or nothing for records projects cannot reference. */
export function usedInWords(record: LibraryRecord): string | undefined {
  if (!record.referenceable) return undefined;
  return record.used_in_total === 0 ? "unused" : `used in ${record.used_in_total} project${record.used_in_total === 1 ? "" : "s"}`;
}
