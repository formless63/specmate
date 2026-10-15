import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BodyFace } from "./BodyFace";
import type { Body } from "./api";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const contacts = (n: number) => [...Array.from({ length: n }, (_, i) => ({ contact_id: String(i + 1), number: String(i + 1), physical_role: "contact" as const, label: String(i + 1), position_mm: null })), { contact_id: "shell", physical_role: "shell" as const, label: "Shell", position_mm: null }];
const body = (extra: Partial<Body>): Body => ({ kind: "connector_body", family: "10-pin round DIN", mating_role: "receptacle", contacts: contacts(10), drawing_orientation: { viewing_side: "unknown", rotation_degrees: null, datum: null }, ...extra });

test("a declared face key draws the body's socket face with its contacts as pins", () => {
  render(<MantineProvider><BodyFace body={body({ geometry_key: "mini-din-10" })} /></MantineProvider>);
  const face = screen.getByRole("group", { name: /Mini-DIN 10 socket mating face, 10 positions/ });
  expect(face.getAttribute("data-geometry")).toBe("mini-din-10-female");
  fireEvent.click(screen.getByRole("button", { name: "Pin 7" }));
  expect(screen.getByText("Pin 7:")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Solder side" }));
  expect(screen.getByRole("group", { name: /solder side/ }).getAttribute("data-view")).toBe("solder");
});

test("the plug role selects the mirrored plug face", () => {
  render(<MantineProvider><BodyFace body={body({ geometry_key: "scart", family: "21-pin RGB", mating_role: "plug", contacts: contacts(21) })} /></MantineProvider>);
  expect(screen.getByRole("group", { name: /SCART plug mating face/ }).getAttribute("data-geometry")).toBe("scart-male");
});

test("an ambiguous family without a face key stays unknown rather than guessing", () => {
  render(<MantineProvider><BodyFace body={body({})} /></MantineProvider>);
  expect(screen.queryByRole("group")).toBeNull();
  expect(screen.getByText("face geometry unknown")).toBeTruthy();
});
