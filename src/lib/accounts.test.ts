import { describe, expect, it } from 'vitest';
import { buildAccounts, parseAccountId, venueName, workloadKind } from './accounts';
import type { AccountLease, BotConfig, ContainerInfo } from '$lib/types/spawner';

function config(over: Partial<BotConfig>): BotConfig {
  return {
    id: 'id',
    name: 'cfg',
    image: 'ghcr.io/nuniesmith/fks-bot-crypto:latest',
    mode: 'live',
    cpu_limit: null,
    memory_mb: null,
    env: {},
    ...over,
  };
}

function lease(over: Partial<AccountLease>): AccountLease {
  return {
    account: 'kraken:spot:default',
    bot_id: 'crypto-regime',
    container_id: 'abc',
    acquired_at: '2026-10-25T17:00:00Z',
    heartbeat_at: '2026-10-26T14:00:00Z',
    expires_at: '2026-10-26T14:01:30Z',
    live: true,
    ...over,
  };
}

function container(over: Partial<ContainerInfo>): ContainerInfo {
  return {
    id: 'abc',
    name: 'fks-bot-crypto-regime',
    image: 'ghcr.io/nuniesmith/fks-bot-crypto:latest',
    status: 'Up 20 hours',
    state: 'running',
    bot_id: 'crypto-regime',
    mode: 'live',
    ...over,
  } as ContainerInfo;
}

describe('parseAccountId / venueName', () => {
  it('splits venue, market and name', () => {
    expect(parseAccountId('kraken:spot:default')).toEqual({ venue: 'kraken', market: 'spot', name: 'default' });
    expect(parseAccountId('Binance')).toEqual({ venue: 'binance', market: null, name: null });
  });
  it('names known venues and capitalises the rest', () => {
    expect(venueName('cryptocom')).toBe('Crypto.com');
    expect(venueName('gemini')).toBe('Gemini');
  });
});

describe('buildAccounts', () => {
  it('today on oryx: one Kraken key, one live bot holding the lease, plus a recorder', () => {
    const accounts = buildAccounts({
      keys: [{ exchange: 'kraken', updated_at: '2026-10-25T02:19:14Z' }],
      configs: [
        config({ name: 'crypto-regime', bot_id: 'crypto-regime', account: 'kraken:spot:default' }),
        config({ name: 'btc', bot_id: 'btc', mode: 'record', account: null }),
      ],
      leases: [lease({})],
      containers: [container({}), container({ id: 'r1', bot_id: 'btc', mode: 'record', name: 'fks-bot-btc' })],
    });
    expect(accounts).toHaveLength(1);
    const [kraken] = accounts;
    expect(kraken.id).toBe('kraken:spot:default');
    expect(kraken.label).toBe('Kraken · spot');
    expect(kraken.hasKey).toBe(true);
    expect(kraken.keyUpdatedAt).toBe('2026-10-25T02:19:14Z');
    expect(kraken.bot).toEqual({
      config: 'crypto-regime',
      botId: 'crypto-regime',
      mode: 'live',
      state: 'running',
      running: true,
    });
    expect(kraken.lease).toEqual({ botId: 'crypto-regime', live: true, expiresAt: '2026-10-26T14:01:30Z' });
  });

  it('a key with no account yet shows up as a key-only account', () => {
    const accounts = buildAccounts({
      keys: [{ exchange: 'kraken' }, { exchange: 'binance', updated_at: '2026-10-26T10:00:00Z' }],
      configs: [config({ name: 'crypto-regime', bot_id: 'crypto-regime', account: 'kraken:spot:default' })],
      leases: [],
      containers: [],
    });
    expect(accounts.map((a) => a.id)).toEqual(['kraken:spot:default', 'binance']);
    const binance = accounts[1];
    expect(binance.bot).toBeNull();
    expect(binance.hasKey).toBe(true);
    expect(binance.label).toBe('Binance');
  });

  it('an account a bot is configured for but has no key reads as keyless', () => {
    const [acct] = buildAccounts({
      keys: [],
      configs: [config({ name: 'b', bot_id: 'b', account: 'kucoin:spot:main' })],
      leases: [],
      containers: [],
    });
    expect(acct.hasKey).toBe(false);
    expect(acct.label).toBe('KuCoin · spot · main');
    expect(acct.bot?.running).toBe(false);
    expect(acct.bot?.state).toBeNull();
  });

  it('the lease holder wins when two configs name the same account', () => {
    const [acct] = buildAccounts({
      keys: [{ exchange: 'kraken' }],
      configs: [
        config({ name: 'old', bot_id: 'old-bot', account: 'kraken:spot:default' }),
        config({ name: 'new', bot_id: 'new-bot', account: 'kraken:spot:default', mode: 'paper' }),
      ],
      leases: [lease({ bot_id: 'new-bot' })],
      containers: [],
    });
    expect(acct.bot?.config).toBe('new');
    expect(acct.bot?.mode).toBe('paper');
  });

  it('a lapsed lease is reported as not live, never dropped', () => {
    const [acct] = buildAccounts({
      keys: [{ exchange: 'kraken' }],
      configs: [],
      leases: [lease({ live: false })],
      containers: [],
    });
    expect(acct.lease?.live).toBe(false);
    expect(acct.bot).toBeNull();
  });

  it('no keys and no accounts is an empty list', () => {
    expect(buildAccounts({ keys: [], configs: [], leases: [], containers: [] })).toEqual([]);
  });
});

describe('workloadKind', () => {
  it('prefers the template kind, then falls back to the mode', () => {
    expect(workloadKind('live', 'recorder')).toBe('recorder');
    expect(workloadKind('record')).toBe('recorder');
    expect(workloadKind('backtest')).toBe('job');
    expect(workloadKind('live')).toBe('bot');
    expect(workloadKind('paper', null)).toBe('bot');
  });
});
