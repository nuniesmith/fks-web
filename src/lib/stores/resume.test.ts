import { describe, expect, it } from 'vitest';
import { RESUME_MIN_INTERVAL_MS, shouldRefreshOnResume } from './resume';

describe('shouldRefreshOnResume', () => {
  it('never refreshes before any fetch has completed (first fetch is the acquire path)', () => {
    expect(shouldRefreshOnResume(null, 1_000_000)).toBe(false);
    // even with a huge clock, null last-fetch stays false
    expect(shouldRefreshOnResume(null, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it('refreshes when the last fetch is older than the floor (a real background suspend)', () => {
    const now = 1_000_000;
    const stale = now - (RESUME_MIN_INTERVAL_MS + 1);
    expect(shouldRefreshOnResume(stale, now)).toBe(true);
  });

  it('does NOT refresh on a rapid flip within the floor (storm guard)', () => {
    const now = 1_000_000;
    const justFetched = now - (RESUME_MIN_INTERVAL_MS - 1);
    expect(shouldRefreshOnResume(justFetched, now)).toBe(false);
  });

  it('refreshes exactly at the floor boundary (>= is inclusive)', () => {
    const now = 1_000_000;
    expect(shouldRefreshOnResume(now - RESUME_MIN_INTERVAL_MS, now)).toBe(true);
  });

  it('honours a custom min interval', () => {
    const now = 1_000_000;
    // 5s old, custom floor 10s → too fresh
    expect(shouldRefreshOnResume(now - 5_000, now, 10_000)).toBe(false);
    // 5s old, custom floor 2s → refresh
    expect(shouldRefreshOnResume(now - 5_000, now, 2_000)).toBe(true);
  });

  it('treats clock skew (last fetch in the future) as too fresh', () => {
    const now = 1_000_000;
    expect(shouldRefreshOnResume(now + 5_000, now)).toBe(false);
  });
});
