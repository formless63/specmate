import { AppShell, Group, VisuallyHidden } from "@mantine/core";
import { Spotlight, spotlight, type SpotlightActionData } from "@mantine/spotlight";
import type { ReactNode } from "react";
import { topBarHeight } from "../../theme/schematicBench";

type HomeFrameProps = {
  /** Signed-in username; omitted before sign-in. */
  username?: string;
  signOutControl?: ReactNode;
  /** Palette actions; the jump control appears only when there is something to jump to. */
  actions?: SpotlightActionData[];
  statusLabel?: string;
  children: ReactNode;
};

/** The Schematic Bench chrome for every screen that exists before a project is open. */
export function HomeFrame({ username, signOutControl, actions = [], statusLabel, children }: HomeFrameProps) {
  return <AppShell header={{ height: topBarHeight }} footer={{ height: 24 }} padding={0}>
    <AppShell.Header className="sb-header" data-testid="sb-top-bar">
      <div className="sb-topbar">
        <span className="sb-wordmark">SPECMATE</span>
        {actions.length > 0 && <button type="button" className="sb-search" onClick={() => spotlight.open()} aria-label="Jump to a project" aria-keyshortcuts="Control+K">
          <span className="sb-mono" aria-hidden="true" style={{ color: "var(--sb-accent)" }}>›</span>
          <span className="sb-search-hint">jump to a project</span>
          <span className="sb-keycap" aria-hidden="true">Ctrl K</span>
        </button>}
        <span style={{ flex: 1 }} />
        {username && <Group gap={6} wrap="nowrap" aria-label="Account">
          <span className="sb-account" title={username}><VisuallyHidden>Signed in as {username}</VisuallyHidden><span aria-hidden="true">{username}</span></span>
          {signOutControl}
        </Group>}
      </div>
    </AppShell.Header>
    <AppShell.Main className="sb-main sb-home-main">{children}</AppShell.Main>
    <AppShell.Footer className="sb-footer">
      <div className="sb-statusline" data-testid="sb-status-line">
        {actions.length > 0 && <span className="sb-silk">Ctrl K jump</span>}
        <span className="sb-spacer" />
        <span className="sb-silk">{statusLabel ?? "Workshop"}</span>
      </div>
    </AppShell.Footer>
    {actions.length > 0 && <Spotlight actions={actions} shortcut="mod + K" nothingFound="No matching project" highlightQuery
      searchProps={{ placeholder: "Jump to a project", "aria-label": "Jump to a project" }} />}
  </AppShell>;
}
