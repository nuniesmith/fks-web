<!--
  New task — pick a template, fill its form, check it, create it.

  The form is generated from the template's JSON-Schema params (GET
  /api/spawner/templates), so a new template needs no UI change. "Check"
  asks the spawner what the instance WOULD be (POST /instances/validate: the
  image, env, resources and data folder, or one line per mistake); "Create"
  makes exactly what was checked and is disabled until a check passes for the
  current values. An agent does the same two calls through the API.

  ?kind=recorder|job|bot filters the picker; ?template=<id> opens a form.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto, replaceState } from '$app/navigation';
  import { spawner } from '$api/spawner';
  import { ApiError } from '$api/client';
  import Panel from '$components/ui/Panel.svelte';
  import Badge from '$components/ui/Badge.svelte';
  import EmptyState from '$components/ui/EmptyState.svelte';
  import { fmtBytes } from '$lib/coverage';
  import {
    estimateMbPerDay,
    fieldKind,
    initialValues,
    prefill,
    nameError,
    orderedFields,
    suggestName,
    toParams,
    type FieldValue,
  } from '$lib/templateForm';
  import type { InstancePlan, Template, TemplateKind } from '$lib/types/spawner';

  const KIND_COPY: Record<TemplateKind, { title: string; blurb: string }> = {
    recorder: {
      title: 'Record data',
      blurb: 'Raw exchange events into the data lake, with a ledger of every gap. Step 1 of the process.',
    },
    job: {
      title: 'Run a job',
      blurb: 'One-shot work on recorded data: searching for edges, validating them, re-checking live ones.',
    },
    bot: {
      title: 'Run a bot',
      blurb: 'A strategy on an exchange account: paper first, live only with an admin and the account lease.',
    },
  };

  let templates = $state<Template[] | null>(null);
  let loadError = $state('');
  let kindFilter = $derived(($page.url.searchParams.get('kind') as TemplateKind | null) ?? null);
  let selected = $state<Template | null>(null);

  // ── Form state ────────────────────────────────────────────────────────────
  let values = $state<Record<string, FieldValue>>({});
  let name = $state('');
  let nameTouched = $state(false);
  let mode = $state('');
  let checking = $state(false);
  let creating = $state(false);
  let plan = $state<InstancePlan | null>(null);
  let planFor = $state('');
  let serverErrors = $state<string[]>([]);

  let parsed = $derived(selected ? toParams(selected, values) : { params: {}, errors: [] });
  let request = $derived(selected ? { template: selected.id, name, params: parsed.params, mode } : null);
  let requestKey = $derived(JSON.stringify(request));
  let localErrors = $derived([...(nameError(name) ? [nameError(name)!] : []), ...parsed.errors]);
  let estimate = $derived(selected ? estimateMbPerDay(selected, values) : null);
  let checkedOk = $derived(plan !== null && planFor === requestKey);

  let role = $derived(($page.data.user?.role as string | undefined) ?? null);
  let canOperate = $derived(role == null || role === 'admin' || role === 'operator');

  $effect(() => {
    if (selected && !nameTouched) name = suggestName(selected, values);
  });

  function pick(t: Template) {
    selected = t;
    values = prefill(t, initialValues(t), $page.url.searchParams);
    mode = t.modes[0] ?? '';
    nameTouched = false;
    plan = null;
    serverErrors = [];
    // Shallow routing: keep the chosen template in the URL (shareable, and
    // the agent-facing equivalent of ?template=) without a navigation.
    const url = new URL($page.url);
    url.searchParams.set('template', t.id);
    replaceState(url, $page.state);
  }

  onMount(async () => {
    try {
      const res = await spawner.templates();
      templates = res.templates;
      const wanted = $page.url.searchParams.get('template');
      const t = wanted ? res.templates.find((x) => x.id === wanted) : null;
      if (t) pick(t);
      else {
        const shown = res.templates.filter((x) => !kindFilter || x.kind === kindFilter);
        if (shown.length === 1) pick(shown[0]);
      }
    } catch (e) {
      loadError = e instanceof ApiError ? `${e.status}: ${e.statusText}` : String(e);
      templates = [];
    }
  });

  function errorsOf(e: unknown): string[] {
    if (e instanceof ApiError && typeof e.body === 'string') {
      try {
        const b = JSON.parse(e.body);
        if (Array.isArray(b.errors)) return b.errors.map(String);
        if (b.error) return [String(b.error)];
        if (b.detail) return [String(b.detail)];
      } catch {
        return [e.body];
      }
    }
    return [e instanceof ApiError ? `${e.status}: ${e.statusText}` : String(e)];
  }

  async function check() {
    if (!request) return;
    checking = true;
    serverErrors = [];
    plan = null;
    const key = requestKey;
    try {
      const res = await spawner.validateInstance(request);
      if (res.ok && res.plan) {
        plan = res.plan;
        planFor = key;
      } else {
        serverErrors = res.errors ?? ['the spawner refused the form'];
      }
    } catch (e) {
      serverErrors = errorsOf(e);
    } finally {
      checking = false;
    }
  }

  async function create() {
    if (!request || !checkedOk) return;
    creating = true;
    serverErrors = [];
    try {
      const res = await spawner.createInstance(request);
      if (!res.ok) {
        serverErrors = res.errors ?? ['the spawner refused to create it'];
        return;
      }
      await goto(selected?.kind === 'recorder' ? '/data' : '/tasks');
    } catch (e) {
      serverErrors = errorsOf(e);
    } finally {
      creating = false;
    }
  }

  function toggle(key: string, option: string) {
    const cur = Array.isArray(values[key]) ? (values[key] as string[]) : [];
    values[key] = cur.includes(option) ? cur.filter((x) => x !== option) : [...cur, option];
  }
</script>

<svelte:head>
  <title>New task — FKS Terminal</title>
</svelte:head>

<div class="page-scroll page page-scroll--capped">
  <nav class="crumbs"><a href="/tasks">Tasks</a> / New{selected ? ` / ${selected.display_name}` : ''}</nav>

  {#if templates === null}
    <p class="muted" role="status">Loading templates…</p>
  {:else if loadError}
    <EmptyState icon="⚠️" variant="error" title="Couldn't load templates" hint={loadError} />
  {:else if !selected}
    {#each Object.entries(KIND_COPY) as [kind, copy] (kind)}
      {@const shown = templates.filter((t) => t.kind === kind)}
      {#if !kindFilter || kindFilter === kind}
        <Panel title={copy.title}>
          <p class="blurb">{copy.blurb}</p>
          {#if shown.length === 0}
            <p class="muted">
              No {kind} templates yet.
              {#if kind === 'job'}Edge search and validation jobs are the next step of the build.{/if}
              {#if kind === 'bot'}Bots come from templates once the crypto bot gains its config surface.{/if}
            </p>
          {:else}
            <div class="picks">
              {#each shown as t (t.id)}
                <button class="pick" onclick={() => pick(t)} data-testid="template-pick" data-template={t.id}>
                  <span class="pick-name">{t.display_name}</span>
                  <span class="pick-desc">{t.description ?? t.id}</span>
                  <span class="pick-meta">{t.id} · v{t.version}</span>
                </button>
              {/each}
            </div>
          {/if}
        </Panel>
      {/if}
    {/each}
  {:else}
    <Panel title={selected.display_name}>
      <p class="blurb">{selected.description}</p>
      <form
        class="form"
        onsubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        <label class="field">
          <span class="lbl">Name</span>
          <input
            class="inp"
            bind:value={name}
            oninput={() => (nameTouched = true)}
            autocomplete="off"
            spellcheck="false"
            aria-describedby="name-hint"
          />
          <span class="hint" id="name-hint">
            The container is fks-bot-{name || '…'}{selected.data
              ? `; files go to raw/${selected.data.venue}/${selected.data.market}/${name || '…'}`
              : ''}.
          </span>
        </label>

        {#if selected.modes.length > 1}
          <label class="field">
            <span class="lbl">Mode</span>
            <select class="inp" bind:value={mode}>
              {#each selected.modes as m (m)}<option value={m}>{m}</option>{/each}
            </select>
            {#if mode === 'live'}
              <span class="hint warn">
                Live trades real money with the account's stored key. It needs an admin, and the account
                lease allows one bot per account.
              </span>
            {/if}
          </label>
        {/if}

        {#each orderedFields(selected) as [key, f] (key)}
          {@const kind = fieldKind(f)}
          {@const required = (selected.params.required ?? []).includes(key)}
          <div class="field">
            {#if kind === 'multi-enum'}
              <span class="lbl">{f.title ?? key}{required ? ' *' : ''}</span>
              <div class="checks">
                {#each f.items?.enum ?? [] as opt (String(opt))}
                  {@const o = String(opt)}
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={Array.isArray(values[key]) && (values[key] as string[]).includes(o)}
                      onchange={() => toggle(key, o)}
                    />
                    <span>{f['x-labels']?.[o] ?? o}</span>
                    <code class="opt">{o}</code>
                    {#if f['x-backfillable']?.[o]}
                      <Badge variant={f['x-backfillable'][o] === 'no' ? 'amber' : 'default'}>
                        {f['x-backfillable'][o] === 'no' ? 'not downloadable later' : `backfill: ${f['x-backfillable'][o]}`}
                      </Badge>
                    {/if}
                    {#if f['x-est-mb-per-day']?.[o] != null}
                      <span class="hint">~{f['x-est-mb-per-day'][o]} MB/day</span>
                    {/if}
                  </label>
                {/each}
              </div>
            {:else if kind === 'boolean'}
              <label class="check">
                <input
                  type="checkbox"
                  checked={values[key] === true}
                  onchange={(e) => (values[key] = e.currentTarget.checked)}
                />
                <span>{f.title ?? key}</span>
              </label>
            {:else if kind === 'enum'}
              <label class="field">
                <span class="lbl">{f.title ?? key}{required ? ' *' : ''}</span>
                <select
                  class="inp"
                  value={String(values[key] ?? '')}
                  onchange={(e) => (values[key] = e.currentTarget.value)}
                >
                  {#each f.enum ?? [] as opt (String(opt))}<option value={String(opt)}>{f['x-labels']?.[String(opt)] ?? opt}</option>{/each}
                </select>
              </label>
            {:else}
              <label class="field">
                <span class="lbl">{f.title ?? key}{required ? ' *' : ''}</span>
                <input
                  class="inp"
                  inputmode={kind === 'integer' || kind === 'number' ? 'decimal' : 'text'}
                  placeholder={kind === 'list' ? 'comma or space separated' : ''}
                  value={String(values[key] ?? '')}
                  oninput={(e) => (values[key] = e.currentTarget.value)}
                  autocomplete="off"
                  spellcheck="false"
                />
              </label>
            {/if}
            {#if f.description}<span class="hint">{f.description}</span>{/if}
            {#if f['x-note']}<span class="hint">{f['x-note']}</span>{/if}
            {#if f.minimum != null || f.maximum != null}
              <span class="hint">{f.minimum ?? '…'} to {f.maximum ?? '…'}</span>
            {/if}
          </div>
        {/each}

        {#if estimate != null}
          <p class="estimate">
            About <strong>{fmtBytes(estimate * 1e6)}</strong> a day once compressed (~{fmtBytes(estimate * 30e6)}
            a month), from the template's measured sizes.
          </p>
        {/if}

        {#if localErrors.length}
          <ul class="errors" aria-label="Fix before checking">
            {#each localErrors as e (e)}<li>{e}</li>{/each}
          </ul>
        {/if}
        {#if serverErrors.length}
          <ul class="errors server" role="alert" aria-label="The spawner refused">
            {#each serverErrors as e (e)}<li>{e}</li>{/each}
          </ul>
        {/if}

        <div class="buttons">
          <button type="submit" class="btn" disabled={checking || localErrors.length > 0}>
            {checking ? 'Checking…' : 'Check'}
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={!checkedOk || creating || !canOperate}
            onclick={create}
            title={checkedOk ? '' : 'Check the form first'}
          >
            {creating ? 'Creating…' : selected.id.startsWith('history.') ? 'Start downloading' : selected.kind === 'recorder' ? 'Start recording' : 'Create'}
          </button>
          <button type="button" class="btn ghost" onclick={() => (selected = null)}>Other template</button>
        </div>
      </form>
    </Panel>

    {#if checkedOk && plan}
      <Panel title="What will run">
        <dl class="plan" data-testid="instance-plan">
          <dt>Container</dt><dd>fks-bot-{plan.name} · {plan.image}</dd>
          <dt>Mode</dt><dd>{plan.mode}</dd>
          <dt>Resources</dt><dd>{plan.cpu_limit ?? 'default'} CPU · {plan.memory_mb ?? 'default'} MB</dd>
          {#if plan.data_dir}<dt>Data folder</dt><dd>{plan.data_dir}</dd>{/if}
          <dt>Environment</dt>
          <dd>
            {#each Object.entries(plan.env) as [k, v] (k)}<code class="env">{k}={v}</code>{/each}
          </dd>
        </dl>
      </Panel>
    {/if}
  {/if}
</div>

<style>
  .crumbs {
    font-size: 11px;
    color: var(--t3);
  }
  .crumbs a {
    color: var(--t2);
  }
  .muted {
    font-size: 11px;
    color: var(--t3);
  }
  .blurb {
    margin: 0 0 10px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--t2);
  }
  .picks {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 8px;
  }
  .pick {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px;
    text-align: left;
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r-md);
    color: var(--t1);
    font: inherit;
    cursor: pointer;
  }
  .pick:hover {
    border-color: var(--cyan);
  }
  .pick-name {
    font-size: 13px;
    font-weight: 600;
  }
  .pick-desc {
    font-size: 11px;
    line-height: 1.45;
    color: var(--t2);
  }
  .pick-meta {
    font-size: 10px;
    color: var(--t3);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .lbl {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--t2);
  }
  .inp {
    min-height: 30px;
    padding: 4px 8px;
    background: var(--bg2);
    border: 1px solid var(--b2);
    border-radius: var(--r);
    color: var(--t1);
    font: inherit;
    font-size: 12px;
  }
  .inp:focus {
    outline: none;
    border-color: var(--cyan);
  }
  .hint {
    font-size: 10px;
    color: var(--t3);
  }
  .hint.warn {
    color: var(--amber);
  }
  .checks {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .check {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--t1);
  }
  .opt {
    font-size: 10px;
    color: var(--t3);
  }
  .estimate {
    margin: 0;
    font-size: 12px;
    color: var(--t2);
  }
  .errors {
    margin: 0;
    padding-left: 18px;
    font-size: 11px;
    color: var(--amber);
  }
  .errors.server {
    color: var(--red);
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .btn {
    min-height: 32px;
    padding: 4px 14px;
    background: transparent;
    border: 1px solid var(--b2);
    border-radius: var(--r);
    color: var(--t1);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .btn.primary {
    border-color: var(--cyan);
    color: var(--cyan);
  }
  .btn.ghost {
    border-color: transparent;
    color: var(--t3);
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .plan {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 6px 12px;
    margin: 0;
    font-size: 11px;
  }
  .plan dt {
    color: var(--t3);
  }
  .plan dd {
    margin: 0;
    color: var(--t1);
    overflow-wrap: anywhere;
  }
  .env {
    display: block;
    font-size: 10.5px;
    color: var(--t2);
  }
  @media (pointer: coarse) {
    .btn,
    .inp {
      min-height: 44px;
    }
  }
</style>
