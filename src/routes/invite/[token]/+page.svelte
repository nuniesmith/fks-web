<script lang="ts">
  import { enhance } from "$app/forms";

  // Discriminated by `state`; the token is NEVER part of `data` (URL-only).
  type Data =
    | { state: "valid"; role: string; expiresAt: string | null; minPasswordLength: number }
    | { state: "invalid"; minPasswordLength?: number }
    | { state: "authed"; username: string }
    | { state: "unavailable" };

  interface Props {
    data: Data;
    form?: { error?: string; username?: string } | null;
  }

  let { data, form }: Props = $props();

  const minLen = $derived(
    data.state === "valid" ? data.minPasswordLength : 12,
  );

  let loading = $state(false);
  let username = $state("");
  let password = $state("");
  let confirm = $state("");

  let tooShort = $derived(password.length > 0 && password.length < minLen);
  let mismatch = $derived(confirm.length > 0 && confirm !== password);
  let canSubmit = $derived(
    username.trim().length > 0 &&
      password.length >= minLen &&
      confirm === password &&
      !loading,
  );

  function fmtExpiry(iso: string | null): string {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return "";
    return new Date(iso).toLocaleString();
  }
</script>

<svelte:head>
  <title>FKS Terminal — Accept Invite</title>
</svelte:head>

<div class="gate">
  <div class="panel">
    <h1 class="title">
      <span class="bracket">[</span>
      Accept Invite
      <span class="bracket">]</span>
    </h1>

    {#if data.state === "valid"}
      <p class="subtitle">
        You've been invited to the FKS Terminal as
        <strong class="role">{data.role}</strong>. Choose your own username and
        password to create your account.
        {#if data.expiresAt}
          <br />This link expires {fmtExpiry(data.expiresAt)}.
        {/if}
      </p>

      <form
        method="POST"
        action="?/claim"
        use:enhance={() => {
          loading = true;
          return async ({ update }) => {
            loading = false;
            await update();
          };
        }}
      >
        <label class="field-label" for="username">Username</label>
        <div class="input-row">
          <span class="prompt" aria-hidden="true">@</span>
          <input
            id="username"
            name="username"
            type="text"
            class="input"
            placeholder="pick a username"
            autocomplete="username"
            bind:value={username}
            disabled={loading}
          />
        </div>

        <label class="field-label" for="password">Password</label>
        <div class="input-row" class:input-row-error={tooShort}>
          <span class="prompt" aria-hidden="true">$</span>
          <input
            id="password"
            name="password"
            type="password"
            class="input"
            placeholder={`min ${minLen} characters`}
            autocomplete="new-password"
            bind:value={password}
            disabled={loading}
          />
        </div>

        <label class="field-label" for="confirm">Confirm password</label>
        <div class="input-row" class:input-row-error={mismatch}>
          <span class="prompt" aria-hidden="true">$</span>
          <input
            id="confirm"
            name="confirm"
            type="password"
            class="input"
            autocomplete="new-password"
            bind:value={confirm}
            disabled={loading}
          />
        </div>

        {#if tooShort}
          <p class="hint">Password must be at least {minLen} characters.</p>
        {:else if mismatch}
          <p class="hint">Passwords do not match.</p>
        {/if}

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
          disabled={!canSubmit}
        >
          {#if loading}
            <span class="spinner" aria-hidden="true"></span>
            Creating…
          {:else}
            <span class="btn-arrow" aria-hidden="true">→</span>
            Create account & Enter
          {/if}
        </button>
      </form>
    {:else if data.state === "authed"}
      <p class="subtitle">
        You're already signed in as <strong>{data.username}</strong>. To accept a
        new invite, log out first, then open this link again.
      </p>
      <a class="btn link" href="/logout">Log out</a>
    {:else if data.state === "unavailable"}
      <p class="subtitle">
        The service is temporarily unavailable. Please try this link again in a
        few moments.
      </p>
    {:else}
      <p class="subtitle">
        This invite link is not valid, has expired, or has already been used. Ask
        whoever invited you to send a fresh link.
      </p>
      <a class="btn link" href="/login">Go to login</a>
    {/if}
  </div>
</div>

<style>
  .gate {
    display: flex;
    align-items: center;
    justify-content: center;
    /* This page owns the ONLY scroll region (see the one-scroll rule in
       app.css). Without overflow-y the centred card is clipped at both ends
       on a short viewport — with the keyboard up, that hides the submit
       button. padding + `margin:auto` on the child keeps it centred when it
       fits and scrollable when it does not. */
    overflow-y: auto;
    padding: 16px;
    min-height: 100vh;
    max-height: 100vh;
    background: var(--bg0);
  }
  .panel {
    /* min() so the card never exceeds a 375px phone viewport, where a fixed
       width overflowed horizontally and pushed the submit button out of
       reach. */
    width: min(380px, 100%);
    padding: 32px 28px 24px;
    background: var(--bg1);
    border: 1px solid var(--b2);
    border-radius: var(--r-md);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .title {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--t1);
    text-align: center;
    margin: 0;
  }
  .bracket {
    color: var(--accent);
    opacity: 0.7;
  }
  .subtitle {
    font-size: 11px;
    color: var(--t3);
    text-align: center;
    line-height: 1.5;
  }
  .role {
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 4px;
  }
  .field-label {
    font-size: 10px;
    color: var(--t3);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-top: 6px;
  }
  .input-row {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r);
    padding: 0 10px;
  }
  .input-row:focus-within {
    border-color: var(--accent-brd);
    box-shadow: 0 0 0 2px var(--accent-dim);
  }
  .input-row-error {
    border-color: var(--red-brd) !important;
  }
  .prompt {
    color: var(--cyan);
    font-size: 12px;
    flex-shrink: 0;
  }
  .input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--t1);
    font-family: inherit;
    font-size: 12px;
    height: 36px;
  }
  .hint {
    font-size: 10px;
    color: var(--amber);
  }
  .error-msg {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--red);
    background: var(--red-dim);
    border: 1px solid var(--red-brd);
    border-radius: var(--r);
    padding: 6px 10px;
  }
  .error-icon {
    flex-shrink: 0;
  }
  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 36px;
    margin-top: 10px;
    background: var(--accent-dim);
    border: 1px solid var(--accent-brd);
    border-radius: var(--r);
    color: var(--accent);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    text-decoration: none;
  }
  .btn:hover:not(:disabled) {
    background: rgba(91, 110, 245, 0.2);
    border-color: var(--accent);
    color: var(--t1);
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .btn.link {
    text-align: center;
  }
  .btn-loading {
    opacity: 0.7;
  }
  .spinner {
    display: inline-block;
    width: 11px;
    height: 11px;
    border: 1.5px solid var(--accent-brd);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
</style>
