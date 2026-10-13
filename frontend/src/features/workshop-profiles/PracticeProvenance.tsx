import { Stack, Text, Title } from '@mantine/core';
import type { Suggestion, WorkshopProfile } from './api';

function valueText(value: unknown, unit?: string): string {
  if (value === null) return 'Unknown';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return `${String(value)}${unit ? ` ${unit}` : ''}`;
}

export function SuggestionProvenance<T>({ label, suggestion, unit }: {
  label: string; suggestion: Suggestion<T>; unit?: string;
}) {
  const source = suggestion.source;
  return <Stack gap={0}>
    <Text size="sm"><strong>{label}:</strong> {valueText(suggestion.value, unit)} · Basis: {suggestion.basis}</Text>
    {suggestion.note && <Text size="sm" c="dimmed">Basis note: {suggestion.note}</Text>}
    {source?.kind === 'citation' && <Text size="sm" c="dimmed">Unverified citation: {source.citation}</Text>}
    {source?.kind === 'source_file' && <>
      <Text size="sm" c="dimmed">Registered source file · bundle revision {source.bundle_revision_id} · path <code>“{source.path}”</code></Text>
      <Text size="sm" c="dimmed">SHA-256 {source.sha256} · rights {source.rights}</Text>
      {source.locator && <Text size="sm" c="dimmed">Locator: {source.locator}</Text>}
    </>}
  </Stack>;
}

/** Read-only inspection of the exact suggestions in a draft or frozen profile. */
export function WorkshopProfileProvenance({ profile }: { profile: WorkshopProfile }) {
  const rules = Object.entries(profile.element_rules).sort(([a], [b]) => a.localeCompare(b));
  return <Stack component="section" aria-label="Recorded workshop practices" gap="xs">
    <Title order={3}>Recorded practice details</Title>
    <Text size="sm">These values and sources belong to the displayed profile revision. They do not establish measured dimensions, ratings, or electrical bonds.</Text>
    <SuggestionProvenance label="Foil visibility" suggestion={profile.foil_visibility} />
    <SuggestionProvenance label="Illustration lay length" suggestion={profile.illustration_lay_length_mm} unit="mm" />
    <SuggestionProvenance label="Omit occluded material" suggestion={profile.omit_occluded} />
    <Text size="sm">Hidden element paths (display only): {profile.hidden_element_paths.length ? profile.hidden_element_paths.join(', ') : 'None recorded'}</Text>
    <Title order={4}>Per-element preparation</Title>
    {rules.length === 0 && <Text size="sm">No element preparation rules recorded; cuts and leads are unknown.</Text>}
    {rules.map(([path, rule]) => <Stack key={path} gap="xs" style={{ borderLeft: '2px solid #aaa', paddingLeft: 12 }}>
      <Text fw={600}>{path}</Text>
      {(['a', 'b'] as const).map(end => <Stack key={end} gap={0}>
        <Text fw={500} size="sm">End {end.toUpperCase()}</Text>
        <SuggestionProvenance label="Cutback" suggestion={rule[end].cutback_mm} unit="mm" />
        <SuggestionProvenance label="Prepend cut" suggestion={rule[end].prepend_cut_mm} unit="mm" />
        {rule[end].lead ? <>
          <SuggestionProvenance label="Illustrated lead extent" suggestion={rule[end].lead.length_mm} unit="mm" />
          <SuggestionProvenance label="Illustrated lead diameter" suggestion={rule[end].lead.diameter_mm} unit="mm" />
          <SuggestionProvenance label="Illustrated lead reach" suggestion={rule[end].lead.reach_mm} unit="mm" />
          <SuggestionProvenance label="Illustrated lead angle" suggestion={rule[end].lead.angle_deg} unit="degrees" />
        </> : <Text size="sm">Lead depiction: Unknown (no rule recorded)</Text>}
      </Stack>)}
    </Stack>)}
  </Stack>;
}
