<script lang="ts">
  import { onMount } from 'svelte';
  import Nest from './Nest.svelte';
  import { router } from './router.svelte';

  onMount(() => {
    document.addEventListener('click', router.onClick);
    return () => document.removeEventListener('click', router.onClick);
  });
</script>

<Nest chain={router.chain} />
