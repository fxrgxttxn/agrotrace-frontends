<script lang="ts">
  import type { Snippet } from 'svelte';
  import Card from '../ui/Card.svelte';
  import CardBody from '../ui/CardBody.svelte';
  import Illustration from '../ui/Illustration.svelte';
  import type { IllustrationName } from '../ui/illustrations';
  import Page from '../ui/Page.svelte';

  let {
    title,
    furrow = false,
    art,
    children,
  }: { title: string; furrow?: boolean; art?: IllustrationName; children: Snippet } = $props();
</script>

<Page {title} main style="max-width: 30rem">
  <Card {furrow}>
    <CardBody>
      {#if art}<Illustration name={art} style="display: block; margin-inline: auto" />{/if}
      {@render children()}
    </CardBody>
  </Card>
</Page>
