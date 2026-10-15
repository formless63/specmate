import { Button, Group, NumberInput, Select, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { PN_KINDS, schemeFromConfig, type PrefixSchemeConfig } from "./part-numbers";

export function NumberingFields({ text, onChange, disabled = false }: { text: string; onChange: (text: string) => void; disabled?: boolean }) {
  let config: unknown; try { config = JSON.parse(text); } catch { config = { type: "declarative" }; }
  const mode = config === null ? "off" : (config as { type?: string }).type === "declarative" ? "declarative" : "prefix";
  const prefix = config as PrefixSchemeConfig;
  const setPrefix = (value: PrefixSchemeConfig) => onChange(JSON.stringify(value, null, 2));
  let example = "Complete the prefix fields to see an example.";
  try { if (mode === "prefix") example = schemeFromConfig(prefix).suggest({ kind: Object.keys(prefix.prefixes)[0]!, label: 'Format example' }, [])?.pn ?? "No number proposed for these kinds."; } catch { /* Prepared invalid input stays editable. */ }
  return <Stack gap="xs">
    <Select label="Numbering" disabled={disabled} dropdownOpened={disabled ? false : undefined} value={mode} data={[{ value: "off", label: "Off" }, { value: "prefix", label: "Kind prefixes" }, { value: "declarative", label: "Advanced template" }]} onChange={value => onChange(value === "off" ? "null" : JSON.stringify(value === "prefix" ? { prefixes: { cable: "CBL" }, digits: 5, separator: "-" } : { type: "declarative", template: "{seq}", segments: [{ id: "seq", type: "counter", width: 5 }] }, null, 2))} />
    <Text size="sm">A scheme checks proposed numbers. Saving it never assigns, allocates or renumbers existing identifiers.</Text>
    {mode === "prefix" && <>
      {Object.entries(prefix.prefixes ?? {}).map(([kind, value], index) => <Group key={kind} align="end" grow>
        <Select label={`Kind ${index + 1}`} disabled={disabled} dropdownOpened={disabled ? false : undefined} value={kind} data={[...new Set([kind, ...PN_KINDS.filter(item => !(item in prefix.prefixes))])].map(item => ({ value: item, label: item.replaceAll('_', ' ') }))} onChange={next => { if (!next) return; const values = Object.fromEntries(Object.entries(prefix.prefixes).map(([key, entry]) => [key === kind ? next : key, entry])); setPrefix({ ...prefix, prefixes: values }); }} />
        <TextInput label={`Prefix ${index + 1}`} maxLength={8} disabled={disabled} value={value} onChange={event => setPrefix({ ...prefix, prefixes: { ...prefix.prefixes, [kind]: event.currentTarget.value.toUpperCase() } })} />
        <Button variant="quiet" disabled={disabled} onClick={() => setPrefix({ ...prefix, prefixes: Object.fromEntries(Object.entries(prefix.prefixes).filter(([key]) => key !== kind)) })}>Remove {kind.replaceAll('_', ' ')} prefix</Button>
      </Group>)}
      <Button variant="quiet" disabled={disabled || PN_KINDS.every(kind => kind in prefix.prefixes)} onClick={() => { const kind = PN_KINDS.find(item => !(item in prefix.prefixes)); if (kind) setPrefix({ ...prefix, prefixes: { ...prefix.prefixes, [kind]: "" } }); }}>Add kind prefix</Button>
      <Group grow><NumberInput label="Sequence digits" min={1} max={12} allowDecimal={false} disabled={disabled} value={prefix.digits ?? 5} onChange={digits => setPrefix({ ...prefix, digits: Number(digits) })} /><TextInput label="Separator" maxLength={2} disabled={disabled} value={prefix.separator ?? '-'} onChange={event => setPrefix({ ...prefix, separator: event.currentTarget.value })} /></Group>
      <Text size="sm">Format example: <strong>{example}</strong>. Example only; no number is reserved.</Text>
    </>}
    {mode === "declarative" && <details><summary>Advanced declarative scheme</summary><Textarea autosize minRows={6} disabled={disabled} label="Numbering scheme" value={text} onChange={event => onChange(event.currentTarget.value)} description="Template, choice, counter and variant segments. Custom regular expressions are unsupported." /></details>}
  </Stack>;
}
