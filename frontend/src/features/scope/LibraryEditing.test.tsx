import { afterEach, expect, test, vi } from 'vitest';
import { LIBRARY_VIEWS } from '../shell/scope';
import { referenceFromProject } from './openProbed';
afterEach(()=>vi.unstubAllGlobals());
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
test("a failed project reference says the item was still saved in the library", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => reply({ error: { message: "Project is archived" } }, 409)));
  await expect(referenceFromProject("p1", "d1", "interface")).rejects.toThrow("Saved in the library, but not added to this project");
  await expect(referenceFromProject(null, "d1", "interface")).resolves.toBeUndefined();
});


test("every library lens names the permission its New action needs", () => {
  for (const view of Object.values(LIBRARY_VIEWS)) expect(view.create).toBeTruthy();
  expect(LIBRARY_VIEWS.sources!.create).toBe("source.register");
  expect(LIBRARY_VIEWS.inventory!.create).toBe("inventory.manage");
});
