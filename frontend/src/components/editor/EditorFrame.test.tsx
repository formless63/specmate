import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import { EditorInspector, type InspectorTab } from "./EditorFrame";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test("phone inspector has an accessible trigger, reachable tabs, retained Notes, and named close action", async () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  function Inspector() {
    const [tab, setTab] = useState<InspectorTab>("issues");
    return <EditorInspector tab={tab} onTab={setTab} issueCount={2} tabs={{ issues: "Unknown geometry", connection: "Connections", part: "Part", signals: "Signals", notes: <textarea aria-label="Note buffer" />, recipe: "Recipe" }} />;
  }
  render(<MantineProvider><Inspector /></MantineProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Inspector · Issues (2)" }));
  expect(await screen.findByRole("dialog", { name: "Cable inspector" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Note buffer" }), { target: { value: "Retained note" } });
  fireEvent.click(screen.getByRole("tab", { name: "Recipe" })); fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
  expect((screen.getByRole("textbox", { name: "Note buffer" }) as HTMLTextAreaElement).value).toBe("Retained note");
  fireEvent.click(screen.getByRole("button", { name: "Close cable inspector" }));
  fireEvent.click(screen.getByRole("button", { name: "Inspector · Notes" }));
  expect((screen.getByRole("textbox", { name: "Note buffer" }) as HTMLTextAreaElement).value).toBe("Retained note");
});
