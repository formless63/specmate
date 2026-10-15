import { MantineProvider } from "@mantine/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../workspace/api";
import { PermissionsProvider } from "../../lib/permissions";
import { DocumentDefaults } from "./DocumentDefaults";
import { SettingsPanel } from "./SettingsPanel";
import { readSettings, saveSettings, type DocumentSettingsSnapshot } from "./api";
import { useState } from "react";
vi.mock("./api", async original => ({ ...await original<typeof import('./api')>(), readSettings: vi.fn(), saveSettings: vi.fn() }));
const settings = { workspace_id: 'ws', version: 1, state_token: 'settings-v1', values: { documents: { organization: 'Synthetic workshop', designer: 'Default designer' }, numbering: null } };
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); vi.mocked(readSettings).mockResolvedValue(settings); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
function panel(section: string, permissions = ['workspace.read', 'workspace.admin']) { render(<MantineProvider><PermissionsProvider permissions={permissions}><SettingsPanel workspaceId="ws" section={section} /></PermissionsProvider></MantineProvider>); }

test('admin settings preserve prepared edits and original token after a conflict', async () => {
  vi.mocked(saveSettings).mockRejectedValue(new Error('Settings changed elsewhere.'));
  panel('settings-documents'); const field = await screen.findByRole('textbox', { name: 'Organization' });
  fireEvent.change(field, { target: { value: 'Prepared workshop' } }); fireEvent.click(screen.getByRole('button', { name: 'Save documents settings' }));
  await screen.findByText('Settings changed elsewhere.');
  expect((field as HTMLInputElement).value).toBe('Prepared workshop');
  expect(vi.mocked(saveSettings).mock.calls[0]).toEqual(['ws', { ...settings.values, documents: { ...settings.values.documents, organization: 'Prepared workshop' } }, 'settings-v1']);
});
test('viewers read document settings but cannot save workspace policy', async () => {
  panel('settings-documents', ['workspace.read']);
  await screen.findByRole('textbox', { name: 'Organization' });
  expect((screen.getByRole('button', { name: 'Save documents settings' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('textbox', { name: 'Organization' }) as HTMLInputElement).readOnly).toBe(true);
  expect(saveSettings).not.toHaveBeenCalled();
});
test('numbering starts off and checking a sample never saves or assigns', async () => {
  panel('part-numbering'); await screen.findByRole('combobox', { name: 'Numbering' });
  expect((screen.getByRole('combobox', { name: 'Numbering' }) as HTMLInputElement).value).toBe('Off');
  fireEvent.click(screen.getByRole('button', { name: 'Check proposed numbers' }));
  await screen.findByText('Numbering is off. Existing identifiers remain unchanged.'); expect(saveSettings).not.toHaveBeenCalled();
});
test('document defaults are copied only deliberately, editable and independent of later settings reads', async () => {
  function Draft() { const [value, setValue] = useState<DocumentSettingsSnapshot>(); return <><DocumentDefaults workspaceId="ws" value={value} onChange={setValue} /><pre data-testid="snapshot">{JSON.stringify(value)}</pre></>; }
  render(<MantineProvider><Draft /></MantineProvider>); expect(readSettings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Copy workspace document defaults' }));
  const designer = await screen.findByRole('textbox', { name: 'Designer' });
  fireEvent.change(designer, { target: { value: 'Reviewed designer' } });
  expect(screen.getByTestId('snapshot').textContent).toContain('"source_settings_version":1');
  expect(screen.getByTestId('snapshot').textContent).toContain('Reviewed designer');
  vi.mocked(readSettings).mockResolvedValue({ ...settings, version: 2, values: { documents: { designer: 'Later default' } } });
  await waitFor(() => expect((designer as HTMLInputElement).value).toBe('Reviewed designer'));
  expect(readSettings).toHaveBeenCalledTimes(1);
});


function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const wrap = (content: React.ReactNode) => <MantineProvider><PermissionsProvider permissions={['workspace.read', 'workspace.admin']}>{content}</PermissionsProvider></MantineProvider>;

test.each(['save', 'reload'])('%s denial hides cached settings; fresh recovery retains prepared values and original CAS', async action => {
  const accessLost = vi.fn();
  vi.mocked(saveSettings).mockRejectedValue(new ApiError(403, 'Settings access denied.'));
  render(wrap(<SettingsPanel workspaceId="ws" principalKey="principal" onAccessLost={accessLost} section="settings-documents" />));
  const field = await screen.findByRole('textbox', { name: 'Organization' });
  fireEvent.change(field, { target: { value: 'Private prepared workshop' } });
  if (action === 'reload') vi.mocked(readSettings).mockRejectedValue(new ApiError(404, 'Settings access denied.'));
  fireEvent.click(screen.getByRole('button', { name: action === 'save' ? 'Save documents settings' : 'Reload saved settings' }));
  await screen.findByText('Settings access denied.');
  expect(screen.queryByRole('textbox', { name: 'Organization' })).toBeNull();
  expect(accessLost).toHaveBeenCalledTimes(1);
  vi.mocked(readSettings).mockResolvedValue({ ...settings, version: 2, state_token: 'settings-v2', values: { documents: { organization: 'New server workshop' } } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh settings access' }));
  expect((await screen.findByRole('textbox', { name: 'Organization' }) as HTMLInputElement).value).toBe('Private prepared workshop');
  fireEvent.click(screen.getByRole('button', { name: 'Save documents settings' }));
  await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(action === 'save' ? 2 : 1));
  expect(vi.mocked(saveSettings).mock.calls.at(-1)?.[2]).toBe('settings-v1');
});

test('saving locks fields and ignores edits dispatched while a save is pending', async () => {
  const pending = deferred<typeof settings>(); vi.mocked(saveSettings).mockReturnValue(pending.promise);
  panel('settings-documents'); const field = await screen.findByRole('textbox', { name: 'Organization' });
  fireEvent.change(field, { target: { value: 'Reviewed workshop' } }); fireEvent.click(screen.getByRole('button', { name: 'Save documents settings' }));
  expect(field.closest('fieldset')?.disabled).toBe(true);
  fireEvent.change(field, { target: { value: 'Unreviewed pending edit' } });
  expect((field as HTMLInputElement).value).toBe('Reviewed workshop');
  fireEvent(window, new Event('focus'));
  await screen.findByRole('textbox', { name: 'Organization' });
  expect(field.closest('fieldset')?.disabled).toBe(true);
  await act(async () => pending.resolve({ ...settings, version: 2, state_token: 'settings-v2', values: { ...settings.values, documents: { ...settings.values.documents, organization: 'Reviewed workshop' } } }));
  expect((field as HTMLInputElement).value).toBe('Reviewed workshop');
});

test('late initial reads cannot populate a changed principal or workspace', async () => {
  const pending = deferred<typeof settings>(); vi.mocked(readSettings).mockReturnValueOnce(pending.promise).mockResolvedValue({ ...settings, workspace_id: 'other', values: { documents: { organization: 'Other workspace' } } });
  const view = render(wrap(<SettingsPanel workspaceId="ws" principalKey="first" section="settings-documents" />));
  view.rerender(wrap(<SettingsPanel workspaceId="other" principalKey="second" section="settings-documents" />));
  const field = await screen.findByRole('textbox', { name: 'Organization' });
  await act(async () => pending.resolve(settings));
  expect((field as HTMLInputElement).value).toBe('Other workspace');
});

test('late successful saves cannot replace another principal workspace values', async () => {
  const pending = deferred<typeof settings>(); vi.mocked(saveSettings).mockReturnValue(pending.promise);
  const view = render(wrap(<SettingsPanel workspaceId="ws" principalKey="first" section="settings-documents" />));
  const field = await screen.findByRole('textbox', { name: 'Organization' }); fireEvent.change(field, { target: { value: 'First prepared' } }); fireEvent.click(screen.getByRole('button', { name: 'Save documents settings' }));
  vi.mocked(readSettings).mockResolvedValue({ ...settings, workspace_id: 'other', values: { documents: { organization: 'Other workspace' } } });
  view.rerender(wrap(<SettingsPanel workspaceId="other" principalKey="second" section="settings-documents" />));
  const other = await screen.findByRole('textbox', { name: 'Organization' }); await waitFor(() => expect((other as HTMLInputElement).value).toBe('Other workspace'));
  await act(async () => pending.resolve(settings)); expect((other as HTMLInputElement).value).toBe('Other workspace');
});

test.each(['record', 'inactive'])('late document-default copies ignore %s context changes', async mode => {
  const pending = deferred<typeof settings>(); vi.mocked(readSettings).mockReturnValue(pending.promise); const changed = vi.fn();
  const view = render(<MantineProvider><DocumentDefaults key="record-a" workspaceId="ws" onChange={changed} /></MantineProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Copy workspace document defaults' }));
  view.rerender(<MantineProvider><DocumentDefaults key={mode === 'record' ? 'record-b' : 'record-a'} workspaceId="ws" active={mode !== 'inactive'} onChange={changed} /></MantineProvider>);
  await act(async () => pending.resolve(settings)); expect(changed).not.toHaveBeenCalled();
});

test('common prefix setup uses kind rows, digit count, separator and a live example', async () => {
  vi.mocked(saveSettings).mockResolvedValue({ ...settings, values: { ...settings.values, numbering: { prefixes: { cable: 'CAB' }, digits: 4, separator: '_' } } });
  panel('part-numbering'); const mode = await screen.findByRole('combobox', { name: 'Numbering' });
  fireEvent.focus(mode); fireEvent.keyDown(mode, { key: 'ArrowDown' }); fireEvent.click(await within(screen.getByRole('listbox', { hidden: true })).findByText('Kind prefixes'));
  expect(screen.queryByRole('textbox', { name: 'Numbering scheme' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: 'Prefix 1' }), { target: { value: 'CAB' } });
  fireEvent.change(screen.getByLabelText('Sequence digits', { selector: 'input' }), { target: { value: '4' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Separator' }), { target: { value: '_' } });
  await screen.findByText('CAB_0001'); fireEvent.click(screen.getByRole('button', { name: 'Save part numbering settings' }));
  await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
  expect(vi.mocked(saveSettings).mock.calls[0]?.[1].numbering).toEqual({ prefixes: { cable: 'CAB' }, digits: 4, separator: '_' });
});

test.each(['reactivation', 'focus'])('%s fences retained settings until fresh authority succeeds; denial and recovery preserve edits and CAS', async trigger => {
  vi.mocked(saveSettings).mockRejectedValue(new Error('Captured original save token'));
  const lost = vi.fn();
  const component = (active: boolean) => wrap(<SettingsPanel workspaceId="ws" principalKey="same" active={active} onAccessLost={lost} section="settings-documents" />);
  const view = render(component(true));
  const field = await screen.findByRole('textbox', { name: 'Organization' });
  fireEvent.change(field, { target: { value: 'Retained prepared values' } });
  let deny!: (reason: Error) => void;
  vi.mocked(readSettings).mockImplementationOnce(() => new Promise((_, reject) => { deny = reject; }));
  if (trigger === 'reactivation') { view.rerender(component(false)); view.rerender(component(true)); }
  else fireEvent(window, new Event('focus'));
  expect(screen.queryByRole('textbox', { name: 'Organization' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save documents settings' })).toBeNull();
  await act(async () => deny(new ApiError(403, 'Current settings denied')));
  await screen.findByText('Current settings denied'); expect(lost).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('textbox', { name: 'Organization' })).toBeNull();
  vi.mocked(readSettings).mockResolvedValue({ ...settings, version: 2, state_token: 'settings-v2', values: { documents: { organization: 'New server default' } } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh settings access' }));
  expect((await screen.findByRole('textbox', { name: 'Organization' }) as HTMLInputElement).value).toBe('Retained prepared values');
  fireEvent.click(screen.getByRole('button', { name: 'Save documents settings' }));
  await screen.findByText('Captured original save token'); expect(vi.mocked(saveSettings).mock.calls[0]?.[2]).toBe('settings-v1');
});

test.each([1, 2])('successful reactivation at server version %s retains the prepared buffer and original save token', async version => {
  vi.mocked(saveSettings).mockRejectedValue(new Error('Captured original save token'));
  const component = (active: boolean) => wrap(<SettingsPanel workspaceId="ws" active={active} section="settings-documents" />);
  const view = render(component(true));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Organization' }), { target: { value: 'Unsaved workshop' } });
  view.rerender(component(false));
  vi.mocked(readSettings).mockResolvedValue({ ...settings, version, state_token: `settings-v${version}`, values: { documents: { organization: 'Saved elsewhere' } } });
  view.rerender(component(true));
  expect((await screen.findByRole('textbox', { name: 'Organization' }) as HTMLInputElement).value).toBe('Unsaved workshop');
  fireEvent.click(screen.getByRole('button', { name: 'Save documents settings' }));
  await screen.findByText('Captured original save token'); expect(vi.mocked(saveSettings).mock.calls[0]?.[2]).toBe('settings-v1');
});
