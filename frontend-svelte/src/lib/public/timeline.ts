import { withVariant } from '@agrotrace/api-client/public';
import { initials } from './data.svelte';

export interface Step {
  at: string;
  atText: string;
  orgName: string;
  logoUrl: string | null;
  typeText: string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function avatar(name: string, logo: string | null): HTMLElement {
  const span = el('span', 'at-avatar');
  span.dataset.size = 's';
  span.dataset.shape = 'square';
  if (logo) {
    const img = document.createElement('img');
    img.src = withVariant(logo, 96);
    img.alt = '';
    span.append(img);
  } else {
    span.setAttribute('aria-hidden', 'true');
    span.textContent = initials(name);
  }
  return span;
}

export function timeline(node: HTMLOListElement, steps: Step[]) {
  const render = (list: Step[]) =>
    node.replaceChildren(
      ...list.map((s, i) => {
        const li = el('li', 'at-timeline__item');
        if (i === list.length - 1) li.dataset.current = '';
        const time = el('time', 'at-timeline__time', s.atText);
        time.dateTime = s.at;
        const meta = el('p', 'at-timeline__meta');
        meta.append(avatar(s.orgName, s.logoUrl), s.typeText);
        li.append(time, el('p', 'at-timeline__title', s.orgName), meta);
        return li;
      }),
    );
  render(steps);
  return { update: render };
}
