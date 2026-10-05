import { Directive, ElementRef, inject, input, effect } from '@angular/core';

export interface ParsedArt {
  viewBox: string;
  inner: string;
}

export function parseArt(raw: string): ParsedArt | null {
  const m = /^\s*<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>\s*$/.exec(raw);
  return m ? { viewBox: m[1]!, inner: m[2]!.trim() } : null;
}

@Directive({ selector: 'svg[atArt]', standalone: true })
export class ArtDirective {
  readonly atArt = input.required<ParsedArt>();
  constructor() {
    const el = inject<ElementRef<SVGSVGElement>>(ElementRef).nativeElement;
    effect(() => {
      const art = this.atArt();
      el.setAttribute('viewBox', art.viewBox);
      el.innerHTML = art.inner;
    });
  }
}
