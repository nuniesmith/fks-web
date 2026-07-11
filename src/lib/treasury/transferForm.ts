/**
 * Record-a-transfer form logic — the pure part of the /treasury "record my
 * paycheck DCA deposit from my phone" flow, kept out of the component so it
 * is vitest-coverable (transferForm.test.ts).
 *
 * SIGN CONVENTION (mirrors the spawner): `amount` is signed from the
 * account's point of view — positive = money INTO the account, negative =
 * money OUT. The form collects a magnitude plus an explicit in/out direction
 * (defaulted by kind) so a fat-fingered minus sign can never silently flip a
 * deposit into a withdrawal: the direction toggle is the single source of
 * sign truth and the typed amount's sign is discarded.
 */

import type {
  RecordTransferRequest,
  RecordTransferResponse,
  TransferKind,
  TransferRow,
} from '$lib/types/spawner';

/** Form display order; `deposit` first — it's the paycheck-DCA default. */
export const TRANSFER_KINDS: readonly TransferKind[] = [
  'deposit',
  'withdrawal',
  'payout',
  'sweep',
];

export type TransferDirection = 'in' | 'out';

/**
 * Default flow direction per kind. Deposits flow in; withdrawals, prop
 * payouts, and sweeps leave the account. Overridable in the form — e.g. a
 * sweep INTO the cold backbone recorded from the receiving account's side.
 */
export function defaultDirection(kind: TransferKind | string): TransferDirection {
  return kind === 'deposit' ? 'in' : 'out';
}

/** Raw form state, exactly as bound to the inputs. */
export interface TransferDraft {
  accountId: string;
  /** Free text — "1,500", "$250", "-40" all accepted; sign is ignored. */
  amountText: string;
  kind: TransferKind | string;
  direction: TransferDirection;
  /** `datetime-local` value ('' = now → let the DB stamp NOW()). */
  backdate?: string;
  note?: string;
}

export type TransferValidation =
  | { ok: true; req: RecordTransferRequest }
  | { ok: false; error: string };

const fail = (error: string): TransferValidation => ({ ok: false, error });

/**
 * Validate a draft into a `POST /transfers` body. Client-side gate: account
 * picked, amount finite and non-zero, known kind, backdate (if any) parseable
 * and not in the future. `now` is injectable for deterministic tests.
 */
export function validateTransfer(
  draft: TransferDraft,
  now: Date = new Date(),
): TransferValidation {
  const accountId = draft.accountId.trim();
  if (!accountId) return fail('Pick an account.');

  if (!(TRANSFER_KINDS as readonly string[]).includes(draft.kind)) {
    return fail(`Unknown kind '${draft.kind}'.`);
  }

  // Thumb-typed amounts arrive with $ signs, thousands commas, spaces.
  const cleaned = draft.amountText.replace(/[$,\s]/g, '');
  if (cleaned === '') return fail('Enter an amount.');
  const raw = Number(cleaned);
  if (!Number.isFinite(raw)) return fail('Amount must be a number.');
  if (raw === 0) return fail('Amount must be non-zero.');

  const magnitude = Math.abs(raw);
  const amount = draft.direction === 'in' ? magnitude : -magnitude;

  const req: RecordTransferRequest = { account_id: accountId, amount, kind: draft.kind };

  const backdate = draft.backdate?.trim();
  if (backdate) {
    const d = new Date(backdate); // datetime-local parses as local wall time
    if (Number.isNaN(d.getTime())) return fail('Backdate is not a valid date/time.');
    if (d.getTime() - now.getTime() > 60_000) return fail('Backdate is in the future.');
    req.ts = d.toISOString();
  }

  const note = draft.note?.trim();
  if (note) req.note = note;

  return { ok: true, req };
}

/**
 * The TransferRow to optimistically prepend after a 201 — mirrors what the
 * spawner persisted (id from the ack; server-side defaults filled in). A
 * missing ack id falls back to a negative epoch-ms placeholder so `{#each}`
 * keys stay unique until the next real refresh replaces it.
 */
export function optimisticRow(
  req: RecordTransferRequest,
  ack: RecordTransferResponse,
  now: Date = new Date(),
): TransferRow {
  return {
    id: ack.id ?? -now.getTime(),
    account_id: req.account_id,
    ts: req.ts ?? now.toISOString(),
    amount: req.amount,
    currency: req.currency ?? 'USD',
    kind: req.kind,
    source: req.source ?? 'manual',
    note: req.note ?? null,
  };
}
