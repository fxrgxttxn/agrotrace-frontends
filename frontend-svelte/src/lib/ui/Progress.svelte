<script lang="ts">
  import { t } from '../app/i18n';

  let {
    id,
    label,
    value,
    max,
    tone,
    labelHidden = false,
  }: { id: string; label: string; value: number; max: number; tone?: 'danger'; labelHidden?: boolean } = $props();
</script>

<div class="at-progress" data-tone={tone}>
  <span class={labelHidden ? 'at-progress__label at-visually-hidden' : 'at-progress__label'} {id}>{label}</span>
  <span class="at-progress__value">{t('ui.progressValue', { value, max })}</span>
  <progress class="at-progress__bar" {max} {value} aria-labelledby={id}></progress>
</div>
