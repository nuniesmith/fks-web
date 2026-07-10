/**
 * Client-side account-class registry — treasury P0.2, v1 (STOPGAP).
 *
 * Maps a spawner `bot_id` to a coarse account class so the net-worth roll-up
 * can group legend entries and keep paper money out of the headline total.
 *
 * This is deliberately a dumb static table: the mapping moves server-side
 * with the account registry in P0.5, at which point this module gets deleted
 * wholesale. Don't add fetches or heuristics here — new bots land in
 * 'unclassified' until the registry exists.
 */

export type AccountClass = 'personal-crypto' | 'paper' | 'unclassified';

/** bot_id → class. Anything not listed classifies as 'unclassified'. */
const BOT_CLASS: Record<string, AccountClass> = {
  // Kraken / KuCoin / Crypto.com spot rebalancer — real money.
  'crypto-spot': 'personal-crypto',
  // Funding-rate bot runs on a paper account (it reports a fake 10 000 USDT
  // starting balance) — it must never inflate real net worth.
  'crypto-funding': 'paper',
};

/** Classify a bot; unknown ids are 'unclassified' (treated as real, non-paper). */
export function classifyBot(botId: string): AccountClass {
  return BOT_CLASS[botId] ?? 'unclassified';
}

/** Paper accounts are excluded from the headline TOTAL by default. */
export function isPaper(cls: AccountClass): boolean {
  return cls === 'paper';
}

/** Human labels for legend group headers. */
export const CLASS_LABELS: Record<AccountClass, string> = {
  'personal-crypto': 'Personal crypto',
  unclassified: 'Unclassified',
  paper: 'Paper',
};

/** Legend group display order: real money first, paper last. */
export const CLASS_ORDER: readonly AccountClass[] = [
  'personal-crypto',
  'unclassified',
  'paper',
];
