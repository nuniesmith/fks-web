import { describe, expect, it } from 'vitest';
import {
  board,
  datasetText,
  deploymentNext,
  emptyParam,
  experimentNext,
  fmtScore,
  lakeFolders,
  paramSpecs,
  paramText,
  symbolList,
  yesterday,
} from './ladder';
import type { Deployment, Experiment, Hypothesis } from '$lib/types/spawner';

const hyp = (id: number, over: Partial<Hypothesis> = {}): Hypothesis => ({
  id,
  edge_id: 'liq-fade',
  idea: 'Liquidation clusters overshoot; fading the move earns the snap-back.',
  symbols: ['BTCUSDT'],
  dataset: 'raw/binance/usdm/btc 2026-10-27..2027-01-27',
  holdout_share: 0.25,
  params: [{ name: 'threshold_usd', min: 1e6, max: 2e7, step: 1e6 }],
  baseline: 'buy-and-hold',
  metric: 'net return after fees',
  costs: { maker_bps: 40, taker_bps: 80, slippage_bps: 5 },
  registered_at: '2026-10-27T03:00:00Z',
  registered_by: 'jordan',
  status: 'registered',
  withdrawn_reason: null,
  withdrawn_at: null,
  ...over,
});

const exp = (id: number, over: Partial<Experiment> = {}): Experiment => ({
  id,
  study_name: `liq-fade-${id}`,
  config_fingerprint: 'fp',
  symbol: 'BTCUSDT',
  bar_minutes: 5,
  hypothesis: null,
  hypothesis_id: null,
  registered_at: null,
  tuned_params: ['threshold_usd'],
  n_trials: 40,
  train_days: null,
  test_days: null,
  folds: null,
  holdout_folds: null,
  selection_score: 1.2,
  holdout_score: 0.8,
  baseline_holdout_score: 0.5,
  overfit_gap: 0.4,
  selection_trades: 80,
  holdout_trades: 31,
  verdict: 'USABLE',
  verdict_reasons: [],
  outcome: 'pending',
  finished_at: '2026-10-28T00:00:00Z',
  created_at: '2026-10-28T00:00:00Z',
  ...over,
});

const dep = (id: number, over: Partial<Deployment> = {}): Deployment => ({
  id,
  experiment_id: 1,
  account_id: 'kraken-main',
  symbol: 'BTCUSDT',
  stage: 'backtest',
  execution: 'manual',
  params_snapshot: {},
  forward_sessions_required: null,
  forward_sessions_observed: 0,
  live_trades: 0,
  live_r_sum: 0,
  divergence_vs_backtest: null,
  since: '2026-10-29T00:00:00Z',
  retired_reason: null,
  created_at: '2026-10-29T00:00:00Z',
  updated_at: '2026-10-29T00:00:00Z',
  ...over,
});

describe('board', () => {
  it('places each item on its rung', () => {
    const b = board({
      hypotheses: [hyp(3), hyp(2), hyp(1, { status: 'withdrawn', withdrawn_reason: 'superseded' })],
      experiments: [exp(1, { hypothesis_id: 2 }), exp(2, { verdict: 'DO NOT PASTE' })],
      deployments: [
        dep(10, { stage: 'forward', forward_sessions_required: 20, forward_sessions_observed: 4 }),
        dep(11, { stage: 'live' }),
        dep(12, { stage: 'retired', retired_reason: 'drift' }),
        dep(13),
      ],
    });
    // 2 was searched, 1 withdrawn: only 3 waits for a search.
    expect(b.hypotheses.map((h) => h.id)).toEqual([3]);
    expect(b.withdrawn.map((h) => h.id)).toEqual([1]);
    expect(b.searched.map((s) => [s.experiment.id, s.hypothesis?.id ?? null, s.deployments.length])).toEqual([
      [1, 2, 4],
      [2, null, 0],
    ]);
    expect(b.forward.map((d) => d.id)).toEqual([10, 13]);
    expect(b.live.map((d) => d.id)).toEqual([11]);
    expect(b.retired.map((d) => d.id)).toEqual([12]);
  });

  it('copes with an empty ladder', () => {
    const b = board({ hypotheses: [], experiments: [], deployments: [] });
    expect([b.hypotheses, b.searched, b.forward, b.live, b.retired, b.withdrawn].every((x) => x.length === 0)).toBe(true);
  });
});

describe('what comes next', () => {
  it('for an experiment', () => {
    expect(experimentNext({ experiment: exp(1, { verdict: 'DO NOT PASTE' }), hypothesis: null, deployments: [] })).toBe(
      'Stops here. It still counts toward N.',
    );
    expect(experimentNext({ experiment: exp(1), hypothesis: null, deployments: [] })).toMatch(/^Next: a deployment/);
    expect(
      experimentNext({ experiment: exp(1), hypothesis: null, deployments: [dep(5, { stage: 'forward' }), dep(6, { stage: 'retired' })] }),
    ).toBe('Deployed: #5 forward');
  });

  it('for a deployment', () => {
    expect(deploymentNext(dep(1))).toMatch(/declare the forward sessions/);
    expect(deploymentNext(dep(1, { stage: 'forward', forward_sessions_required: 20, forward_sessions_observed: 4 }))).toBe(
      '4 of 20 sessions observed; live opens at 20.',
    );
    expect(deploymentNext(dep(1, { stage: 'forward', forward_sessions_required: 20, forward_sessions_observed: 20 }))).toMatch(
      /live is open to an admin/,
    );
    expect(deploymentNext(dep(1, { stage: 'live', live_trades: 3, live_r_sum: 1.5 }))).toBe('Live since 2026-10-29: 3 trades, 1.50 R.');
    expect(deploymentNext(dep(1, { stage: 'retired', retired_reason: 'drift' }))).toBe('Retired: drift');
  });
});

describe('formatting', () => {
  it('parameters and scores', () => {
    expect(paramText({ name: 'lookback', min: 10, max: 200, step: 10 })).toBe('lookback 10..200 step 10');
    expect(paramText({ name: 'side', choices: ['long', 'short'] })).toBe('side: long | short');
    expect(fmtScore(0.123456)).toBe('0.123');
    expect(fmtScore(1234.5)).toBe('1235');
    expect(fmtScore(null)).toBe('—');
  });

  it('symbols', () => {
    expect(symbolList('btcusdt, ETHUSDT  sol,btcusdt')).toEqual(['BTCUSDT', 'ETHUSDT', 'SOL']);
  });
});

describe('paramSpecs', () => {
  it('turns rows into specs', () => {
    const rows = [
      { ...emptyParam(), name: 'lookback', min: '10', max: '200', step: '10' },
      { ...emptyParam(), name: 'side', kind: 'choices' as const, choices: 'long, short' },
      { ...emptyParam(), name: 'band', kind: 'choices' as const, choices: '0.03, 0.05' },
    ];
    expect(paramSpecs(rows)).toEqual({
      params: [
        { name: 'lookback', min: 10, max: 200, step: 10 },
        { name: 'side', choices: ['long', 'short'] },
        { name: 'band', choices: [0.03, 0.05] },
      ],
      errors: [],
    });
  });

  it('says what is wrong with each row', () => {
    const { errors } = paramSpecs([
      { ...emptyParam(), name: 'Lookback', min: '5', max: '1' },
      { ...emptyParam(), name: 'x', kind: 'choices', choices: ' , ' },
      { ...emptyParam(), name: 'x', min: '0', max: '1', step: '-1' },
    ]);
    expect(errors.join('\n')).toContain('starting with a letter');
    expect(errors.join('\n')).toContain('a range needs a min below its max');
    expect(errors.join('\n')).toContain('list the choices');
    expect(errors.join('\n')).toContain('the step must be a positive number');
    expect(errors.join('\n')).toContain('Parameter x is listed twice');
    expect(paramSpecs([]).errors).toEqual(['A hypothesis tunes at least one parameter']);
  });
});

describe('the dataset, as the search job reads it', () => {
  it('lists the lake folders, history recorders first, with their bars and start', () => {
    const folders = lakeFolders([
      { template: 'recorder.binance-usdm', data_dir: '/srv/fks-lake/raw/binance/usdm/btc', params: { symbols: ['BTCUSDT'] } },
      {
        template: 'history.binance-spot',
        data_dir: '/srv/fks-lake/raw/binance/spot/spot-history',
        params: { intervals: ['1h', '1d'], start_year: 2017 },
      },
      { template: 'job.edge-search', data_dir: '/srv/fks-lake/jobs/edge-search-h3', params: {} },
    ]);
    expect(folders).toEqual([
      { path: 'raw/binance/spot/spot-history', history: true, intervals: ['1h', '1d'], from: '2017-01-01' },
      { path: 'raw/binance/usdm/btc', history: false, intervals: [], from: null },
    ]);
  });

  it('writes the one form the job parses', () => {
    expect(datasetText('raw/binance/spot/spot-history', '1d', '2017-08-17', '2026-10-25')).toBe(
      'raw/binance/spot/spot-history 1d 2017-08-17..2026-10-25',
    );
    expect(datasetText('', '1d', '2017-08-17', '2026-10-25')).toBe('');
    expect(yesterday(Date.parse('2026-10-27T03:00:00Z'))).toBe('2026-10-26');
  });
});

