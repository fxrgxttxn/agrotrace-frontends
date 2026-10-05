import { beforeEach, describe, expect, it } from 'vitest';
import {
  arrive,
  keepFocusFor,
  resetRouteFocus,
  restoreKeptFocus,
  skipRouteFocus,
} from '../../src/lib/app/routeFocus';

function title(): HTMLHeadingElement {
  const h1 = document.createElement('h1');
  h1.tabIndex = -1;
  document.body.append(h1);
  return h1;
}

beforeEach(() => {
  resetRouteFocus();
  document.body.replaceChildren();
});

describe('route focus rule', () => {
  it('the first page (first load, start-up redirects included) leaves focus alone', () => {
    const h1 = title();
    arrive('/login', h1);
    expect(document.activeElement).toBe(document.body);
  });

  it('a new pathname focuses the new title; the same pathname (query-only, repeated report) does not', () => {
    arrive('/batches', title());
    const fields = title();
    arrive('/fields', fields);
    expect(document.activeElement).toBe(fields);
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    arrive('/fields', fields);
    expect(document.activeElement).toBe(other);
  });

  it('a pick in «Ещё» skips exactly that arrival', () => {
    arrive('/batches', title());
    const more = document.createElement('button');
    document.body.append(more);
    more.focus();
    skipRouteFocus('/profile');
    arrive('/profile', title());
    expect(document.activeElement).toBe(more);
    const fields = title();
    arrive('/fields', fields);
    expect(document.activeElement).toBe(fields);
  });

  it('a skip announced for another path does not suppress this one (a redirect happened instead)', () => {
    arrive('/batches', title());
    skipRouteFocus('/profile');
    const h1 = title();
    arrive('/403', h1);
    expect(document.activeElement).toBe(h1);
  });
});

describe('a query-only navigation that started with nothing focused', () => {
  const at = (path: string) => new URL(path, 'http://app.test');

  it('leaves nothing focused when only the router moved the focus meanwhile', () => {
    const select = document.createElement('select');
    document.body.append(select);
    keepFocusFor(at('/batches'), at('/batches?status=SHIPPED'));
    select.focus();
    restoreKeptFocus();
    expect(document.activeElement).toBe(document.body);
  });

  it('keeps a focus the person moved during the navigation (no blur of their field)', () => {
    const search = document.createElement('input');
    document.body.append(search);
    keepFocusFor(at('/batches'), at('/batches?status=SHIPPED'));
    search.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    search.focus();
    restoreKeptFocus();
    expect(document.activeElement).toBe(search);
  });
});
