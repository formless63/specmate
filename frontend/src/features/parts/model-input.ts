import type { MechanicalSource } from '../mechanical-sources/api';
import type { PreviewRepresentation } from './PartModel';
import type { Content } from './api';
/** Preserve the declared source path/hash. No fit, units or target geometry are synthesized. */
export function mechanicalModels(content: Content): PreviewRepresentation[] {
  const value = content.mechanical_source as MechanicalSource | undefined;
  if (!value?.sources || !value.models) return [];
  return value.models.flatMap(model => {
    const source = value.sources.find(row => row.local_id === model.source_local_id), file = source?.files.find(row => row.path === model.path && row.role === 'model');
    return source && file ? [{ representation_id: model.representation_id, kind: 'model', label: `${model.local_id} · ${model.purpose}`, source_bundle_revision_id: source.source_revision_id, source_path: file.path, sha256: file.sha256, rights: file.rights, rights_status: 'unknown' }] : [];
  });
}
