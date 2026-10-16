import { Alert } from '@mantine/core';
import { SecondaryLibrary, type SecondaryConfig, type SecondaryLibraryProps } from '../records/SecondaryLibrary';
import { SignalSetEditor, SignalSetInspector } from '../interfaces/SignalSetFields';
import { ConventionEditor, ConventionInspector } from '../interfaces/ConventionFields';
import { initialInterface, type SignalSet, type Convention } from '../interfaces/api';
import { WorkshopProfileFields, blankProfile } from '../workshop-profiles/WorkshopProfileFields';
import type { WorkshopProfile } from '../workshop-profiles/api';
import { requestJson } from '../workspace/api';
import type { Content } from '../parts/api';

/** Only exact engineering/source pins affect the current permission fence. */
export function vocabularyReferences(content: Content): string[] {
  const paths = new Set<string>();
  const convention = content.interface as Convention | undefined;
  if (convention?.kind === 'conductor_convention') {
    if (convention.signal_set_revision_id) paths.add(`/api/v0/interfaces/revisions/${encodeURIComponent(convention.signal_set_revision_id)}`);
    if (convention.stock_revision_id) paths.add(`/api/v0/revisions/${encodeURIComponent(convention.stock_revision_id)}/snapshot`);
  }
  const profile = content.profile as WorkshopProfile | undefined;
  if (profile?.stock_revision_id) paths.add(`/api/v0/revisions/${encodeURIComponent(profile.stock_revision_id)}/snapshot`);
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    if (row.kind === 'source_file' && typeof row.bundle_revision_id === 'string' && row.bundle_revision_id) paths.add(`/api/v0/sources/revisions/${encodeURIComponent(row.bundle_revision_id)}`);
    Object.values(row).forEach(visit);
  }
  if (profile) visit(profile);
  return [...paths].sort();
}
export const authorizeVocabulary = async (content: Content) => { for (const path of vocabularyReferences(content)) await requestJson(path, { cache: 'no-store' }); };
const common = { collectionLabel: 'Vocabulary', authorizeContent: authorizeVocabulary, contentSignature: (content: Content) => JSON.stringify(vocabularyReferences(content)) };
export function vocabularyConfig(toolId: string): SecondaryConfig {
  if (toolId === 'signals') return { ...common, title: 'Signal set', viewLabel: 'Signals', initial: { kind: 'signal_set', content: { interface: initialInterface('signal_set') } }, allowedKinds: ['signal_set'], freezeOperation: 'interface.freeze',
    renderContent: ({ content, change }) => <SignalSetEditor value={content.interface as SignalSet} onChange={value => change({ ...content, interface: value })} />,
    renderInspection: ({ selected }) => selected?.kind === 'revision' ? <SignalSetInspector revisionId={selected.revision_id} /> : <Alert>Exact signal set unavailable.</Alert> };
  if (toolId === 'conventions') return { ...common, title: 'Conductor convention', viewLabel: 'Conductor uses', initial: { kind: 'conductor_convention', content: { interface: initialInterface('conductor_convention') } }, allowedKinds: ['conductor_convention'], freezeOperation: 'interface.freeze',
    renderContent: ({ content, change }) => <ConventionEditor value={content.interface as Convention} onChange={value => change({ ...content, interface: value })} />,
    renderInspection: ({ selected }) => selected?.kind === 'revision' ? <ConventionInspector revisionId={selected.revision_id} /> : <Alert>Exact convention unavailable.</Alert> };
  return { ...common, title: 'Workshop profile', viewLabel: 'Practices', initial: { kind: 'workshop_profile', content: { profile: blankProfile('') } }, allowedKinds: ['workshop_profile'], freezeOperation: 'workshop_profile.freeze', canSave: ({ content }) => !!(content.profile as WorkshopProfile)?.stock_revision_id,
    renderContent: ({ content, change, editable, active, selected }) => <WorkshopProfileFields profile={content.profile as WorkshopProfile} onChange={profile => change({ ...content, profile })} editable={editable} active={active} stateLabel={selected?.kind === 'revision' ? `Frozen revision ${selected.number}` : 'Working draft'} /> };
}
export function VocabularyLibrary(props: Omit<SecondaryLibraryProps, 'config'>) { return <SecondaryLibrary {...props} config={vocabularyConfig(props.toolId)} />; }
