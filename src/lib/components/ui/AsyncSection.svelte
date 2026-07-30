<!--
  AsyncSection — the three-way async branch for a section fed by a poll:
  NEVER-FETCHED, FETCHED-AND-FAILED, and DATA.

  ## Why this exists (the operator consequence)

  `/exchanges` and `/futures` used to gate on `{#if !data}` alone. With no third
  state to occupy, the "…status server didn't respond" outage copy was the
  GUARANTEED first paint — present in the first byte of SSR HTML, before any
  fetch had even been attempted. Not a race; every single load. An operator who
  meets that sentence on every cold load learns it is startup noise, and that is
  precisely the sentence that must stay alarming when it is true.

  ## Branching, in order

    1. `data != null`          → the caller's content, handed the non-null `data`.
                                 One prop, not a `data` + `hasData` pair: those
                                 two can drift, and the drift direction that
                                 costs money is "hasData says yes, the document
                                 is absent".
       DATA-FIRST deliberately: a poll engine holds its last-good payload across
       a failed tick (`stores/poll.ts`), so one bad tick must never blank a
       screen the operator is mid-read on. Staleness is the job of a `Freshness`
       indicator over the same poll's `updatedAt` — not of this component.
    2. `updatedAt === null`    → `Skeleton`. Honest: nothing has answered yet.
       and no `error`
    3. otherwise              → `EmptyState` with `variant="error"`.
       Reached by BOTH failure shapes: a rejected fetch (`error` set, `updatedAt`
       still null) and a 200 whose payload lacks the document (`updatedAt` set,
       `hasData` false — the adapter answered, the bot did not).

  ## Branch 2 is bounded by construction — do not "improve" it away

  `$lib/api/client.ts` arms a 15s `AbortController` on every `api.get`, so a
  black-hole backend CANNOT produce an infinite skeleton: worst case is 15s of
  skeleton followed by the correctly-worded red state. A refused connection
  rejects in milliseconds and reaches branch 3 immediately. Branch 2 is
  therefore a bounded "asking", never a place an outage can hide.

  That bound is also why `error` must stay wired: keying branch 2 on
  `updatedAt === null` ALONE would hold the shimmer forever against a status
  server that is permanently refusing, which is strictly worse than the bug this
  component fixes — a calm loading animation over a real money outage.

  ## Deviation from the roadmap sketch

  M4 item 5 sketched `{loading, error, empty}`. Both consumers that motivated
  the primitive have exactly ONE meaning for "no data" — the bot's status server
  did not answer — so the third branch is named `error` and is always red. A
  consumer whose empty really is benign should use `EmptyState` directly; do NOT
  teach this component to render a calm grey state over an outage.

  ## Usage

    <AsyncSection
      data={spot}
      updatedAt={$statusUpdatedAt}
      error={$statusError}
      errorIcon="🛰"
      errorTitle="No spot-portfolio bot status available"
      errorHint="The …"
    >
      {#snippet children(doc)}
        …content, with `doc` narrowed non-null…
      {/snippet}
    </AsyncSection>
-->
<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import Skeleton from './Skeleton.svelte';
  import EmptyState from './EmptyState.svelte';

  interface Props {
    /**
     * The payload this section renders, or `null`/`undefined` when absent.
     * Checked FIRST — see the data-first note above.
     */
    data: T | null | undefined;
    /**
     * The poll's `updatedAt`: epoch-ms of the last SUCCESSFUL fetch, `null`
     * before the first one. Must be the success stamp, not the attempt stamp,
     * or a permanently-failing feed reads as freshly loaded.
     */
    updatedAt: number | null;
    /** The poll's `error` — last fetch's message, `null` when it resolved. */
    error?: string | null;
    /** Glyph for the error state. */
    errorIcon?: string;
    /** Error headline. Keep it alarming; it means real money is unobserved. */
    errorTitle: string;
    /** Error detail — name the mechanism and the env var to check. */
    errorHint?: string;
    /** Skeleton geometry for the never-fetched branch. */
    lines?: number;
    height?: string;
    /** The success content, handed the non-null `data`. Rendered with NO wrapper
        element, so a caller's flex/grid layout and scoped styles survive the
        branch unchanged. */
    children: Snippet<[T]>;
  }

  let {
    data,
    updatedAt,
    error = null,
    errorIcon,
    errorTitle,
    errorHint,
    lines = 3,
    height = '52px',
    children,
  }: Props = $props();

  /** Nothing has answered and nothing has failed — we are still asking. */
  let asking = $derived(updatedAt === null && !error);
</script>

{#if data !== null && data !== undefined}
  {@render children(data)}
{:else if asking}
  <div class="as-asking">
    <Skeleton {lines} {height} />
  </div>
{:else}
  <EmptyState
    icon={errorIcon}
    title={errorTitle}
    hint={errorHint}
    variant="error"
  />
{/if}

<style>
  .as-asking {
    padding: 8px 0;
  }
</style>
