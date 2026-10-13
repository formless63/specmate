import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { sectionLayout } from '../../../../packages/section-layout/src';
import { stockPresets } from './presets';
import { adaptFrozenProfile } from './profile-adapter';
import { profileRevision, suggestion } from './profile-test-fixtures';
import { WirePreparationPreview } from './WirePreparationPreview';

const loaded = vi.hoisted(() => vi.fn());
vi.mock('./WireViewport', () => { loaded(); return { default: () => <div>Loaded interactive viewport</div> }; });
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('opens the lazy viewport only on request and keeps local preparation separate', async () => {
  const stock = structuredClone(stockPresets.coax!), before = structuredClone(stock);
  render(<MantineProvider><WirePreparationPreview section={sectionLayout(stock)} lengthMm={50} /></MantineProvider>);
  expect(loaded).not.toHaveBeenCalled();
  expect(screen.queryByText('Loaded interactive viewport')).toBeNull();
  fireEvent.change(screen.getByLabelText('End A cut mm'), { target: { value: '7' } });
  expect(screen.getByText(/Local explicit preview profile/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Hide selected element in preview'));
  expect(screen.getByText(/stock.center: Hidden by explicit display profile/)).toBeTruthy();
  expect(stock).toEqual(before);
  fireEvent.click(screen.getByRole('button', { name: 'Open 3D preview' }));
  await screen.findByText('Loaded interactive viewport'); expect(loaded).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Close 3D preview' }));
  expect(screen.queryByText('Loaded interactive viewport')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reset preview profile' }));
  expect(screen.getByText(/Profile: Unprepared stock/)).toBeTruthy();
  expect((screen.getByLabelText('End A cut mm') as HTMLInputElement).value).toBe('0');
});


test('shows the actual frozen lay application or straight fallback before opening WebGL', () => {
  const stock = stockPresets.pair!, revision = profileRevision();
  revision.content.profile.illustration_lay_length_mm = suggestion(24);
  revision.content.profile.illustration_lay_direction = suggestion('positive');
  const show = () => <MantineProvider><WirePreparationPreview section={sectionLayout(stock)} lengthMm={50}
    appliedProfile={adaptFrozenProfile(revision, 'stock-r1', stock)} /></MantineProvider>;
  const view = render(show());
  expect(screen.getByText(/Helical illustration: 24 mm axial period, positive/)).toBeTruthy();
  expect(screen.queryByText('Loaded interactive viewport')).toBeNull();
  revision.content.profile.illustration_lay_direction = suggestion<'positive' | 'negative'>(null);
  view.rerender(show());
  expect(screen.getByText(/Straight illustration: illustration lay length or direction is unknown/)).toBeTruthy();
  expect(screen.queryByText(/Helical illustration:/)).toBeNull();
});
