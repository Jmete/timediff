(function () {
  'use strict';

  const STORAGE_KEY = 'timediff.cities';
  const SETTINGS_KEY = 'timediff.settings';
  const THEME_KEY = 'timediff.theme';
  const HOUR = 3600000;

  const CATEGORIES = [
    { id: 'work', label: 'Work' },
    { id: 'busy', label: 'Busy' },
    { id: 'sleep', label: 'Sleeping' },
    { id: 'free', label: 'Free' },
  ];
  const CAT_IDS = CATEGORIES.map((c) => c.id);
  const catLabel = (id) => (CATEGORIES.find((c) => c.id === id) || {}).label || '';
  const DEFAULT_COLORS = { work: '#3d8bff', busy: '#ff3b3b', sleep: '#7d828c', free: '#2fdc76' };
  const DEFAULT_REF_HEADER = '#c8ff00';
  const defaultSchedule = () => Array.from({ length: 24 }, (_, h) => (h >= 9 && h < 17 ? 'work' : null));
  // Weekdays use JS numbering (0 = Sunday); the editor lists them Monday first.
  const DAY_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const defaultWorkDays = () => [1, 2, 3, 4, 5];

  const $ = (sel) => document.querySelector(sel);
  const root = document.documentElement;
  const board = $('#board');
  const headRow = $('#head-row');
  const bodyRows = $('#body-rows');
  const cellMenu = $('#cell-menu');

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function button(className, text, attrs) {
    const b = el('button', className, text);
    b.type = 'button';
    for (const k in attrs || {}) b.setAttribute(k, attrs[k]);
    return b;
  }

  // ---------- Time zone helpers (built on Intl, which tracks DST rules) ----------

  const partsFmtCache = new Map();
  function partsFormatter(tz) {
    if (!partsFmtCache.has(tz)) {
      partsFmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
      }));
    }
    return partsFmtCache.get(tz);
  }

  function zonedParts(date, tz) {
    const out = {};
    for (const p of partsFormatter(tz).formatToParts(date)) out[p.type] = p.value;
    return {
      year: +out.year, month: +out.month, day: +out.day,
      hour: +out.hour % 24, minute: +out.minute, second: +out.second,
      weekday: out.weekday,
    };
  }

  // Offset of `tz` from UTC in minutes at the given instant.
  function offsetMinutes(tz, ms) {
    const p = zonedParts(new Date(ms), tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  }

  // UTC instant of local midnight (today) in `tz`.
  function startOfLocalDay(now, tz) {
    const p = zonedParts(now, tz);
    const guess = Date.UTC(p.year, p.month - 1, p.day);
    let utc = guess - offsetMinutes(tz, guess) * 60000;
    utc = guess - offsetMinutes(tz, utc) * 60000;
    return utc;
  }

  function formatOffset(mins) {
    const sign = mins < 0 ? '−' : '+';
    const a = Math.abs(mins);
    const h = Math.floor(a / 60), m = a % 60;
    return 'GMT' + (mins === 0 ? '' : sign + h + (m ? ':' + String(m).padStart(2, '0') : ''));
  }

  // DST is active when the current offset is the larger of the year's two offsets.
  function isDst(tz, now) {
    const y = zonedParts(now, tz).year;
    const jan = offsetMinutes(tz, Date.UTC(y, 0, 1));
    const jul = offsetMinutes(tz, Date.UTC(y, 6, 1));
    if (jan === jul) return null; // zone doesn't observe DST
    return offsetMinutes(tz, now.getTime()) === Math.max(jan, jul);
  }

  function to12h(h, m) {
    const suffix = h < 12 ? 'AM' : 'PM';
    const hh = h % 12 === 0 ? 12 : h % 12;
    return { hh, text: hh + ':' + String(m).padStart(2, '0'), suffix };
  }

  function isValidTz(tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
  }

  // ---------- Color helpers ----------

  function normalizeHex(s) {
    if (typeof s !== 'string') return null;
    let h = s.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((c) => c + c).join('');
    return /^[0-9a-f]{6}$/i.test(h) ? '#' + h.toLowerCase() : null;
  }

  // Pick black or off-white text for a given background.
  function textOn(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.23 ? '#0a0b0d' : '#f1efe8';
  }

  // Color picker + hex text field. `onChange(hexOrNull)` fires on every valid edit.
  function colorField({ value, fallback, onChange, resetTo, resetLabel }) {
    const wrap = el('div', 'color-field');
    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.className = 'swatch-input';
    swatch.setAttribute('aria-label', 'Pick color');
    const hash = el('span', 'hex-hash', '#');
    const hex = document.createElement('input');
    hex.type = 'text';
    hex.className = 'hex-input';
    hex.maxLength = 7;
    hex.spellcheck = false;
    hex.autocomplete = 'off';
    hex.setAttribute('aria-label', 'Hex code');
    const hexWrap = el('label', 'hex-wrap');
    hexWrap.append(hash, hex);

    let fb = fallback;
    function show(v, newFallback) {
      if (newFallback !== undefined) fb = newFallback;
      swatch.value = v || fb;
      hex.value = v ? v.slice(1).toUpperCase() : '';
      hex.placeholder = v ? '' : 'AUTO';
      hexWrap.classList.remove('invalid');
      wrap.classList.toggle('is-default', !v);
    }
    swatch.addEventListener('input', () => {
      hex.value = swatch.value.slice(1).toUpperCase();
      hexWrap.classList.remove('invalid');
      wrap.classList.remove('is-default');
      onChange(swatch.value.toLowerCase());
    });
    hex.addEventListener('input', () => {
      const v = normalizeHex(hex.value);
      hexWrap.classList.toggle('invalid', !!hex.value && !v);
      if (v) { swatch.value = v; wrap.classList.remove('is-default'); onChange(v); }
    });
    hex.addEventListener('blur', () => {
      const v = normalizeHex(hex.value);
      if (v) hex.value = v.slice(1).toUpperCase();
    });
    wrap.append(swatch, hexWrap);
    if (resetTo !== undefined) {
      const r = button('text-btn', resetLabel || 'Reset');
      r.addEventListener('click', () => { show(resetTo); onChange(resetTo); });
      wrap.append(r);
    }
    show(value);
    return { el: wrap, set: show };
  }

  // ---------- State ----------

  const newId = () => Math.random().toString(36).slice(2, 10);

  function sanitizeCity(c) {
    if (!c || typeof c.city !== 'string' || !isValidTz(c.tz)) return null;
    const out = {
      id: typeof c.id === 'string' ? c.id : newId(),
      city: c.city,
      country: typeof c.country === 'string' ? c.country : '',
      tz: c.tz,
    };
    if (typeof c.label === 'string' && c.label.trim()) out.label = c.label.trim().slice(0, 40);
    const hc = normalizeHex(c.headerColor);
    if (hc) out.headerColor = hc;
    out.schedule = Array.isArray(c.schedule) && c.schedule.length === 24
      ? c.schedule.map((s) => (CAT_IDS.includes(s) ? s : null))
      : defaultSchedule();
    out.workDays = Array.isArray(c.workDays)
      ? [...new Set(c.workDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : defaultWorkDays();
    return out;
  }

  const defaultCities = () => window.DEFAULT_CITIES.map(sanitizeCity);

  function loadCities() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (Array.isArray(saved)) {
        const list = saved.map(sanitizeCity).filter(Boolean);
        if (list.length) return list;
      }
    } catch { /* fall through to defaults */ }
    return defaultCities();
  }

  function loadSettings() {
    const s = { colors: { ...DEFAULT_COLORS } };
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      for (const id of CAT_IDS) {
        const v = saved && saved.colors && normalizeHex(saved.colors[id]);
        if (v) s.colors[id] = v;
      }
    } catch { /* defaults */ }
    return s;
  }

  let cities = loadCities();
  let settings = loadSettings();
  const saveCities = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(cities));
  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

  const displayName = (c) => c.label || c.city;
  const headerColorFor = (c, i) => c.headerColor || (i === 0 ? DEFAULT_REF_HEADER : null);

  function applyColors() {
    for (const id of CAT_IDS) root.style.setProperty('--cat-' + id, settings.colors[id]);
  }

  // ---------- Rendering: header ----------

  const clockEls = [];

  const ICON_EDIT = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="miter"/></svg>';

  function toolBtn(label, action, idx, html, extraClass) {
    const b = button('mini-btn' + (extraClass ? ' ' + extraClass : ''), null, { title: label, 'aria-label': label });
    b.dataset.action = action;
    b.dataset.idx = idx;
    b.innerHTML = html;
    return b;
  }

  function renderHead(now) {
    headRow.replaceChildren();
    clockEls.length = 0;

    cities.forEach((c, i) => {
      const th = el('th');
      th.scope = 'col';
      if (i === 0) th.classList.add('ref');
      const color = headerColorFor(c, i);
      if (color) {
        th.classList.add('tinted');
        th.style.setProperty('--hbg', color);
        th.style.setProperty('--hfg', textOn(color));
      }

      const top = el('div', 'th-top');
      const tag = el('span', 'tag', String(i + 1).padStart(2, '0'));
      if (i === 0) tag.append(el('span', 'tag-ref', ' // REF'));
      const tools = el('div', 'col-tools');
      if (i > 0) tools.append(toolBtn('Move left' + (i === 1 ? ' (make reference)' : ''), 'left', i, '‹', 'desk'));
      if (i < cities.length - 1) tools.append(toolBtn('Move right', 'right', i, '›', 'desk'));
      if (cities.length > 1) tools.append(toolBtn('Remove', 'remove', i, '✕', 'desk danger'));
      tools.append(toolBtn('Edit name, color & schedule', 'edit', i, ICON_EDIT, 'edit'));
      top.append(tag, tools);

      const name = el('div', 'name', displayName(c));
      name.title = displayName(c) + ' — click to edit';
      name.dataset.action = 'edit';
      name.dataset.idx = i;
      const cityCountry = !c.country ? c.city : c.country.startsWith(c.city) ? c.country : c.city + ', ' + c.country;
      const loc = el('div', 'loc', c.label ? cityCountry : c.country || c.tz);
      loc.title = loc.textContent;

      const clock = el('div', 'clock');
      const time = el('span', 'clock-time');
      const sfx = el('span', 'clock-suffix');
      clock.append(time, sfx);

      const meta = el('div', 'meta');
      const date = el('span', 'meta-date');
      const off = el('span', 'meta-off');
      meta.append(date, off);

      th.append(top, name, loc, clock, meta);
      headRow.append(th);
      clockEls.push({ tz: c.tz, time, sfx, date, off });
    });

    const addTh = el('th', 'add-col');
    const addBtn = button('add-btn', null, { 'aria-label': 'Add city', title: 'Add city' });
    addBtn.innerHTML = '<span>+</span><small>ADD</small>';
    addBtn.addEventListener('click', openAddDialog);
    addTh.append(addBtn);
    headRow.append(addTh);

    $('#wm-count').textContent = String(cities.length).padStart(2, '0');
    updateClocks(now);
  }

  function updateClocks(now) {
    for (const e of clockEls) {
      const p = zonedParts(now, e.tz);
      const t = to12h(p.hour, p.minute);
      e.time.textContent = t.text;
      e.sfx.textContent = t.suffix;
      e.date.textContent = now.toLocaleDateString('en-US', { timeZone: e.tz, weekday: 'short', month: 'short', day: 'numeric' });
      const offText = formatOffset(offsetMinutes(e.tz, now.getTime()));
      if (e.off.dataset.v !== offText) {
        e.off.dataset.v = offText;
        e.off.replaceChildren(offText);
        if (isDst(e.tz, now)) {
          const d = el('span', 'dst', 'DST');
          d.title = 'Daylight saving time is in effect';
          e.off.append(' ', d);
        }
      }
    }
  }

  // ---------- Rendering: body ----------

  function renderBody(now) {
    const refTz = cities[0].tz;
    const start = startOfLocalDay(now, refTz);
    const refParts = zonedParts(new Date(start), refTz);
    const refDay = Date.UTC(refParts.year, refParts.month - 1, refParts.day);
    const currentIdx = Math.min(23, Math.max(0, Math.floor((now - start) / HOUR)));

    const frag = document.createDocumentFragment();
    for (let r = 0; r < 24; r++) {
      const instant = new Date(start + r * HOUR);
      const tr = el('tr');
      if (r === currentIdx) tr.classList.add('current');

      cities.forEach((c, i) => {
        const p = zonedParts(instant, c.tz);
        const td = el('td');
        td.dataset.col = i;
        td.dataset.hour = p.hour;
        if (i === 0) td.classList.add('ref');
        // Work hours only count on the column's work days (in its own local date).
        let cat = c.schedule[p.hour];
        if (cat === 'work' && !c.workDays.includes(DAY_KEYS.indexOf(p.weekday))) cat = null;
        if (cat) td.classList.add('cat', 'cat-' + cat);

        const t = to12h(p.hour, p.minute);
        td.dataset.label = t.text + ' ' + t.suffix;
        td.title = displayName(c) + ' · ' + td.dataset.label + (cat ? ' · ' + catLabel(cat) : '') + ' — click to set status';
        td.append(el('span', 'time', t.text), el('span', 'suffix', t.suffix));

        const dayDiff = Math.round((Date.UTC(p.year, p.month - 1, p.day) - refDay) / 86400000);
        if (dayDiff !== 0) {
          const chip = el('span', 'chip ' + (dayDiff > 0 ? 'ahead' : 'behind'), p.weekday);
          chip.title = (dayDiff > 0 ? 'Next day' : 'Previous day') + ' relative to ' + displayName(cities[0]);
          td.append(chip);
        }
        if (r === currentIdx && i === 0) td.append(el('span', 'now-pill', 'Now'));
        tr.append(td);
      });
      tr.append(el('td', 'pad'));
      frag.append(tr);
    }
    bodyRows.replaceChildren(frag);
  }

  // ---------- Render orchestration ----------

  let renderedKey = '';

  function stateKey(now) {
    const start = startOfLocalDay(now, cities[0].tz);
    return start + '#' + Math.floor((now - start) / HOUR);
  }

  // Full redraw. `scroll` re-centres the current hour.
  function renderAll(scroll) {
    const now = new Date();
    closeCellMenu();
    renderHead(now);
    renderBody(now);
    renderedKey = stateKey(now);
    if (scroll) scrollCurrentIntoView();
  }

  function tick() {
    const now = new Date();
    const key = stateKey(now);
    if (key !== renderedKey) {
      renderBody(now);
      renderedKey = key;
    }
    updateClocks(now);
  }

  function scrollCurrentIntoView() {
    const row = bodyRows.querySelector('tr.current');
    if (!row) return;
    const head = headRow.getBoundingClientRect().height;
    const target = row.offsetTop - head - (board.clientHeight - head) / 2 + row.offsetHeight / 2;
    board.scrollTop = Math.max(0, target);
  }

  // ---------- Column actions ----------

  function moveCity(from, to) {
    if (to < 0 || to >= cities.length || from === to) return;
    const [c] = cities.splice(from, 1);
    cities.splice(to, 0, c);
    saveCities();
    renderAll(false);
  }

  function removeCity(i) {
    if (cities.length <= 1) return;
    cities.splice(i, 1);
    saveCities();
    renderAll(false);
  }

  headRow.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const i = +t.dataset.idx;
    switch (t.dataset.action) {
      case 'edit': openColDialog(i); break;
      case 'remove': removeCity(i); break;
      case 'left': moveCity(i, i - 1); break;
      case 'right': moveCity(i, i + 1); break;
    }
  });

  $('#reset-btn').addEventListener('click', () => {
    if (!confirm('Reset cities, names, schedules and colors to the defaults?')) return;
    cities = defaultCities();
    settings = { colors: { ...DEFAULT_COLORS } };
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    applyColors();
    renderAll(true);
  });

  // ---------- Toast ----------

  const toastEl = $('#toast');
  let toastTimer;
  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('error', !!isError);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, isError ? 5000 : 2800);
  }

  // ---------- Config export / import ----------
  // Schedules are written as readable hour ranges, e.g. { "work": ["09:00-17:00"] },
  // so shared files are easy to hand-edit. Ranges may wrap midnight ("22:00-06:00").

  const CONFIG_APP = 'timediff';
  const CONFIG_VERSION = 1;
  const hh = (h) => String(h).padStart(2, '0') + ':00';

  function scheduleToRanges(schedule) {
    const out = {};
    for (const id of CAT_IDS) {
      const ranges = [];
      for (let h = 0; h < 24; h++) {
        if (schedule[h] !== id || schedule[h - 1] === id) continue;
        let end = h;
        while (end < 24 && schedule[end] === id) end++;
        ranges.push([h, end]);
      }
      // Merge a block that crosses midnight into one range, e.g. "22:00-06:00".
      const first = ranges[0], last = ranges[ranges.length - 1];
      if (ranges.length > 1 && first[0] === 0 && last[1] === 24) {
        ranges.pop();
        first[0] = last[0];
        ranges.push(ranges.shift());
      }
      const labels = ranges.map(([s, e]) => hh(s) + '-' + hh(e));
      if (labels.length) out[id] = labels;
    }
    return out;
  }

  function rangesToSchedule(obj) {
    if (Array.isArray(obj)) return obj; // raw 24-slot array is accepted too
    const schedule = Array(24).fill(null);
    if (!obj || typeof obj !== 'object') return schedule;
    for (const id of CAT_IDS) {
      const list = typeof obj[id] === 'string' ? [obj[id]] : obj[id];
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        const m = /^\s*(\d{1,2})(?::00)?\s*(?:-\s*(\d{1,2})(?::00)?)?\s*$/.exec(String(r));
        if (!m) continue;
        const start = +m[1];
        const end = m[2] === undefined ? start + 1 : +m[2];
        if (start > 23 || end > 24) continue;
        const len = ((end - start) % 24 + 24) % 24 || 24;
        for (let k = 0; k < len; k++) schedule[(start + k) % 24] = id;
      }
    }
    return schedule;
  }

  function buildConfig() {
    return {
      app: CONFIG_APP,
      version: CONFIG_VERSION,
      exportedAt: new Date().toISOString(),
      statusColors: { ...settings.colors },
      columns: cities.map((c) => {
        const col = { city: c.city, country: c.country, timeZone: c.tz };
        if (c.label) col.name = c.label;
        if (c.headerColor) col.headerColor = c.headerColor;
        col.schedule = scheduleToRanges(c.schedule);
        col.workDays = DAY_ORDER.filter((d) => c.workDays.includes(d)).map((d) => DAY_KEYS[d]);
        return col;
      }),
    };
  }

  function exportConfig() {
    const blob = new Blob([JSON.stringify(buildConfig(), null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = 'timediff-config-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Config downloaded');
  }

  // Returns { cities, colors } or throws an Error with a user-facing message.
  function parseConfig(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('File is not valid JSON.'); }
    if (!data || typeof data !== 'object' || !Array.isArray(data.columns)) {
      throw new Error('This doesn’t look like a TIME/DIFF config file.');
    }
    if (data.app && data.app !== CONFIG_APP) throw new Error('This config is for a different app ("' + data.app + '").');
    if (typeof data.version === 'number' && data.version > CONFIG_VERSION) {
      throw new Error('This config was made by a newer version of TIME/DIFF.');
    }
    const list = data.columns.map((col) => col && sanitizeCity({
      city: col.city,
      country: col.country,
      tz: col.timeZone || col.tz,
      label: col.name || col.label,
      headerColor: col.headerColor,
      schedule: rangesToSchedule(col.schedule),
      workDays: Array.isArray(col.workDays)
        ? col.workDays.map((d) => DAY_KEYS.findIndex((k) => k.toLowerCase() === String(d).slice(0, 3).toLowerCase()))
        : undefined,
    })).filter(Boolean);
    const skipped = data.columns.length - list.length;
    if (!list.length) throw new Error('No valid cities found in the file.');
    const colors = { ...DEFAULT_COLORS };
    for (const id of CAT_IDS) {
      const v = data.statusColors && normalizeHex(data.statusColors[id]);
      if (v) colors[id] = v;
    }
    return { cities: list, colors, skipped };
  }

  async function importFile(file) {
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('File is too large to be a config.');
      const cfg = parseConfig(await file.text());
      const names = cfg.cities.map(displayName).join(', ');
      if (!confirm('Load "' + file.name + '"?\n\n' + cfg.cities.length + ' columns: ' + names + '\n\nThis replaces your current layout and colors.')) return;
      document.querySelectorAll('dialog[open]').forEach((d) => d.close());
      cities = cfg.cities;
      settings = { colors: cfg.colors };
      saveCities();
      saveSettings();
      applyColors();
      renderAll(true);
      toast('Config loaded' + (cfg.skipped ? ' — skipped ' + cfg.skipped + ' invalid column(s)' : ''));
    } catch (err) {
      toast('Import failed: ' + err.message, true);
    }
  }

  const importInput = $('#import-file');
  $('#export-btn').addEventListener('click', exportConfig);
  $('#import-btn').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', () => {
    importFile(importInput.files[0]);
    importInput.value = ''; // allow re-importing the same file
  });

  // Drag & drop a config file anywhere on the page.
  const dropZone = $('#drop-zone');
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dropZone.hidden = false;
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    if (dragDepth && --dragDepth === 0) dropZone.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropZone.hidden = true;
    importFile(e.dataTransfer.files[0]);
  });

  // ---------- Dialog plumbing ----------

  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (e) => {
      if (e.target === d || e.target.closest('[data-close]')) d.close();
    });
  });

  // ---------- Cell status menu ----------

  let menuTd = null;

  function setStatus(col, hour, cat) {
    cities[col].schedule[hour] = cat;
    saveCities();
    renderBody(new Date());
  }

  function openCellMenu(td) {
    closeCellMenu();
    const col = +td.dataset.col;
    const hour = +td.dataset.hour;
    const c = cities[col];
    const current = c.schedule[hour];

    const head = el('div', 'menu-head');
    head.append(el('span', 'menu-name', displayName(c)), el('span', 'menu-time', td.dataset.label));
    cellMenu.replaceChildren(head);

    for (const cat of CATEGORIES) {
      const b = button('menu-item' + (current === cat.id ? ' active' : ''), null, { role: 'menuitemradio' });
      b.style.setProperty('--c', 'var(--cat-' + cat.id + ')');
      b.append(el('i', 'menu-swatch'), el('span', null, cat.label));
      b.addEventListener('click', () => { setStatus(col, hour, cat.id); closeCellMenu(); });
      cellMenu.append(b);
    }
    const clear = button('menu-item clear' + (current ? '' : ' active'), null, { role: 'menuitemradio' });
    clear.append(el('i', 'menu-swatch none'), el('span', null, 'None'));
    clear.addEventListener('click', () => { setStatus(col, hour, null); closeCellMenu(); });
    const edit = button('menu-item link', 'Edit full schedule…');
    edit.addEventListener('click', () => { closeCellMenu(); openColDialog(col); });
    cellMenu.append(clear, el('div', 'menu-sep'), edit);

    cellMenu.hidden = false;
    menuTd = td;
    td.classList.add('menu-open');
    const r = td.getBoundingClientRect();
    const mw = cellMenu.offsetWidth, mh = cellMenu.offsetHeight;
    const left = Math.min(Math.max(8, r.left), innerWidth - mw - 8);
    let top = r.bottom + 4;
    if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    cellMenu.style.left = left + 'px';
    cellMenu.style.top = top + 'px';
    cellMenu.querySelector('.menu-item').focus({ preventScroll: true });
  }

  function closeCellMenu() {
    if (cellMenu.hidden) return;
    cellMenu.hidden = true;
    if (menuTd) menuTd.classList.remove('menu-open');
    menuTd = null;
  }

  bodyRows.addEventListener('click', (e) => {
    const td = e.target.closest('td[data-col]');
    if (!td) return;
    if (menuTd === td) closeCellMenu();
    else openCellMenu(td);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!cellMenu.hidden && !cellMenu.contains(e.target) && !e.target.closest('td[data-col]')) closeCellMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCellMenu(); });
  board.addEventListener('scroll', closeCellMenu, { passive: true });
  window.addEventListener('resize', closeCellMenu);

  // ---------- Column editor ----------

  const colDialog = $('#col-dialog');
  const colName = $('#col-name');
  const hoursEl = $('#hours');
  const brushesEl = $('#brushes');
  let editId = null;
  let brush = 'work';

  const editIdx = () => cities.findIndex((c) => c.id === editId);
  const editCity = () => cities[editIdx()];

  const headerField = colorField({
    value: null,
    fallback: '#15181c',
    resetTo: null,
    resetLabel: 'Default',
    onChange(v) {
      const c = editCity();
      if (!c) return;
      if (v) c.headerColor = v; else delete c.headerColor;
      saveCities();
      renderHead(new Date());
    },
  });
  $('#col-color').append(headerField.el);

  for (const cat of [...CATEGORIES, { id: 'erase', label: 'Erase' }]) {
    const b = button('brush' + (cat.id === 'erase' ? ' erase' : ''), null, { role: 'radio', 'data-brush': cat.id });
    if (cat.id !== 'erase') b.style.setProperty('--c', 'var(--cat-' + cat.id + ')');
    b.append(el('i', 'brush-swatch'), el('span', null, cat.label));
    b.addEventListener('click', () => setBrush(cat.id));
    brushesEl.append(b);
  }
  function setBrush(id) {
    brush = id;
    brushesEl.querySelectorAll('.brush').forEach((b) => {
      const on = b.dataset.brush === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on);
    });
  }

  for (let h = 0; h < 24; h++) {
    const b = button('hour');
    b.dataset.hour = h;
    const t = to12h(h, 0);
    b.append(el('span', 'hour-n', t.hh), el('small', null, t.suffix));
    hoursEl.append(b);
  }

  function paintHourButtons() {
    const c = editCity();
    if (!c) return;
    hoursEl.querySelectorAll('.hour').forEach((b) => {
      const cat = c.schedule[+b.dataset.hour];
      b.className = 'hour' + (cat ? ' cat cat-' + cat : '');
      b.title = cat ? catLabel(cat) : 'No status';
    });
  }

  // Tap/drag painting. Starting a drag on a cell that already has the active
  // brush erases instead, so a single tap toggles.
  let paintValue;
  function paintAt(b) {
    const c = editCity();
    const h = +b.dataset.hour;
    if (!c || c.schedule[h] === paintValue) return;
    c.schedule[h] = paintValue;
    paintHourButtons();
    renderBody(new Date());
  }
  hoursEl.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.hour');
    if (!b) return;
    e.preventDefault();
    const target = brush === 'erase' ? null : brush;
    paintValue = editCity().schedule[+b.dataset.hour] === target ? null : target;
    paintAt(b);
  });
  hoursEl.addEventListener('pointermove', (e) => {
    if (paintValue === undefined) return;
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const b = t && t.closest('.hour');
    if (b && hoursEl.contains(b)) paintAt(b);
  });
  window.addEventListener('pointerup', () => {
    if (paintValue === undefined) return;
    paintValue = undefined;
    saveCities();
  });
  window.addEventListener('pointercancel', () => { paintValue = undefined; saveCities(); });

  const daysEl = $('#workdays');
  for (const d of DAY_ORDER) {
    const b = button('day', DAY_KEYS[d], { 'aria-pressed': 'false' });
    b.dataset.day = d;
    b.addEventListener('click', () => {
      const c = editCity();
      c.workDays = c.workDays.includes(d) ? c.workDays.filter((x) => x !== d) : [...c.workDays, d].sort();
      saveCities(); paintDayButtons(); renderBody(new Date());
    });
    daysEl.append(b);
  }
  function paintDayButtons() {
    const c = editCity();
    if (!c) return;
    daysEl.querySelectorAll('.day').forEach((b) => {
      const on = c.workDays.includes(+b.dataset.day);
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on);
    });
  }
  $('#days-weekdays').addEventListener('click', () => {
    editCity().workDays = defaultWorkDays();
    saveCities(); paintDayButtons(); renderBody(new Date());
  });
  $('#days-all').addEventListener('click', () => {
    editCity().workDays = [0, 1, 2, 3, 4, 5, 6];
    saveCities(); paintDayButtons(); renderBody(new Date());
  });

  $('#sched-default').addEventListener('click', () => {
    editCity().schedule = defaultSchedule();
    saveCities(); paintHourButtons(); renderBody(new Date());
  });
  $('#sched-clear').addEventListener('click', () => {
    editCity().schedule = Array(24).fill(null);
    saveCities(); paintHourButtons(); renderBody(new Date());
  });

  colName.addEventListener('input', () => {
    const c = editCity();
    const v = colName.value.trim();
    if (v) c.label = v; else delete c.label;
    saveCities();
    renderHead(new Date());
  });
  colName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); colDialog.close(); } });

  $('#col-remove').addEventListener('click', () => {
    const i = editIdx();
    if (i < 0) return;
    colDialog.close();
    removeCity(i);
  });
  $('#col-makeref').addEventListener('click', () => {
    const i = editIdx();
    if (i > 0) moveCity(i, 0);
    syncColDialog();
  });

  function syncColDialog() {
    const i = editIdx();
    const c = cities[i];
    if (!c) return;
    $('#col-kicker').textContent = 'COLUMN ' + String(i + 1).padStart(2, '0') + (i === 0 ? ' // REFERENCE' : '');
    colName.value = c.label || '';
    colName.placeholder = c.city;
    $('#col-loc').textContent = c.city + ', ' + c.country + ' · ' + c.tz.replace(/_/g, ' ');
    headerField.set(c.headerColor || null, i === 0 ? DEFAULT_REF_HEADER : '#15181c');
    $('#col-remove').disabled = cities.length <= 1;
    $('#col-makeref').hidden = i === 0;
    paintHourButtons();
    paintDayButtons();
  }

  function openColDialog(i) {
    editId = cities[i].id;
    setBrush(brush);
    syncColDialog();
    colDialog.showModal();
    // Avoid popping the on-screen keyboard on touch devices.
    if (matchMedia('(hover: hover)').matches) colName.focus();
  }

  // ---------- Status colors ----------

  const colorsDialog = $('#colors-dialog');
  const colorFields = {};
  for (const cat of CATEGORIES) {
    const row = el('div', 'color-row');
    const label = el('div', 'color-row-label');
    label.style.setProperty('--c', 'var(--cat-' + cat.id + ')');
    label.append(el('i', 'legend-swatch'), el('span', null, cat.label));
    const field = colorField({
      value: settings.colors[cat.id],
      fallback: DEFAULT_COLORS[cat.id],
      resetTo: DEFAULT_COLORS[cat.id],
      onChange(v) {
        settings.colors[cat.id] = v;
        saveSettings();
        applyColors();
      },
    });
    colorFields[cat.id] = field;
    row.append(label, field.el);
    $('#color-rows').append(row);
  }
  $('#colors-reset').addEventListener('click', () => {
    settings.colors = { ...DEFAULT_COLORS };
    saveSettings();
    applyColors();
    for (const id of CAT_IDS) colorFields[id].set(settings.colors[id]);
  });
  function openColorsDialog() {
    for (const id of CAT_IDS) colorFields[id].set(settings.colors[id]);
    colorsDialog.showModal();
  }
  $('#colors-btn').addEventListener('click', openColorsDialog);

  // ---------- Legend ----------

  (function buildLegend() {
    const legend = $('#legend');
    const keys = el('div', 'legend-keys');
    for (const cat of CATEGORIES) {
      const b = button('legend-item', null, { title: 'Change ' + cat.label + ' color' });
      b.style.setProperty('--c', 'var(--cat-' + cat.id + ')');
      b.append(el('i', 'legend-swatch'), el('span', null, cat.label));
      b.addEventListener('click', openColorsDialog);
      keys.append(b);
    }
    const day = el('span', 'legend-note');
    day.append(el('i', 'chip ahead', 'Sun'), ' different day');
    const hint = el('span', 'legend-hint', 'Tap a cell to set status · tap a name to rename');
    legend.append(keys, day, hint);
  })();

  // ---------- Add city dialog ----------

  const addDialog = $('#add-dialog');
  const search = $('#search');
  const results = $('#results');

  function buildCatalog() {
    const list = window.CITIES.slice();
    const covered = new Set(list.map((c) => c.tz));
    // Include every other IANA zone the browser knows, so any place is reachable.
    const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    for (const tz of zones) {
      if (covered.has(tz)) continue;
      const parts = tz.split('/');
      list.push({ city: parts[parts.length - 1].replace(/_/g, ' '), country: tz, tz, generic: true });
    }
    return list;
  }
  let catalog = null;

  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  function renderResults() {
    catalog = catalog || buildCatalog();
    const q = norm(search.value.trim());
    const now = Date.now();
    const matches = catalog
      .map((c) => {
        const name = norm(c.city);
        let score = 0;
        if (q) {
          if (name.startsWith(q)) score = 3;
          else if (name.includes(q)) score = 2;
          else if (norm(c.city + ' ' + c.country + ' ' + c.tz).includes(q)) score = 1;
          else return null;
        }
        return { c, score: score - (c.generic ? 0.5 : 0) };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.c.city.localeCompare(b.c.city))
      .slice(0, 60);

    results.replaceChildren();
    if (!matches.length) {
      results.append(el('li', 'empty', 'No matching cities'));
      return;
    }
    for (const { c } of matches) {
      const p = zonedParts(new Date(now), c.tz);
      const t = to12h(p.hour, p.minute);
      const btn = button('result');
      const main = el('span', 'r-main');
      main.append(el('span', 'r-city', c.city), el('span', 'r-country', c.country));
      const side = el('span', 'r-side');
      side.append(el('span', 'r-time', t.text + ' ' + t.suffix), el('span', 'r-off', formatOffset(offsetMinutes(c.tz, now))));
      btn.append(main, side);
      btn.addEventListener('click', () => addCity(c));
      const li = el('li');
      li.append(btn);
      results.append(li);
    }
  }

  function addCity(c) {
    cities.push(sanitizeCity({ city: c.city, country: c.country, tz: c.tz }));
    saveCities();
    addDialog.close();
    renderAll(false);
    board.scrollLeft = board.scrollWidth;
  }

  function openAddDialog() {
    search.value = '';
    renderResults();
    addDialog.showModal();
    search.focus();
  }

  search.addEventListener('input', renderResults);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = results.querySelector('.result');
      if (first) first.click();
    }
  });

  // ---------- Theme ----------

  $('#theme-toggle').addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
  });

  // Sync changes made in another tab.
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) { cities = loadCities(); renderAll(false); }
    if (e.key === SETTINGS_KEY) { settings = loadSettings(); applyColors(); }
  });

  // ---------- Go ----------

  applyColors();
  renderAll(true);
  (function loop() {
    tick();
    setTimeout(loop, 1000 - (Date.now() % 1000) + 5);
  })();
})();
