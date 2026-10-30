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

/** The baselines EDGE_PROCESS §2.4 names, the two the search job computes. */
export const BASELINES = [
  { value: 'trend-200d-5pct', label: 'The live trend rule (200-day ±5%)' },
  { value: 'buy-and-hold', label: 'Buy and hold' },
] as const;

/** The metrics the search job scores (fks-spawner bots/edge-search), all net of costs. */
export const METRICS = [
  { value: 'net return after fees', label: 'Net return (CAGR)' },
  { value: 'sharpe after fees', label: 'Sharpe' },
  { value: 'return over max drawdown after fees', label: 'Return over max drawdown (Calmar)' },
] as const;

export const ALL_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d'];

/** A folder in the lake an instance writes, as a hypothesis names it. */
export interface LakeFolder {
  path: string;
  /** A history recorder's: the search job reads its klines. */
  history: boolean;
  /** Its candle intervals, from the instance's form. */
  intervals: string[];
  /** Its first day, from the form's start year. */
  from: string | null;
}

/** The lake folders the instances write, history recorders first. */
export function lakeFolders(
  instances: { template: string | null; data_dir: string | null; params: Record<string, unknown> | null }[],
): LakeFolder[] {
  const out: LakeFolder[] = [];
  for (const i of instances) {
    const m = /\/raw\/(.+)$/.exec(i.data_dir ?? '');
    if (!m) continue;
    const history = i.template?.startsWith('history.') ?? false;
    const iv = Array.isArray(i.params?.intervals) ? (i.params!.intervals as string[]) : [];
    const year = Number(i.params?.start_year);
    out.push({
      path: `raw/${m[1]}`,
      history,
      intervals: history ? (iv.length ? iv : ['1d']) : [],
      from: history && year >= 2017 ? `${year}-01-01` : null,
    });
  }
  return out.sort((a, b) => Number(b.history) - Number(a.history) || a.path.localeCompare(b.path));
}

/** The dataset as the search job reads it: `<lake folder> <interval> <from>..<to>`. */
export function datasetText(folder: string, interval: string, from: string, to: string): string {
  return folder && interval && from && to ? `${folder} ${interval} ${from}..${to}` : '';
}

/** Yesterday in UTC, `YYYY-MM-DD`: the archive's newest complete day. */
export function yesterday(now = Date.now()): string {
  return new Date(now - 86_400_000).toISOString().slice(0, 10);
}
