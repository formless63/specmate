import { runOperation } from "../workspace/api";
import type { PrefixSchemeConfig } from "./part-numbers";
import type { DeclarativeSchemeConfig } from "./pn-declarative";
export type DocumentTitleBlock = { organization?: string | null; rights_line?: string | null; designer?: string | null; label_qr_url?: string | null; paper?: "A4" | "A3" | "letter" | "legal" | null; title_block?: "iso7200" | "ansi" | null };
export type DocumentSettingsSnapshot = DocumentTitleBlock & { source_settings_version: number };
export type SettingsValues = { documents: DocumentTitleBlock; numbering?: PrefixSchemeConfig | DeclarativeSchemeConfig | null };
export type WorkspaceSettings = { workspace_id: string; version: number; state_token: string; values: SettingsValues };
export const readSettings = (workspaceId: string) => runOperation<WorkspaceSettings>("workspace.settings.get", { workspace_id: workspaceId }).then(result => result.result);
export const saveSettings = (workspaceId: string, values: SettingsValues, state: string) => runOperation<WorkspaceSettings>("workspace.settings.update", { workspace_id: workspaceId, values }, { expectedState: state }).then(result => result.result);
