// Showcase helpers (not part of the design system; frameworks implement their own behaviour).
// - ?theme=light|dark puts data-theme on <html>; without it, pages marked data-ds-split render
//   the specimen twice: light and dark columns side by side.
// - injects a placeholder icon sprite (the real sprite arrives with Task 18, same symbol ids);
// - wires the small demos: combobox, switch, tabs, dialog, sort buttons, drop zone, filters.
(() => {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

  const ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
    filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    upload: '<path d="M12 16V5M7 10l5-5 5 5M5 20h14"/>',
    'chevron-left': '<path d="m15 6-6 6 6 6"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/>',
    batch: '<rect x="4" y="7" width="16" height="13" rx="2"/><path d="M4 11.5h16M9.5 7V4h5v3"/>',
    field:
      '<path d="M3 19c5-4 13-4 18 0M5 14.5c4-3 10-3 14 0M8 10c2.5-1.6 5.5-1.6 8 0"/><circle cx="17.5" cy="5" r="1.5"/>',
    waybill: '<path d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5"/>',
    flask: '<path d="M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M9 3h6M7.5 15h9"/>',
    recall: '<path d="M12 4 2.8 19.5h18.4zM12 10v4M12 16.8v.2"/>',
    qr: '<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><path d="M14 14h2v2M18 18h2v2M14 20h2M20 14v2"/>',
    graph:
      '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="9" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="m8.4 7 7.2 1.2M7 8.4l1.4 7.2M16.3 10.8l-5.6 5.4"/>',
    more: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
    users:
      '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M15.5 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
    truck:
      '<path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>',
    trash: '<path d="M5 7h14M9.5 7V4h5v3M7 7l1 13h8l1-13"/>',
    scale: '<path d="M12 4v16M7 20h10M5 8h14M5 8l-2.5 6h5zM19 8l-2.5 6h5z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    building: '<path d="M5 21V4h10v17M15 9h4v12M3 21h18M8.5 8h3M8.5 12h3M8.5 16h3"/>',
  };
  const sprite =
    '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">' +
    Object.entries(ICONS)
      .map(
        ([id, body]) =>
          `<symbol id="i-${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</symbol>`,
      )
      .join('') +
    '</svg>';

  function splitThemes() {
    const col = document.querySelector('[data-ds-split] .ds-col');
    if (!col) return;
    if (theme) {
      col.removeAttribute('data-theme');
      return;
    }
    const dark = col.cloneNode(true);
    dark.dataset.theme = 'dark';
    dark.setAttribute('aria-label', 'Тёмная тема');
    col.setAttribute('aria-label', 'Светлая тема');
    const ids = new Set([...dark.querySelectorAll('[id]')].map((el) => el.id));
    const fix = (v) => (ids.has(v) ? `${v}-dark` : v);
    for (const el of dark.querySelectorAll('*')) {
      if (el.id) el.id = fix(el.id);
      for (const a of [
        'for',
        'aria-describedby',
        'aria-controls',
        'aria-labelledby',
        'aria-activedescendant',
      ]) {
        const v = el.getAttribute(a);
        if (v) el.setAttribute(a, v.split(' ').map(fix).join(' '));
      }
      if (el.name && el.type === 'radio') el.name = `${el.name}-dark`;
    }
    col.after(dark);
    col.parentElement.classList.add('ds-cols--split');
  }

  function wire() {
    for (const sw of document.querySelectorAll('.at-switch:not(:disabled)')) {
      sw.addEventListener('click', () =>
        sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true')),
      );
    }
    for (const el of document.querySelectorAll('input[data-indeterminate]')) el.indeterminate = true;

    for (const box of document.querySelectorAll('.at-combobox[data-ds-live]')) {
      const input = box.querySelector('[role=combobox]');
      const list = box.querySelector('[role=listbox]');
      const options = () => [...list.querySelectorAll('[role=option]:not([aria-disabled=true])')];
      let active = -1;
      const open = (v) => {
        list.hidden = !v;
        input.setAttribute('aria-expanded', String(v));
        if (!v) input.removeAttribute('aria-activedescendant');
      };
      const highlight = (i) => {
        const all = options();
        active = Math.max(0, Math.min(all.length - 1, i));
        all.forEach((o, n) => o.toggleAttribute('data-active', n === active));
        input.setAttribute('aria-activedescendant', all[active].id);
        all[active].scrollIntoView({ block: 'nearest' });
      };
      const choose = (o) => {
        options().forEach((x) => x.setAttribute('aria-selected', String(x === o)));
        input.value = o.dataset.value ?? o.firstChild.textContent.trim();
        open(false);
      };
      input.addEventListener('keydown', (e) => {
        const all = options();
        const actions = {
          ArrowDown: () => (list.hidden ? open(true) : highlight(active + 1)),
          ArrowUp: () => highlight(active - 1),
          Home: () => !list.hidden && highlight(0),
          End: () => !list.hidden && highlight(all.length - 1),
          Enter: () => !list.hidden && all[active] && choose(all[active]),
          Escape: () => open(false),
        };
        const act = actions[e.key];
        if (!act || (list.hidden && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        act();
      });
      input.addEventListener('input', () => open(true));
      list.addEventListener('mousedown', (e) => e.preventDefault());
      list.addEventListener('click', (e) => {
        const o = e.target.closest('[role=option]');
        if (o && o.getAttribute('aria-disabled') !== 'true') choose(o);
      });
      input.addEventListener('blur', () => open(false));
    }

    for (const list of document.querySelectorAll('[role=tablist]')) {
      const tabs = [...list.querySelectorAll('[role=tab]')];
      const select = (t) => {
        for (const x of tabs) {
          const on = x === t;
          x.setAttribute('aria-selected', String(on));
          x.tabIndex = on ? 0 : -1;
          const panel = document.getElementById(x.getAttribute('aria-controls'));
          if (panel) panel.hidden = !on;
        }
        t.focus();
      };
      list.addEventListener('click', (e) => {
        const t = e.target.closest('[role=tab]');
        if (t) select(t);
      });
      list.addEventListener('keydown', (e) => {
        const i = tabs.indexOf(document.activeElement);
        const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        select(tabs[(next + tabs.length) % tabs.length]);
      });
    }

    for (const btn of document.querySelectorAll('[data-ds-open-dialog]')) {
      const dlg = document.getElementById(btn.dataset.dsOpenDialog);
      btn.addEventListener('click', () => {
        dlg.showModal();
        if (btn.hasAttribute('aria-expanded')) btn.setAttribute('aria-expanded', 'true');
        // Initial focus: first field in the body, else the title (README «Диалог»).
        const first = dlg.querySelector('.at-dialog__body :is(input, select, textarea, a, button)');
        (first ?? dlg.querySelector('.at-dialog__title'))?.focus();
      });
      dlg.addEventListener('close', () => {
        if (btn.hasAttribute('aria-expanded')) btn.setAttribute('aria-expanded', 'false');
      });
    }
    // Backdrop click closes only dialogs without an irreversible action.
    for (const dlg of document.querySelectorAll('dialog[data-ds-light-dismiss]')) {
      dlg.addEventListener('click', (e) => {
        if (e.target === dlg) dlg.close();
      });
    }
    for (const btn of document.querySelectorAll('dialog [data-ds-close]')) {
      btn.addEventListener('click', () => btn.closest('dialog').close());
    }

    for (const btn of document.querySelectorAll('.at-table__sort')) {
      btn.addEventListener('click', () => {
        const th = btn.closest('th');
        const next = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
        for (const other of th.parentElement.querySelectorAll('th[aria-sort]'))
          other.setAttribute('aria-sort', 'none');
        th.setAttribute('aria-sort', next);
      });
    }

    // at-date: the same logic as @agrotrace/i18n maskRuDateInput / parseRuDate / formatRuDate
    // (frameworks import those; the showcase is plain JS).
    const mask = (raw) => {
      const iso = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(raw);
      if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
      const d = raw.replace(/\D/g, '').slice(0, 8);
      return [d.slice(0, 2), d.slice(2, 4), d.slice(4)].filter(Boolean).join('.');
    };
    const toIso = (text) => {
      const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim());
      return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
    };
    for (const box of document.querySelectorAll('.at-date')) {
      const text = box.querySelector('.at-input');
      const native = box.querySelector('.at-date__native');
      text.addEventListener('input', () => {
        text.value = mask(text.value);
      });
      box.querySelector('.at-date__button').addEventListener('click', () => {
        native.value = toIso(text.value);
        native.showPicker?.();
      });
      native.addEventListener('change', () => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(native.value);
        if (m) text.value = `${m[3]}.${m[2]}.${m[1]}`;
        text.focus();
      });
    }

    for (const zone of document.querySelectorAll('.at-file')) {
      zone.addEventListener('dragover', (e) => (e.preventDefault(), zone.setAttribute('data-dragover', '')));
      zone.addEventListener('dragleave', () => zone.removeAttribute('data-dragover'));
      zone.addEventListener('drop', (e) => (e.preventDefault(), zone.removeAttribute('data-dragover')));
    }

    // Filters: a <details> that is always open from 768 px up, collapsible below.
    const wide = matchMedia('(min-width: 768px)');
    const syncFilters = () => {
      for (const d of document.querySelectorAll('.at-page__filters')) d.open = wide.matches;
    };
    syncFilters();
    wide.addEventListener('change', syncFilters);

    for (const a of document.querySelectorAll('[data-ds-keep-theme]')) {
      if (theme) a.href += `?theme=${theme}`;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.body.insertAdjacentHTML('afterbegin', sprite);
    splitThemes();
    wire();
  });
})();
