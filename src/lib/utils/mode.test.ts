import { describe, it, expect } from 'vitest';
import { modeVariant } from './mode';

/**
 * A-5 — one definition, three call sites (`/exchanges`, `/exchanges/[exchange]`,
 * `/futures`). These assertions pin the mapping so a future "tidy-up" of the
 * shared helper cannot quietly change three money surfaces at once.
 */
describe('modeVariant', () => {
  it('maps live → green (venue custody mode, not an alarm state)', () => {
    expect(modeVariant('live')).toBe('green');
  });

  it('maps paper → amber (simulated money)', () => {
    expect(modeVariant('paper')).toBe('amber');
  });

  it('maps dry-run → cyan, NEVER paper amber — dry-run is REAL money', () => {
    // dry-run = real balances, no orders. Colouring it as paper would tell the
    // operator the balances on screen are fake when they are not.
    expect(modeVariant('dry-run')).toBe('cyan');
    expect(modeVariant('dry-run')).not.toBe(modeVariant('paper'));
  });

  it('falls back to cyan for an unrecognised mode, never to paper amber', () => {
    expect(modeVariant('')).toBe('cyan');
    expect(modeVariant('shadow')).toBe('cyan');
  });

  it('is case-sensitive — "LIVE" is not the live token', () => {
    // The bot's /status document emits lowercase; anything else is unknown and
    // must not inherit live's green.
    expect(modeVariant('LIVE')).toBe('cyan');
  });
});
