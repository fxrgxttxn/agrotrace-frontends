export const BOOT_TEXTS = __AT_BOOT_TEXTS__;

export function renderBootFailure(root: HTMLElement): void {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
    const node = document.createElement(tag);
    node.className = cls;
    if (text) node.textContent = text;
    return node;
  };
  const main = el('main', 'at-page');
  main.id = 'main';
  main.tabIndex = -1;
  main.style.maxWidth = '30rem';
  main.style.marginInline = 'auto';
  const empty = el('div', 'at-empty');
  empty.append(el('p', 'at-empty__text', BOOT_TEXTS.text));
  const button = el('button', 'at-button', BOOT_TEXTS.retry);
  button.type = 'button';
  button.dataset.variant = 'primary';
  button.addEventListener('click', () => window.location.reload());
  empty.append(button);
  const card = el('article', 'at-card');
  card.append(empty);
  main.append(card);
  root.replaceChildren(main);
}
