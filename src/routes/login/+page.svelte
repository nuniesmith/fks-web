<script lang="ts">
  import { enhance } from '$app/forms';
  import { page } from '$app/stores';
  // Shared auth-gate chrome (.gate/.panel/.input/.btn/…) — ONE definition for
  // /login, /setup and /invite. See src/styles/gate.css.
  import '../../styles/gate.css';

  interface Props {
    form?: { error?: string; username?: string } | null;
  }

  let { form }: Props = $props();

  let loading = $state(false);
  let password = $state('');

  // Preserve the ?next= redirect target through the form submission
  let next = $derived($page.url.searchParams.get('next') ?? '');
</script>

<svelte:head>
  <title>Login — FKS Terminal</title>
</svelte:head>

<div class="gate">
  <div class="panel">

    <!-- ASCII terminal icon -->
    <pre class="ascii" aria-hidden="true">
╔══════════════╗
║  &gt; FKS_     ║
║  $ terminal  ║
╚══════════════╝</pre>

    <h1 class="title">
      <span class="bracket">[</span>
      FKS Terminal
      <span class="bracket">]</span>
    </h1>
    <p class="subtitle">Restricted access. Authenticate to continue.</p>

    <form
      method="POST"
      action="?/login"
      use:enhance={() => {
        loading = true;
        return async ({ update }) => {
          loading = false;
          await update();
        };
      }}
    >
      {#if next}
        <input type="hidden" name="next" value={next} />
      {/if}

      <label class="field-label" for="username">Username</label>
      <div class="input-row" class:input-row-error={!!form?.error}>
        <span class="prompt" aria-hidden="true">@</span>
        <input
          id="username"
          name="username"
          type="text"
          class="input"
          placeholder="username"
          autocomplete="username"
          value={form?.username ?? ''}
          disabled={loading}
        />
      </div>

      <label class="field-label" for="password">Password</label>
      <div class="input-row" class:input-row-error={!!form?.error}>
        <span class="prompt" aria-hidden="true">$</span>
        <input
          id="password"
          name="password"
          type="password"
          class="input"
          placeholder="enter passphrase…"
          autocomplete="current-password"
          bind:value={password}
          disabled={loading}
        />
      </div>

      {#if form?.error}
        <p class="error-msg" role="alert">
          <span class="error-icon" aria-hidden="true">✗</span>
          {form.error}
        </p>
      {/if}

      <button
        type="submit"
        class="btn"
        class:btn-loading={loading}
        disabled={loading || password.length === 0}
      >
        {#if loading}
          <span class="spinner" aria-hidden="true"></span>
          Authenticating…
        {:else}
          <span class="btn-arrow" aria-hidden="true">→</span>
          Enter Terminal
        {/if}
      </button>
    </form>

    <p class="footer-note">
      <span class="dot dot-amber"></span>
      Access is logged. Authorised users only.
    </p>
  </div>
</div>

<style>
  /* Everything shared with /setup and /invite lives in src/styles/gate.css
     (imported above). Only the login-specific ornament stays here. */

  /* ── ASCII art ───────────────────────────────────────── */
  .ascii {
    font-family: inherit;
    font-size: 10px;
    line-height: 1.4;
    color: var(--accent);
    opacity: 0.55;
    text-align: center;
    white-space: pre;
    user-select: none;
    margin: 0;
  }

  /* ── Footer note ─────────────────────────────────────── */
  .footer-note {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    font-size: 9px;
    color: var(--t3);
    opacity: 0.6;
    text-align: center;
    margin-top: 4px;
  }

  .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .dot-amber {
    background: var(--amber);
    opacity: 0.7;
  }
</style>
