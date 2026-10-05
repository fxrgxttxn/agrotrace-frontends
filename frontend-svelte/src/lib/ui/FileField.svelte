<script lang="ts" module>
  export interface FileItem {
    key: string;
    name: string;
    sizeText: string;
    error?: boolean;
    previewUrl?: string;
    kind?: string;
    progress?: number | null;
  }
</script>

<script lang="ts">
  import { t } from '../app/i18n';
  import Button from './Button.svelte';

  let {
    id,
    label,
    accept,
    multiple = false,
    hint,
    files,
    onfiles,
    onremove,
    error = null,
    disabled = false,
  }: {
    id: string;
    label: string;
    accept?: string;
    multiple?: boolean;
    hint?: string;
    files: FileItem[];
    onfiles: (files: File[]) => void;
    onremove: (key: string) => void;
    error?: string | null;
    disabled?: boolean;
  } = $props();

  let over = $state(false);
  let depth = 0;
  const labelId = $derived(`${id}-label`);
  const errorId = $derived(error ? `${id}-error` : undefined);

  function drop(e: DragEvent) {
    e.preventDefault();
    depth = 0;
    over = false;
    if (disabled) return;
    const list = [...(e.dataTransfer?.files ?? [])];
    if (list.length) onfiles(multiple ? list : list.slice(0, 1));
  }
</script>

<div class="at-field" data-invalid={error ? '' : undefined}>
  <span class="at-field__label" id={labelId}>{label}</span>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="at-file"
    data-dragover={over ? '' : undefined}
    data-invalid={error ? '' : undefined}
    ondragenter={(e) => {
      e.preventDefault();
      depth += 1;
      if (!disabled) over = true;
    }}
    ondragover={(e) => e.preventDefault()}
    ondragleave={() => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) over = false;
    }}
    ondrop={drop}
  >
    <label class="at-file__drop">
      <input
        {id}
        type="file"
        {accept}
        {multiple}
        {disabled}
        aria-labelledby={labelId}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={errorId}
        onchange={(e) => {
          const list = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = '';
          if (list.length) onfiles(list);
        }}
      />
      <svg class="at-file__icon" aria-hidden="true"><use href="#i-upload" /></svg>
      <span class="at-file__action">{t('ui.chooseFile')}</span>
      {#if hint}<span class="at-file__hint" id="{id}-hint">{hint}</span>{/if}
    </label>
    {#if files.length > 0}
      <ul class="at-file__list">
        {#each files as f (f.key)}
          <li class="at-file__item" data-error={f.error ? '' : undefined}>
            {#if f.previewUrl}
              <span class="at-file__preview"><img src={f.previewUrl} alt="" /></span>
            {:else}
              <span class="at-file__preview" aria-hidden="true">{f.kind ?? ''}</span>
            {/if}
            <span class="at-file__body">
              <span class="at-file__name">{f.name}</span>
              <span class="at-file__size">{f.sizeText}</span>
              {#if f.progress !== undefined}
                <progress
                  class="at-file__progress"
                  max="100"
                  value={f.progress ?? undefined}
                  aria-label={t('ui.uploading', { name: f.name })}
                ></progress>
              {/if}
            </span>
            <Button
              variant="ghost"
              size="s"
              iconOnly
              icon="close"
              aria-label={t('ui.removeFile', { name: f.name })}
              onclick={() => onremove(f.key)}
            />
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  {#if error}
    <p class="at-field__error" id={errorId} role="alert">{error}</p>
  {/if}
</div>
