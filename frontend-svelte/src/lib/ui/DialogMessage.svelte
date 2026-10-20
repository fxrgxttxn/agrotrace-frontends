<script lang="ts">
  /** A failure of the action of an open dialog, said inside it (README «Диалог»: the page's toast region is behind
   * the modal). */
  let { text }: { text: string | null | undefined } = $props();
</script>

{#if text}<p class="at-field__error" role="alert" style="margin: 0">{text}</p>{/if}
