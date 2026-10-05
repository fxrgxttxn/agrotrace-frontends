(() => {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

  const text = (url) => fetch(url).then((r) => (r.ok ? r.text() : Promise.reject(new Error(url))));

  async function loadGraphics() {
    const [sprite, names] = await Promise.all([
      text('../sprite.svg'),
      document.querySelector('[data-ds-icons]') ? text('../icons/manifest.json').then(JSON.parse) : [],
    ]);
    document.body.insertAdjacentHTML('afterbegin', sprite);
    for (const list of document.querySelectorAll('[data-ds-icons]')) {
      list.innerHTML = names
        .map(
          (n) =>
            `<li class="ds-icon"><span class="ds-icon__art">` +
            `<svg width="24" height="24" aria-hidden="true"><use href="#i-${n}"/></svg>` +
            `<svg width="16" height="16" aria-hidden="true"><use href="#i-${n}"/></svg>` +
            `</span><code class="ds-name">${n}</code></li>`,
        )
        .join('');
    }
    const slots = [...document.querySelectorAll('[data-ds-art]')];
    const arts = await Promise.all(slots.map((s) => text(`../illustrations/${s.dataset.dsArt}.svg`)));
    slots.forEach((slot, i) => {
      const tpl = document.createElement('template');
      tpl.innerHTML = arts[i].trim();
      const art = tpl.content.firstElementChild;
      for (const a of slot.attributes) if (a.name !== 'data-ds-art') art.setAttribute(a.name, a.value);
      slot.replaceWith(art);
    });
  }

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
        const first = dlg.querySelector('.at-dialog__body :is(input, select, textarea, a, button)');
        (first ?? dlg.querySelector('.at-dialog__title'))?.focus();
      });
      dlg.addEventListener('close', () => {
        if (btn.hasAttribute('aria-expanded')) btn.setAttribute('aria-expanded', 'false');
      });
    }
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

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      await loadGraphics();
    } finally {
      splitThemes();
      wire();
      document.documentElement.dataset.dsReady = '';
    }
  });
})();
