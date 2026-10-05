import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const README = readFileSync(resolve(process.cwd(), '../packages/design-system/README.md'), 'utf8');

export function readmeBlock(heading: string, n = 0): string {
  const start = README.split('\n').findIndex((l) => /^#{2,4} /.test(l) && l.includes(heading));
  if (start < 0) throw new Error(`README heading not found: ${heading}`);
  const rest = README.split('\n').slice(start + 1);
  const end = rest.findIndex((l) => /^#{2,4} /.test(l));
  const section = (end < 0 ? rest : rest.slice(0, end)).join('\n');
  const blocks = [...section.matchAll(/```html\n([\s\S]*?)```/g)].map((m) => m[1]!);
  if (!blocks[n]) throw new Error(`README block ${n} under «${heading}» not found`);
  return blocks[n];
}

export function expandIcons(html: string, cls: string | null): string {
  return html.replace(/…#i-([a-z-]+)…/g, (_, name: string) =>
    cls === null
      ? `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`
      : `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`,
  );
}

const STATE_ATTRS: Record<string, string[]> = {
  input: ['value', 'checked'],
  textarea: ['value'],
  select: ['value'],
  option: ['selected'],
};

function walk(node: Node, out: string[], depth: number): void {
  const pad = '  '.repeat(depth);
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) out.push(`${pad}"${text}"`);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const skip = STATE_ATTRS[tag] ?? [];
  const attrs = [...el.attributes]
    .filter((a) => !skip.includes(a.name))
    .map((a) => `${a.name}="${a.name === 'style' ? normStyle(a.value) : a.value}"`)
    .sort();
  out.push(`${pad}<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
  const children = tag === 'template' ? (el as HTMLTemplateElement).content.childNodes : el.childNodes;
  for (const c of children) walk(c, out, depth + 1);
}

export function canonical(nodes: Iterable<Node>): string {
  const out: string[] = [];
  for (const n of nodes) walk(n, out, 0);
  return out.join('\n');
}

export function canonicalHtml(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return canonical(tpl.content.childNodes);
}

function normStyle(v: string): string {
  return v
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => d.replace(/\s*:\s*/, ': '))
    .join('; ');
}

export function readmeMenuIcons(): Map<string, string> {
  const start = README.indexOf('Иконки разделов');
  if (start < 0) throw new Error('README menu icon table not found');
  const out = new Map<string, string>();
  for (const line of README.slice(start).split('\n').slice(1)) {
    if (line.trim() === '') {
      if (out.size) break;
      continue;
    }
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter((c, i, all) => i > 0 && i < all.length - 1);
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const icon = /^`([a-z-]+)`$/.exec(cells[i + 1]!)?.[1];
      if (cells[i] && icon) out.set(cells[i]!, icon);
    }
  }
  return out;
}
