// The static screen of a bootstrap chunk that failed twice (rulings FM15, FM17): no framework, README markup
// (`at-page`, `at-card` with `at-empty`: one line and one primary button) and no title. The entry carries no i18n
// bundle (the public page budget): the texts equal `empty.pageLoadFailed` and `action.retry` of @agrotrace/i18n — a
// test (test/app/boot.test.ts) keeps them equal.

export const BOOT_TEXTS = {
  text: 'Не удалось загрузить страницу.',
  retry: 'Повторить',
} as const;

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
