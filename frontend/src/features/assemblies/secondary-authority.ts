import type { Content } from '../parts/api';
import { ApiError, requestJson } from '../workspace/api';

/** Domain pins in secondary declarations include evidence sources and option choices. */
export function secondaryPins(content: Content) {
  const revisions = new Set<string>(), sources = new Set<string>();
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    for (const [key, field] of Object.entries(value)) {
      if ((key === 'revision_id' || key.endsWith('_revision_id')) && typeof field === 'string' && field.trim()) {
        (['source_revision_id', 'source_bundle_revision_id'].includes(key) ? sources : revisions).add(field);
      } else visit(field);
    }
  }
  visit(content);
  return { revisions: [...revisions].sort(), sources: [...sources].sort() };
}
export async function authorizeSecondary(content: Content) {
  const pins = secondaryPins(content);
  for (let offset = 0; offset < Math.max(pins.revisions.length, pins.sources.length); offset += 50) {
    const revisions = pins.revisions.slice(offset, offset + 50), sources = pins.sources.slice(offset, offset + 50), query = new URLSearchParams();
    revisions.forEach(id => query.append('revision_ids', id)); sources.forEach(id => query.append('source_revision_ids', id));
    const result = await requestJson<{ labels: { revision_id: string; readable: boolean }[]; source_labels: { revision_id: string; readable: boolean }[] }>(`/api/v0/catalog/revision-labels?${query}`, { cache: 'no-store' });
    if (revisions.some(id => !result.labels.some(row => row.revision_id === id && row.readable)) || sources.some(id => !result.source_labels.some(row => row.revision_id === id && row.readable))) throw new ApiError(403, 'A selected declaration or retained local source is unavailable.');
  }
}
