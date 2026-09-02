/**
 * The experiment registry — mirror of `fks_db.edge_experiments` and the
 * `edge_search_effort` view (fks `src/sql/spawner/017_edge_experiments.sql`).
 *
 * ONE ROW PER STUDY, NOT PER TRIAL. The trials stay in Optuna; this is the
 * layer above, and it exists so that the NUMBER of things tried is knowable.
 * Without that N, every additional experiment silently inflates the best
 * result and nothing counts the inflation.
 *
 * The columns are deliberately mirrored 1:1 rather than pre-digested: a
 * summary shape here would be a second place for the gate's meaning to live,
 * and `verdict`/`verdict_reasons` are stored verbatim in Postgres precisely so
 * a later change to the gate cannot silently rewrite history.
 */

/**
 * The two verdicts the DB CHECK constraint allows.
 *
 * Kept as a union for the writers' benefit, but every row's `verdict` is typed
 * `string` below: a value outside this union means the constraint changed under
 * us, and the UI must render it AS ITSELF rather than crashing or — far worse —
 * defaulting it to the permissive side. See `verdictVariant`, which treats
 * anything that is not exactly `USABLE` as the blocking colour.
 */
export type EdgeVerdict = 'USABLE' | 'DO NOT PASTE';

/** The verbatim blocking verdict. Compared by value in several places. */
export const DO_NOT_PASTE = 'DO NOT PASTE';
/** The verbatim passing verdict. The ONLY string treated as passing. */
export const USABLE = 'USABLE';

/** What the operator did about the row, which is not what the gate said. */
export type EdgeOutcome = 'pending' | 'adopted' | 'rejected' | 'superseded';

/** One registered Optuna study. */
export interface EdgeExperiment {
  id: number;

  // ── Identity ──────────────────────────────────────────────────────────
  study_name: string;
  /**
   * The optimizer's hash over dataset + folds + risk policy + search space.
   * Two rows sharing it were searching the same problem; two rows differing on
   * it are NOT comparable, whatever their scores say.
   */
  config_fingerprint: string;
  symbol: string;
  bar_minutes: number;

  // ── The hypothesis, ideally written FIRST ─────────────────────────────
  hypothesis: string | null;
  /** When the hypothesis was registered. Compare against `finished_at`: one
   *  written after the answer was known is not a hypothesis. */
  registered_at: string | null;

  // ── What was searched ─────────────────────────────────────────────────
  /** The dimensions actually tuned. Its LENGTH is half the overfitting
   *  argument — a 4-name array and a 71-name array are different experiments
   *  even at identical trial counts. */
  tuned_params: string[];
  n_trials: number;
  train_days: number | null;
  test_days: number | null;
  folds: number | null;
  holdout_folds: number | null;

  // ── What came out ─────────────────────────────────────────────────────
  /** What the search MAXIMISED — the most flattered number in the row. */
  selection_score: number | null;
  /** Scored once, on folds the search never saw. The only number nobody
   *  selected on, and therefore the one this page sorts by. */
  holdout_score: number | null;
  baseline_holdout_score: number | null;
  overfit_gap: number | null;
  selection_trades: number | null;
  /** ZERO here is the 2026-07 failure mode: a winner that never traded. */
  holdout_trades: number | null;

  // ── The verdict, verbatim ─────────────────────────────────────────────
  /** `EdgeVerdict` in practice; typed wide so an unrecognised value renders
   *  as itself instead of being coerced to the permissive side. */
  verdict: string;
  verdict_reasons: string[];
  /** `EdgeOutcome` in practice; typed wide for the same reason. */
  outcome: string;

  finished_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * One row of `edge_search_effort` — cumulative trials per symbol/fingerprint
 * family.
 *
 * `trials_total` is the whole point of the registry: how many draws the best
 * result in the family is the maximum of. It is the N a multiple-testing
 * correction (Deflated Sharpe) needs, and reporting a winner without it
 * overstates the winner.
 */
export interface EdgeSearchEffort {
  symbol: string;
  config_fingerprint: string;
  experiments: number;
  trials_total: number;
  best_holdout: number | null;
  usable: number;
  adopted: number;
  first_run: string | null;
  last_run: string | null;
}

/**
 * What the page loader hands the component.
 *
 * HONEST-EMPTY (the `alertAck` / `cockpit` / `rithmicAccounts` idiom): the
 * registry being ABSENT, UNREACHABLE and EMPTY are three different facts with
 * three different next actions, and collapsing any of them into "no
 * experiments" would let this page report a clean sheet for a database it
 * never successfully read. `configured:false` always carries a `reason`.
 */
export interface EdgeExperimentsView {
  configured: boolean;
  /** Why not, when `configured` is false. Never omitted in that case. */
  reason?: string;
  experiments: EdgeExperiment[];
  effort: EdgeSearchEffort[];
}
