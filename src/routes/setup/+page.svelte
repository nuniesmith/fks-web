<script lang="ts">
  import { enhance } from '$app/forms';
  // Shared auth-gate chrome (.gate/.panel/.input/.btn/…) — ONE definition for
  // /login, /setup and /invite. See src/styles/gate.css.
  import '../../styles/gate.css';

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
  <title>Set Your Credentials — FKS Terminal</title>
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

<!-- No local <style>: every class on this page is shared auth-gate chrome,
     defined once in src/styles/gate.css (imported above). -->
