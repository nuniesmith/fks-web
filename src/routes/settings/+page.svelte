<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { api } from '$api/client';
  import Badge from '$components/ui/Badge.svelte';
  import Skeleton from '$components/ui/Skeleton.svelte';
  import Panel from '$components/ui/Panel.svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import { createPoll } from '$lib/stores/poll';
  import { fmtRelative, fmtDateTime } from '$lib/utils/format';
  import {
    NOTIFY_EVENT_KINDS,
    ALWAYS_DELIVERED_EVENT_IDS,
    isKnownEventKind,
    coerceNotificationHistory,
    kindBadgeVariant,
    outcomeIsOk,
    type NotificationChannel,
    type NotificationHistory,
  } from '$lib/types/notifications';

  // ─── Role-aware affordances (A5) ────────────────────────────────────
  // The credential / notification / risk / janus-config saves are all R2
  // (admin-only mutations) at the seam. Disable those Save controls for a
  // known non-admin so the UI is honest; null role (auth disabled / no
  // session) leaves them on — the server is the real gate either way.
  let role = $derived(($page.data.user?.role as string | undefined) ?? null);
  let canAdmin = $derived(role == null || role === 'admin');

  // ─── Types ──────────────────────────────────────────────────────────
  interface HealthResponse {
    status: string;
    version?: string;
    uptime?: string;
    components?: Record<string, { status: string; latency?: string }>;
  }

  interface RiskSettings {
    daily_loss_limit: number;
    max_contracts: number;
    hard_stop: number;
  }

  interface JanusConfig {
    optimize_assets: string;
    optimize_interval: string;
    optimize_trials: number;
    optimize_historical_days: number;
    data_kline_intervals: string;
    janus_auto_start: boolean;
    janus_bootstrap_days: number;
  }

  interface JanusConfigResponse {
    config: JanusConfig;
    assets_list: string[];
    source: 'redis' | 'env_defaults';
    valid_intervals: string[];
    redis_available: boolean;
    /** Fields janus reads once at boot — a saved override only takes effect
     *  after the janus/optimizer process restarts (currently all of them). */
    requires_restart?: string[];
  }

  interface BootstrapPushResponse {
    ok: boolean;
    pushed: number;
    failed: number;
    total: number;
    source: string;
    message: string;
  }

  // ─── Exchange Credentials State (dynamic list) ──────────────────────
  // The spawner secret store keys credentials by a free-form exchange id, so
  // the UI stays a dynamic list: starts blank, any venue can be added. The
  // browser only submits keys; it never reads a secret back.
  //
  // Provider registry: the spawner schema has exactly THREE encrypted slots
  // per credential — api_key / api_secret / api_passphrase (optional). Every
  // provider maps its fields onto those slots, so storage is unchanged; only
  // the form labels differ. Rithmic (a futures broker, not an exchange)
  // re-labels the slots:  User → api_key, Password → api_secret,
  // System → api_passphrase.
  // Exchange creds are for read-only pulls (balances, trade history) + book
  // data — not autonomous trading. Rithmic is the futures-trading focus: its
  // workflows only activate when a rithmic credential is present.
  interface ProviderSpec {
    id: string; // slug stored in the spawner secret store
    label: string;
    kind: 'exchange' | 'broker';
    /** One-line expectation setter shown under the picker. */
    purpose: string;
    keyLabel: string;
    keyPlaceholder: string;
    secretLabel: string;
    secretPlaceholder: string;
    /** Third slot (api_passphrase). Absent = field hidden for this provider. */
    third?: { label: string; placeholder: string; required: boolean; hint?: string };
    /** Has a public reachability ping in hooks.server.ts (rithmic has none). */
    testable: boolean;
  }

  const EXCHANGE_PURPOSE =
    'Read-only: balances, trade history, book-level data — not autonomous trading.';
  const KUCOIN_THIRD = {
    label: 'API Passphrase',
    placeholder: 'Passphrase chosen when the key was created…',
    required: true,
    hint: 'KuCoin keys sign requests with the passphrase set at key creation.',
  };
  const PROVIDERS: ProviderSpec[] = [
    {
      id: 'kraken', label: 'Kraken', kind: 'exchange', purpose: EXCHANGE_PURPOSE,
      keyLabel: 'API Key', keyPlaceholder: 'Enter API key…',
      secretLabel: 'API Secret', secretPlaceholder: 'Enter API secret…',
      testable: true,
    },
    {
      id: 'kucoin', label: 'KuCoin', kind: 'exchange', purpose: EXCHANGE_PURPOSE,
      keyLabel: 'API Key', keyPlaceholder: 'Enter API key…',
      secretLabel: 'API Secret', secretPlaceholder: 'Enter API secret…',
      third: KUCOIN_THIRD, testable: true,
    },
    {
      id: 'kucoin-futures', label: 'KuCoin Futures', kind: 'exchange', purpose: EXCHANGE_PURPOSE,
      keyLabel: 'API Key', keyPlaceholder: 'Enter API key…',
      secretLabel: 'API Secret', secretPlaceholder: 'Enter API secret…',
      third: KUCOIN_THIRD, testable: true,
    },
    {
      id: 'cryptocom', label: 'Crypto.com', kind: 'exchange', purpose: EXCHANGE_PURPOSE,
      keyLabel: 'API Key', keyPlaceholder: 'Enter API key…',
      secretLabel: 'API Secret', secretPlaceholder: 'Enter API secret…',
      testable: true,
    },
    {
      id: 'binance', label: 'Binance', kind: 'exchange', purpose: EXCHANGE_PURPOSE,
      keyLabel: 'API Key', keyPlaceholder: 'Enter API key…',
      secretLabel: 'API Secret', secretPlaceholder: 'Enter API secret…',
      testable: true,
    },
    {
      id: 'rithmic', label: 'Rithmic', kind: 'broker',
      purpose:
        'Futures trading focus — enables the Rithmic workflows when present. ' +
        'We trade manually; creds unlock read-only account pulls + book data.',
      keyLabel: 'User', keyPlaceholder: 'Rithmic login user…',
      secretLabel: 'Password', secretPlaceholder: 'Rithmic password…',
      third: {
        label: 'System', placeholder: 'e.g. Rithmic Paper Trading', required: true,
        hint:
          'Stored in the standard 3-slot secret record: User → api_key, ' +
          'Password → api_secret, System → api_passphrase.',
      },
      // No public ping endpoint — R|API is a proprietary gateway protocol.
      testable: false,
    },
  ];
  const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));
  // "Other…" escape hatch: free-form slug keeps the store's generality.
  // The sentinel is not a valid slug, so it can never collide with a stored id.
  const OTHER = '__other__';

  interface StoredCredential {
    exchange: string;
    updated_at?: string;
  }
  // null = secret store unreachable (distinct from "no credentials yet").
  let credList = $state<StoredCredential[] | null>(null);
  let credDbEnabled = $state(true);
  // Add/update form
  let credProviderId = $state<string>(PROVIDERS[0].id);
  // undefined ⇒ "Other…" mode (free-text slug input).
  let credProvider = $derived(PROVIDER_BY_ID.get(credProviderId));
  let credExchange = $state(''); // free-text slug — Other… mode only
  let credKey = $state('');
  let credSecret = $state('');
  let credPassphrase = $state('');
  let credSaving = $state(false);
  // Delete flow: exchange id armed for confirm / currently deleting.
  let credPendingDelete = $state<string | null>(null);
  let credDeleting = $state<string | null>(null);
  let credFeedback = $state('');
  let credFeedbackVariant = $state<'green' | 'red' | 'default'>('default');
  // Venues with a server-side reachability test (GET /api/exchanges/:venue/ping).
  // Reachability only — stored credentials are never read back, so key
  // validation would have to run in the spawner (follow-up). Rithmic is not
  // testable: it has no public ping.
  const TESTABLE_VENUES = new Set(PROVIDERS.filter((p) => p.testable).map((p) => p.id));
  let venueTesting = $state<string | null>(null);
  let venueTestFeedback = $state('');
  let venueTestVariant = $state<'green' | 'red' | 'default'>('default');

  // ─── Risk Controls State (rustrade PortfolioRiskConfig) ─────────────
  let riskDailyLoss = $state(5000);          // max daily loss (USD; shown positive, stored ≤0)
  let riskMaxPositions = $state(10);         // max concurrent positions
  let riskGrossExposure = $state(5_000_000); // max gross exposure (USD)
  let riskSaving = $state(false);
  let riskLoading = $state(false);
  let riskFeedback = $state('');

  // ─── System Health State ───────────────────────────────────────────
  let healthData = $state<HealthResponse | null>(null);
  let healthLoading = $state(true);
  let healthTimer: ReturnType<typeof setInterval> | null = null;

  // ─── Observability Links ───────────────────────────────────────────
  const obsLinks = [
    { label: 'Grafana',       icon: '📊', url: 'http://localhost:3000',  color: 'var(--amber)' },
    { label: 'Prometheus',    icon: '🔥', url: 'http://localhost:9090',  color: 'var(--cyan)' },
    { label: 'Alertmanager',  icon: '🔔', url: 'http://localhost:9093',  color: 'var(--red)' },
    { label: 'Jaeger',        icon: '🔍', url: 'http://localhost:16686', color: 'var(--purple)' },
  ];

  // ─── Janus Config State ────────────────────────────────────────────
  let janusConfig = $state<JanusConfig>({
    optimize_assets: 'BTC,ETH,SOL',
    optimize_interval: '6h',
    optimize_trials: 100,
    optimize_historical_days: 30,
    data_kline_intervals: '1m,5m',
    janus_auto_start: false,
    janus_bootstrap_days: 30,
  });
  let janusConfigSource = $state<'redis' | 'env_defaults'>('env_defaults');
  let janusRedisAvailable = $state(false);
  let janusValidIntervals = $state<string[]>(['1h', '4h', '6h', '12h', '1D']);
  // Boot-time fields as reported by janus — saved values apply on restart.
  let janusRequiresRestart = $state<string[]>([]);
  let janusLoading = $state(true);
  let janusSaving = $state(false);
  let janusFeedback = $state('');
  let janusFeedbackVariant = $state<'green' | 'red' | 'default'>('default');
  let janusPushing = $state(false);
  let janusPushFeedback = $state('');
  let janusPushVariant = $state<'green' | 'red' | 'default'>('default');

  // ─── Helpers ────────────────────────────────────────────────────────

  function clearFeedbackAfter(setter: (v: string) => void, ms = 3000) {
    setTimeout(() => setter(''), ms);
  }

  function componentVariant(status: string): 'green' | 'red' | 'amber' | 'default' {
    const s = status.toLowerCase();
    if (s === 'ok' || s === 'healthy' || s === 'up' || s === 'connected') return 'green';
    if (s === 'degraded' || s === 'warning' || s === 'slow') return 'amber';
    if (s === 'error' || s === 'down' || s === 'unhealthy' || s === 'disconnected') return 'red';
    return 'default';
  }

  function overallVariant(status: string): 'green' | 'red' | 'amber' | 'default' {
    const s = status.toLowerCase();
    if (s === 'ok' || s === 'healthy') return 'green';
    if (s === 'degraded') return 'amber';
    if (s === 'error' || s === 'unhealthy') return 'red';
    return 'default';
  }

  // ─── API: Exchange Credentials ─────────────────────────────────────

  async function loadCredentials() {
    try {
      const res = await api.get<{ db_enabled?: boolean; exchanges?: StoredCredential[] }>(
        '/api/settings/exchange-keys/status'
      );
      credList = Array.isArray(res?.exchanges) ? res.exchanges : [];
      credDbEnabled = res?.db_enabled !== false;
    } catch {
      credList = null;
    }
  }

  // Switching provider clears the inputs so a value typed under one
  // provider's labels can't be silently submitted under another's.
  function onProviderChange() {
    credExchange = '';
    credKey = '';
    credSecret = '';
    credPassphrase = '';
  }

  async function saveCredential() {
    // Known providers submit their fixed slug; Other… uses the free text.
    const exchange = credProvider ? credProvider.id : credExchange.trim().toLowerCase();
    // Same slug rule the adapter enforces — but with a message the user can
    // act on (the api client discards server error bodies, so a 400 would
    // surface as an unhelpful "API 400: Bad Request").
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(exchange)) {
      credFeedback = `Invalid id "${exchange}" — letters, digits, - and _ only (e.g. cryptocom, not crypto.com)`;
      credFeedbackVariant = 'red';
      clearFeedbackAfter(v => credFeedback = v, 6000);
      return;
    }
    credSaving = true;
    credFeedback = '';
    try {
      await api.post('/api/settings/exchange-keys', {
        exchange,
        api_key: credKey,
        api_secret: credSecret,
        ...(credPassphrase ? { api_passphrase: credPassphrase } : {}),
      });
      credFeedback = `${exchange} credentials saved ✓`;
      credFeedbackVariant = 'green';
      // Browser submits then forgets: clear the inputs and refresh the list.
      credExchange = '';
      credKey = '';
      credSecret = '';
      credPassphrase = '';
      loadCredentials();
      clearFeedbackAfter(v => credFeedback = v);
    } catch (err: any) {
      credFeedback = `Error: ${err.message ?? 'Failed to save'}`;
      credFeedbackVariant = 'red';
      clearFeedbackAfter(v => credFeedback = v, 5000);
    } finally {
      credSaving = false;
    }
  }

  // Prefill the form to overwrite an existing credential (upsert semantics).
  // Known ids select their provider; anything else opens the Other… slug path.
  function startUpdate(exchange: string) {
    const known = PROVIDER_BY_ID.has(exchange);
    credProviderId = known ? exchange : OTHER;
    credExchange = known ? '' : exchange;
    credKey = '';
    credSecret = '';
    credPassphrase = '';
  }

  // Two-step inline confirm: first click arms (auto-disarms after 4s),
  // second click deletes. No browser dialogs.
  async function deleteCredential(exchange: string) {
    if (credPendingDelete !== exchange) {
      credPendingDelete = exchange;
      setTimeout(() => {
        if (credPendingDelete === exchange) credPendingDelete = null;
      }, 4000);
      return;
    }
    credPendingDelete = null;
    credDeleting = exchange;
    try {
      await api.delete(`/api/settings/exchange-keys/${encodeURIComponent(exchange)}`);
      credFeedback = `${exchange} keys deleted`;
      credFeedbackVariant = 'green';
      loadCredentials();
      clearFeedbackAfter(v => credFeedback = v);
    } catch (err: any) {
      credFeedback = `Error: ${err.message ?? 'Failed to delete'}`;
      credFeedbackVariant = 'red';
      clearFeedbackAfter(v => credFeedback = v, 5000);
    } finally {
      credDeleting = null;
    }
  }

  async function testVenue(exchange: string) {
    venueTesting = exchange;
    venueTestFeedback = '';
    try {
      const res = await api.get<{ ok?: boolean; message?: string }>(
        `/api/exchanges/${encodeURIComponent(exchange)}/ping`
      );
      if (res?.ok) {
        venueTestFeedback = `✓ ${res.message ?? 'Reachable'}`;
        venueTestVariant = 'green';
      } else {
        venueTestFeedback = `✗ ${res?.message ?? 'Unreachable'}`;
        venueTestVariant = 'red';
      }
    } catch (err: any) {
      venueTestFeedback = `✗ ${err.message ?? 'Connection failed'}`;
      venueTestVariant = 'red';
    } finally {
      venueTesting = null;
      clearFeedbackAfter(v => venueTestFeedback = v, 5000);
    }
  }

  // ─── Notification Channels State ────────────────────────────────────
  // Operator-configured Discord webhooks stored in the spawner (encrypted at
  // rest, never read back — mirrors the credential store above). Submit-only:
  // the browser sends the URL and forgets it.
  //
  // The selectable event kinds (NOTIFY_EVENT_KINDS) are the spawner's real wire
  // contract, sourced from $lib/types/notifications (the single source of truth
  // shared with the adapter's POST validation). Empty selection = catch-all
  // ("send everything"). `bot_crashed` is always-delivered — it bypasses the
  // filter, so it renders checked+disabled and is force-included on save.
  // null = notification store unreachable (distinct from "no channels yet").
  let channelList = $state<NotificationChannel[] | null>(null);
  let channelDbEnabled = $state(true);
  // Add/update form
  let channelName = $state('');
  let channelUrl = $state('');
  let channelCatchAll = $state(true); // true = subscribe to all events
  let channelEvents = $state<Set<string>>(new Set());
  let channelSaving = $state(false);
  let channelPendingDelete = $state<string | null>(null);
  let channelDeleting = $state<string | null>(null);
  let channelTesting = $state<string | null>(null); // one in-flight test at a time
  let channelFeedback = $state('');
  let channelFeedbackVariant = $state<'green' | 'red' | 'default'>('default');

  // ─── Notification delivery history (Phase E) ────────────────────────
  // The read side of the notifier: one row per webhook send ATTEMPT (real
  // fires + test probes) from the spawner's `notification_log` ledger, so the
  // operator can answer "did the 3am crash page actually send?". The adapter
  // already coerces the response; we re-run the SAME pure coercer as a poll
  // transform for belt-and-suspenders (a bad payload never reaches the panel).
  // 30s cadence via the shared poll engine — never a hand-rolled setInterval.
  // `/settings` scrolls at the pane level, so this panel stays rigid and caps
  // the list at 50 rather than adding a nested scroller.
  const history = createPoll<NotificationHistory>(
    '/api/settings/notifications/history?limit=50',
    30_000,
    { transform: coerceNotificationHistory },
  );
  const historyLoading = history.loading;
  const historyError = history.error;
  $effect(() => {
    history.start();
    return () => history.stop();
  });

  // ─── API: Notification Channels ────────────────────────────────────

  async function loadNotifications() {
    try {
      const res = await api.get<{ db_enabled?: boolean; channels?: NotificationChannel[] }>(
        '/api/settings/notifications'
      );
      channelList = Array.isArray(res?.channels) ? res.channels : [];
      channelDbEnabled = res?.db_enabled !== false;
    } catch {
      channelList = null;
    }
  }

  function toggleChannelEvent(id: string) {
    const next = new Set(channelEvents);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    channelEvents = next;
  }

  async function saveNotification() {
    const name = channelName.trim();
    // Same rule the adapter enforces — surfaced with an actionable message.
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name)) {
      channelFeedback = 'Invalid name — letters, digits, space . _ - (max 64 chars)';
      channelFeedbackVariant = 'red';
      clearFeedbackAfter(v => channelFeedback = v, 6000);
      return;
    }
    const url = channelUrl.trim();
    if (!/^https?:\/\//.test(url)) {
      channelFeedback = 'Webhook URL must start with https:// (or http://)';
      channelFeedbackVariant = 'red';
      clearFeedbackAfter(v => channelFeedback = v, 6000);
      return;
    }
    // Catch-all ⇒ empty events list. Otherwise the selected subset PLUS the
    // always-delivered kinds (bot_crashed): they bypass the filter anyway, and
    // recording them keeps the stored scope honest — a channel scoped to only
    // "Bot crashed" stores exactly ["bot_crashed"].
    const events = channelCatchAll
      ? []
      : Array.from(new Set([...channelEvents, ...ALWAYS_DELIVERED_EVENT_IDS]));
    channelSaving = true;
    channelFeedback = '';
    try {
      await api.post('/api/settings/notifications', {
        name,
        kind: 'discord_webhook',
        url,
        events,
      });
      channelFeedback = `${name} saved ✓`;
      channelFeedbackVariant = 'green';
      // Browser submits then forgets: clear inputs and refresh the list.
      channelName = '';
      channelUrl = '';
      channelCatchAll = true;
      channelEvents = new Set();
      loadNotifications();
      clearFeedbackAfter(v => channelFeedback = v);
    } catch (err: any) {
      channelFeedback = `Error: ${err.message ?? 'Failed to save'}`;
      channelFeedbackVariant = 'red';
      clearFeedbackAfter(v => channelFeedback = v, 5000);
    } finally {
      channelSaving = false;
    }
  }

  // Prefill the name to overwrite an existing channel (upsert semantics). The
  // URL is never returned, so it must be re-entered on update.
  function startChannelUpdate(ch: NotificationChannel) {
    channelName = ch.name;
    channelUrl = '';
    channelCatchAll = ch.events.length === 0;
    // Seed only the operator-selectable kinds: drop always-delivered ids (their
    // checkbox is disabled and re-added on save) and any legacy/unknown ids
    // (they have no checkbox — the operator re-ticks the real kinds), so a
    // re-save can't resubmit a dead id the adapter would 400.
    channelEvents = new Set(
      ch.events.filter((e) => isKnownEventKind(e) && !ALWAYS_DELIVERED_EVENT_IDS.includes(e)),
    );
  }

  // Two-step inline confirm: first click arms (auto-disarms after 4s),
  // second click deletes. No browser dialogs.
  async function deleteNotification(name: string) {
    if (channelPendingDelete !== name) {
      channelPendingDelete = name;
      setTimeout(() => {
        if (channelPendingDelete === name) channelPendingDelete = null;
      }, 4000);
      return;
    }
    channelPendingDelete = null;
    channelDeleting = name;
    try {
      await api.delete(`/api/settings/notifications/${encodeURIComponent(name)}`);
      channelFeedback = `${name} deleted`;
      channelFeedbackVariant = 'green';
      loadNotifications();
      clearFeedbackAfter(v => channelFeedback = v);
    } catch (err: any) {
      channelFeedback = `Error: ${err.message ?? 'Failed to delete'}`;
      channelFeedbackVariant = 'red';
      clearFeedbackAfter(v => channelFeedback = v, 5000);
    } finally {
      channelDeleting = null;
    }
  }

  // Fire a synthetic event at the channel's stored webhook so the operator can
  // confirm delivery. The URL never returns to the browser — the spawner sends
  // and reports only the outcome. One in-flight at a time (mirrors testVenue).
  async function testChannel(name: string) {
    if (channelTesting !== null) return;
    channelTesting = name;
    channelFeedback = '';
    try {
      const res = await api.post<{ ok?: boolean; message?: string }>(
        `/api/settings/notifications/${encodeURIComponent(name)}/test`,
        {}
      );
      if (res?.ok) {
        channelFeedback = `✓ ${res.message ?? 'Test message sent'}`;
        channelFeedbackVariant = 'green';
      } else {
        channelFeedback = `✗ ${res?.message ?? 'Test send failed'}`;
        channelFeedbackVariant = 'red';
      }
    } catch (err: any) {
      channelFeedback = `✗ ${err.message ?? 'Test failed'}`;
      channelFeedbackVariant = 'red';
    } finally {
      channelTesting = null;
      clearFeedbackAfter(v => channelFeedback = v, 5000);
    }
  }

  // ─── API: Risk Controls ────────────────────────────────────────────

  async function loadRisk() {
    riskLoading = true;
    try {
      const c = await api.get<{ max_daily_loss_usd?: number; max_positions?: number; max_gross_exposure_usd?: number }>(
        '/api/settings/risk'
      );
      if (c?.max_daily_loss_usd != null) riskDailyLoss = c.max_daily_loss_usd;
      if (c?.max_positions != null) riskMaxPositions = c.max_positions;
      if (c?.max_gross_exposure_usd != null) riskGrossExposure = c.max_gross_exposure_usd;
    } catch {
      // keep defaults if the risk service isn't reachable
    } finally {
      riskLoading = false;
    }
  }

  async function saveRisk() {
    riskSaving = true;
    riskFeedback = '';
    try {
      await api.post('/api/settings/risk', {
        max_daily_loss_usd: riskDailyLoss,
        max_positions: riskMaxPositions,
        max_gross_exposure_usd: riskGrossExposure,
      });
      riskFeedback = 'Saved ✓';
      clearFeedbackAfter(v => riskFeedback = v);
    } catch (err: any) {
      riskFeedback = `Error: ${err.message ?? 'Failed to save'}`;
      clearFeedbackAfter(v => riskFeedback = v, 5000);
    } finally {
      riskSaving = false;
    }
  }

  // ─── API: Janus Config ────────────────────────────────────────────

  async function loadJanusConfig() {
    janusLoading = true;
    try {
      const res = await api.get<JanusConfigResponse>('/api/janus/config');
      janusConfig = res.config;
      janusConfigSource = res.source;
      janusRedisAvailable = res.redis_available;
      if (res.valid_intervals?.length) janusValidIntervals = res.valid_intervals;
      janusRequiresRestart = res.requires_restart ?? [];
    } catch {
      // Keep defaults
    } finally {
      janusLoading = false;
    }
  }

  async function saveJanusConfig() {
    janusSaving = true;
    janusFeedback = '';
    try {
      await api.put('/api/janus/config', {
        optimize_assets: janusConfig.optimize_assets,
        optimize_interval: janusConfig.optimize_interval,
        optimize_trials: janusConfig.optimize_trials,
        optimize_historical_days: janusConfig.optimize_historical_days,
        data_kline_intervals: janusConfig.data_kline_intervals,
        janus_auto_start: janusConfig.janus_auto_start,
        janus_bootstrap_days: janusConfig.janus_bootstrap_days,
      });
      janusFeedback = 'Saved ✓';
      janusFeedbackVariant = 'green';
      janusConfigSource = 'redis';
      clearFeedbackAfter(v => janusFeedback = v);
    } catch (err: any) {
      janusFeedback = `Error: ${err.message ?? 'Failed to save'}`;
      janusFeedbackVariant = 'red';
      clearFeedbackAfter(v => janusFeedback = v, 5000);
    } finally {
      janusSaving = false;
    }
  }

  async function pushBootstrapToJanus() {
    janusPushing = true;
    janusPushFeedback = '';
    janusPushVariant = 'default';
    try {
      const res = await api.post<BootstrapPushResponse>(
        `/api/janus/memories/bootstrap/push?days=${janusConfig.janus_bootstrap_days}&limit=500`,
        {}
      );
      janusPushFeedback = res.message ?? `Pushed ${res.pushed} memories ✓`;
      janusPushVariant = res.ok ? 'green' : 'red';
      clearFeedbackAfter(v => janusPushFeedback = v, 8000);
    } catch (err: any) {
      janusPushFeedback = `Error: ${err.message ?? 'Push failed'}`;
      janusPushVariant = 'red';
      clearFeedbackAfter(v => janusPushFeedback = v, 5000);
    } finally {
      janusPushing = false;
    }
  }

  // ─── API: System Health ────────────────────────────────────────────

  async function fetchHealth() {
    try {
      healthData = await api.get<HealthResponse>('/api/health');
    } catch {
      healthData = { status: 'error', components: {} };
    } finally {
      healthLoading = false;
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  onMount(() => {
    fetchHealth();
    loadJanusConfig();
    loadRisk();
    loadCredentials();
    loadNotifications();
    healthTimer = setInterval(fetchHealth, 15_000);
  });

  onDestroy(() => {
    if (healthTimer) clearInterval(healthTimer);
  });
</script>

<svelte:head>
  <title>Settings — FKS Terminal</title>
</svelte:head>

<!-- Janus reports which config fields are boot-time only (requires_restart);
     mark those inputs so a save isn't mistaken for a live reconfigure. -->
{#snippet restartHint(field: string)}
  {#if janusRequiresRestart.includes(field)}
    <span class="restart-hint" title="Janus reads this at boot — the saved value takes effect after a janus restart">↻ after restart</span>
  {/if}
{/snippet}

<div class="page">
  <!-- ════════════════════════════════════════════════════════════════════
       LEFT PANE
       ════════════════════════════════════════════════════════════════════ -->
  <div class="pane pane-left">

    {#if !canAdmin}
      <div class="role-banner" role="status">
        Read-only ({role}) — saving keys, notifications, risk limits and janus
        config is admin-only. You can view current status but not change it.
      </div>
    {/if}

    <!-- ── Panel: API Connections ─────────────────────────────────── -->
    <!-- Dynamic credential list backed by the spawner secret store. Starts
         blank; known providers are picked from the dropdown (per-provider
         labels/hints), and Other… accepts any slug so nothing is lost.
         Submit-only: secrets are never read back to the browser. -->
    <Panel title="API Connections">
      {#if credList !== null && !credDbEnabled}
        <div class="status-display key-status">
          <span class="status-dot dot-amber"></span>
          <span class="mono">Secret storage (spawner DB) is not configured — saves will fail</span>
        </div>
      {/if}

      <!-- Stored credentials -->
      {#if credList === null}
        <div class="status-display key-status">
          <span class="status-dot dot-amber"></span>
          <span class="mono">Secret store unreachable</span>
        </div>
      {:else if credList.length === 0}
        <div class="cred-empty mono">No API credentials stored — using public/keyless data. Add one below.</div>
      {:else}
        {#each credList as cred (cred.exchange)}
          {@const prov = PROVIDER_BY_ID.get(cred.exchange)}
          <div class="cred-row">
            <span class="status-dot dot-green"></span>
            <span class="cred-name">{cred.exchange}</span>
            {#if prov}
              <!-- Known-provider kind badge; unknown ids render as before. -->
              <Badge variant={prov.kind === 'broker' ? 'purple' : 'cyan'}>{prov.kind}</Badge>
            {/if}
            {#if cred.updated_at}
              <span class="cred-updated">updated {cred.updated_at}</span>
            {/if}
            <span class="cred-actions">
              {#if TESTABLE_VENUES.has(cred.exchange)}
                <button
                  class="btn-ghost"
                  onclick={() => testVenue(cred.exchange)}
                  disabled={venueTesting !== null}
                >
                  {venueTesting === cred.exchange ? '⏳ Testing…' : '🔌 Test'}
                </button>
              {/if}
              <button class="btn-ghost" onclick={() => startUpdate(cred.exchange)}>Update</button>
              <button
                class="btn-ghost btn-delete"
                class:armed={credPendingDelete === cred.exchange}
                onclick={() => deleteCredential(cred.exchange)}
                disabled={credDeleting === cred.exchange}
              >
                {credDeleting === cred.exchange
                  ? 'Deleting…'
                  : credPendingDelete === cred.exchange
                    ? 'Confirm delete?'
                    : 'Delete'}
              </button>
            </span>
          </div>
        {/each}
        {#if venueTestFeedback}
          <span class="feedback" class:feedback-ok={venueTestVariant === 'green'} class:feedback-err={venueTestVariant === 'red'}>
            {venueTestFeedback}
          </span>
        {/if}
      {/if}

      <!-- Add / update credential -->
      <div class="connection-block">
        <div class="connection-title">Add / update credential</div>
        <div class="form-group">
          <label class="form-label" for="cred-provider">Provider</label>
          <select
            id="cred-provider"
            class="form-select"
            bind:value={credProviderId}
            onchange={onProviderChange}
          >
            {#each PROVIDERS as p (p.id)}
              <option value={p.id}>{p.label}</option>
            {/each}
            <option value={OTHER}>Other…</option>
          </select>
          <span class="form-hint">
            {credProvider?.purpose ??
              'Any other venue — generic key/secret (+ optional passphrase), stored under the slug below.'}
          </span>
        </div>
        {#if !credProvider}
          <div class="form-group">
            <label class="form-label" for="cred-exchange">Venue id (slug)</label>
            <input
              id="cred-exchange"
              class="form-input"
              type="text"
              placeholder="e.g. bybit, okx, deribit…"
              bind:value={credExchange}
              autocomplete="off"
              spellcheck="false"
            />
            <span class="form-hint">Lowercase letters, digits, - and _ (e.g. cryptocom, not crypto.com)</span>
          </div>
        {/if}
        <div class="form-group">
          <label class="form-label" for="cred-api-key">{credProvider?.keyLabel ?? 'API Key'}</label>
          <input
            id="cred-api-key"
            class="form-input"
            type="password"
            placeholder={credProvider?.keyPlaceholder ?? 'Enter API key…'}
            bind:value={credKey}
            autocomplete="off"
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="cred-api-secret">{credProvider?.secretLabel ?? 'API Secret'}</label>
          <input
            id="cred-api-secret"
            class="form-input"
            type="password"
            placeholder={credProvider?.secretPlaceholder ?? 'Enter API secret…'}
            bind:value={credSecret}
            autocomplete="off"
          />
        </div>
        <!-- Third encrypted slot (api_passphrase): shown only for providers
             that use it (kucoin, kucoin-futures) or re-label it (rithmic
             System), and always in Other… mode to keep the generality. -->
        {#if credProvider?.third || !credProvider}
          <div class="form-group">
            <label class="form-label" for="cred-api-passphrase">
              {credProvider?.third
                ? credProvider.third.label + (credProvider.third.required ? '' : ' (optional)')
                : 'API Passphrase (optional — only if the venue uses one)'}
            </label>
            <input
              id="cred-api-passphrase"
              class="form-input"
              type="password"
              placeholder={credProvider?.third?.placeholder ?? 'Only if the venue requires one…'}
              bind:value={credPassphrase}
              autocomplete="off"
            />
            {#if credProvider?.third?.hint}
              <span class="form-hint">{credProvider.third.hint}</span>
            {/if}
          </div>
        {/if}
        <div class="form-actions">
          <button
            class="btn-primary"
            onclick={saveCredential}
            disabled={credSaving ||
              !canAdmin ||
              (!credProvider && !credExchange.trim()) ||
              !credKey ||
              !credSecret ||
              (credProvider?.third?.required === true && !credPassphrase)}
          >
            {credSaving ? 'Saving…' : 'Save Credentials'}
          </button>
          {#if credFeedback}
            <span class="feedback" class:feedback-ok={credFeedbackVariant === 'green'} class:feedback-err={credFeedbackVariant === 'red'}>
              {credFeedback}
            </span>
          {/if}
        </div>
        <div class="cred-hint">
          Credentials are submit-only: stored encrypted server-side, never displayed again.
          Saving a provider that already has credentials overwrites them.
        </div>
      </div>
    </Panel>

    <!-- ── Panel: Notifications ───────────────────────────────────── -->
    <!-- Operator-configured Discord webhooks stored in the spawner (encrypted
         at rest, never read back). Submit-only, like the credential form. Each
         row has a Test button that POSTs to the spawner's test route (fks #181),
         which decrypts the stored webhook, sends a synthetic event, and reports
         only the outcome — the URL never returns to the browser. -->
    <Panel title="Notifications">
      {#if channelList !== null && !channelDbEnabled}
        <div class="status-display key-status">
          <span class="status-dot dot-amber"></span>
          <span class="mono">Notification storage (spawner DB) is not configured — saves will fail</span>
        </div>
      {/if}

      <!-- Stored channels -->
      {#if channelList === null}
        <div class="status-display key-status">
          <span class="status-dot dot-amber"></span>
          <span class="mono">Notification store unreachable</span>
        </div>
      {:else if channelList.length === 0}
        <div class="cred-empty mono">No notification channels — add a Discord webhook below.</div>
      {:else}
        {#each channelList as ch (ch.name)}
          <div class="cred-row">
            <span class="status-dot dot-green"></span>
            <span class="cred-name">{ch.name}</span>
            <Badge variant="cyan">{ch.kind === 'discord_webhook' ? 'discord' : ch.kind}</Badge>
            <span class="channel-events mono">
              {#if ch.events.length === 0}
                all events
              {:else}
                {#each ch.events as ev (ev)}
                  {#if isKnownEventKind(ev)}
                    <span class="ev-known">{ev}</span>
                  {:else}
                    <!-- Legacy/typo id (e.g. spawn, stop, pnl_digest): matches
                         no spawner wire kind, so it silently drops everything.
                         Repair: click Update, re-tick, re-enter the URL, save. -->
                    <Badge variant="amber">{ev} — will never match</Badge>
                  {/if}
                {/each}
              {/if}
            </span>
            {#if ch.updated_at}
              <span class="cred-updated">updated {ch.updated_at}</span>
            {/if}
            <span class="cred-actions">
              <button
                class="btn-ghost"
                onclick={() => testChannel(ch.name)}
                disabled={channelTesting !== null}
              >
                {channelTesting === ch.name ? '⏳ Testing…' : '🔔 Test'}
              </button>
              <button class="btn-ghost" onclick={() => startChannelUpdate(ch)}>Update</button>
              <button
                class="btn-ghost btn-delete"
                class:armed={channelPendingDelete === ch.name}
                onclick={() => deleteNotification(ch.name)}
                disabled={channelDeleting === ch.name}
              >
                {channelDeleting === ch.name
                  ? 'Deleting…'
                  : channelPendingDelete === ch.name
                    ? 'Confirm delete?'
                    : 'Delete'}
              </button>
            </span>
          </div>
        {/each}
      {/if}

      <!-- Add / update channel -->
      <div class="connection-block">
        <div class="connection-title">Add Discord webhook</div>
        <div class="form-group">
          <label class="form-label" for="channel-name">Channel name</label>
          <input
            id="channel-name"
            class="form-input"
            type="text"
            placeholder="e.g. ops-alerts"
            bind:value={channelName}
            autocomplete="off"
            spellcheck="false"
          />
          <span class="form-hint">Letters, digits, space . _ - (max 64 chars). Re-using a name overwrites it.</span>
        </div>
        <div class="form-group">
          <label class="form-label" for="channel-url">Webhook URL</label>
          <input
            id="channel-url"
            class="form-input"
            type="password"
            placeholder="https://discord.com/api/webhooks/…"
            bind:value={channelUrl}
            autocomplete="off"
          />
          <span class="form-hint">Stored encrypted server-side, never displayed again.</span>
        </div>
        <div class="form-group">
          <label class="check-row">
            <input type="checkbox" bind:checked={channelCatchAll} />
            <span>Send all events (catch-all)</span>
          </label>
          {#if !channelCatchAll}
            <div class="event-grid">
              {#each NOTIFY_EVENT_KINDS as ev (ev.id)}
                <label class="check-row" class:always-on={ev.alwaysDelivered}>
                  <input
                    type="checkbox"
                    checked={ev.alwaysDelivered || channelEvents.has(ev.id)}
                    disabled={ev.alwaysDelivered}
                    onchange={() => toggleChannelEvent(ev.id)}
                  />
                  <span>
                    {ev.label}
                    {#if ev.alwaysDelivered}<span class="always-hint">always delivered</span>{/if}
                  </span>
                </label>
              {/each}
            </div>
            <span class="form-hint">
              Always-sent events (crash, restart, live-flip, risk halt) bypass
              the filter and stay checked. Tick any additional events to include,
              or re-enable catch-all above.
            </span>
          {/if}
        </div>
        <div class="form-actions">
          <button
            class="btn-primary"
            onclick={saveNotification}
            disabled={channelSaving ||
              !canAdmin ||
              !channelName.trim() ||
              !channelUrl.trim() ||
              (!channelCatchAll && channelEvents.size === 0)}
          >
            {channelSaving ? 'Saving…' : 'Save Channel'}
          </button>
          {#if channelFeedback}
            <span class="feedback" class:feedback-ok={channelFeedbackVariant === 'green'} class:feedback-err={channelFeedbackVariant === 'red'}>
              {channelFeedback}
            </span>
          {/if}
        </div>
        <div class="cred-hint">
          Submit-only: the webhook URL is stored encrypted server-side and never
          returned. The spawner delivers the events above to their scoped
          channels live; a channel scoped to ids it doesn't emit receives
          nothing (except the always-delivered pages: crash, restart, live-flip,
          risk halt).
        </div>
      </div>
    </Panel>

    <!-- ── Panel: Notification history ────────────────────────────── -->
    <!-- Read side of the notifier: the spawner's delivery ledger
         (notification_log, fks 013), one row per webhook send ATTEMPT. Answers
         "did the crash page actually send at 3am?" without docker logs. HONEST
         STATES: skeleton while loading, an amber line when the ledger DB/table
         is absent (NOT a fake-empty list), and a real empty state otherwise.
         Rigid panel — the pane scrolls; the list caps at 50 (no nested
         overflow). -->
    <Panel title="Notification history">
      {#if $history === null}
        {#if $historyError}
          <div class="status-display key-status">
            <span class="status-dot dot-amber"></span>
            <span class="mono">Notification history unreachable</span>
          </div>
        {:else}
          <div class="notif-log" aria-busy="true">
            <Skeleton lines={4} height="20px" />
          </div>
        {/if}
      {:else if !$history.db_enabled}
        <!-- The ledger DB is off or the 013 migration was never applied. Say so
             explicitly — an empty list here would lie ("nothing sent") when the
             truth is "we can't see whether anything sent". -->
        <div class="status-display key-status">
          <span class="status-dot dot-amber"></span>
          <span class="mono"
            >History unavailable — spawner DB off or notification_log table missing (013 not
            applied)</span
          >
        </div>
      {:else if $history.entries.length === 0}
        <EmptyState
          icon="🔔"
          title="No notifications recorded yet"
          hint="Sends show up here as bots spawn, stop, or crash and your channels fire."
        />
      {:else}
        <div class="notif-log">
          {#each $history.entries as row, i (`${row.ts}|${row.channel_name}|${row.event}|${i}`)}
            <div class="notif-row">
              <span class="notif-time" title={fmtDateTime(row.ts)}>{fmtRelative(row.ts)}</span>
              <Badge variant={kindBadgeVariant(row.event)}>{row.event || '—'}</Badge>
              <span class="notif-bot mono" title={row.bot_id}>{row.bot_id || '—'}</span>
              <span class="notif-chan" title={row.channel_name}>{row.channel_name || '—'}</span>
              <span class="notif-outcome" title={row.outcome}>
                <span
                  class="status-dot {outcomeIsOk(row.outcome) ? 'dot-green' : 'dot-red'}"
                ></span>
                <span class="mono"
                  >{row.outcome || '—'}{row.status_code != null ? ` ${row.status_code}` : ''}</span
                >
              </span>
              {#if row.detail}
                <span class="notif-detail" title={row.detail}>{row.detail}</span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
      <div class="cred-hint">
        One row per webhook send attempt (real events + test probes), newest first — last 50,
        refreshed every 30s. The detail snippet is URL-free: the ledger never stores the webhook
        address.
      </div>
    </Panel>

    <!-- ── Panel 3: Risk Controls ─────────────────────────────────── -->
    <Panel title="Risk Controls">
      <div class="form-row">
        <div class="form-group form-grow">
          <label class="form-label" for="risk-daily-loss">Max Daily Loss ($)</label>
          <input
            id="risk-daily-loss"
            class="form-input"
            type="number"
            min="0"
            step="100"
            bind:value={riskDailyLoss}
          />
        </div>
        <div class="form-group form-grow">
          <label class="form-label" for="risk-max-positions">Max Positions</label>
          <input
            id="risk-max-positions"
            class="form-input"
            type="number"
            min="1"
            step="1"
            bind:value={riskMaxPositions}
          />
        </div>
        <div class="form-group form-grow">
          <label class="form-label" for="risk-gross-exposure">Max Gross Exposure ($)</label>
          <input
            id="risk-gross-exposure"
            class="form-input"
            type="number"
            min="0"
            step="1000"
            bind:value={riskGrossExposure}
          />
        </div>
      </div>
      <div class="form-actions">
        <button class="btn-primary" onclick={saveRisk} disabled={riskSaving || riskLoading || !canAdmin}>
          {riskSaving ? 'Saving…' : riskLoading ? 'Loading…' : 'Save'}
        </button>
        {#if riskFeedback}
          <span class="feedback" class:feedback-ok={riskFeedback.startsWith('Saved')} class:feedback-err={riskFeedback.startsWith('Error')}>
            {riskFeedback}
          </span>
        {/if}
      </div>
    </Panel>
  </div>

  <!-- ════════════════════════════════════════════════════════════════════
       RIGHT PANE
       ════════════════════════════════════════════════════════════════════ -->
  <div class="pane pane-right">

    <!-- ── Panel: System Info ─────────────────────────────────────── -->
    <Panel title="System Info" badge="15s">
      {#if healthLoading && !healthData}
        <Skeleton lines={4} height="14px" />
      {:else if healthData}
        <div class="sys-overview">
          <div class="sys-row">
            <span class="sys-key">Overall Status</span>
            <Badge variant={overallVariant(healthData.status)}>
              {healthData.status.toUpperCase()}
            </Badge>
          </div>
          {#if healthData.version}
            <div class="sys-row">
              <span class="sys-key">Version</span>
              <span class="sys-val mono">{healthData.version}</span>
            </div>
          {/if}
          {#if healthData.uptime}
            <div class="sys-row">
              <span class="sys-key">Uptime</span>
              <span class="sys-val mono">{healthData.uptime}</span>
            </div>
          {/if}
        </div>

        {#if healthData.components && Object.keys(healthData.components).length > 0}
          <div class="component-grid">
            {#each Object.entries(healthData.components) as [name, comp]}
              <div class="component-card">
                <span class="status-dot" class:dot-green={componentVariant(comp.status) === 'green'} class:dot-red={componentVariant(comp.status) === 'red'} class:dot-amber={componentVariant(comp.status) === 'amber'}></span>
                <div class="component-info">
                  <span class="component-name">{name}</span>
                  <span class="component-status">{comp.status}</span>
                  {#if comp.latency}
                    <span class="component-latency">{comp.latency}</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {:else}
        <div class="empty-state">Unable to fetch system health</div>
      {/if}
    </Panel>

    <!-- ── Panel 3: Observability Links ───────────────────────────── -->
    <Panel title="Observability">
      <div class="obs-grid">
        {#each obsLinks as link}
          <a class="obs-link" href={link.url} target="_blank" rel="noopener noreferrer">
            <span class="obs-icon">{link.icon}</span>
            <span class="obs-label">{link.label}</span>
            <span class="obs-url">{link.url.replace('http://localhost', ':')}</span>
          </a>
        {/each}
      </div>
    </Panel>

    <!-- ── Panel 4: Janus Optimizer Config ──────────────────────────── -->
    <Panel title="Janus Optimizer">
      {#snippet header()}
        {#if !janusLoading}
          <span class="header-badge" title="Config source">{janusConfigSource === 'redis' ? '⬤ Redis' : '○ Env'}</span>
          {#if !janusRedisAvailable}
            <span class="header-badge" style="color: var(--red)">Redis unavailable</span>
          {/if}
        {/if}
      {/snippet}
      {#if janusLoading}
        <Skeleton lines={5} height="14px" />
      {:else}
        <!-- Optimize Assets -->
        <div class="form-group">
          <label class="form-label" for="janus-assets">Optimize Assets{@render restartHint('optimize_assets')}</label>
          <input
            id="janus-assets"
            class="form-input"
            type="text"
            placeholder="BTC,ETH,SOL"
            bind:value={janusConfig.optimize_assets}
            spellcheck="false"
          />
          <span class="form-hint">Comma-separated symbols for the optimizer to watch</span>
        </div>

        <div class="form-row">
          <!-- Interval -->
          <div class="form-group form-grow">
            <label class="form-label" for="janus-interval">Optimize Interval{@render restartHint('optimize_interval')}</label>
            <select id="janus-interval" class="form-select" bind:value={janusConfig.optimize_interval}>
              {#each janusValidIntervals as iv}
                <option value={iv}>{iv}</option>
              {/each}
            </select>
          </div>

          <!-- Trials -->
          <div class="form-group form-grow">
            <label class="form-label" for="janus-trials">Trials{@render restartHint('optimize_trials')}</label>
            <input
              id="janus-trials"
              class="form-input"
              type="number"
              min="1"
              max="1000"
              step="10"
              bind:value={janusConfig.optimize_trials}
            />
          </div>

          <!-- Historical Days -->
          <div class="form-group form-grow">
            <label class="form-label" for="janus-hist-days">Historical Days{@render restartHint('optimize_historical_days')}</label>
            <input
              id="janus-hist-days"
              class="form-input"
              type="number"
              min="1"
              max="365"
              step="1"
              bind:value={janusConfig.optimize_historical_days}
            />
          </div>
        </div>

        <!-- Kline Intervals -->
        <div class="form-group">
          <label class="form-label" for="janus-kline">Kline Intervals{@render restartHint('data_kline_intervals')}</label>
          <input
            id="janus-kline"
            class="form-input"
            type="text"
            placeholder="1m,5m,15m"
            bind:value={janusConfig.data_kline_intervals}
            spellcheck="false"
          />
        </div>

        <div class="form-row">
          <!-- Bootstrap Days -->
          <div class="form-group form-grow">
            <label class="form-label" for="janus-boot-days">Bootstrap History (days){@render restartHint('janus_bootstrap_days')}</label>
            <input
              id="janus-boot-days"
              class="form-input"
              type="number"
              min="1"
              max="365"
              step="1"
              bind:value={janusConfig.janus_bootstrap_days}
            />
          </div>

          <!-- Auto-start -->
          <div class="form-group form-grow">
            <span class="form-label">Auto-start on Boot{@render restartHint('janus_auto_start')}</span>
            <label class="toggle-label">
              <input
                type="checkbox"
                class="toggle-input"
                bind:checked={janusConfig.janus_auto_start}
              />
              <span class="toggle-track">
                <span class="toggle-thumb"></span>
              </span>
              <span class="toggle-text">{janusConfig.janus_auto_start ? 'Enabled' : 'Disabled'}</span>
            </label>
          </div>
        </div>

        <!-- Actions -->
        <div class="form-actions">
          <button
            class="btn-primary"
            onclick={saveJanusConfig}
            disabled={janusSaving || !janusRedisAvailable || !canAdmin}
            title={janusRedisAvailable ? 'Save config to Redis' : 'Redis unavailable'}
          >
            {janusSaving ? 'Saving…' : 'Save Config'}
          </button>
          {#if janusFeedback}
            <span class="feedback" class:feedback-ok={janusFeedbackVariant === 'green'} class:feedback-err={janusFeedbackVariant === 'red'}>
              {janusFeedback}
            </span>
          {/if}
        </div>

        <div class="divider"></div>

        <!-- Memory Bootstrap -->
        <div class="janus-bootstrap">
          <div class="bootstrap-desc">
            Push the last <strong>{janusConfig.janus_bootstrap_days} days</strong> of
            <code>janus_memories</code> to the Janus affinity tracker.
            Use this after a fresh deployment to warm-start the brain without retraining.
          </div>
          <div class="form-actions">
            <button
              class="btn-ghost"
              onclick={pushBootstrapToJanus}
              disabled={janusPushing}
            >
              {janusPushing ? '⏳ Pushing…' : '🧠 Push Memories to Janus'}
            </button>
            {#if janusPushFeedback}
              <span class="feedback" class:feedback-ok={janusPushVariant === 'green'} class:feedback-err={janusPushVariant === 'red'}>
                {janusPushFeedback}
              </span>
            {/if}
          </div>
        </div>
      {/if}
    </Panel>
  </div>
</div>

<style>
  /* ═══════════════════════════════════════════════════════════════════
     Page Layout
     ═══════════════════════════════════════════════════════════════════ */
  .page {
    display: flex;
    height: 100%;
    overflow: hidden;
  }

  .role-banner {
    font-size: 12px;
    color: var(--amber, #e0a000);
    border: 1px solid var(--amber, #e0a000);
    border-radius: 4px;
    padding: 6px 10px;
    line-height: 1.4;
  }

  .pane {
    overflow: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .pane-left  { flex: 5; }
  .pane-right { flex: 5; }

  /* Narrow viewports: stack the two settings columns; the page owns the
     single scroll (both panes are forms with no `fill` panel, so they grow
     naturally). */
  @media (max-width: 900px) {
    .page {
      flex-direction: column;
      overflow-y: auto;
    }
    .pane {
      overflow: visible;
      flex: none;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     Header Badges (inside Panel header snippet)
     ═══════════════════════════════════════════════════════════════════ */
  .header-badge {
    font-size: 8px;
    color: var(--t3);
    background: var(--bg3);
    padding: 1px 5px;
    border-radius: var(--r);
  }

  /* ═══════════════════════════════════════════════════════════════════
     Status Indicators
     ═══════════════════════════════════════════════════════════════════ */
  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
    background: var(--t3);
  }

  .dot-green  { background: var(--green);  box-shadow: 0 0 4px var(--green); }
  .dot-red    { background: var(--red);    box-shadow: 0 0 4px var(--red); }
  .dot-amber  { background: var(--amber);  box-shadow: 0 0 4px var(--amber); }

  .status-display {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--t1);
  }

  .key-status {
    margin-bottom: 8px;
    font-size: 11px;
  }

  /* ═══════════════════════════════════════════════════════════════════
     Form Elements
     ═══════════════════════════════════════════════════════════════════ */
  .form-group {
    margin-bottom: 8px;
  }

  .form-grow {
    flex: 1;
    min-width: 0;
  }

  .form-label {
    display: block;
    font-size: 10px;
    color: var(--t2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .form-input,
  .form-select {
    width: 100%;
    padding: 6px 8px;
    background: var(--bg2);
    border: 1px solid var(--b1);
    border-radius: var(--r);
    color: var(--t1);
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    outline: none;
    transition: border-color 0.15s;
    box-sizing: border-box;
  }

  .form-input:focus,
  .form-select:focus {
    border-color: var(--accent, var(--cyan));
  }

  .form-input::placeholder {
    color: var(--t3);
  }

  .form-select {
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    padding-right: 24px;
  }

  .form-select option {
    background: var(--bg2);
    color: var(--t1);
  }

  .form-row {
    display: flex;
    gap: 8px;
  }

  .form-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }

  /* ═══════════════════════════════════════════════════════════════════
     Buttons
     ═══════════════════════════════════════════════════════════════════ */
  .btn-primary {
    all: unset;
    padding: 5px 14px;
    font-size: 11px;
    font-weight: 600;
    color: var(--bg0);
    background: var(--accent, var(--cyan));
    border-radius: var(--r);
    cursor: pointer;
    transition: opacity 0.15s;
    white-space: nowrap;
  }

  .btn-primary:hover { opacity: 0.85; }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-ghost {
    all: unset;
    padding: 4px 10px;
    font-size: 11px;
    font-weight: 600;
    color: var(--t2);
    border: 1px solid var(--b1);
    border-radius: var(--r);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
    white-space: nowrap;
  }

  .btn-ghost:hover {
    color: var(--t1);
    border-color: var(--t2);
  }

  .btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ═══════════════════════════════════════════════════════════════════
     Feedback
     ═══════════════════════════════════════════════════════════════════ */
  .feedback {
    font-size: 11px;
    font-weight: 600;
    color: var(--t2);
  }

  .feedback-ok  { color: var(--green); }
  .feedback-err { color: var(--red); }

  /* ═══════════════════════════════════════════════════════════════════
     Connection Blocks
     ═══════════════════════════════════════════════════════════════════ */
  .connection-block {
    margin-bottom: 4px;
  }

  .connection-title {
    font-size: 11px;
    font-weight: 700;
    color: var(--t1);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--b1);
  }

  .divider {
    height: 1px;
    background: var(--b1);
    margin: 8px 0;
  }

  /* Dynamic credential list */
  .cred-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: var(--bg2);
    border: 1px solid var(--b1);
    border-radius: var(--r);
    margin-bottom: 4px;
  }

  .cred-name {
    font-size: 11px;
    font-weight: 700;
    color: var(--t1);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .cred-updated {
    font-size: 9px;
    color: var(--t3);
  }

  .cred-actions {
    margin-left: auto;
    display: flex;
    gap: 6px;
  }

  .cred-empty {
    padding: 10px 8px;
    font-size: 11px;
    color: var(--t3);
    text-align: center;
  }

  .cred-hint {
    font-size: 9px;
    color: var(--t3);
    margin-top: 6px;
    line-height: 1.5;
  }

  .channel-events {
    font-size: 9px;
    color: var(--t3);
    max-width: 55%;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 3px 5px;
    min-width: 0;
  }

  .ev-known {
    color: var(--t2);
  }

  /* ── Notification history rows ──────────────────────────────────────
     One compact row per send attempt. The pane is the scroller (`.page`
     document scroll); this list stays rigid and is capped at 50 rows, so
     there is deliberately NO overflow:auto here. */
  .notif-log {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-bottom: 6px;
  }

  .notif-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    background: var(--bg2);
    border: 1px solid var(--b1);
    border-radius: var(--r);
    font-size: 10px;
    min-width: 0;
  }

  .notif-time {
    color: var(--t3);
    white-space: nowrap;
    flex: 0 0 auto;
    min-width: 56px;
  }

  .notif-bot {
    color: var(--t2);
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 0 1 auto;
  }

  .notif-chan {
    color: var(--t2);
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 0 1 auto;
  }

  .notif-outcome {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--t3);
    white-space: nowrap;
    flex: 0 0 auto;
  }

  .notif-detail {
    color: var(--t3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
    min-width: 0;
    text-align: right;
  }

  /* Always-delivered event row: the disabled checkbox reads as "locked on". */
  .check-row.always-on {
    cursor: default;
    color: var(--t3);
  }
  .check-row.always-on input {
    cursor: not-allowed;
  }
  .always-hint {
    margin-left: 4px;
    font-size: 9px;
    color: var(--amber);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .check-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--t2);
    cursor: pointer;
  }

  .check-row input {
    accent-color: var(--cyan);
  }

  .event-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px 12px;
    margin: 6px 0 4px;
  }

  .btn-delete:hover:not(:disabled),
  .btn-delete.armed {
    color: var(--red);
  }

  /* ═══════════════════════════════════════════════════════════════════
     Form Hints
     ═══════════════════════════════════════════════════════════════════ */
  .form-hint {
    font-size: 9px;
    color: var(--t3);
    margin-top: 2px;
    display: block;
  }

  /* Boot-time config marker (janus requires_restart fields). */
  .restart-hint {
    margin-left: 6px;
    font-size: 9px;
    color: var(--amber);
    text-transform: none;
    letter-spacing: 0;
    cursor: help;
  }

  /* ═══════════════════════════════════════════════════════════════════
     Toggle Switch
     ═══════════════════════════════════════════════════════════════════ */
  .toggle-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    margin-top: 2px;
  }
  .toggle-input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .toggle-track {
    width: 32px;
    height: 18px;
    background: var(--bg3);
    border: 1px solid var(--b2);
    border-radius: 9px;
    position: relative;
    transition: background .2s, border-color .2s;
    flex-shrink: 0;
  }
  .toggle-input:checked ~ .toggle-track {
    background: var(--accent, #6366f1);
    border-color: var(--accent, #6366f1);
  }
  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    background: var(--t3);
    border-radius: 50%;
    transition: left .2s, background .2s;
  }
  .toggle-input:checked ~ .toggle-track .toggle-thumb {
    left: 16px;
    background: #fff;
  }
  .toggle-text {
    font-size: 11px;
    color: var(--t2);
  }

  /* ═══════════════════════════════════════════════════════════════════
     Janus Bootstrap Block
     ═══════════════════════════════════════════════════════════════════ */
  .janus-bootstrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .bootstrap-desc {
    font-size: 11px;
    color: var(--t2);
    line-height: 1.5;
  }
  .bootstrap-desc code {
    font-family: 'SF Mono', 'Fira Code', monospace;
    color: var(--cyan, #00e5ff);
    font-size: 10px;
  }
  .bootstrap-desc strong {
    color: var(--t1);
  }

  /* ═══════════════════════════════════════════════════════════════════
     System Info
     ═══════════════════════════════════════════════════════════════════ */
  .sys-overview {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 10px;
  }

  .sys-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .sys-key {
    font-size: 11px;
    color: var(--t2);
    font-weight: 600;
  }

  .sys-val {
    font-size: 11px;
    color: var(--t1);
  }

  .component-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 6px;
  }

  .component-card {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 10px;
    background: var(--bg2);
    border: 1px solid var(--b1);
    border-radius: var(--r);
  }

  .component-card .status-dot {
    margin-top: 3px;
  }

  .component-info {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .component-name {
    font-size: 11px;
    font-weight: 700;
    color: var(--t1);
    text-transform: capitalize;
  }

  .component-status {
    font-size: 10px;
    color: var(--t2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .component-latency {
    font-size: 9px;
    color: var(--t3);
    font-family: var(--font-mono, monospace);
  }

  /* ═══════════════════════════════════════════════════════════════════
     Observability Links
     ═══════════════════════════════════════════════════════════════════ */
  .obs-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }

  .obs-link {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: var(--bg2);
    border: 1px solid var(--b1);
    border-radius: var(--r);
    text-decoration: none;
    color: var(--t1);
    transition: border-color 0.15s, background 0.15s;
  }

  .obs-link:hover {
    border-color: var(--accent, var(--cyan));
    background: var(--bg3);
  }

  .obs-icon {
    font-size: 18px;
    flex-shrink: 0;
  }

  .obs-label {
    font-size: 12px;
    font-weight: 700;
    color: var(--t1);
  }

  .obs-url {
    font-size: 9px;
    color: var(--t3);
    font-family: var(--font-mono, monospace);
    margin-left: auto;
  }

  /* ═══════════════════════════════════════════════════════════════════
     Utilities
     ═══════════════════════════════════════════════════════════════════ */
  .empty-state {
    color: var(--t3);
    font-size: 11px;
    text-align: center;
    padding: 24px 0;
  }

  .mono {
    font-family: var(--font-mono, monospace);
  }

  /* ── Number input spinner removal ───────────────────────── */
  .form-input[type="number"]::-webkit-inner-spin-button,
  .form-input[type="number"]::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .form-input[type="number"] {
    -moz-appearance: textfield;
    appearance: textfield;
  }
</style>
