/**
 * The edge ladder board (EDGE_PROCESS_2026-10-26): the spawner's `GET /ladder`
 * turned into columns, one per rung, with what each item is waiting for.
 *
 *   Hypotheses → Searched → Forward → Live, and Retired beside them.
 *
 * Postgres guards every rung (fks 018/020/024); nothing here decides whether
 * a move is allowed. It only places items and says what comes next, so the
 * board can never show a rung the database would refuse as reachable.
 */
import type {
  Deployment,
  Experiment,
  Hypothesis,
  LadderResponse,
  ParamSpec,
} from '$lib/types/spawner';

export interface SearchedItem {
  experiment: Experiment;
  hypothesis: Hypothesis | null;
  deployments: Deployment[];
}

export interface Board {
  /** Registered and not searched yet. */
  hypotheses: Hypothesis[];
  /** Searches with their verdict and the deployments made from them. */
  searched: SearchedItem[];
  /** Deployments at backtest (waiting for a forward test) or forward. */
  forward: Deployment[];
  live: Deployment[];
  retired: Deployment[];
  /** Withdrawn hypotheses: kept, they count as tried. */
  withdrawn: Hypothesis[];
}

export function board(l: Pick<LadderResponse, 'hypotheses' | 'experiments' | 'deployments'>): Board {
  const hypotheses = l.hypotheses ?? [];
  const experiments = l.experiments ?? [];
  const deployments = l.deployments ?? [];
  const searchedIds = new Set(experiments.map((e) => e.hypothesis_id).filter((id) => id != null));
  const byId = new Map(hypotheses.map((h) => [h.id, h]));
  return {
    hypotheses: hypotheses.filter((h) => h.status === 'registered' && !searchedIds.has(h.id)),
    searched: experiments.map((experiment) => ({
      experiment,
      hypothesis: experiment.hypothesis_id != null ? (byId.get(experiment.hypothesis_id) ?? null) : null,
      deployments: deployments.filter((d) => d.experiment_id === experiment.id),
    })),
    forward: deployments.filter((d) => d.stage === 'backtest' || d.stage === 'forward'),
    live: deployments.filter((d) => d.stage === 'live'),
    retired: deployments.filter((d) => d.stage === 'retired'),
    withdrawn: hypotheses.filter((h) => h.status === 'withdrawn'),
  };
}

/** What a searched experiment is waiting for. */
export function experimentNext(item: SearchedItem): string {
  if (item.experiment.verdict !== 'USABLE') return 'Stops here. It still counts toward N.';
  const open = item.deployments.filter((d) => d.stage !== 'retired');
  if (open.length === 0) return 'Next: a deployment at backtest, on an account.';
  return `Deployed: ${open.map((d) => `#${d.id} ${d.stage}`).join(', ')}`;
}

/** What a deployment is waiting for. */
export function deploymentNext(d: Deployment): string {
  switch (d.stage) {
    case 'backtest':
      return 'Next: declare the forward sessions, then forward (paper).';
    case 'forward': {
      const req = d.forward_sessions_required ?? 0;
      const seen = d.forward_sessions_observed;
      return seen >= req
        ? `${seen} of ${req} sessions observed: live is open to an admin.`
        : `${seen} of ${req} sessions observed; live opens at ${req}.`;
    }
    case 'live':
      return `Live since ${d.since.slice(0, 10)}: ${d.live_trades} trades, ${d.live_r_sum.toFixed(2)} R.`;
    case 'retired':
      return d.retired_reason ? `Retired: ${d.retired_reason}` : 'Retired.';
  }
}

/** A parameter as one line: `lookback 10..200 step 10`, `side: long | short`. */
export function paramText(p: ParamSpec): string {
  if (p.choices) return `${p.name}: ${p.choices.map(String).join(' | ')}`;
  const step = p.step != null ? ` step ${p.step}` : '';
  return `${p.name} ${p.min}..${p.max}${step}`;
}

/** A score for the board: 3 significant figures, a dash when missing. */
export function fmtScore(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return '—';
  return Math.abs(x) >= 100 ? x.toFixed(0) : Number(x.toPrecision(3)).toString();
}

// ── The Register-hypothesis form ────────────────────────────────────────────

export interface ParamRow {
  name: string;
  kind: 'range' | 'choices';
  min: string;
  max: string;
  step: string;
  choices: string;
}

export function emptyParam(): ParamRow {
  return { name: '', kind: 'range', min: '', max: '', step: '', choices: '' };
}

/** Parameter rows to the API's specs, with the problems a person can fix. */
export function paramSpecs(rows: ParamRow[]): { params: ParamSpec[]; errors: string[] } {
  const params: ParamSpec[] = [];
  const errors: string[] = [];
  rows.forEach((r, i) => {
    const name = r.name.trim();
    const at = `Parameter ${i + 1}${name ? ` (${name})` : ''}`;
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) {
      errors.push(`${at}: a name is lower-case letters, digits and _, starting with a letter`);
    }
    if (r.kind === 'choices') {
      const choices = r.choices
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => (c !== '' && Number.isFinite(Number(c)) ? Number(c) : c));
      if (choices.length === 0) errors.push(`${at}: list the choices, separated by commas`);
      params.push({ name, choices });
      return;
    }
    const min = Number(r.min);
    const max = Number(r.max);
    if (r.min.trim() === '' || r.max.trim() === '' || !Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
      errors.push(`${at}: a range needs a min below its max`);
    }
    const spec: ParamSpec = { name, min, max };
    if (r.step.trim() !== '') {
      const step = Number(r.step);
      if (!Number.isFinite(step) || step <= 0) errors.push(`${at}: the step must be a positive number`);
      spec.step = step;
    }
    params.push(spec);
  });
  const names = params.map((p) => p.name).filter(Boolean);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) errors.push(`Parameter ${dup} is listed twice`);
  if (rows.length === 0) errors.push('A hypothesis tunes at least one parameter');
  return { params, errors };
}

/** `btcusdt, ETHUSDT sol` → `['BTCUSDT', 'ETHUSDT', 'SOL']`, deduplicated. */
export function symbolList(raw: string): string[] {
  const out: string[] = [];
  for (const s of raw.split(/[\s,]+/)) {
    const v = s.trim().toUpperCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** The baselines EDGE_PROCESS §2.4 names; anything else is typed. */
export const BASELINES = [
  { value: 'trend-200d-5pct', label: 'The live trend rule (200-day ±5%)' },
  { value: 'buy-and-hold', label: 'Buy and hold' },
] as const;
