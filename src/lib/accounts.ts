/**
 * The accounts you have set up, as one list.
 *
 * "An account" is assembled from four spawner reads, because no single table
 * holds it:
 *
 *   - stored exchange keys   GET /secrets/status   (`kraken`)
 *   - bot configs            GET /configs          (`account: kraken:spot:default`)
 *   - account leases         GET /leases           (which bot holds the account)
 *   - running containers     GET /containers       (is that bot up)
 *
 * An account id is `venue:market:label` (fks-spawner leases.rs). A key is
 * per venue, so it attaches to every account on that venue; a key with no
 * account yet becomes a key-only account (`kraken`), which is how a freshly
 * added exchange shows up before any bot trades it.
 *
 * Pure, so the merge rules are unit-tested (accounts.test.ts) and the pages
 * only fetch and render.
 */
import type {
  AccountLease,
  BotConfig,
  ContainerInfo,
  StoredExchangeCredential,
} from '$lib/types/spawner';

export interface AccountBot {
  /** The saved config's name. */
  config: string;
  botId: string;
  mode: string;
  /** Container state from Docker, or null when no container exists. */
  state: string | null;
  running: boolean;
}

export interface AccountView {
  /** `kraken:spot:default`, or just `kraken` for a key with no account yet. */
  id: string;
  venue: string;
  market: string | null;
  /** The third segment (`default`), when there is one. */
  name: string | null;
  label: string;
  hasKey: boolean;
  keyUpdatedAt: string | null;
  /** The bot configured to trade this account, if any. */
  bot: AccountBot | null;
  lease: { botId: string; live: boolean; expiresAt: string } | null;
}

export interface AccountInputs {
  keys: StoredExchangeCredential[];
  configs: BotConfig[];
  leases: AccountLease[];
  containers: ContainerInfo[];
}

const VENUE_NAMES: Record<string, string> = {
  kraken: 'Kraken',
  binance: 'Binance',
  kucoin: 'KuCoin',
  'kucoin-futures': 'KuCoin Futures',
  cryptocom: 'Crypto.com',
  coinbase: 'Coinbase',
  bybit: 'Bybit',
  okx: 'OKX',
};

export function venueName(venue: string): string {
  return VENUE_NAMES[venue] ?? venue.charAt(0).toUpperCase() + venue.slice(1);
}

/** `kraken:spot:default` → { venue: kraken, market: spot, name: default }. */
export function parseAccountId(id: string): { venue: string; market: string | null; name: string | null } {
  const [venue = '', market, name] = id.split(':');
  return { venue: venue.toLowerCase(), market: market || null, name: name || null };
}

function label(venue: string, market: string | null, name: string | null): string {
  const parts = [venueName(venue)];
  if (market) parts.push(market);
  if (name && name !== 'default') parts.push(name);
  return parts.join(' · ');
}

function botFor(
  accountId: string,
  configs: BotConfig[],
  lease: AccountLease | undefined,
  containers: ContainerInfo[],
): AccountBot | null {
  const candidates = configs.filter((c) => c.account === accountId);
  if (candidates.length === 0) return null;
  const botIdOf = (c: BotConfig) => (c.bot_id && c.bot_id.trim()) || c.name;
  // The lease holder wins when several configs name the account: it is the
  // one actually trading it.
  const chosen = (lease && candidates.find((c) => botIdOf(c) === lease.bot_id)) ?? candidates[0];
  const botId = botIdOf(chosen);
  const container =
    containers.find((k) => k.bot_id === botId && k.state === 'running') ??
    containers.find((k) => k.bot_id === botId);
  return {
    config: chosen.name,
    botId,
    mode: chosen.mode,
    state: container?.state ?? null,
    running: container?.state === 'running',
  };
}

/** Every account you have set up, the ones with a bot first, then by venue. */
export function buildAccounts({ keys, configs, leases, containers }: AccountInputs): AccountView[] {
  const keyByVenue = new Map(keys.map((k) => [k.exchange.toLowerCase(), k]));
  const ids = new Set<string>();
  for (const c of configs) if (c.account) ids.add(c.account);
  for (const l of leases) ids.add(l.account);

  const accounts: AccountView[] = [];
  const venuesWithAccount = new Set<string>();
  for (const id of ids) {
    const { venue, market, name } = parseAccountId(id);
    if (!venue) continue;
    venuesWithAccount.add(venue);
    const key = keyByVenue.get(venue);
    const lease = leases.find((l) => l.account === id);
    accounts.push({
      id,
      venue,
      market,
      name,
      label: label(venue, market, name),
      hasKey: Boolean(key),
      keyUpdatedAt: key?.updated_at ?? null,
      bot: botFor(id, configs, lease, containers),
      lease: lease ? { botId: lease.bot_id, live: lease.live, expiresAt: lease.expires_at } : null,
    });
  }
  for (const key of keys) {
    const venue = key.exchange.toLowerCase();
    if (venuesWithAccount.has(venue)) continue;
    accounts.push({
      id: venue,
      venue,
      market: null,
      name: null,
      label: venueName(venue),
      hasKey: true,
      keyUpdatedAt: key.updated_at ?? null,
      bot: null,
      lease: null,
    });
  }
  return accounts.sort(
    (a, b) => Number(Boolean(b.bot)) - Number(Boolean(a.bot)) || a.id.localeCompare(b.id),
  );
}

/** What kind of workload a container is, for grouping on Home and Tasks. */
export type WorkloadKind = 'bot' | 'recorder' | 'job';

export function workloadKind(mode: string, templateKind?: string | null): WorkloadKind {
  if (templateKind === 'recorder' || templateKind === 'job' || templateKind === 'bot') return templateKind;
  if (mode === 'record') return 'recorder';
  if (mode === 'backtest' || mode === 'optimise' || mode === 'train') return 'job';
  return 'bot';
}
