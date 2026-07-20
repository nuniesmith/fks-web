<script lang="ts">
  import { enhance } from '$app/forms';

  interface Props {
    data: { currentUsername: string };
    form?: { error?: string; username?: string } | null;
  }

  let { data, form }: Props = $props();

  let loading = $state(false);
  let username = $state('');
  let password = $state('');
  let confirm = $state('');

  let tooShort = $derived(password.length > 0 && password.length < 12);
  let mismatch = $derived(confirm.length > 0 && confirm !== password);
  let canSubmit = $derived(
    username.trim().length > 0 &&
      password.length >= 12 &&
      confirm === password &&
      !loading,
  );
</script>

<svelte:head>
  <title>FKS Terminal — Set Your Credentials</title>
</svelte:head>

<div class="gate">
  <div class="panel">
    <h1 class="title">
      <span class="bracket">[</span>
      First-Run Setup
      <span class="bracket">]</span>
    </h1>
    <p class="subtitle">
      This account still uses the one-time bootstrap password. Choose your own
      username and password to continue — the bootstrap credential is retired.
    </p>

    <form
      method="POST"
      action="?/change"
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
          placeholder={`new username (current: ${data.currentUsername})`}
          autocomplete="username"
          bind:value={username}
          disabled={loading}
        />
      </div>

      <label class="field-label" for="password">New password</label>
      <div class="input-row" class:input-row-error={tooShort}>
        <span class="prompt" aria-hidden="true">$</span>
        <input
          id="password"
          name="password"
          type="password"
          class="input"
          placeholder="min 12 characters"
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
        <p class="hint">Password must be at least 12 characters.</p>
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
          Saving…
        {:else}
          <span class="btn-arrow" aria-hidden="true">→</span>
          Save & Enter Terminal
        {/if}
      </button>
    </form>
  </div>
</div>

<style>
  .gate {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    background: var(--bg0);
  }
  .panel {
    width: 380px;
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
