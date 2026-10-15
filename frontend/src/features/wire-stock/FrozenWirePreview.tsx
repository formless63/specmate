import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Group, NumberInput, Select, Stack, Table, Text, Title } from '@mantine/core';
import { sectionLayout } from '../../../../packages/section-layout/src';
import type { StockSpecification } from '../../../../packages/section-layout/src';
import { WorkshopProfileProvenance } from '../workshop-profiles/PracticeProvenance';
import { readProfileRevision } from '../workshop-profiles/api';
import type { ProfileRevision } from '../workshop-profiles/api';
import { adaptFrozenProfile } from './profile-adapter';
import { listStockRevisions, listViewerDefinitions, loadFrozenStock, matchingProfileRevisions } from './viewer-api';
import type { RevisionChoice, ViewerDefinition } from './viewer-api';
import { WirePreparationPreview } from './WirePreparationPreview';
import { CableViews } from '../cable-views/CableViews';
import { StockSectionView } from '../cable-views/StockSectionView';
import { rowLook, Swatch } from '../cable-views/Swatch';
import { SbIdentityBadge, SbQuantity, SbUnknown } from "../../components/sb";
import { revisionOptionLabel, newestFirst } from "../../lib/revision-labels";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { useOpenProbed } from '../scope/openProbed';
import { StockConventions } from "../interfaces/StockConventions";

/** Own state, exact snapshots, no setters or command adapters for the current stock draft. */
const dimension = (value: number | null) => <SbQuantity value={value} unit="mm" />;

export function FrozenWirePreview({ projectId }: { projectId?: string | null }) {
  const [definitions, setDefinitions] = useState<ViewerDefinition[]>([]);
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<RevisionChoice[]>([]);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [loadedStock, setStock] = useState<{ id: string; value: StockSpecification } | null>(null);
  const stock = loadedStock?.id === revisionId ? loadedStock.value : null;
  const [profiles, setProfiles] = useState<ProfileRevision[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [loadedProfile, setProfile] = useState<ProfileRevision | null>(null);
  const profile = loadedProfile?.revision_id === profileId && loadedProfile?.content.profile.stock_revision_id === revisionId ? loadedProfile : null;
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [length, setLength] = useState(100);
  const section = useMemo(() => stock ? sectionLayout(stock) : null, [stock]);
  const applied = useMemo(() => profile && stock && revisionId ? adaptFrozenProfile(profile, revisionId, stock) : undefined, [profile, stock, revisionId]);
  useEffect(() => {
    let live = true;
    setDefinitions([]); setDefinitionId(null); setRevisions([]); setRevisionId(null); setStock(null); setProfiles([]); setProfileId(null); setProfile(null); setError(''); setLoading(true);
    listViewerDefinitions(projectId).then(items => { if (live) setDefinitions(items); })
      .catch(e => { if (live) setError(String(e.message)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectId, refresh]);
  // A Library row or deep link for a stock selects it here and its latest frozen revision once the
  // revisions load; choosing another definition or revision afterwards is never undone.
  const latestFor = useRef<string | null>(null);
  useOpenProbed(definitions.length ? id => definitions.some(d => d.definition_id === id && d.kind === 'wire_stock') : null, id => { latestFor.current = id; setDefinitionId(id); setRevisionId(null); setProfileId(null); });
  useEffect(() => {
    if (!definitionId || latestFor.current !== definitionId || !revisions.length) return;
    latestFor.current = null;
    setRevisionId(revisions.reduce((a, b) => b.number > a.number ? b : a).revision_id);
  }, [definitionId, revisions]);
  useEffect(() => {
    let live = true;
    setRevisions([]); setRevisionId(null); setStock(null); setProfiles([]); setProfileId(null); setProfile(null);
    if (!definitionId) return;
    setError(''); setLoading(true);
    listStockRevisions(definitionId).then(items => { if (live) setRevisions(items); })
      .catch(e => { if (live) setError(String(e.message)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [definitionId]);
  useEffect(() => {
    let live = true;
    setStock(null); setProfiles([]); setProfileId(null); setProfile(null);
    if (!revisionId) return;
    setError(''); setLoading(true);
    Promise.all([loadFrozenStock(revisionId), matchingProfileRevisions(definitions, revisionId)])
      .then(([exact, matches]) => { if (live) { setStock({ id: revisionId, value: exact }); setProfiles(matches); } })
      .catch(e => { if (live) setError(String(e.message)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [revisionId, definitions]);
  useEffect(() => {
    let live = true;
    setProfile(null);
    if (!profileId || !revisionId) return;
    setError(''); setLoading(true);
    readProfileRevision(profileId).then(exact => {
      if (exact.revision_id !== profileId || exact.content.profile.stock_revision_id !== revisionId) throw new Error('Profile and selected stock revision do not match.');
      if (live) setProfile(exact);
    }).catch(e => { if (live) setError(String(e.message)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [profileId, revisionId]);
  return <section aria-label="Frozen stock profile viewer"><Stack>
    <Group gap="xs"><SbIdentityBadge kind="frozen" /><Title order={3}>Frozen stock and workshop profile</Title></Group>
    <Text>Inspect an exact saved construction and a matching frozen profile. The editable draft above remains separate.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    <Group>
      <Select label="Frozen stock definition" data={definitions.filter(d => d.kind === 'wire_stock').map(d => ({ value: d.definition_id, label: d.name }))} value={definitionId} disabled={loading} onChange={id => { setDefinitionId(id); setRevisionId(null); setProfileId(null); }} />
      <Select label="Exact stock revision" data={newestFirst(revisions).map(r => ({ value: r.revision_id, label: revisionOptionLabel(definitions.find(d => d.definition_id === definitionId)?.name, r.number) }))} value={revisionId} disabled={loading || !definitionId} onChange={setRevisionId} />
      <Button variant="subtle" disabled={loading} onClick={() => setRefresh(n => n + 1)}>Refresh frozen choices</Button>
    </Group>
    {loading && <Text role="status">Loading exact revision…</Text>}
    {stock && section && <>
      <Text><RevisionLabel id={revisionId} role="stock" />. Section: <SbQuantity value={section.widthMm} unit="mm" /> × <SbQuantity value={section.heightMm} unit="mm" /> · {section.rows.length} material elements.</Text>
      <StockSectionView section={section} title="Frozen stock construction" label="Frozen stock section drawing" />
      <CableViews stock={stock} name="Frozen stock construction" revisionId={revisionId} tabs={['end-a', 'end-b', 'info']} />
      {revisionId && <StockConventions revisionId={revisionId} />}
      <Select label="Matching frozen profile" clearable placeholder={profiles.length ? 'Choose a profile revision' : 'No matching frozen profiles'}
        data={profiles.filter(r => r.content.profile.stock_revision_id === revisionId).map(r => ({ value: r.revision_id, label: `${r.name} · revision ${r.number} · ${r.revision_id}` }))} value={profileId} disabled={loading} onChange={setProfileId} />
      <NumberInput label="Frozen preview length mm" min={1} value={length} onChange={value => typeof value === 'number' && value >= 1 && setLength(value)} />
      {profile && <Text><RevisionLabel id={profile.revision_id} role="profile" />. Suggestions are read-only.</Text>}
      {(!profileId || profile) && <WirePreparationPreview key={`${revisionId}:${profile?.revision_id ?? 'local'}`} section={section} lengthMm={length} appliedProfile={applied} />}
      <Title order={4}>Frozen construction materials</Title>
      <Text size="sm">Construction: {stock.construction}. Viewed from: {stock.viewed_from}. Hidden material remains in this table.</Text>
      <Table.ScrollContainer minWidth={650}><Table aria-label="Frozen construction materials">
        <Table.Thead><Table.Tr><Table.Th>Element</Table.Th><Table.Th>Material / color</Table.Th><Table.Th>Dimensions</Table.Th><Table.Th>Source</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{section.rows.map(row => <Table.Tr key={row.path}>
          <Table.Td>{row.label} ({row.kind})<br />{row.path}</Table.Td>
          <Table.Td><Swatch look={rowLook(row)} />Material: {row.material ?? <SbUnknown />}<br />Color: {row.color ?? <SbUnknown />}</Table.Td>
          <Table.Td>{row.kind === 'web' ? <>Width: {dimension(row.widthMm)}<br />Height: {dimension(row.heightMm)}</> : <>Outer diameter: {dimension(row.outerDiameterMm)}<br />Inner diameter: {dimension(row.innerDiameterMm)}</>}</Table.Td>
          <Table.Td>{row.source ?? <SbUnknown />}</Table.Td>
        </Table.Tr>)}</Table.Tbody>
      </Table></Table.ScrollContainer>
      {Object.keys(stock.facts).length > 0 && <Table aria-label="Frozen construction facts">
        <Table.Thead><Table.Tr><Table.Th>Fact</Table.Th><Table.Th>Value</Table.Th><Table.Th>Status</Table.Th><Table.Th>Source</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{Object.entries(stock.facts).map(([name, fact]) => <Table.Tr key={name}>
          <Table.Td>{name}</Table.Td><Table.Td><SbQuantity value={fact.value} unit={fact.unit ?? undefined} /></Table.Td>
          <Table.Td>{fact.status}</Table.Td><Table.Td>{fact.source ?? <SbUnknown />}</Table.Td>
        </Table.Tr>)}</Table.Tbody>
      </Table>}
      {profile && <WorkshopProfileProvenance profile={profile.content.profile} />}
    </>}
  </Stack></section>;
}
