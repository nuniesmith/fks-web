/**
 * Turns a template's JSON-Schema `params` into form state and back.
 *
 * The spawner is the validator (crates/spawner/src/templates.rs); this module
 * only gives the form sensible inputs, the template's defaults, and the same
 * required-field and name checks so a mistake shows before the round trip.
 * Whatever passes here still goes through POST /instances/validate, and only
 * the spawner's answer decides.
 */
import type { Template, TemplateField } from '$lib/types/spawner';

export type FieldKind = 'multi-enum' | 'list' | 'enum' | 'integer' | 'number' | 'boolean' | 'text';
export type FieldValue = string | string[] | boolean;

export function fieldKind(f: TemplateField): FieldKind {
  if (f.type === 'array') return f.items?.enum?.length ? 'multi-enum' : 'list';
  if (f.enum?.length) return 'enum';
  if (f.type === 'integer') return 'integer';
  if (f.type === 'number') return 'number';
  if (f.type === 'boolean') return 'boolean';
  return 'text';
}

const KIND_RANK: Record<FieldKind, number> = {
  list: 0,
  'multi-enum': 1,
  enum: 2,
  text: 3,
  integer: 4,
  number: 4,
  boolean: 5,
};

/**
 * The form's fields in display order. The spawner serializes `properties` as
 * a sorted map, so the template file's own order is gone by the time it gets
 * here; a field's `x-order` restores it. Without one: required fields first,
 * then lists and choices, then numbers, switches last, then by name.
 */
export function orderedFields(t: Template): [string, TemplateField][] {
  const required = new Set(t.params.required ?? []);
  const order = (f: TemplateField) => (typeof f['x-order'] === 'number' ? f['x-order'] : Infinity);
  return Object.entries(t.params.properties).sort(
    ([ka, a], [kb, b]) =>
      order(a) - order(b) ||
      Number(required.has(kb)) - Number(required.has(ka)) ||
      KIND_RANK[fieldKind(a)] - KIND_RANK[fieldKind(b)] ||
      ka.localeCompare(kb),
  );
}

/** Symbols are upper-case on every venue the recorders speak to. */
function isSymbolList(f: TemplateField): boolean {
  return f.items?.['x-format'] === 'symbol' || f['x-format'] === 'symbol';
}

export function initialValues(t: Template): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const [key, f] of Object.entries(t.params.properties)) {
    const d = f.default;
    switch (fieldKind(f)) {
      case 'multi-enum':
        out[key] = Array.isArray(d) ? d.map(String) : [];
        break;
      case 'list':
        out[key] = Array.isArray(d) ? d.join(', ') : '';
        break;
      case 'enum':
        out[key] = d != null ? String(d) : String(f.enum![0]);
        break;
      case 'boolean':
        out[key] = d === true;
        break;
      default:
        out[key] = d != null ? String(d) : '';
    }
  }
  return out;
}

export function parseList(raw: string, upper = false): string[] {
  const items = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (upper ? s.toUpperCase() : s));
  return [...new Set(items)];
}

/** The form's values as the template's params, plus anything missing or malformed. */
export function toParams(
  t: Template,
  values: Record<string, FieldValue>,
): { params: Record<string, unknown>; errors: string[] } {
  const params: Record<string, unknown> = {};
  const errors: string[] = [];
  const required = new Set(t.params.required ?? []);
  for (const [key, f] of Object.entries(t.params.properties)) {
    const label = f.title ?? key;
    const v = values[key];
    switch (fieldKind(f)) {
      case 'multi-enum': {
        const arr = Array.isArray(v) ? v : [];
        if (arr.length || required.has(key)) params[key] = arr;
        if (required.has(key) && arr.length === 0) errors.push(`${label}: pick at least one`);
        break;
      }
      case 'list': {
        const arr = parseList(typeof v === 'string' ? v : '', isSymbolList(f));
        if (arr.length) params[key] = arr;
        else if (required.has(key)) errors.push(`${label} is required`);
        break;
      }
      case 'enum': {
        const s = typeof v === 'string' ? v : '';
        const match = f.enum!.find((e) => String(e) === s);
        if (match !== undefined) params[key] = match;
        else if (required.has(key)) errors.push(`${label} is required`);
        break;
      }
      case 'integer':
      case 'number': {
        const s = typeof v === 'string' ? v.trim() : '';
        if (s === '') {
          if (required.has(key)) errors.push(`${label} is required`);
          break;
        }
        const n = Number(s);
        if (!Number.isFinite(n) || (fieldKind(f) === 'integer' && !Number.isInteger(n))) {
          errors.push(`${label} must be ${fieldKind(f) === 'integer' ? 'a whole number' : 'a number'}`);
        } else {
          params[key] = n;
        }
        break;
      }
      case 'boolean':
        params[key] = v === true;
        break;
      default: {
        const s = typeof v === 'string' ? v.trim() : '';
        if (s) params[key] = s;
        else if (required.has(key)) errors.push(`${label} is required`);
      }
    }
  }
  return { params, errors };
}

/** The spawner's instance-name rule (instances.rs), checked early. */
export function nameError(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) {
    return 'Name: 2-40 lower-case letters, digits and "-", starting with a letter or digit';
  }
  return null;
}

/** A name from the form's first symbol(s): BTCUSDT → btc, [ETH, SOL] → eth-sol. */
export function suggestName(t: Template, values: Record<string, FieldValue>): string {
  const listKey = Object.entries(t.params.properties).find(([, f]) => fieldKind(f) === 'list' && isSymbolList(f))?.[0];
  const symbols = listKey ? parseList(String(values[listKey] ?? ''), true) : [];
  const base = symbols
    .slice(0, 2)
    .map((s) => s.toLowerCase().replace(/(usdt|usdc|usd|busd)$/, ''))
    .filter(Boolean)
    .join('-');
  const suffix = t.kind === 'recorder' ? '' : `-${t.kind}`;
  return (base || t.id.split('.').pop() || 'task').replace(/[^a-z0-9-]/g, '-').slice(0, 40 - suffix.length) + suffix;
}

/**
 * Estimated MB per day for a recorder: the template's per-stream estimate
 * (`x-est-mb-per-day`, measured per symbol) for each picked stream, times
 * the number of symbols. Null when the template carries no estimate.
 */
export function estimateMbPerDay(t: Template, values: Record<string, FieldValue>): number | null {
  const entry = Object.entries(t.params.properties).find(([, f]) => f['x-est-mb-per-day']);
  if (!entry) return null;
  const [key, f] = entry;
  const picked = Array.isArray(values[key]) ? (values[key] as string[]) : [];
  const perSymbol = picked.reduce((sum, s) => sum + (f['x-est-mb-per-day']![s] ?? 0), 0);
  const listKey = Object.entries(t.params.properties).find(([, g]) => fieldKind(g) === 'list' && isSymbolList(g))?.[0];
  const n = listKey ? Math.max(1, parseList(String(values[listKey] ?? ''), true).length) : 1;
  return perSymbol * n;
}
