import { UI } from '../../src/app/ui';
import { QrComponent } from '../../src/app/ui/qr';

export function leakedInputAttributes(root: Element): string[] {
  const native = new Set([
    'id',
    'name',
    'value',
    'type',
    'disabled',
    'hidden',
    'title',
    'label',
    'size',
    'checked',
    'href',
    'src',
    'alt',
    'selected',
    'min',
    'max',
    'accept',
    'multiple',
    'width',
    'height',
  ]);
  const inputs = new Set<string>();
  for (const type of [...UI, QrComponent]) {
    const def =
      (type as unknown as Record<string, { inputs?: Record<string, unknown> }>)['ɵcmp'] ??
      (type as unknown as Record<string, { inputs?: Record<string, unknown> }>)['ɵdir'];
    for (const k of Object.keys(def?.inputs ?? {}))
      if (!native.has(k.toLowerCase())) inputs.add(k.toLowerCase());
  }
  const out: string[] = [];
  for (const el of root.querySelectorAll('*'))
    for (const a of el.attributes)
      if (inputs.has(a.name)) out.push(`<${el.tagName.toLowerCase()} ${a.name}>`);
  return out;
}

export function expectNoLeakedInputs(root: Element): void {
  const leaks = leakedInputAttributes(root);
  if (leaks.length) throw new Error(`wrapper inputs written as static attributes: ${leaks.join(', ')}`);
}
