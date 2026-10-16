import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useState } from 'react';
import { AssessmentEditor, AssessmentResults } from './AssessmentFields';
import { initialAssessment, unknownEvidence, operating, type Result } from './assessment-api';
beforeEach(()=>vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function wrap(node:React.ReactNode){return <MantineProvider env="test">{node}</MantineProvider>;}
const result: Result = {
  left_pinout_revision_id: "left-exact", right_pinout_revision_id: "right-exact", scope: "exact_pinout_pair_and_explicit_contact_rows", physical_qualification: false,
  findings: [
    { dimension: "mating", pair_id: null, status: "satisfied", basis: "declaration", explanation: "Declared mating pair with explicit basis", evidence: [{ status: "registered_file", source_path: "mating.txt", source_bundle_revision_id: "original-evidence", sha256: "a".repeat(64), rights: "AGPL-3.0-only" }], facts: {} },
    { dimension: "pin_correspondence", pair_id: "signal", status: "invalid", basis: "comparison_of_declarations", explanation: "Contact missing from exact right body", evidence: [], facts: { pair: { left_contact_id: "data", right_contact_id: "missing", expected_signal: "bus", basis: "original proposed map", operating: operating() }, left: { signal: "bus" }, right: null } },
    ...(["levels", "current", "protocol", "shielding", "grounding", "fit"] as const).map(dimension => ({ dimension, pair_id: null, status: "unknown" as const, basis: "comparison_of_declarations" as const, explanation: `${dimension} input is unknown`, evidence: [], facts: {} })),
  ], limitations: ["No overall compatibility or physical qualification is established."],
};
test("eight visible dimensions retain declared mating alongside invalid correspondence and unknown ratings", () => {
  render(wrap(<AssessmentResults result={result} />));
  for (const name of ["Mating", "Pin correspondence", "Levels", "Current", "Protocol", "Shielding", "Grounding", "Fit"]) expect(screen.getByRole("heading", { name })).toBeTruthy();
  const card = (name: string) => within(screen.getByRole("heading", { name }).closest(".mantine-Card-root")! as HTMLElement);
  expect(card("Mating").getByText("Satisfied by declarations")).toBeTruthy();
  expect(card("Pin correspondence").getByText("Invalid / conflicting declaration")).toBeTruthy();
  expect(card("Levels").getByText("Unknown")).toBeTruthy();
  expect(card("Pin correspondence").getByText(/data → missing/)).toBeTruthy();
  expect(screen.getByText(/rights AGPL-3.0-only/)).toBeTruthy();
});

test('assessment operating fields preserve decimal and negative intermediate input and explicit zero',()=>{
 let latest=initialAssessment();latest.pairs=[{local_id:'signal',left_contact_id:'a',right_contact_id:'b',expected_signal:null,basis:'Declared',evidence:unknownEvidence(),operating:operating()}];
 function Form(){const [value,setValue]=useState(latest);return <AssessmentEditor value={value} onChange={next=>{latest=next;setValue(next);}}/>;}render(wrap(<Form/>));
 const field=screen.getByRole('textbox',{name:'signal operating minimum V (blank = unknown)'});fireEvent.change(field,{target:{value:'1'}});fireEvent.change(field,{target:{value:'1.'}});expect((field as HTMLInputElement).value).toBe('1.');fireEvent.change(field,{target:{value:'1.25'}});fireEvent.change(field,{target:{value:'-'}});expect((field as HTMLInputElement).value).toBe('-');fireEvent.change(field,{target:{value:'-1.25'}});fireEvent.change(screen.getByRole('textbox',{name:'signal current demand A (blank = unknown)'}),{target:{value:'0'}});expect(latest.pairs[0]!.operating).toMatchObject({voltage_min_v:-1.25,demand_a:0});
});
