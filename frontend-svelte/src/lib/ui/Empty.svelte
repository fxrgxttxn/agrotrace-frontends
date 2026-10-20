<script lang="ts">
  import type { Snippet } from 'svelte';
  import Illustration from './Illustration.svelte';
  import type { IllustrationName } from './illustrations';

  /** `at-empty` (README «Пустое состояние»): illustration, one line, one action. */
  let { art, text, action }: { art: IllustrationName; text: string; action?: Snippet } = $props();
</script>

<div class="at-empty">
  <Illustration name={art} />
  <p class="at-empty__text">{text}</p>
  {@render action?.()}
</div>
