import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '../../packages/design-system/illustrations');
const OUT = join(here, '../src/app/ui/illustrations.generated.ts');

export function generate() {
  const names = readdirSync(SRC)
    .filter((f) => f.endsWith('.svg'))
    .map((f) => f.slice(0, -4))
    .sort();
  const cases = [];
  const boxes = [];
  for (const name of names) {
    const raw = readFileSync(join(SRC, `${name}.svg`), 'utf8');
    const m = /^\s*<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>\s*$/.exec(raw);
    if (!m) throw new Error(`${name}.svg: unexpected markup`);
    const inner = m[2].trim();
    if (/[{}@`$]/.test(inner)) throw new Error(`${name}.svg: characters Angular templates reserve`);
    const elements = [...inner.matchAll(/<([a-z]+)\b([^>]*?)\s*\/>/g)];
    const rest = inner.replace(/<([a-z]+)\b([^>]*?)\s*\/>/g, '').trim();
    if (rest)
      throw new Error(`${name}.svg: only self-closing elements are expected, found: ${rest.slice(0, 60)}`);
    const attrsOf = (a) => a.replace(/ style="([^"']*)"/g, ' [attr.style]="\'$1\'"');
    const body = elements
      .map(([, tag, attrs]) => `<svg:${tag}${attrsOf(attrs)}></svg:${tag}>`)
      .join('\n          ');
    cases.push(`      @case ('${name}') {\n          ${body}\n        }`);
    boxes.push(`  '${name}': '${m[1]}',`);
  }
  return `import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type IllustrationName =
${names.map((n) => `  | '${n}'`).join('\n')};

export const ILLUSTRATIONS: readonly IllustrationName[] = [${names.map((n) => `'${n}'`).join(', ')}];

const VIEW_BOX: Record<IllustrationName, string> = {
${boxes.join('\n')}
};

@Component({
  selector: 'svg[art]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', '[attr.viewBox]': 'viewBox()' },
  template: \`@switch (art()) {
${cases.join('\n')}
    }\`,
})
export class IllustrationComponent {
  readonly art = input.required<IllustrationName>();
  protected readonly viewBox = computed(() => VIEW_BOX[this.art()]);
}
`;
}

const text = generate();
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {}
  if (current !== text) {
    console.error(
      'illustrations.generated.ts is out of date — run `pnpm --filter @agrotrace/frontend-angular illustrations`',
    );
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
