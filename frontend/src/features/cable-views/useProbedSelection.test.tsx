import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ProbeProvider } from "../probe";
import type { ProbeTarget } from "../navigation";
import { useProbedSelection } from "./useProbedSelection";

afterEach(cleanup);

test("clearing a probe keeps editor content but lets the same exact address apply again", () => {
  const chosen = vi.fn();
  function Editor() {
    const [definitionId, setDefinition] = useState("a");
    const [revision, setRevision] = useState("");
    const [buffer, setBuffer] = useState("");
    useProbedSelection({ kind: "cable", definitions: [{ definition_id: "a", kind: "cable" }, { definition_id: "b", kind: "cable" }], definitionId,
      revisions: [{ revision_id: `${definitionId}-one`, number: 1 }, { revision_id: `${definitionId}-two`, number: 2 }],
      pickDefinition: id => { chosen(id); setDefinition(id); }, pickRevision: setRevision });
    return <><output aria-label="editor definition">{definitionId}</output><output aria-label="editor revision">{revision}</output><input aria-label="local unsaved content" value={buffer} onChange={event => setBuffer(event.currentTarget.value)} /><button onClick={() => { setDefinition("b"); setRevision("b-two"); }}>Manual B</button></>;
  }
  function Host() {
    const [probe, setProbe] = useState<ProbeTarget | null>({ object: "a", rev: 1, path: [] });
    return <ProbeProvider probe={probe} onProbe={setProbe}><button onClick={() => setProbe(null)}>Clear navigation probe</button><button onClick={() => setProbe({ object: "a", rev: 1, path: [] })}>Reopen A</button><Editor /></ProbeProvider>;
  }
  render(<Host />);
  expect(screen.getByLabelText("editor revision").textContent).toBe("a-one");
  fireEvent.click(screen.getByText("Manual B"));
  fireEvent.change(screen.getByLabelText("local unsaved content"), { target: { value: "unsaved B" } });
  fireEvent.click(screen.getByText("Clear navigation probe"));
  expect(screen.getByLabelText("editor definition").textContent).toBe("b");
  expect(screen.getByLabelText("editor revision").textContent).toBe("b-two");
  expect((screen.getByLabelText("local unsaved content") as HTMLInputElement).value).toBe("unsaved B");
  expect(chosen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Reopen A"));
  expect(chosen).toHaveBeenCalledWith("a");
  expect(screen.getByLabelText("editor definition").textContent).toBe("a");
  expect(screen.getByLabelText("editor revision").textContent).toBe("a-one");
});
