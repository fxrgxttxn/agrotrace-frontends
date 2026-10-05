<script lang="ts" module>
  import { encode } from 'uqr';

  export function qrPath(text: string): { size: number; d: string } {
    const { data, size } = encode(text, { ecc: 'M', border: 2 });
    let d = '';
    data.forEach((row, y) => {
      let x = 0;
      while (x < size) {
        if (!row[x]) {
          x += 1;
          continue;
        }
        let run = 1;
        while (x + run < size && row[x + run]) run += 1;
        d += `M${x} ${y}h${run}v1h-${run}z`;
        x += run;
      }
    });
    return { size, d };
  }
</script>

<script lang="ts">
  let { value, label, size = 192 }: { value: string; label: string; size?: number } = $props();

  const qr = $derived(qrPath(value));
</script>

<span data-theme="light" style="display: inline-block; line-height: 0">
  <svg
    role="img"
    aria-label={label}
    viewBox="0 0 {qr.size} {qr.size}"
    width={size}
    height={size}
    shape-rendering="crispEdges"
    style="background: var(--c-surface); border-radius: var(--r-s)"
  >
    <path d={qr.d} style="fill: var(--c-ink)" />
  </svg>
</span>
