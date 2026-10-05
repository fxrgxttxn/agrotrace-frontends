<script lang="ts">
  import type { Schemas } from '@agrotrace/api-client';
  import { auditActionLabel, auditFieldLabel, auditValue, enumLabel, formatLocalDateTime } from '@agrotrace/i18n';
  import { dictionary } from '../../app/dictionaries';
  import { LOCALE, t } from '../../app/i18n';
  import Button from '../../ui/Button.svelte';
  import CardFacts from '../../ui/CardFacts.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import Table from '../../ui/Table.svelte';
  import type { Column } from '../../ui/table';

  type Entry = Schemas['AuditEntry'];
  type Row = { field: string; before: unknown; after: unknown };
  let { entry, onclose }: { entry: Entry | null; onclose: () => void } = $props();

  const has = (...fields: string[]) => entry !== null && fields.some((f) => f in entry!.diff);
  const products = dictionary('products', () => has('productId'));
  const indicators = dictionary('indicators', () => has('indicatorId'));
  const substances = dictionary('substances', () => has('substanceId'));
  const regions = dictionary('regions', () => has('regionId', 'regionCode'));
  function resolve(field: string, value: string): string | undefined {
    const byId = (list: { id: string; name: string }[] | null | undefined) => list?.find((x) => x.id === value)?.name;
    if (field === 'productId') return byId(products.data);
    if (field === 'indicatorId') return byId(indicators.data);
    if (field === 'substanceId') return byId(substances.data);
    if (field === 'regionId') return byId(regions.data);
    if (field === 'regionCode') return regions.data?.find((r) => r.code === value)?.name;
    return undefined;
  }
  const shown = (v: unknown, field: string) =>
    auditValue(t, v, LOCALE, entry ? { field, entityType: entry.entityType, resolve } : undefined);
  const at = (iso: string) => formatLocalDateTime(iso, LOCALE);
  const rows = $derived<Row[]>(
    entry
      ? Object.entries(entry.diff).map(([field, pair]) => ({
          field,
          before: (pair as unknown[])[0],
          after: (pair as unknown[])[1],
        }))
      : [],
  );
  const columns: Column<Row>[] = [
    { key: 'field', header: t('audit.field'), primary: true },
    { key: 'before', header: t('audit.before') },
    { key: 'after', header: t('audit.after') },
  ];
</script>

{#snippet cell(r: Row, c: Column<Row>)}
  {#if c.key === 'field'}<span class="at-table__primary"
      ><span>{auditFieldLabel(t, r.field)}</span><span class="at-table__sub at-mono">{r.field}</span></span
    >{:else}<span style="overflow-wrap: anywhere; white-space: pre-wrap"
      >{shown(c.key === 'before' ? r.before : r.after, r.field)}</span
    >{/if}
{/snippet}
{#snippet mono(text: string)}<span class="at-mono">{text}</span>{/snippet}
{#snippet entityId()}{@render mono(entry?.entityId ?? '')}{/snippet}
{#snippet ip()}{@render mono(entry?.ip ?? '')}{/snippet}
{#snippet requestId()}{@render mono(entry?.requestId ?? '')}{/snippet}

<Dialog
  open={entry !== null}
  {onclose}
  size="l"
  lightDismiss
  title={entry
    ? t('audit.diffTitle', {
        entity: enumLabel(t, 'AuditEntityType', entry.entityType),
        action: auditActionLabel(t, entry.action),
      })
    : ''}
>
  {#snippet actions()}
    <Button variant="ghost" onclick={onclose}>{t('shell.close')}</Button>
  {/snippet}
  {#if entry}
    <div style="display: grid; gap: var(--sp-4)">
      <CardFacts
        facts={[
          { key: 'time', term: t('audit.time'), value: at(entry.createdAt) },
          {
            key: 'actor',
            term: t('audit.actor'),
            value: entry.actor ? `${entry.actor.fullName}, ${entry.actor.organization.name}` : t('audit.system'),
          },
          ...(entry.entityId ? [{ key: 'id', term: t('audit.entityId'), value: entityId }] : []),
          { key: 'backend', term: t('audit.backend'), value: enumLabel(t, 'AuditEntry.backend', entry.backend) },
          ...(entry.ip ? [{ key: 'ip', term: t('audit.ip'), value: ip }] : []),
          ...(entry.requestId ? [{ key: 'req', term: t('audit.requestId'), value: requestId }] : []),
        ]}
      />
      {#if rows.length}
        <Table cards caption={t('audit.changes')} {columns} {rows} rowKey={(r) => r.field} {cell} />
      {:else}
        <p style="margin: 0">{t('audit.noChanges')}</p>
      {/if}
    </div>
  {/if}
</Dialog>
