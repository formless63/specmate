/**
 * Typed option-set content and client-side checks mirroring the server contract
 * (configurations/contracts.py). The server stays authoritative: it also checks exact
 * pins, target paths and population options, and reports a generic message.
 */

export type Domain = 'part' | 'population' | 'firmware' | 'material' | 'process' | 'requirement';
export const DOMAINS: { value: Domain; label: string }[] = [
  { value: 'part', label: 'Part' }, { value: 'population', label: 'Population' }, { value: 'firmware', label: 'Firmware' },
  { value: 'material', label: 'Material' }, { value: 'process', label: 'Process' }, { value: 'requirement', label: 'Requirement' },
];
/** Domains whose choices pin an exact frozen revision. */
export const REVISION_DOMAINS = new Set<Domain>(['part', 'population', 'firmware']);
/** Domains deciding one contextual occurrence of the target assembly. */
export const OCCURRENCE_DOMAINS = new Set<Domain>(['population', 'firmware']);
/** Exact definition kinds required where the domain has established semantics. */
export const DOMAIN_KINDS: Partial<Record<Domain, string>> = { population: 'pcb_population', firmware: 'firmware' };
/** Configuration records are never the engineering content of a choice. */
export const EXCLUDED_KINDS = new Set(['option_set', 'configuration']);

export type ChoiceBody = { key: string; label: string; revision_id: string | null; population_option_id: string | null; value: string | null };
export type OptionBody = { key: string; label: string; domain: Domain; path: string[] | null; required: boolean; default_choice: string | null; choices: ChoiceBody[] };
export type OptionSetBody = { schema_version: '0.1'; target_revision_id: string | null; options: OptionBody[] };

const KEY = /^[a-z][a-z0-9_-]{0,79}$/;
const POPULATION_OPTION = /^[a-z][a-z0-9_-]{0,63}$/;

export function emptyOptionSet(): OptionSetBody {
  return { schema_version: '0.1', target_revision_id: null, options: [] };
}

function nextKey(prefix: string, taken: string[]): string {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

export function blankChoice(option: OptionBody): ChoiceBody {
  const key = nextKey('choice', option.choices.map((c) => c.key));
  return { key, label: '', revision_id: null, population_option_id: null, value: null };
}

export function blankOption(body: OptionSetBody): OptionBody {
  const option: OptionBody = { key: nextKey('option', body.options.map((o) => o.key)), label: '', domain: 'process', path: null, required: true, default_choice: null, choices: [] };
  return { ...option, choices: [blankChoice(option)] };
}

/** Read stored content leniently so a partly authored draft still opens. */
export function parseOptionSet(content: unknown): OptionSetBody {
  const raw = (content as { option_set?: Partial<OptionSetBody> } | null)?.option_set;
  if (!raw) return emptyOptionSet();
  return {
    schema_version: '0.1',
    target_revision_id: raw.target_revision_id ?? null,
    options: (raw.options ?? []).map((o) => ({
      key: o.key ?? '', label: o.label ?? '', domain: o.domain ?? 'process', path: o.path && o.path.length ? [...o.path] : null,
      required: o.required ?? true, default_choice: o.default_choice ?? null,
      choices: (o.choices ?? []).map((c) => ({ key: c.key ?? '', label: c.label ?? '', revision_id: c.revision_id ?? null, population_option_id: c.population_option_id ?? null, value: c.value ?? null })),
    })),
  };
}

/** Content sent to the server: subjects that do not apply to the domain are dropped. */
export function serializeOptionSet(body: OptionSetBody): { option_set: OptionSetBody } {
  return {
    option_set: {
      schema_version: '0.1',
      target_revision_id: body.target_revision_id,
      options: body.options.map((o) => {
        const revisions = REVISION_DOMAINS.has(o.domain);
        return {
          key: o.key.trim(), label: o.label.trim(), domain: o.domain, path: o.path && o.path.length ? o.path : null, required: o.required, default_choice: o.default_choice,
          choices: o.choices.map((c) => ({
            key: c.key.trim(), label: c.label.trim(),
            revision_id: revisions ? c.revision_id : null,
            population_option_id: o.domain === 'population' ? c.population_option_id : null,
            value: revisions ? null : (c.value?.trim() || null),
          })),
        };
      }),
    },
  };
}

function text(value: string | null | undefined, max: number) {
  return !!value && /\S/.test(value) && value.length <= max;
}

/** Problems the server would reject, named per option so an author can fix them. */
export function validateOptionSet(body: OptionSetBody): string[] {
  const problems: string[] = [];
  const keys = body.options.map((o) => o.key.trim());
  if (new Set(keys).size !== keys.length) problems.push('Option keys must be unique.');
  const addressed = new Set<string>();
  body.options.forEach((option, index) => {
    const name = option.key.trim() || `Option ${index + 1}`;
    if (!KEY.test(option.key.trim())) problems.push(`${name}: key must start with a lowercase letter and use a-z, 0-9, - or _.`);
    if (!text(option.label, 500)) problems.push(`${name}: label is required.`);
    if (option.choices.length === 0) problems.push(`${name}: declare at least one choice.`);
    const choiceKeys = option.choices.map((c) => c.key.trim());
    if (new Set(choiceKeys).size !== choiceKeys.length) problems.push(`${name}: choice keys must be unique.`);
    if (option.default_choice !== null && !choiceKeys.includes(option.default_choice)) problems.push(`${name}: the default must name a declared choice.`);
    if (OCCURRENCE_DOMAINS.has(option.domain)) {
      if (!option.path?.length) problems.push(`${name}: ${option.domain} options address one occurrence path.`);
      else {
        const slot = `${option.domain}:${option.path.join('/')}`;
        if (addressed.has(slot)) problems.push(`${name}: another option already decides ${option.domain} for this occurrence.`);
        addressed.add(slot);
      }
    }
    if (option.path?.length && !body.target_revision_id) problems.push(`${name}: occurrence paths require an exact target assembly revision.`);
    option.choices.forEach((choice, position) => {
      const label = `${name} / ${choice.key.trim() || `choice ${position + 1}`}`;
      if (!KEY.test(choice.key.trim())) problems.push(`${label}: key must start with a lowercase letter and use a-z, 0-9, - or _.`);
      if (!text(choice.label, 500)) problems.push(`${label}: label is required.`);
      if (REVISION_DOMAINS.has(option.domain)) {
        if (!choice.revision_id) problems.push(`${label}: pin an exact frozen revision.`);
        if (option.domain === 'population' && !POPULATION_OPTION.test(choice.population_option_id ?? '')) problems.push(`${label}: choose a population option of the revision.`);
      } else if (!text(choice.value, 500)) problems.push(`${label}: declare a value.`);
    });
  });
  return problems;
}
