import { Alert, Button, Checkbox, Group, NativeSelect, SegmentedControl, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useEffect, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import { InspectionScope, usePermission } from '../../lib/permissions';
import { addProjectReference, libraryDefinitions, type Definition } from '../identity/api';
import { listDrafts, type DraftRow } from '../mechanical-proposals/api';
import { operation, type ConstraintResult, type Development, type DevelopmentLink, type DevelopmentNeedKind } from './api';

export const NEED_LABEL: Record<DevelopmentNeedKind, string> = { adapter_board: 'Adapter board', cable: 'Cable', enclosure: 'Enclosure' };
/** The resolution outcome with linked proposals; a proposal never reads as valid. */
export const DEVELOPMENT_LABEL: Record<Development['outcome'], string> = {
  valid: 'valid', invalid: 'invalid', unknown: 'unknown', not_evaluated: 'not evaluated',
  invalid_with_proposal: 'invalid, with proposal', unknown_with_proposal: 'unknown, with proposal',
};
const FAILING = new Set(['invalid', 'unknown']);

function LinkedProposal({ link }: { link: DevelopmentLink }) {
  const target = link.target;
  if (!target.readable) return <Text size="sm" data-link={link.link_id}>Mechanical proposal · <Text span className="sb-silk">Not readable by you</Text></Text>;
  const kind = target.need ? NEED_LABEL[target.need] : 'Development need';
  const detail = target.kind === 'mechanical_proposal'
    ? `mechanical proposal${target.latest_retained ? ` · retained r${target.latest_retained.number}` : ' · not retained'}${target.current_decision ? ` · ${target.current_decision}` : ''}`
    : `development need${target.latest_revision ? ` · r${target.latest_revision}` : ' · draft'}`;
  return <Stack gap={0} data-link={link.link_id}>
    <Text size="sm">{kind} · {target.name}</Text>
    <Text className="sb-silk">{detail} · linked while {link.observed_outcome} · {link.basis}</Text>
  </Stack>;
}

type Mode = 'new' | 'existing';

function ProposeForm({ rule, draftId, projectId, needs, onDone, onCancel }: { rule: ConstraintResult; draftId: string; projectId: string; needs: Definition[]; onDone: () => void; onCancel: () => void }) {
  const create = usePermission('item.create');
  const [mode, setMode] = useState<Mode>('new');
  const [need, setNeed] = useState<DevelopmentNeedKind>('adapter_board');
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [basis, setBasis] = useState('');
  const [target, setTarget] = useState('');
  const [useHere, setUseHere] = useState(true);
  const [proposals, setProposals] = useState<DraftRow[]>([]);
  const [key] = useState(() => randomUUID());
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (mode !== 'existing') return;
    const controller = new AbortController();
    libraryDefinitions(projectId).then(({ workspace_id }) => listDrafts(workspace_id, controller.signal))
      .then((result) => setProposals(result.drafts))
      .catch((failure: Error) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [mode, projectId]);
  async function submit() {
    setBusy(true); setError(''); setNote('');
    try {
      if (mode === 'new') {
        const result = await operation<DevelopmentLink & { target: { definition_id: string } }>('configuration.propose_development',
          { draft_id: draftId, rule_key: rule.key, need, name: name.trim(), summary: summary.trim(), basis: basis.trim() }, { key });
        if (useHere) {
          // The need joins the workspace library; this project only references it.
          try { await addProjectReference(projectId, 'definition', result.target.definition_id, 'development proposal'); }
          catch (failure) { setNote(`Proposed in the library, but not added to this project: ${(failure as Error).message}`); setBusy(false); return; }
        }
      } else {
        const [kind, id] = target.split(':');
        await operation('configuration.link_development', { draft_id: draftId, rule_key: rule.key, basis: basis.trim(),
          target: kind === 'need' ? { kind: 'development_need', definition_id: id } : { kind: 'mechanical_proposal', proposal_draft_id: id } }, { key });
      }
      onDone();
    } catch (failure) { setError((failure as Error).message); setBusy(false); }
  }
  const ready = basis.trim() && (mode === 'new' ? name.trim() && summary.trim() : target);
  return <Stack gap="xs" aria-label={`Propose development for ${rule.label}`} role="group">
    {error && <Alert color="red">{error}</Alert>}
    {note && <Alert color="yellow">{note}</Alert>}
    <InspectionScope permission="item.create">
      <SegmentedControl size="xs" value={mode} onChange={(value) => setMode(value as Mode)} data={[{ value: 'new', label: 'New need' }, { value: 'existing', label: 'Link existing' }]} />
      {mode === 'new' ? <>
        <NativeSelect label="Development need" value={need} onChange={(event) => setNeed(event.currentTarget.value as DevelopmentNeedKind)}
          data={Object.entries(NEED_LABEL).map(([value, label]) => ({ value, label }))} />
        <TextInput label="Need name" value={name} onChange={(event) => setName(event.currentTarget.value)} />
        <Textarea label="Summary" value={summary} onChange={(event) => setSummary(event.currentTarget.value)} />
        <Checkbox label="Use in this project" checked={useHere} onChange={(event) => setUseHere(event.currentTarget.checked)} />
      </> : <NativeSelect label="Existing proposal" value={target} onChange={(event) => setTarget(event.currentTarget.value)}
        data={[{ value: '', label: needs.length || proposals.length ? 'Select a proposal' : 'No proposals in the library' },
          ...needs.map((item) => ({ value: `need:${item.definition_id}`, label: `Development need · ${item.name}` })),
          ...proposals.map((item) => ({ value: `mechanical:${item.draft_id}`, label: `Mechanical proposal · ${item.name}` }))]} />}
      <Textarea label="Link basis" value={basis} onChange={(event) => setBasis(event.currentTarget.value)} />
    </InspectionScope>
    <Group gap="xs">
      <Button size="xs" {...create.props} disabled={!create.allowed || !ready || busy} onClick={() => { void submit(); }}>{mode === 'new' ? 'Create and link' : 'Link proposal'}</Button>
      <Button size="xs" variant="quiet" disabled={busy} onClick={onCancel}>Cancel</Button>
    </Group>
    <Text className="sb-silk">A proposal records development intent. The rule stays {rule.outcome} until the design changes.</Text>
  </Stack>;
}

/** Linked proposals beside one rule, with the "Propose development" action for failing rules. */
export function RuleProposals({ rule, links, draftId, projectId, needs, onChanged }: {
  rule: ConstraintResult; links: DevelopmentLink[]; draftId: string; projectId: string; needs: Definition[]; onChanged: () => void;
}) {
  const create = usePermission('item.create');
  const [open, setOpen] = useState(false);
  const failing = FAILING.has(rule.outcome);
  return <Stack gap={4}>
    {links.length === 0 && <Text size="sm">{failing ? 'No proposal' : '-'}</Text>}
    {links.map((link) => <LinkedProposal key={link.link_id} link={link} />)}
    {failing && !open && <Group><Button size="xs" variant="quiet" {...create.props} onClick={() => setOpen(true)}>Propose development</Button></Group>}
    {failing && open && <ProposeForm rule={rule} draftId={draftId} projectId={projectId} needs={needs} onDone={() => { setOpen(false); onChanged(); }} onCancel={() => setOpen(false)} />}
  </Stack>;
}
