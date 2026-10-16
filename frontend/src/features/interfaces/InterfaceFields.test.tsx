import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { InterfaceEditor } from './InterfaceFields';
import { initialInterface } from './api';
import { useState } from 'react';
beforeEach(()=>vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function wrap(children:React.ReactNode){return <MantineProvider><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>{children}</QueryClientProvider></MantineProvider>;}
test("mapping form pins the selected repeated occurrence and its exact revision", async () => {
  const calls: { operation: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    let body: unknown;
    if (options?.method === "POST") {
      calls.push(JSON.parse(String(options.body)));
      return new Response(JSON.stringify({ error: { message: "Stop after captured command" } }), { status: 409 });
    }
    if (url.includes("interfaces/revisions/pinout-rev")) body = { interface: { kind: "pinout" }, contacts: [{ contact_id: "a", physical_role: "contact" }] };
    else if (url.includes("revisions/assembly-rev")) body = { snapshot_id: "root-snapshot" };
    else if (url.includes("assemblies/snapshots/")) body = { occurrences: ["left", "right"].map((side) => ({ address: { path: [side, "board"] }, revision_id: "board-rev", name: "Synthetic board", display_ref: "B1" })) };
    else body = [];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  let declared=initialInterface('interface_map');function Form(){const [value,setValue]=useState(declared);return <InterfaceEditor value={value} mode="draft" onChange={next=>{declared=next;setValue(next);}}/>;}render(wrap(<Form/>));
  fireEvent.click(screen.getByRole('button',{name:'Advanced: paste exact revision ID for Assembly'}));fireEvent.click(screen.getByRole('button',{name:'Advanced: paste exact revision ID for External pinout'}));
  fireEvent.change(screen.getByLabelText("Assembly exact revision ID"), { target: { value: "assembly-rev" } });
  fireEvent.change(screen.getByLabelText("External pinout exact revision ID"), { target: { value: "pinout-rev" } });
  const contact = screen.getByRole("combobox", { name: "External contact" });
  fireEvent.focus(contact); fireEvent.keyDown(contact, { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name: "External contact", hidden: true })).findByText("a"));
  const occurrence = screen.getByRole("combobox", { name: "Exact internal occurrence" });
  fireEvent.focus(occurrence); fireEvent.keyDown(occurrence, { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name: "Exact internal occurrence", hidden: true })).findByText("right / board · Synthetic board (B1)"));
  fireEvent.change(screen.getByLabelText("Passage stable ID"), { target: { value: "path-a" } });
  fireEvent.change(screen.getByLabelText("Internal terminal feature ID"), { target: { value: "header.pin3" } });
  fireEvent.change(screen.getByLabelText("Passage declaration basis"), { target: { value: "Synthetic connection table" } });
  fireEvent.click(screen.getByText("Add declared passage"));
  expect(screen.getByText("a → right / board · header.pin3")).toBeTruthy();
  expect(calls).toHaveLength(0);expect(declared).toMatchObject({kind:'interface_map',assembly_revision_id:'assembly-rev',external_pinout_revision_id:'pinout-rev',passages:[{local_id:'path-a',internal:{path:['right','board'],revision_id:'board-rev',feature_id:'header.pin3'},condition:null,basis:'Synthetic connection table'}]});
});
