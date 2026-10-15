import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { emptyConfiguration, type Configuration } from "../../features/preparation-documents/api";
import { ApiError } from "../../features/workspace/api";
import * as api from "../../features/export-packages/api";
import type { Review } from "../../features/export-packages/api";
import { DocumentPackage } from "./DocumentPackage";

vi.mock("../../features/export-packages/api", async original => ({ ...await original<typeof api>(), review: vi.fn(), download: vi.fn(), saveArchive: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const review = { sha256: "exact-reviewed-hash", manifest: { coherence: "coherent", completeness: "limited", rights: { counts: { cleared: 0, restricted: 0, unknown: 1 }, acknowledgement_required: true }, unresolved: [{ output: "physical test", reason: "not performed" }] } } as Review;
test("reviewed package requires rights acknowledgement and passes exact root, retained set, reviewed hash and deliberate consent to fresh download", async () => {
  vi.mocked(api.review).mockResolvedValue(review); vi.mocked(api.download).mockResolvedValue(new Blob(["archive"]));
  const config: Configuration = { ...emptyConfiguration(), root_revision_id: "exact-r1", quantity: null };
  const denied = vi.fn();
  const ui = (active = true) => <MantineProvider><DocumentPackage active={active} rootRevisionId="exact-r1" config={config} documentSetId="set-exact" onDenied={denied} /></MantineProvider>;
  const mounted = render(ui());
  fireEvent.click(screen.getByRole("button", { name: "Review export package" })); await screen.findByText(/Manifest SHA-256 exact-reviewed-hash/);
  const button = screen.getByRole("button", { name: "Download reviewed export package" }); expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(button);
  await waitFor(() => expect(api.saveArchive).toHaveBeenCalledOnce());
  expect(api.download).toHaveBeenCalledWith(expect.objectContaining({ root_revision_id: "exact-r1", quantity: null, preparation_document_set_ids: ["set-exact"] }), "exact-reviewed-hash", true);
  config.quantity = 3; mounted.rerender(ui());
  expect(screen.queryByText(/exact-reviewed-hash/)).toBeNull(); expect(screen.queryByRole("button", { name: "Download reviewed export package" })).toBeNull();
});

test("fresh download denial withdraws reviewed metadata; response arriving after deactivation cannot save a file", async () => {
  vi.mocked(api.review).mockResolvedValue(review);
  const denied = vi.fn(); const config = { ...emptyConfiguration(), root_revision_id: "exact-r1" };
  const ui = (active = true) => <MantineProvider><DocumentPackage active={active} rootRevisionId="exact-r1" config={config} documentSetId={null} onDenied={denied} /></MantineProvider>;
  const mounted = render(ui());
  fireEvent.click(screen.getByRole("button", { name: "Review export package" })); await screen.findByText(/Manifest SHA-256/);
  vi.mocked(api.download).mockRejectedValue(new ApiError(403, "Current source denied"));
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Download reviewed export package" })); await screen.findByText("Current source denied");
  expect(screen.queryByText(/exact-reviewed-hash/)).toBeNull(); expect(denied).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Review export package" })); await screen.findByText(/Manifest SHA-256/);
  let finish!: (value: Blob) => void; vi.mocked(api.download).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Download reviewed export package" }));
  mounted.rerender(ui(false)); finish(new Blob(["archive"]));
  await waitFor(() => expect(screen.getByRole("button", { name: "Review export package" }).hasAttribute("disabled")).toBe(true));
  expect(api.saveArchive).not.toHaveBeenCalled();
});
