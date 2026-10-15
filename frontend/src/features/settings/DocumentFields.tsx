import { Group, Select, Stack, Text, TextInput } from "@mantine/core";
import type { DocumentTitleBlock } from "./api";

export function DocumentFields({ value, onChange, disabled = false, designerLabel = "Default designer" }: { designerLabel?: string; disabled?: boolean; value: DocumentTitleBlock; onChange: (value: DocumentTitleBlock) => void }) {
  return <Stack gap="xs">
    {([['organization', 'Organization'], ['designer', designerLabel], ['rights_line', 'Printed rights / confidentiality line'], ['label_qr_url', 'Label QR address']] as const).map(([key, label]) => <TextInput disabled={disabled} key={key} label={label} maxLength={200} value={value[key] ?? ""} onChange={event => onChange({ ...value, [key]: event.currentTarget.value || null })} />)}
    <Text size="xs" c="dimmed">Printed text does not grant distribution rights. QR addresses describe a label destination; they are never fetched here.</Text>
    <Group grow><Select disabled={disabled} dropdownOpened={disabled ? false : undefined} label="Paper" clearable placeholder="Generic layout" value={value.paper ?? null} data={[{ value: 'A4', label: 'A4' }, { value: 'A3', label: 'A3' }, { value: 'letter', label: 'Letter' }, { value: 'legal', label: 'Legal' }]} onChange={paper => onChange({ ...value, paper: paper as DocumentTitleBlock['paper'] })} />
      <Select disabled={disabled} dropdownOpened={disabled ? false : undefined} label="Title block" clearable placeholder="Generic layout" value={value.title_block ?? null} data={[{ value: 'iso7200', label: 'ISO-style (right aligned)' }, { value: 'ansi', label: 'ANSI-style (full width)' }]} onChange={title_block => onChange({ ...value, title_block: title_block as DocumentTitleBlock['title_block'] })} /></Group>
  </Stack>;
}
