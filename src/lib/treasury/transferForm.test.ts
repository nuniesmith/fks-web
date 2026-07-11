import { describe, expect, it } from 'vitest';
import {
  TRANSFER_KINDS,
  defaultDirection,
  optimisticRow,
  validateTransfer,
  type TransferDraft,
} from './transferForm';
import type { RecordTransferRequest } from '$lib/types/spawner';

const NOW = new Date('2026-07-10T15:00:00Z');

function draft(overrides: Partial<TransferDraft> = {}): TransferDraft {
  return {
    accountId: 'rithmic-main',
    amountText: '500',
    kind: 'deposit',
    direction: 'in',
    ...overrides,
  };
}

describe('defaultDirection', () => {
  it('deposit flows in; withdrawal / payout / sweep flow out', () => {
    expect(defaultDirection('deposit')).toBe('in');
    expect(defaultDirection('withdrawal')).toBe('out');
    expect(defaultDirection('payout')).toBe('out');
    expect(defaultDirection('sweep')).toBe('out');
  });
});

describe('validateTransfer', () => {
  it('builds a minimal deposit body (positive amount, no optional keys)', () => {
    const v = validateTransfer(draft(), NOW);
    expect(v).toEqual({
      ok: true,
      req: { account_id: 'rithmic-main', amount: 500, kind: 'deposit' },
    });
  });

  it('signs by direction, not by the typed sign (out ⇒ negative)', () => {
    const v = validateTransfer(
      draft({ kind: 'withdrawal', direction: 'out', amountText: '250' }),
      NOW,
    );
    expect(v.ok && v.req.amount).toBe(-250);
  });

  it('discards a typed minus sign — the direction toggle is sign truth', () => {
    const v = validateTransfer(draft({ amountText: '-500' }), NOW);
    expect(v.ok && v.req.amount).toBe(500);
  });

  it('accepts thumb-typed formatting: "$1,500.25"', () => {
    const v = validateTransfer(draft({ amountText: '$1,500.25' }), NOW);
    expect(v.ok && v.req.amount).toBe(1500.25);
  });

  it.each([
    [draft({ accountId: '  ' }), 'Pick an account.'],
    [draft({ amountText: '' }), 'Enter an amount.'],
    [draft({ amountText: '  $ ' }), 'Enter an amount.'],
    [draft({ amountText: 'abc' }), 'Amount must be a number.'],
    [draft({ amountText: '0' }), 'Amount must be non-zero.'],
    [draft({ amountText: '0.00' }), 'Amount must be non-zero.'],
    [draft({ kind: 'donation' }), "Unknown kind 'donation'."],
  ])('rejects invalid input (%#)', (d, error) => {
    expect(validateTransfer(d, NOW)).toEqual({ ok: false, error });
  });

  it('converts a backdate to ISO and trims the note', () => {
    const v = validateTransfer(
      draft({ backdate: '2026-07-03T09:30', note: '  paycheck DCA  ' }),
      NOW,
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      // datetime-local is wall-clock local time → any valid ISO instant.
      expect(new Date(v.req.ts!).getTime()).toBe(new Date('2026-07-03T09:30').getTime());
      expect(v.req.note).toBe('paycheck DCA');
    }
  });

  it('rejects an unparseable or future backdate', () => {
    expect(validateTransfer(draft({ backdate: 'not-a-date' }), NOW)).toEqual({
      ok: false,
      error: 'Backdate is not a valid date/time.',
    });
    const future = new Date(NOW.getTime() + 86_400_000).toISOString();
    expect(validateTransfer(draft({ backdate: future }), NOW)).toEqual({
      ok: false,
      error: 'Backdate is in the future.',
    });
  });

  it('omits empty note / backdate instead of sending blanks', () => {
    const v = validateTransfer(draft({ backdate: '  ', note: '   ' }), NOW);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect('ts' in v.req).toBe(false);
      expect('note' in v.req).toBe(false);
    }
  });

  it('covers every allowlisted kind', () => {
    for (const kind of TRANSFER_KINDS) {
      const v = validateTransfer(draft({ kind, direction: defaultDirection(kind) }), NOW);
      expect(v.ok).toBe(true);
    }
  });
});

describe('optimisticRow', () => {
  const req: RecordTransferRequest = {
    account_id: 'rithmic-main',
    amount: 500,
    kind: 'deposit',
  };

  it('mirrors the ack id and fills server-side defaults', () => {
    const row = optimisticRow(req, { ok: true, id: 42 }, NOW);
    expect(row).toEqual({
      id: 42,
      account_id: 'rithmic-main',
      ts: NOW.toISOString(),
      amount: 500,
      currency: 'USD',
      kind: 'deposit',
      source: 'manual',
      note: null,
    });
  });

  it('keeps an explicit backdated ts and falls back to a placeholder id', () => {
    const row = optimisticRow({ ...req, ts: '2026-07-03T13:30:00.000Z' }, { ok: true }, NOW);
    expect(row.ts).toBe('2026-07-03T13:30:00.000Z');
    expect(row.id).toBe(-NOW.getTime());
  });
});
