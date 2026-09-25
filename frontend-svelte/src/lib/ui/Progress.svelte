<script lang="ts">
  import { t } from '../app/i18n';

  /** `at-progress` (README «Прогресс»): «N из M» with a labelled `<progress>`. */
  let {
    id,
    label,
    value,
    max,
    tone,
  }: { id: string; label: string; value: number; max: number; tone?: 'danger' } = $props();
</script>

<div class="at-progress" data-tone={tone}>
  <span class="at-progress__label" {id}>{label}</span>
  <span class="at-progress__value">{t('ui.progressValue', { value, max })}</span>
  <progress class="at-progress__bar" {max} {value} aria-labelledby={id}></progress>
</div>
