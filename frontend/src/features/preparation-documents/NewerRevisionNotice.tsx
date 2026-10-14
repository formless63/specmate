import { Alert, Anchor, Text } from '@mantine/core';
import type { MouseEvent } from 'react';
import { useNavigation } from '../navigation/NavigationProvider';
import { formatLocation } from '../navigation/url';
import { areaOfTool } from '../shell/areas';
import type { RootCurrency } from './api';

/** The design lens that edits and inspects each document root kind. */
const LENS: Record<string, string> = { cable: 'cables', harness: 'harnesses', assembly: 'assemblies' };

/**
 * Says that the retained set's root has a newer frozen revision, with a link to it. The
 * retained set itself is not changed: it stays the exact record of the older revision.
 */
export function NewerRevisionNotice({ currency }: { currency: RootCurrency | undefined }) {
  const navigation = useNavigation();
  const newer = currency?.newer_revision;
  if (!currency || !newer) return null;
  const lens = LENS[newer.kind] ?? 'assemblies';
  const target = { area: areaOfTool(lens).id, lens, project: navigation?.location.project ?? null, probe: { object: newer.definition_id, rev: newer.number, path: [] } };
  const href = formatLocation(target);
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!navigation || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigation.navigate(target);
  };
  return <Alert color="yellow" title={`Newer revision r${newer.number} exists`}>
    <Text size="sm">This retained set was generated from {newer.name} r{currency.root_revision_number}. Revision r{newer.number} was frozen later; these documents do not reflect it and are kept unchanged.</Text>
    <Anchor href={href} onClick={open} size="sm">Open {newer.name} r{newer.number}</Anchor>
  </Alert>;
}
