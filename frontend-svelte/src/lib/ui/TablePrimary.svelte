<script lang="ts">
  let { href, code, sub }: { href: string; code: string; sub?: string } = $props();
</script>

<span class="at-table__primary"
  ><a class="at-mono" {href}>{code}</a>{#if sub !== undefined}<span class="at-table__sub">{sub}</span>{/if}</span
>
