<script lang="ts">
  let { text }: { text: string | null | undefined } = $props();
</script>

{#if text}<p class="at-field__error" role="alert" style="margin: 0">{text}</p>{/if}
