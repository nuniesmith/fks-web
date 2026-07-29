/**
 * Venue custody-mode → Badge variant.
 *
 * ONE definition for the three pages that render a venue's `mode` badge
 * (`/exchanges`, `/exchanges/[exchange]`, `/futures`). Previously copy-pasted
 * three times, and only one copy carried the dry-run note that makes the cyan
 * choice legible.
 *
 * The colours are deliberate and are NOT a health scale:
 *   - `live`    → green. This is the spot bot's **venue custody mode**, read
 *     from the bot's own `/status` document — ground truth about where real
 *     money is held, and permanently true for every real venue. It is NOT the
 *     cockpit's red "LIVE — real money" badge, which reports the *armed
 *     futures twin* (an alarm state that toggles). Do not unify the two: three
 *     permanently-red badges on `/exchanges` would train the exact ignore-red
 *     reflex that makes the cockpit's red load-bearing.
 *   - `paper`   → amber. Simulated money.
 *   - anything else (i.e. `dry-run`) → cyan. dry-run is REAL money: real
 *     balances, no orders. It must never share paper's colour.
 */
export type ModeVariant = 'green' | 'cyan' | 'amber';

export function modeVariant(mode: string): ModeVariant {
  if (mode === 'live') return 'green';
  if (mode === 'paper') return 'amber';
  return 'cyan'; // dry-run: real balances, no orders
}
