import { describe, expect, it } from 'vitest';
import {
  estimateMbPerDay,
  fieldKind,
  initialValues,
  nameError,
  orderedFields,
  parseList,
  suggestName,
  toParams,
} from './templateForm';
import type { Template } from '$lib/types/spawner';

// templates/recorder.binance-usdm.json in fks, as served by GET /templates.
const recorder: Template = {
  id: 'recorder.binance-usdm',
  version: 1,
  kind: 'recorder',
  display_name: 'Binance USDⓈ-M futures recorder',
  image: 'ghcr.io/nuniesmith/fks-bot-recorder:latest',
  modes: ['record'],
  data: { venue: 'binance', market: 'usdm' },
  params: {
    type: 'object',
    required: ['symbols'],
    properties: {
      symbols: { type: 'array', title: 'Symbols', items: { type: 'string', 'x-format': 'symbol' }, minItems: 1 },
      streams: {
        type: 'array',
        title: 'Streams',
        items: { enum: ['forceOrder', 'bookTicker', 'markPrice@1s'] },
        default: ['forceOrder', 'bookTicker', 'markPrice@1s'],
        'x-est-mb-per-day': { forceOrder: 0.1, bookTicker: 415, 'markPrice@1s': 2 },
      },
      rest_seconds: { type: 'integer', title: 'Seconds between REST snapshots', minimum: 60, default: 300 },
      backfill_oi: { type: 'boolean', default: false },
    },
  },
};

describe('fieldKind', () => {
  it('maps the schema subset onto inputs', () => {
    const p = recorder.params.properties;
    expect(fieldKind(p.symbols)).toBe('list');
    expect(fieldKind(p.streams)).toBe('multi-enum');
    expect(fieldKind(p.rest_seconds)).toBe('integer');
    expect(fieldKind(p.backfill_oi)).toBe('boolean');
    expect(fieldKind({ type: 'string', enum: ['a', 'b'] })).toBe('enum');
    expect(fieldKind({ type: 'string' })).toBe('text');
  });
});

describe('initialValues / toParams', () => {
  it('round-trips the defaults, upper-cases symbols, and drops duplicates', () => {
    const v = initialValues(recorder);
    expect(v).toEqual({
      symbols: '',
      streams: ['forceOrder', 'bookTicker', 'markPrice@1s'],
      rest_seconds: '300',
      backfill_oi: false,
    });
    v.symbols = 'btcusdt, ETHUSDT btcusdt';
    const { params, errors } = toParams(recorder, v);
    expect(errors).toEqual([]);
    expect(params).toEqual({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      streams: ['forceOrder', 'bookTicker', 'markPrice@1s'],
      rest_seconds: 300,
      backfill_oi: false,
    });
  });

  it('names what is missing or malformed', () => {
    const v = initialValues(recorder);
    v.rest_seconds = '2.5';
    expect(toParams(recorder, v).errors).toEqual([
      'Symbols is required',
      'Seconds between REST snapshots must be a whole number',
    ]);
  });
});

describe('names and estimates', () => {
  it('suggests a name from the symbols and checks the spawner rule', () => {
    const v = initialValues(recorder);
    v.symbols = 'BTCUSDT';
    expect(suggestName(recorder, v)).toBe('btc');
    v.symbols = 'ETHUSDT SOLUSDT XRPUSDT';
    expect(suggestName(recorder, v)).toBe('eth-sol');
    expect(nameError('btc')).toBeNull();
    expect(nameError('B')).not.toBeNull();
    expect(nameError('-btc')).not.toBeNull();
  });

  it('estimates MB per day from the picked streams and the symbol count', () => {
    const v = initialValues(recorder);
    v.symbols = 'BTCUSDT ETHUSDT';
    expect(estimateMbPerDay(recorder, v)).toBeCloseTo(2 * 417.1);
    v.streams = ['forceOrder'];
    expect(estimateMbPerDay(recorder, v)).toBeCloseTo(0.2);
  });

  it('parseList splits on commas and whitespace', () => {
    expect(parseList(' a, b  c,,d ')).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('orderedFields', () => {
  it('without hints: required first, then choices, numbers, switches', () => {
    expect(orderedFields(recorder).map(([k]) => k)).toEqual(['symbols', 'streams', 'rest_seconds', 'backfill_oi']);
  });
  it('x-order wins over the heuristic', () => {
    const t = structuredClone(recorder);
    t.params.properties.backfill_oi['x-order'] = 1;
    t.params.properties.symbols['x-order'] = 2;
    expect(orderedFields(t).map(([k]) => k)).toEqual(['backfill_oi', 'symbols', 'streams', 'rest_seconds']);
  });
});
