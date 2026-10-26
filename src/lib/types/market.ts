/** One row of `GET /api/market/coverage`: what janus has in candles_crypto. */
export interface MarketCoverageRow {
  symbol: string;
  interval: string;
  bars: number;
  /** ISO-8601 of the first and last bar. */
  first: string | null;
  last: string | null;
}

export interface MarketCoverageResponse {
  /** false when QuestDB did not answer: then `rows` is empty and means unknown. */
  ok: boolean;
  table?: string;
  rows: MarketCoverageRow[];
  error?: string;
}
