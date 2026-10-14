import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SbIdentityBadge, SbJobCard, SbProvenance, SbQuantity, SbQuantityField, SbStatus, SbUnknown, quantityState } from ".";

afterEach(cleanup);
const wrap = (node: React.ReactNode) => render(<MantineProvider>{node}</MantineProvider>);

test("quantity states are distinct and unknown never renders as zero", () => {
  expect(quantityState(null)).toBe("unknown");
  expect(quantityState(0)).toBe("known");
  expect(quantityState(undefined, "na")).toBe("na");
  const { container } = render(<>
    <SbQuantityField label="Installed" value={1200} unit="mm" basis="manual declaration" />
    <SbQuantityField label="Shield" value={null} unit="mm" />
    <SbQuantityField label="Overmould" value={null} state="na" note="no overmould on this end" />
    <SbQuantityField label="Strip" value="-4" unit="mm" state="invalid" note="Must be 0 or more." />
  </>);
  const states = [...container.querySelectorAll(".sb-q")].map((el) => el.getAttribute("data-state"));
  expect(states).toEqual(["known", "unknown", "na", "invalid"]);
  expect((screen.getByLabelText("Installed") as HTMLInputElement).value).toBe("1200");
  expect((screen.getByLabelText("Shield") as HTMLInputElement).value).toBe("");
  expect(screen.getByLabelText("Shield").getAttribute("placeholder")).toBe("– – –");
  expect((screen.getByLabelText("Overmould") as HTMLInputElement).value).toBe("n/a");
  expect(screen.getByLabelText("Strip").getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByText("Must be 0 or more.")).toBeTruthy();
  expect(screen.getAllByText("mm")).toHaveLength(3);
});

test("a known zero stays zero and an editable field reports the raw entry", () => {
  const seen = vi.fn();
  render(<SbQuantityField label="Offset" value={0} unit="mm" onChange={seen} />);
  const input = screen.getByLabelText("Offset") as HTMLInputElement;
  expect(input.value).toBe("0");
  fireEvent.change(input, { target: { value: "2.5" } });
  expect(seen).toHaveBeenCalledWith("2.5");
});

test("a not-applicable field is never editable", () => {
  render(<SbQuantityField label="Overmould" value={null} state="na" onChange={() => { throw new Error("edited"); }} />);
  expect((screen.getByLabelText("Overmould") as HTMLInputElement).readOnly).toBe(true);
});

test("inline quantity shows value with separate unit, unknown and n/a", () => {
  const { container } = render(<><SbQuantity value={3} unit="mm" /><SbQuantity value={null} /><SbQuantity value={null} state="na" /></>);
  expect(container.textContent).toContain("3 mm");
  expect(container.textContent).toContain("– – – unknown");
  expect(container.textContent).toContain("n/a");
});

test("SbUnknown names what is unknown and offers a next step", () => {
  render(<SbUnknown what="placement" next="record placement" />);
  expect(screen.getByText("placement unknown")).toBeTruthy();
  expect(screen.getByText("record placement")).toBeTruthy();
});

test("SbStatus always carries dimension and value with an LED, never a bare OK", () => {
  const { container } = render(<SbStatus led="info" dimension="compile" value="compiled, 5 outputs" />);
  expect(container.textContent).toBe("compilecompiled, 5 outputs");
  expect(container.querySelector(".sb-led")?.getAttribute("aria-hidden")).toBe("true");
  expect(container.querySelector(".sb-led")?.getAttribute("data-state")).toBe("info");
});

test("SbProvenance shows the summary and keeps exact pins behind a disclosure", () => {
  render(<SbProvenance summary="native bundle r2 · accepted 10-11" pins={[{ label: "SHA-256", value: "ab".repeat(32) }, { label: "Missing", value: null }]} />);
  expect(screen.getByText("native bundle r2 · accepted 10-11")).toBeTruthy();
  const toggle = screen.getByRole("button", { name: /exact pins/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("ab".repeat(32))).toBeTruthy();
  expect(screen.queryByText("Missing")).toBeNull();
});

test("job cards show step progress only when both numbers are known", () => {
  const { rerender, container } = render(<SbJobCard title="Extract board" state="running" stateWords="running" step={{ done: 2, total: 4 }} />);
  expect(container.textContent).toContain("running · step 2 of 4");
  expect(container.querySelector(".sb-led")?.getAttribute("data-pulse")).toBe("blink");
  rerender(<SbJobCard title="Extract board" state="running" stateWords="running" step={null} />);
  expect(container.textContent).not.toContain("step");
  expect(container.textContent).not.toContain("%");
  rerender(<SbJobCard title="Compile" state="failed" stateWords="failed, exit 3" detail="input unchanged" actions={<button>Open log</button>} />);
  expect(container.querySelector(".sb-job")?.getAttribute("data-state")).toBe("failed");
  expect(screen.getByRole("button", { name: "Open log" })).toBeTruthy();
});

test("identity badges map to the five variants", () => {
  wrap(<>{(["definition", "draft", "frozen", "occurrence", "unit"] as const).map((kind) => <SbIdentityBadge key={kind} kind={kind} />)}<SbIdentityBadge kind="unit">Unit DEMO-001</SbIdentityBadge></>);
  for (const kind of ["definition", "draft", "frozen", "occurrence", "unit"]) {
    expect(document.querySelector(`[data-identity="${kind}"]`)?.getAttribute("data-variant")).toBe(kind);
  }
  expect(screen.getByText("Unit DEMO-001")).toBeTruthy();
});

test("pulsing LEDs stop under reduced motion and styles use tokens only", () => {
  const css = readFileSync(resolve(process.cwd(), "src/components/sb/sb-components.css"), "utf8");
  expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.sb-led\[data-pulse\] \{ animation: none/);
  expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
});
