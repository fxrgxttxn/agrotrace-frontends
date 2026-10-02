import { Directive, ElementRef, inject, input, effect } from '@angular/core';

// An inlined illustration (README «Иконки и иллюстрации»): the inner markup of a file of
// packages/design-system/illustrations inside our own `<svg class="at-empty__art" aria-hidden="true">`. Only the ones
// the public page shows are bundled (the trusted files of the design system: written as markup, not sanitized).

export interface ParsedArt {
  viewBox: string;
  inner: string;
}

/** Parses the raw text of an illustration file. */
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
