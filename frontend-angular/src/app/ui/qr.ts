import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { encode } from 'uqr';

/** SVG path of the dark modules, one rectangle per horizontal run. */
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

/** A QR code drawn client-side as inline SVG (no image request, nothing for the CSP to block), as the React app's
 * `Qr`. It always stays dark on light — the wrapper pins the light theme (`data-theme="light"`, README «Темы») so
 * scanners read it in the dark theme too; the quiet zone is part of the drawing. */
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
  /** The text to encode (e.g. an `otpauth://` URI). */
  readonly qr = input.required<string>();
  readonly label = input.required<string>();
  readonly size = input(192);
  protected readonly drawing = computed(() => qrPath(this.qr()));
}
