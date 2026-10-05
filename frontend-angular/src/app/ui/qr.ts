import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
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

@Component({
  selector: 'span[qr]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg
    role="img"
    [attr.aria-label]="label()"
    [attr.viewBox]="'0 0 ' + drawing().size + ' ' + drawing().size"
    [attr.width]="size()"
    [attr.height]="size()"
    shape-rendering="crispEdges"
    style="background: var(--c-surface); border-radius: var(--r-s)"
  >
    <path [attr.d]="drawing().d" style="fill: var(--c-ink)" />
  </svg>`,
  host: { 'data-theme': 'light', style: 'display: inline-block; line-height: 0' },
})
export class QrComponent {
  readonly qr = input.required<string>();
  readonly label = input.required<string>();
  readonly size = input(192);
  protected readonly drawing = computed(() => qrPath(this.qr()));
}
