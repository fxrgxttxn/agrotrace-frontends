<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../app/i18n';
  import type { Tone } from './display';

  /** `at-chip` (README «Статус»): `status` — a contract `BatchStatus` (text from `status.batch.*`), or `tone` for the
   * other entities with the caller's text. */
  let {
    status,
    tone,
    size,
    children,
  }: { status?: string; tone?: Tone; size?: 'l'; children?: Snippet } = $props();
</script>

<span class="at-chip" data-status={status} data-tone={tone} data-size={size}
  >{#if children}{@render children()}{:else if status}{t(`status.batch.${status}`)}{/if}</span
>
