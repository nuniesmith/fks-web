<script lang="ts">
  import { enhance } from "$app/forms";
  // Shared auth-gate chrome (.gate/.panel/.input/.btn/…) — ONE definition for
  // /login, /setup and /invite. See src/styles/gate.css.
  import "../../../styles/gate.css";

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
  <title>Accept Invite — FKS Terminal</title>
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
  /* Everything shared with /login and /setup lives in src/styles/gate.css
     (imported above). Only the invited role's emphasis stays here. */
  .role {
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
</style>
