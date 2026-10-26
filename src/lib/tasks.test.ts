import { describe, expect, it } from 'vitest';
import { buildTasks } from './tasks';
import type { BotConfig, ContainerInfo, Instance } from '$lib/types/spawner';

const config = (over: Partial<BotConfig>): BotConfig => ({
  id: 'x',
  name: 'cfg',
  image: 'img',
  mode: 'paper',
  cpu_limit: null,
  memory_mb: null,
  env: {},
  ...over,
});

const container = (over: Partial<ContainerInfo>): ContainerInfo =>
  ({
    id: 'c1',
    id_full: 'c1full',
    name: 'fks-bot-x',
    image: 'img',
    status: 'Up 1 hour',
    state: 'running',
    bot_id: 'x',
    mode: 'paper',
    created_at: '2026-10-26T10:00:00Z',
    started_at: null,
    finished_at: null,
    labels: {},
    cpu_percent: null,
    memory_bytes: null,
    memory_limit_bytes: null,
    ...over,
  }) as ContainerInfo;

const instance = (over: Partial<Instance>): Instance => ({
  name: 'btc',
  kind: 'recorder',
  template: 'recorder.binance-usdm',
  template_version: 1,
  params: { symbols: ['BTCUSDT'] },
  template_unreadable: false,
  mode: 'record',
  image: 'ghcr.io/nuniesmith/fks-bot-recorder:latest',
  bot_id: 'btc',
  data_dir: '/srv/fks-lake/raw/binance/usdm/btc',
  container: { id: 'r1', state: 'running', status: 'Up', started_at: null },
  ...over,
});

describe('buildTasks', () => {
  it('today on oryx: the live bot, the recorder, and nothing listed twice', () => {
    const rows = buildTasks({
      configs: [
        config({ name: 'crypto-regime', bot_id: 'crypto-regime', mode: 'live', account: 'kraken:spot:default' }),
        // the recorder's own config: an instance, so it must not appear again
        config({ name: 'btc', bot_id: 'btc', mode: 'record', template: { id: 'recorder.binance-usdm', version: 1, params: {} } }),
      ],
      instances: [instance({})],
      containers: [
        container({ id: 'a', bot_id: 'crypto-regime', mode: 'live', name: 'fks-bot-crypto-regime' }),
        container({ id: 'r1', bot_id: 'btc', mode: 'record', name: 'fks-bot-btc' }),
      ],
    });
    expect(rows.map((r) => [r.name, r.kind, r.source])).toEqual([
      ['crypto-regime', 'bot', 'config'],
      ['btc', 'recorder', 'instance'],
    ]);
    expect(rows[0].account).toBe('kraken:spot:default');
    expect(rows[0].container?.id).toBe('a');
    expect(rows[1].dataDir).toBe('/srv/fks-lake/raw/binance/usdm/btc');
  });

  it('lists a stopped config, a stray container, and puts running work first', () => {
    const rows = buildTasks({
      configs: [config({ name: 'idle', bot_id: 'idle' })],
      instances: [],
      containers: [container({ id: 'bt', bot_id: 'bt-edge-1', mode: 'backtest', name: 'fks-bot-bt-edge-1' })],
    });
    expect(rows.map((r) => [r.name, r.kind, r.source, r.container?.id ?? null])).toEqual([
      ['fks-bot-bt-edge-1', 'job', 'container', 'bt'],
      ['idle', 'bot', 'config', null],
    ]);
  });

  it('prefers the running container over a newer exited one', () => {
    const [row] = buildTasks({
      configs: [config({ name: 'x', bot_id: 'x' })],
      instances: [],
      containers: [
        container({ id: 'old', state: 'running', created_at: '2026-10-25T00:00:00Z' }),
        container({ id: 'new', state: 'exited', created_at: '2026-10-26T00:00:00Z' }),
      ],
    });
    expect(row.container?.id).toBe('old');
  });
});
