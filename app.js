(function () {
  'use strict';

  const STORAGE_KEY = 'timediff.cities';
  const SETTINGS_KEY = 'timediff.settings';
  const THEME_KEY = 'timediff.theme';
  const VIEW_KEY = 'timediff.view';
  const RANGE_KEY = 'timediff.range';
  const MENU_MODE_KEY = 'timediff.menuMode';
  const HOUR = 3600000;
  const DAY_MS = 24 * HOUR;
  // One-off events (mirrors EVENT_LIMITS in api/_lib/columns.js). Events are
  // dropped a week after they end, which keeps saved and synced data small.
  const EVENTS = { perColumn: 60, maxDays: 31, keepDays: 7, aheadDays: 730, note: 60 };

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

  // Calendar dates are handled as "civil" ms: UTC midnight of that date, so
  // day arithmetic is plain addition and never trips over DST.
  function civilDay(date, tz) {
    const p = zonedParts(date, tz);
    return Date.UTC(p.year, p.month - 1, p.day);
  }

  // UTC instant of a wall-clock time in `tz`, given as Date.UTC(y, m, d, h, min).
  function localToUtc(tz, wall) {
    let utc = wall - offsetMinutes(tz, wall) * 60000;
    utc = wall - offsetMinutes(tz, utc) * 60000;
    return utc;
  }

  // UTC instant of local midnight (today) in `tz`.
  const startOfLocalDay = (now, tz) => localToUtc(tz, civilDay(now, tz));

  // zonedParts for bulk use (week and month views): Intl is slow, so reuse
  // the zone's UTC offset across 12-hour blocks that don't contain a DST change.
  const BLOCK = 12 * HOUR;
  const offCache = new Map();
  function fastParts(ms, tz) {
    const block = Math.floor(ms / BLOCK);
    const key = tz + '|' + block;
    let off = offCache.get(key);
    if (off === undefined) {
      const a = offsetMinutes(tz, block * BLOCK);
      off = a === offsetMinutes(tz, (block + 1) * BLOCK - 1000) ? a : null;
      if (offCache.size > 20000) offCache.clear();
      offCache.set(key, off);
    }
    if (off === null) return zonedParts(new Date(ms), tz);
    const d = new Date(ms + off * 60000);
    return {
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
      hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(),
      weekday: DAY_KEYS[d.getUTCDay()],
    };
  }

  // Formatting a civil date (see civilDay).
  const civilFmt = (ms, opts) => new Date(ms).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });

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

  // Keeps valid events, sorted by start, dropping any that ended over a week ago.
  function cleanEvents(v, now = Date.now()) {
    if (!Array.isArray(v)) return [];
    const oldest = now - EVENTS.keepDays * DAY_MS;
    const latest = now + EVENTS.aheadDays * DAY_MS;
    const seen = new Set();
    const out = [];
    for (const e of v) {
      if (!e || !CAT_IDS.includes(e.cat) || !Number.isSafeInteger(e.start) || !Number.isSafeInteger(e.end)) continue;
      if (e.end <= e.start || e.end - e.start > EVENTS.maxDays * DAY_MS || e.end < oldest || e.start > latest) continue;
      const id = typeof e.id === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(e.id) && !seen.has(e.id) ? e.id : newId();
      seen.add(id);
      const ev = { id, start: e.start, end: e.end, cat: e.cat };
      const note = typeof e.note === 'string' ? e.note.trim().slice(0, EVENTS.note) : '';
      if (note) ev.note = note;
      out.push(ev);
    }
    return out.sort((a, b) => a.start - b.start).slice(0, EVENTS.perColumn);
  }

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
    out.events = cleanEvents(c.events);
    if (typeof c.ownerId === 'string') out.ownerId = c.ownerId; // shared boards only
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
  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

  // Shared-board state (see "Shared boards" below). When `boardId` is set the
  // columns come from the server and edits are synced instead of saved locally.
  const sync = {
    enabled: false, user: null, boards: [], boardId: null, boardName: '', members: [],
    version: 0, base: new Map(), baseView: '', state: null,
    hiddenCols: [], // columns hidden from this person's view (not rendered)
    viewMine: null, // id of the column assigned to them, as last placed in their view
    dirty: false, inflight: false, saveTimer: 0, pollTimer: 0, lastPoll: 0, lastActive: Date.now(),
  };

  function saveCities() {
    if (sync.boardId) queueSync();
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(cities));
  }

  // Permissions on shared boards. Everything is allowed on the local board.
  // Only the admin adds, removes and assigns columns; each friend manages the one
  // column assigned to them. `canEdit` covers a column's shared parts (name,
  // schedule, work days); order, header colors and hidden columns are personal.
  const inBoard = () => !!sync.boardId;
  const isAdmin = () => !!(sync.user && sync.user.isAdmin);
  const canEdit = (c) => !inBoard() || isAdmin() || (!!c.ownerId && c.ownerId === sync.user.id);
  const canManage = () => !inBoard() || isAdmin(); // add / remove / assign columns
  const memberName = (id) => (sync.members.find((m) => m.id === id) || {}).username;
  const ownerText = (c) => (c.ownerId && memberName(c.ownerId) ? '@' + memberName(c.ownerId) + ' and the admin' : 'the admin');

  const displayName = (c) => c.label || c.city;
  const headerColorFor = (c, i) => c.headerColor || (i === 0 ? DEFAULT_REF_HEADER : null);

  function applyColors() {
    for (const id of CAT_IDS) root.style.setProperty('--cat-' + id, settings.colors[id]);
  }

  // ---------- Rendering: header ----------

  const clockEls = [];

  const ICON_EDIT = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="miter"/></svg>';
  const ICON_HIDE = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6zM4 20 20 4" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>';
  const ICON_GRIP = '<svg viewBox="0 0 10 16" width="8" height="13" aria-hidden="true"><path d="M2 2h2v2H2zM6 2h2v2H6zM2 7h2v2H2zM6 7h2v2H6zM2 12h2v2H2zM6 12h2v2H6z" fill="currentColor"/></svg>';

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
      th.dataset.col = i;
      if (i === 0) th.classList.add('ref');
      const color = headerColorFor(c, i);
      if (color) {
        th.classList.add('tinted');
        th.style.setProperty('--hbg', color);
        th.style.setProperty('--hfg', textOn(color));
      }

      const editable = canEdit(c);
      const top = el('div', 'th-top');
      const tag = el('span', 'tag', String(i + 1).padStart(2, '0'));
      const grip = el('span', 'grip');
      grip.title = 'Drag to reorder';
      grip.innerHTML = ICON_GRIP;
      tag.prepend(grip);
      if (i === 0) tag.append(el('span', 'tag-ref', ' // REF'));
      if (inBoard() && c.ownerId) {
        const mine = c.ownerId === sync.user.id;
        tag.append(el('span', 'tag-owner', mine ? ' // YOU' : ' // @' + (memberName(c.ownerId) || '?')));
        tag.title = mine ? 'Your column' : 'Managed by @' + memberName(c.ownerId);
      }
      const tools = el('div', 'col-tools');
      if (i > 0) tools.append(toolBtn('Move left' + (i === 1 ? ' (make reference)' : ''), 'left', i, '‹', 'desk'));
      if (i < cities.length - 1) tools.append(toolBtn('Move right', 'right', i, '›', 'desk'));
      if (inBoard() && cities.length > 1) tools.append(toolBtn('Hide from my view', 'hide', i, ICON_HIDE, 'desk'));
      if (canManage() && cities.length > 1) tools.append(toolBtn('Remove', 'remove', i, '✕', 'desk danger'));
      tools.append(toolBtn(editable ? 'Edit name, color & schedule' : 'Color & visibility', 'edit', i, ICON_EDIT, 'edit'));
      // Current status; only shown in the stacked mobile view, where the grid is hidden.
      const status = el('span', 'status');
      top.append(tag, status, tools);

      const name = el('div', 'name', displayName(c));
      name.title = displayName(c) + (editable ? ' — click to edit' : ' — managed by ' + ownerText(c));
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
      clockEls.push({ c, tz: c.tz, time, sfx, date, off, status });
    });

    const addTh = el('th', 'add-col');
    const addBtn = button('add-btn', null, { 'aria-label': 'Add city', title: 'Add city' });
    addBtn.innerHTML = '<span>+</span><small>ADD</small>';
    addBtn.hidden = !canManage();
    addBtn.addEventListener('click', openAddDialog);
    const n = inBoard() ? sync.hiddenCols.length : 0;
    const hiddenBtn = button('hidden-btn', n + ' HIDDEN', { title: 'Show hidden columns' });
    hiddenBtn.hidden = !n;
    hiddenBtn.addEventListener('click', () => openHiddenMenu(hiddenBtn));
    addTh.append(addBtn, hiddenBtn);
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
      const cat = statusNow(e.c, now.getTime(), p) || '';
      if (e.status.dataset.v !== cat) {
        e.status.dataset.v = cat;
        e.status.className = 'status' + (cat ? ' cat-' + cat : '');
        e.status.replaceChildren();
        if (cat) e.status.append(el('i', 'status-swatch'), catLabel(cat));
      }
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

  // True when hour h continues a work shift that began the previous evening
  // (the contiguous work run crosses midnight), so it counts toward that day.
  function shiftStartsPrevDay(schedule, h) {
    let crossed = false;
    for (let k = 1; k < 24; k++) {
      const prev = (h - k + 24) % 24;
      if (schedule[prev] !== 'work') return crossed;
      if (prev === 23) crossed = true;
    }
    return false; // all 24 hours are work: no shift start, use the hour's own day
  }

  // Weekly status of city `c` at local time parts `p`. Work hours only count on
  // the column's work days (in its own local date); overnight shifts count
  // toward the day they start.
  function templateStatus(c, p) {
    const cat = c.schedule[p.hour];
    if (cat !== 'work') return cat;
    let day = DAY_KEYS.indexOf(p.weekday);
    if (shiftStartsPrevDay(c.schedule, p.hour)) day = (day + 6) % 7;
    return c.workDays.includes(day) ? cat : null;
  }

  // The one-off event overlapping [t0, t1) the most, as { e, ov } (overlap in ms).
  function bestEvent(c, t0, t1) {
    let best = null;
    for (const e of c.events) {
      if (e.start >= t1) break; // sorted by start
      const ov = Math.min(e.end, t1) - Math.max(e.start, t0);
      if (ov > 0 && (!best || ov > best.ov)) best = { e, ov };
    }
    return best;
  }

  // Status at an instant: a one-off event wins over the weekly schedule.
  function statusNow(c, ms, p) {
    const hit = c.events.find((e) => e.start <= ms && ms < e.end);
    return hit ? hit.cat : templateStatus(c, p);
  }

  // Status over the hour starting at t0 (week/month views): an event counts
  // when it covers at least half of the hour.
  function slotStatus(c, t0) {
    const p = fastParts(t0, c.tz);
    const b = bestEvent(c, t0, t0 + HOUR);
    const ev = b && b.ov * 2 >= HOUR ? b.e : null;
    return { cat: ev ? ev.cat : templateStatus(c, p), ev, p };
  }

  // "Available" for overlap finding: marked Free, or unscheduled during
  // waking hours (8 AM–10 PM) in their own time zone.
  const isAvailable = (s) => s.cat === 'free' || (!s.cat && s.p.hour >= 8 && s.p.hour < 22);

  function renderBody(now) {
    const tz = refTz();
    const refDay = viewDay(now);
    const start = localToUtc(tz, refDay);
    const nowMs = now.getTime();
    const currentIdx = nowMs >= start && nowMs < start + DAY_MS ? Math.floor((nowMs - start) / HOUR) : -1;

    const frag = document.createDocumentFragment();
    for (let r = 0; r < 24; r++) {
      const t0 = start + r * HOUR;
      const instant = new Date(t0);
      const tr = el('tr');
      if (r === currentIdx) tr.classList.add('current');

      cities.forEach((c, i) => {
        const p = zonedParts(instant, c.tz);
        const td = el('td');
        td.dataset.col = i;
        td.dataset.hour = p.hour;
        td.dataset.t0 = t0;
        if (i === 0) td.classList.add('ref');
        // A one-off covering the whole hour replaces its status; a partial one
        // is drawn as a band over the part of the hour it covers.
        const hit = bestEvent(c, t0, t0 + HOUR);
        const full = !!hit && hit.ov >= HOUR;
        const cat = full ? hit.e.cat : templateStatus(c, p);
        if (cat) td.classList.add('cat', 'cat-' + cat);
        if (hit) {
          td.classList.add('evt');
          if (!full) {
            td.classList.add('evt-part');
            td.style.setProperty('--ea', ((Math.max(hit.e.start, t0) - t0) / HOUR) * 100 + '%');
            td.style.setProperty('--eb', ((Math.min(hit.e.end, t0 + HOUR) - t0) / HOUR) * 100 + '%');
            td.style.setProperty('--ec', 'var(--cat-' + hit.e.cat + ')');
          }
        }
        const editable = canEdit(c);
        if (!editable) td.classList.add('locked');

        const t = to12h(p.hour, p.minute);
        td.dataset.label = t.text + ' ' + t.suffix;
        td.title = displayName(c) + ' · ' + td.dataset.label + (cat ? ' · ' + catLabel(cat) : '')
          + (hit ? '\nOne-off: ' + catLabel(hit.e.cat) + (hit.e.note ? ' — ' + hit.e.note : '') + ' · ' + eventWhen(hit.e, c.tz) : '')
          + (editable ? '\nClick to set status' : '');
        td.append(el('span', 'time', t.text), el('span', 'suffix', t.suffix));

        const dayDiff = Math.round((Date.UTC(p.year, p.month - 1, p.day) - refDay) / DAY_MS);
        if (dayDiff !== 0) {
          const chip = el('span', 'chip ' + (dayDiff > 0 ? 'ahead' : 'behind'), p.weekday);
          chip.title = (dayDiff > 0 ? 'Next day' : 'Previous day') + ' relative to ' + displayName(cities[0]);
          td.append(chip);
        }
        if (r === currentIdx && i === 0) td.append(el('span', 'now-pill', 'Now'));
        // Name the event where it starts (or at the top of the day).
        if (hit && hit.e.note && (hit.e.start >= t0 || r === 0)) td.append(el('span', 'evt-note', hit.e.note));
        if (hit) td.append(el('i', 'evt-mark'));
        tr.append(td);
      });
      tr.append(el('td', 'pad'));
      frag.append(tr);
    }
    bodyRows.replaceChildren(frag);
  }

  // ---------- Rendering: week and month ----------
  // Both keep every person in view: a week cell has one stripe per person
  // (left → right in column order) and a month day one bar per person. Hours
  // follow the reference column's zone, like the day grid.

  const cal = $('#cal');
  const calKey = $('#cal-key');
  const hourLabel = (h) => { const t = to12h(h, 0); return t.hh + ' ' + t.suffix; };

  function renderCal(now) {
    renderKey();
    if (nav.range === 'week') renderWeek(now); else renderMonth(now);
  }

  // Who's who: the order people appear in each stripe or bar.
  function renderKey() {
    const people = el('div', 'key-people');
    cities.forEach((c, i) => {
      const b = button('key-person', null, { title: displayName(c) + ' · ' + c.city + ' — ' + (canEdit(c) ? 'edit' : 'view') + ' column' });
      b.dataset.action = 'edit';
      b.dataset.idx = i;
      const n = el('span', 'key-n', String(i + 1).padStart(2, '0'));
      const color = headerColorFor(c, i);
      if (color) { n.style.background = color; n.style.color = textOn(color); }
      b.append(n, el('span', 'key-name', displayName(c)));
      if (inBoard() && c.ownerId && c.ownerId === sync.user.id) b.append(el('span', 'key-you', 'YOU'));
      people.append(b);
    });
    const meta = el('span', 'key-meta');
    const avail = el('span', 'key-avail');
    avail.title = 'Everyone is marked Free, or has nothing scheduled between 8 AM and 10 PM their time';
    avail.append(el('i', 'avail-swatch'), 'Everyone available');
    meta.append(el('span', 'key-hint', nav.range === 'week' ? 'Stripes run left → right in this order' : 'Bars run top → bottom in this order'), avail);
    calKey.replaceChildren(people, meta);
  }

  function renderWeek(now) {
    const tz = refTz();
    const today = civilDay(now, tz);
    const first = weekStart(viewDay(now));
    const nowMs = now.getTime();
    const starts = [];

    const headTr = el('tr');
    const corner = el('th', 'wk-corner', formatOffset(offsetMinutes(tz, localToUtc(tz, first))));
    corner.title = 'Hours in ' + displayName(cities[0]) + ' time';
    headTr.append(corner);
    for (let d = 0; d < 7; d++) {
      const day = first + d * DAY_MS;
      starts.push(localToUtc(tz, day));
      const th = el('th', 'wk-day' + (day === today ? ' today' : ''));
      const b = button('wk-day-btn', null, { title: 'Open ' + civilFmt(day, { weekday: 'long', month: 'long', day: 'numeric' }) });
      b.dataset.day = day;
      b.append(el('span', 'wk-dow', civilFmt(day, { weekday: 'short' })), el('span', 'wk-date', String(new Date(day).getUTCDate())));
      th.append(b);
      headTr.append(th);
    }
    const thead = el('thead');
    thead.append(headTr);

    const tbody = el('tbody');
    for (let r = 0; r < 24; r++) {
      const tr = el('tr');
      tr.append(el('th', 'wk-hour', hourLabel(r)));
      for (let d = 0; d < 7; d++) {
        const t0 = starts[d] + r * HOUR;
        const td = el('td');
        td.dataset.t0 = t0;
        td.dataset.day = first + d * DAY_MS;
        td.dataset.r = r;
        const bar = el('div', 'stripes');
        let all = true;
        for (const c of cities) {
          const s = slotStatus(c, t0);
          if (!isAvailable(s)) all = false;
          bar.append(el('span', 'st' + (s.cat ? ' cat-' + s.cat : '') + (s.ev ? ' ev' : '')));
        }
        if (all) td.classList.add('all-free');
        if (t0 + HOUR <= nowMs) td.classList.add('past');
        if (t0 <= nowMs && nowMs < t0 + HOUR) { td.classList.add('now'); tr.classList.add('current'); }
        td.append(bar);
        tr.append(td);
      }
      tbody.append(tr);
    }
    const table = el('table', 'wk');
    table.append(thead, tbody);
    cal.replaceChildren(table);
  }

  // Month bars: one CSS gradient per person-day instead of 24 elements.
  function stripGradient(row) {
    const stops = [];
    for (let from = 0, r = 1; r <= row.length; r++) {
      if (r < row.length && row[r].cat === row[from].cat) continue;
      const color = row[from].cat ? 'var(--st-' + row[from].cat + ')' : 'transparent';
      stops.push(color + ' ' + ((from / row.length) * 100).toFixed(2) + '% ' + ((r / row.length) * 100).toFixed(2) + '%');
      from = r;
    }
    return 'linear-gradient(90deg, ' + stops.join(', ') + ')';
  }

  function renderMonth(now) {
    const tz = refTz();
    const today = civilDay(now, tz);
    const first = monthStart(viewDay(now));
    const month = new Date(first).getUTCMonth();
    const gridStart = weekStart(first);
    const next = Date.UTC(new Date(first).getUTCFullYear(), month + 1, 1);
    const weeks = Math.ceil((next - gridStart) / DAY_MS / 7);

    const wrap = el('div', 'mo');
    wrap.style.setProperty('--weeks', weeks);
    wrap.style.setProperty('--n', cities.length);
    for (const d of DAY_ORDER) wrap.append(el('div', 'mo-dow', DAY_KEYS[d]));
    for (let i = 0; i < weeks * 7; i++) {
      const day = gridStart + i * DAY_MS;
      const start = localToUtc(tz, day);
      const end = localToUtc(tz, day + DAY_MS);
      const rows = cities.map((c) => Array.from({ length: 24 }, (_, r) => slotStatus(c, start + r * HOUR)));
      let freeHours = 0;
      for (let r = 0; r < 24; r++) if (rows.every((row) => isAvailable(row[r]))) freeHours++;
      const events = cities.reduce((n, c) => n + c.events.filter((e) => e.start < end && e.end > start).length, 0);

      const cell = button('mo-day' + (new Date(day).getUTCMonth() !== month ? ' other' : '')
        + (day === today ? ' today' : '') + (day < today ? ' past' : ''));
      cell.dataset.day = day;
      cell.title = civilFmt(day, { weekday: 'long', month: 'long', day: 'numeric' })
        + (freeHours ? '\n' + freeHours + 'h when everyone is available' : '')
        + (events ? '\n' + events + ' one-off event' + (events > 1 ? 's' : '') : '')
        + '\nClick to open the day';
      const top = el('div', 'mo-top');
      top.append(el('span', 'mo-n', String(new Date(day).getUTCDate())));
      if (events) top.append(el('span', 'mo-evt', String(events)));
      if (freeHours) top.append(el('span', 'mo-free', '✓' + freeHours + 'H'));
      const bars = el('div', 'mo-bars');
      for (const row of rows) {
        const b = el('i', 'mo-bar');
        b.style.backgroundImage = stripGradient(row);
        bars.append(b);
      }
      cell.append(top, bars);
      wrap.append(cell);
    }
    cal.replaceChildren(wrap);
  }

  // Week cell details: everyone's local time and status at that hour.
  function openSlotMenu(td) {
    closeCellMenu();
    cellMenu.classList.add('wide');
    const t0 = +td.dataset.t0;
    const day = +td.dataset.day;
    const rp = zonedParts(new Date(t0), refTz());
    const rt = to12h(rp.hour, rp.minute);
    const head = el('div', 'menu-head');
    head.append(el('span', 'menu-name', civilFmt(day, { weekday: 'short', month: 'short', day: 'numeric' })), el('span', 'menu-time', rt.text + ' ' + rt.suffix));
    cellMenu.replaceChildren(head);

    let all = true;
    for (const c of cities) {
      const s = slotStatus(c, t0);
      if (!isAvailable(s)) all = false;
      const editable = canEdit(c);
      const b = button('menu-item person' + (editable ? '' : ' ro'), null, {
        role: 'menuitem',
        title: editable ? (s.ev ? 'Edit this one-off event' : 'Add a one-off event for ' + displayName(c)) : 'Managed by ' + ownerText(c),
      });
      if (s.cat) b.style.setProperty('--c', 'var(--cat-' + s.cat + ')');
      const lt = to12h(s.p.hour, s.p.minute);
      const main = el('span', 'person-main');
      main.append(el('span', 'person-name', displayName(c)),
        el('span', 'person-sub', (s.cat ? catLabel(s.cat) : 'Unscheduled') + (s.ev ? ' · one-off' + (s.ev.note ? ': ' + s.ev.note : '') : '')));
      b.append(el('i', 'menu-swatch' + (s.cat ? '' : ' none')), main, el('span', 'person-time', lt.text + ' ' + lt.suffix));
      if (editable) {
        b.addEventListener('click', () => {
          closeCellMenu();
          openEventDialog(s.ev ? { colId: c.id, event: s.ev } : { colId: c.id, start: t0, end: t0 + HOUR });
        });
      } else b.setAttribute('aria-disabled', 'true');
      cellMenu.append(b);
    }
    if (all) cellMenu.append(el('div', 'menu-avail', '✓ Everyone available'));
    const open = button('menu-item link', 'Open this day →');
    open.addEventListener('click', () => { closeCellMenu(); setRange('day', day, +td.dataset.r); });
    cellMenu.append(el('div', 'menu-sep'), open);

    menuTd = td;
    td.classList.add('menu-open');
    showMenuAt(td.getBoundingClientRect());
  }

  cal.addEventListener('click', (e) => {
    const td = e.target.closest('td[data-t0]');
    if (td) { if (menuTd === td) closeCellMenu(); else openSlotMenu(td); return; }
    const b = e.target.closest('button[data-day]');
    if (b) setRange('day', +b.dataset.day);
  });
  calKey.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action="edit"]');
    if (b) openColDialog(+b.dataset.idx);
  });

  // ---------- Date navigation ----------
  // `nav.day` is a civil date in the reference zone, or null to follow today
  // (so the view rolls over at midnight).

  const RANGES = ['day', 'week', 'month'];
  const nav = { range: RANGES.includes(root.dataset.range) ? root.dataset.range : 'day', day: null };
  function refTz() { return cities[0].tz; }
  const viewDay = (now) => nav.day ?? civilDay(now, refTz());
  const weekStart = (day) => day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS; // Monday
  const monthStart = (day) => { const d = new Date(day); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
  const sameRange = (a, b) => (nav.range === 'day' ? a === b : nav.range === 'week' ? weekStart(a) === weekStart(b) : monthStart(a) === monthStart(b));

  // The stacked mobile layout only applies to the day view.
  function applyViewMode() {
    root.dataset.view = nav.range === 'day' ? localStorage.getItem(VIEW_KEY) || 'grid' : 'grid';
  }

  function setRange(range, day, hour) {
    nav.range = range;
    if (day !== undefined) nav.day = day === civilDay(new Date(), refTz()) ? null : day;
    root.dataset.range = range;
    localStorage.setItem(RANGE_KEY, range);
    applyViewMode();
    renderAll(false);
    scrollCurrentIntoView(hour);
  }

  function shiftView(dir) {
    const now = new Date();
    const day = viewDay(now);
    let next;
    if (nav.range === 'month') { const d = new Date(day); next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + dir, 1); }
    else next = day + dir * (nav.range === 'week' ? 7 : 1) * DAY_MS;
    nav.day = sameRange(next, civilDay(now, refTz())) ? null : next;
    renderAll(false);
    scrollCurrentIntoView();
  }

  function goToday() {
    nav.day = null;
    renderAll(true);
  }

  const navLabel = $('#nav-label');
  function renderNav(now) {
    const today = civilDay(now, refTz());
    const day = viewDay(now);
    const year = (ms) => new Date(ms).getUTCFullYear();
    document.querySelectorAll('#range-seg [data-range]').forEach((b) => {
      const on = b.dataset.range === nav.range;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on);
    });
    let label;
    if (nav.range === 'day') {
      label = civilFmt(day, { weekday: 'short', month: 'short', day: 'numeric', ...(year(day) !== year(today) ? { year: 'numeric' } : {}) });
    } else if (nav.range === 'week') {
      const a = weekStart(day), b = a + 6 * DAY_MS;
      const sameMonth = new Date(a).getUTCMonth() === new Date(b).getUTCMonth();
      label = civilFmt(a, { month: 'short', day: 'numeric' }) + ' – ' + civilFmt(b, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })
        + (year(b) !== year(today) ? ', ' + year(b) : '');
    } else {
      label = civilFmt(day, { month: 'long', ...(year(day) !== year(today) ? { year: 'numeric' } : {}) });
    }
    navLabel.textContent = label;
    const isNow = sameRange(day, today);
    navLabel.classList.toggle('away', !isNow);
    $('#nav-today').disabled = isNow;
    navLabel.title = 'Dates and hours in ' + displayName(cities[0]) + '’s time (the reference column)';
  }

  document.querySelectorAll('#range-seg [data-range]').forEach((b) => b.addEventListener('click', () => setRange(b.dataset.range)));
  $('#nav-prev').addEventListener('click', () => shiftView(-1));
  $('#nav-next').addEventListener('click', () => shiftView(1));
  $('#nav-today').addEventListener('click', goToday);
  // Keyboard: ← → to move, T for today, D / W / M to switch views.
  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || document.querySelector('dialog[open]') || !cellMenu.hidden) return;
    if (e.target !== document.body && !e.target.closest('.viewbar')) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowleft') shiftView(-1);
    else if (k === 'arrowright') shiftView(1);
    else if (k === 't') goToday();
    else if (k === 'd' || k === 'w' || k === 'm') setRange(RANGES.find((r) => r[0] === k));
    else return;
    e.preventDefault();
  });

  // ---------- Render orchestration ----------

  let renderedKey = '';

  function stateKey(now) {
    const start = startOfLocalDay(now, refTz());
    return nav.range + '#' + viewDay(now) + '#' + start + '#' + Math.floor((now - start) / HOUR);
  }

  // Redraw the time grid of the current range (not the column headers).
  function renderView(now = new Date()) {
    if (nav.range === 'day') renderBody(now); else renderCal(now);
  }

  // Full redraw. `scroll` re-centres the current hour.
  function renderAll(scroll) {
    const now = new Date();
    closeCellMenu();
    const day = nav.range === 'day';
    $('#grid').hidden = !day;
    cal.hidden = calKey.hidden = day;
    renderNav(now);
    renderHead(now);
    renderView(now);
    renderedKey = stateKey(now);
    if (scroll) scrollCurrentIntoView();
  }

  function tick() {
    const now = new Date();
    const key = stateKey(now);
    if (key !== renderedKey) {
      renderNav(now);
      renderView(now);
      renderedKey = key;
    }
    updateClocks(now);
  }

  // Centre the current hour (or put `hour`, else 8 AM, near the top).
  function scrollCurrentIntoView(hour) {
    if (nav.range === 'month') { board.scrollTop = 0; return; }
    const week = nav.range === 'week';
    const rows = week ? cal.querySelector('tbody') : bodyRows;
    const head = (week ? cal.querySelector('thead') : headRow).getBoundingClientRect().height;
    const current = hour == null && rows.querySelector('tr.current');
    const row = current || rows.children[hour ?? 8];
    if (!row) return;
    board.scrollTop = Math.max(0, current
      ? row.offsetTop - head - (board.clientHeight - head) / 2 + row.offsetHeight / 2
      : row.offsetTop - head - 8);
  }

  // ---------- Column actions ----------

  function moveCity(from, to) {
    if (to < 0 || to >= cities.length || from === to) return;
    const [c] = cities.splice(from, 1);
    cities.splice(to, 0, c);
    saveCities();
    renderAll(false);
  }

  // Hide a column from your own view of a shared board (it stays on the board).
  function hideCity(i) {
    if (cities.length <= 1) return;
    const [c] = cities.splice(i, 1);
    sync.hiddenCols.push(c);
    saveCities();
    renderAll(false);
    toast('Hid ' + displayName(c) + ' — bring it back from “HIDDEN” by the + button.');
  }

  function showCities(ids) {
    cities.push(...sync.hiddenCols.filter((c) => ids.includes(c.id)));
    sync.hiddenCols = sync.hiddenCols.filter((c) => !ids.includes(c.id));
    saveCities();
    renderAll(false);
  }

  function removeCity(i) {
    if (cities.length <= 1) return;
    cities.splice(i, 1);
    saveCities();
    renderAll(false);
  }

  // ---------- Drag to reorder columns ----------
  // Mice can drag a header from anywhere; touch only from the grip, so swiping
  // across the headers still scrolls the board.

  const DRAG_THRESHOLD = 6;
  const EDGE = 48; // auto-scroll zone at the board's edges
  let drag = null;
  let suppressClick = false;

  const headCells = () => [...headRow.querySelectorAll('th[data-col]')];

  function markCol(i, cls, on) {
    document.querySelectorAll('.grid [data-col="' + i + '"]').forEach((c) => c.classList.toggle(cls, on));
  }

  function clearDropMarks() {
    document.querySelectorAll('.grid .drop-before, .grid .drop-after').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
  }

  // Work out where the dragged column would land and draw the insertion line.
  function updateDropTarget() {
    const ths = headCells();
    const pos = drag.stacked ? drag.py : drag.px;
    let slot = 0;
    for (const th of ths) {
      const r = th.getBoundingClientRect();
      if (pos > (drag.stacked ? r.top + r.height / 2 : r.left + r.width / 2)) slot++;
    }
    const to = slot > drag.from ? slot - 1 : slot;
    if (to === drag.to) return;
    drag.to = to;
    clearDropMarks();
    if (to === drag.from) return;
    if (slot < ths.length) markCol(slot, 'drop-before', true);
    else markCol(ths.length - 1, 'drop-after', true);
  }

  function autoScroll() {
    if (!drag || !drag.active) return;
    const r = board.getBoundingClientRect();
    const [pos, lo, hi] = drag.stacked ? [drag.py, r.top, r.bottom] : [drag.px, r.left, r.right];
    const step = pos < lo + EDGE ? -1 : pos > hi - EDGE ? 1 : 0;
    if (step) {
      const before = drag.stacked ? board.scrollTop : board.scrollLeft;
      if (drag.stacked) board.scrollTop += step * 14; else board.scrollLeft += step * 14;
      if ((drag.stacked ? board.scrollTop : board.scrollLeft) !== before) updateDropTarget();
    }
    requestAnimationFrame(autoScroll);
  }

  function endDrag(commit) {
    const d = drag;
    drag = null;
    if (!d || !d.active) return;
    root.classList.remove('col-dragging');
    clearDropMarks();
    markCol(d.from, 'dragging', false);
    // Swallow the click that follows the drop so it doesn't open the editor.
    suppressClick = true;
    setTimeout(() => { suppressClick = false; });
    if (commit && d.to != null) moveCity(d.from, d.to);
  }

  headRow.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || cities.length < 2) return;
    const th = e.target.closest('th[data-col]');
    if (!th || e.target.closest('button')) return;
    const onGrip = !!e.target.closest('.grip');
    if (e.pointerType !== 'mouse' && !onGrip) return;
    if (onGrip) e.preventDefault();
    drag = { from: +th.dataset.col, to: null, id: e.pointerId, x: e.clientX, y: e.clientY, active: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD) return;
      drag.active = true;
      drag.stacked = getComputedStyle(headRow).flexDirection === 'column';
      closeCellMenu();
      root.classList.add('col-dragging');
      markCol(drag.from, 'dragging', true);
      requestAnimationFrame(autoScroll);
    }
    drag.px = e.clientX;
    drag.py = e.clientY;
    updateDropTarget();
  });
  window.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.id) endDrag(true); });
  window.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) endDrag(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') endDrag(false); });
  headRow.addEventListener('click', (e) => {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  headRow.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const i = +t.dataset.idx;
    switch (t.dataset.action) {
      case 'edit': openColDialog(i); break;
      case 'remove': removeCity(i); break;
      case 'hide': hideCity(i); break;
      case 'left': moveCity(i, i - 1); break;
      case 'right': moveCity(i, i + 1); break;
    }
  });

  $('#reset-btn').addEventListener('click', () => {
    if (inBoard()) return;
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
        if (c.events.length) {
          col.events = c.events.map((e) => ({
            start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString(), status: e.cat, ...(e.note ? { note: e.note } : {}),
          }));
        }
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
      events: Array.isArray(col.events)
        ? col.events.map((e) => e && { start: Date.parse(e.start), end: Date.parse(e.end), cat: e.status || e.cat, note: e.note })
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
    if (inBoard()) { toast('Switch to “This device” (top right) to import a config.', true); return; }
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
  // Whether the cell menu edits the weekly schedule or just that date.
  let menuMode = localStorage.getItem(MENU_MODE_KEY) === 'once' ? 'once' : 'repeat';

  function setStatus(col, hour, cat) {
    cities[col].schedule[hour] = cat;
    saveCities();
    renderView();
  }

  // Give column `c` status `cat` over [a, b) as a one-off, trimming or splitting
  // any events already there. `cat` null just clears one-offs from that span.
  function setOneOff(c, a, b, cat) {
    const list = [];
    for (const e of c.events) {
      if (e.end <= a || e.start >= b) { list.push(e); continue; }
      if (e.start < a) list.push({ ...e, end: a });
      if (e.end > b) list.push({ ...e, id: e.start < a ? newId() : e.id, start: b });
    }
    if (cat) {
      const ev = { id: newId(), start: a, end: b, cat };
      // Tapping neighbouring hours grows one event rather than making many.
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        const touches = e.end === ev.start || e.start === ev.end;
        if (e.cat === cat && !e.note && touches && Math.max(e.end, ev.end) - Math.min(e.start, ev.start) <= EVENTS.maxDays * DAY_MS) {
          ev.start = Math.min(e.start, ev.start);
          ev.end = Math.max(e.end, ev.end);
          ev.id = e.id;
          list.splice(i, 1);
        }
      }
      list.push(ev);
    }
    if (list.length > EVENTS.perColumn && list.length > c.events.length) {
      toast('Each person can have up to ' + EVENTS.perColumn + ' one-off events — delete a few first.', true);
      return;
    }
    c.events = list.sort((x, y) => x.start - y.start);
    saveCities();
    renderView();
  }

  function openCellMenu(td) {
    closeCellMenu();
    cellMenu.classList.remove('wide');
    const col = +td.dataset.col;
    const hour = +td.dataset.hour;
    const t0 = +td.dataset.t0, t1 = t0 + HOUR;
    const c = cities[col];
    const hit = bestEvent(c, t0, t1);
    const once = menuMode === 'once';
    const date = new Date(t0).toLocaleDateString('en-US', { timeZone: c.tz, weekday: 'short', month: 'short', day: 'numeric' });
    const current = once ? (hit && hit.ov >= HOUR ? hit.e.cat : undefined) : c.schedule[hour];

    const head = el('div', 'menu-head');
    head.append(el('span', 'menu-name', displayName(c)), el('span', 'menu-time', td.dataset.label));
    cellMenu.replaceChildren(head);

    const seg = el('div', 'menu-seg');
    for (const [mode, text, tip] of [
      ['repeat', 'Every week', 'Change the usual weekly schedule for this hour'],
      ['once', 'Just ' + date, 'Only change this hour on ' + date + ' — a one-off'],
    ]) {
      const b = button('menu-seg-btn' + (menuMode === mode ? ' active' : ''), text, { title: tip, 'aria-pressed': menuMode === mode });
      b.addEventListener('click', () => {
        menuMode = mode;
        localStorage.setItem(MENU_MODE_KEY, mode);
        openCellMenu(td);
      });
      seg.append(b);
    }
    cellMenu.append(seg);

    for (const cat of CATEGORIES) {
      const b = button('menu-item' + (current === cat.id ? ' active' : ''), null, { role: 'menuitemradio' });
      b.style.setProperty('--c', 'var(--cat-' + cat.id + ')');
      b.append(el('i', 'menu-swatch'), el('span', null, cat.label));
      b.addEventListener('click', () => {
        closeCellMenu();
        if (once) setOneOff(c, t0, t1, cat.id); else setStatus(col, hour, cat.id);
      });
      cellMenu.append(b);
    }
    if (!once) {
      const clear = button('menu-item clear' + (current ? '' : ' active'), null, { role: 'menuitemradio' });
      clear.append(el('i', 'menu-swatch none'), el('span', null, 'None'));
      clear.addEventListener('click', () => { setStatus(col, hour, null); closeCellMenu(); });
      cellMenu.append(clear);
    } else if (hit) {
      const clear = button('menu-item clear', null, { role: 'menuitem', title: 'Go back to the weekly schedule for this hour' });
      clear.append(el('i', 'menu-swatch none'), el('span', null, 'Remove one-off'));
      clear.addEventListener('click', () => { closeCellMenu(); setOneOff(c, t0, t1, null); });
      cellMenu.append(clear);
    }
    const details = button('menu-item link', hit ? 'Edit one-off' + (hit.e.note ? ' “' + hit.e.note + '”' : '') + '…' : 'New event with times & note…');
    details.addEventListener('click', () => {
      closeCellMenu();
      openEventDialog(hit ? { colId: c.id, event: hit.e } : { colId: c.id, start: t0, end: t1 });
    });
    const edit = button('menu-item link', 'Edit full schedule…');
    edit.addEventListener('click', () => { closeCellMenu(); openColDialog(col); });
    cellMenu.append(el('div', 'menu-sep'), details, edit);

    menuTd = td;
    td.classList.add('menu-open');
    showMenuAt(td.getBoundingClientRect());
  }

  function showMenuAt(r) {
    cellMenu.hidden = false;
    const mw = cellMenu.offsetWidth, mh = cellMenu.offsetHeight;
    const left = Math.min(Math.max(8, r.left), innerWidth - mw - 8);
    let top = r.bottom + 4;
    if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    cellMenu.style.left = left + 'px';
    cellMenu.style.top = top + 'px';
    cellMenu.querySelector('.menu-item').focus({ preventScroll: true });
  }

  // Lists the columns hidden from your view so you can bring them back.
  function openHiddenMenu(anchor) {
    closeCellMenu();
    cellMenu.classList.remove('wide');
    const head = el('div', 'menu-head');
    head.append(el('span', 'menu-name', 'Hidden'), el('span', 'menu-time', String(sync.hiddenCols.length)));
    cellMenu.replaceChildren(head);
    for (const c of sync.hiddenCols) {
      const b = button('menu-item', displayName(c), { role: 'menuitem', title: 'Show ' + displayName(c) });
      b.addEventListener('click', () => { closeCellMenu(); showCities([c.id]); });
      cellMenu.append(b);
    }
    if (sync.hiddenCols.length > 1) {
      const all = button('menu-item link', 'Show all');
      all.addEventListener('click', () => { closeCellMenu(); showCities(sync.hiddenCols.map((c) => c.id)); });
      cellMenu.append(el('div', 'menu-sep'), all);
    }
    showMenuAt(anchor.getBoundingClientRect());
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
    const c = cities[+td.dataset.col];
    if (!canEdit(c)) { closeCellMenu(); toast('Only ' + ownerText(c) + ' can edit ' + displayName(c) + '’s schedule.'); return; }
    if (menuTd === td) closeCellMenu();
    else openCellMenu(td);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!cellMenu.hidden && !cellMenu.contains(e.target) && !e.target.closest('td[data-t0]')) closeCellMenu();
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
    renderView();
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
      saveCities(); paintDayButtons(); renderView();
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
    saveCities(); paintDayButtons(); renderView();
  });
  $('#days-all').addEventListener('click', () => {
    editCity().workDays = [0, 1, 2, 3, 4, 5, 6];
    saveCities(); paintDayButtons(); renderView();
  });

  $('#sched-default').addEventListener('click', () => {
    editCity().schedule = defaultSchedule();
    saveCities(); paintHourButtons(); renderView();
  });
  $('#sched-clear').addEventListener('click', () => {
    editCity().schedule = Array(24).fill(null);
    saveCities(); paintHourButtons(); renderView();
  });

  colName.addEventListener('input', () => {
    const c = editCity();
    const v = colName.value.trim();
    if (v) c.label = v; else delete c.label;
    saveCities();
    renderHead(new Date());
  });
  colName.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); colDialog.close(); } });

  const colOwner = $('#col-owner');
  colOwner.addEventListener('change', () => {
    const c = editCity();
    // A person manages one column per board, so this moves them off any other.
    for (const o of [...cities, ...sync.hiddenCols]) if (colOwner.value && o.ownerId === colOwner.value) delete o.ownerId;
    if (colOwner.value) c.ownerId = colOwner.value; else delete c.ownerId;
    saveCities();
    renderAll(false);
  });

  $('#col-remove').addEventListener('click', () => {
    const i = editIdx();
    if (i < 0) return;
    colDialog.close();
    removeCity(i);
  });
  $('#col-hide').addEventListener('click', () => {
    const i = editIdx();
    if (i < 0) return;
    colDialog.close();
    hideCity(i);
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
    // On shared boards, others' columns only offer the personal view settings.
    const editable = canEdit(c);
    $('#col-title').textContent = editable ? 'Edit column' : 'Column view';
    for (const id of ['#col-name-field', '#col-sched-field', '#col-days-field']) $(id).hidden = !editable;
    $('#col-color-hint').textContent = inBoard() ? '· only you see this' : '';
    $('#col-kicker').textContent = 'COLUMN ' + String(i + 1).padStart(2, '0') + (i === 0 ? ' // REFERENCE' : '');
    // Don't clobber typing when a sync refresh re-runs this.
    if (document.activeElement !== colName) colName.value = c.label || '';
    colName.placeholder = c.city;
    $('#col-loc').textContent = c.city + ', ' + c.country + ' · ' + c.tz.replace(/_/g, ' ');
    headerField.set(c.headerColor || null, i === 0 ? DEFAULT_REF_HEADER : '#15181c');
    $('#col-remove').disabled = cities.length <= 1;
    $('#col-remove').hidden = !canManage();
    $('#col-hide').hidden = !inBoard() || cities.length <= 1;
    $('#col-makeref').hidden = i === 0;
    $('#col-owner-field').hidden = !(inBoard() && isAdmin());
    paintEventList();
    if (!editable) return;
    if (inBoard() && isAdmin()) {
      const current = (id) => [...cities, ...sync.hiddenCols].find((o) => o.ownerId === id && o !== c);
      colOwner.replaceChildren(new Option('Nobody — only you', ''), ...sync.members.map((m) => {
        const other = current(m.id);
        return new Option('@' + m.username + (m.isAdmin ? ' (you)' : '') + (other ? ' — moves from ' + displayName(other) : ''), m.id);
      }));
      colOwner.value = c.ownerId || '';
    }
    paintHourButtons();
    paintDayButtons();
  }

  function openColDialog(i) {
    editId = cities[i].id;
    setBrush(brush);
    syncColDialog();
    colDialog.showModal();
    // Avoid popping the on-screen keyboard on touch devices.
    if (canEdit(cities[i]) && matchMedia('(hover: hover)').matches) colName.focus();
  }

  // ---------- One-off events ----------
  // Times are entered in the column's own zone (the person's local time) and
  // stored as UTC instants, so they land on the right hour for everyone.

  const pad2 = (n) => String(n).padStart(2, '0');
  const isMidnight = (ms, tz) => { const p = zonedParts(new Date(ms), tz); return p.hour === 0 && p.minute === 0; };
  const isAllDay = (e, tz) => isMidnight(e.start, tz) && isMidnight(e.end, tz);

  function toInputs(ms, tz) {
    const p = zonedParts(new Date(ms), tz);
    return { date: p.year + '-' + pad2(p.month) + '-' + pad2(p.day), time: pad2(p.hour) + ':' + pad2(p.minute) };
  }

  // Civil ms of a yyyy-mm-dd input value, or NaN.
  function inputDay(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  }

  function fromInputs(date, time, tz) {
    const day = inputDay(date);
    const t = /^(\d{2}):(\d{2})/.exec(time);
    return isNaN(day) || !t ? NaN : localToUtc(tz, day + (+t[1]) * HOUR + (+t[2]) * 60000);
  }

  // e.g. "Sat, Oct 3 · 2 – 5:30 PM", "Oct 3 – Oct 10", "Sat, Oct 3 · all day".
  function eventWhen(e, tz) {
    const D = { weekday: 'short', month: 'short', day: 'numeric' };
    const day = (ms, o = D) => new Date(ms).toLocaleDateString('en-US', { timeZone: tz, ...o });
    const time = (ms) => { const p = zonedParts(new Date(ms), tz); const t = to12h(p.hour, p.minute); return (p.minute ? t.text : t.hh) + ' ' + t.suffix; };
    if (isAllDay(e, tz)) {
      const last = e.end - 60000;
      return day(e.start) === day(last) ? day(e.start) + ' · all day' : day(e.start) + ' – ' + day(last);
    }
    if (day(e.start) === day(e.end - 1)) return day(e.start) + ' · ' + time(e.start) + ' – ' + time(e.end);
    return day(e.start) + ', ' + time(e.start) + ' – ' + day(e.end) + ', ' + time(e.end);
  }

  const evtDialog = $('#evt-dialog');
  const evtWho = $('#evt-who');
  const evtAllDay = $('#evt-allday');
  const evtStartDate = $('#evt-start-date');
  const evtStartTime = $('#evt-start-time');
  const evtEndDate = $('#evt-end-date');
  const evtEndTime = $('#evt-end-time');
  const evtNote = $('#evt-note');
  const evtError = $('#evt-error');
  const evtBrushes = $('#evt-brushes');
  let evtEdit = null; // { colId, id } of the event being edited; id is null when new
  let evtCat = 'busy';

  const allColumns = () => [...cities, ...sync.hiddenCols];
  const evtColumn = () => allColumns().find((c) => c.id === evtWho.value);

  for (const cat of CATEGORIES) {
    const b = button('brush', null, { role: 'radio', 'data-cat': cat.id });
    b.style.setProperty('--c', 'var(--cat-' + cat.id + ')');
    b.append(el('i', 'brush-swatch'), el('span', null, cat.label));
    b.addEventListener('click', () => setEvtCat(cat.id));
    evtBrushes.append(b);
  }
  function setEvtCat(id) {
    evtCat = id;
    evtBrushes.querySelectorAll('.brush').forEach((b) => {
      const on = b.dataset.cat === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on);
    });
  }

  function syncEvtFields() {
    const c = evtColumn();
    if (!c) return;
    const allDay = evtAllDay.checked;
    evtStartTime.hidden = evtEndTime.hidden = allDay;
    $('#evt-end-label').textContent = allDay ? 'Last day' : 'Ends';
    $('#evt-tz').textContent = (allDay ? 'Whole days' : 'Times') + ' in ' + displayName(c) + '’s time zone · '
      + c.tz.replace(/_/g, ' ') + ' (' + formatOffset(offsetMinutes(c.tz, Date.now())) + ')';
  }

  // `event` to edit an existing one; otherwise `start` / `end` prefill a new one.
  function openEventDialog({ colId, event, start, end }) {
    const editable = allColumns().filter(canEdit);
    const c = editable.find((x) => x.id === colId);
    if (!c) return;
    evtWho.replaceChildren(...editable.map((x) => new Option(displayName(x) + ' — ' + x.city, x.id)));
    evtWho.value = c.id;
    $('#evt-who-field').hidden = editable.length < 2;
    evtEdit = { colId: c.id, id: event ? event.id : null };
    const s = event ? event.start : start;
    const e = event ? event.end : end;
    const allDay = !!event && isAllDay(event, c.tz);
    evtAllDay.checked = allDay;
    const a = toInputs(s, c.tz);
    const b = toInputs(allDay ? e - 60000 : e, c.tz);
    evtStartDate.value = a.date;
    evtStartTime.value = a.time;
    evtEndDate.value = b.date;
    evtEndTime.value = b.time;
    evtNote.value = (event && event.note) || '';
    setEvtCat(event ? event.cat : 'busy');
    $('#evt-title').textContent = event ? 'Edit event' : 'New event';
    $('#evt-kicker').textContent = 'ONE-OFF // ' + displayName(c).toUpperCase();
    $('#evt-delete').hidden = !event;
    evtError.hidden = true;
    syncEvtFields();
    evtDialog.showModal();
  }

  evtAllDay.addEventListener('change', () => {
    // An end at midnight means the day before was the last full day.
    if (evtAllDay.checked && evtEndTime.value === '00:00' && evtEndDate.value > evtStartDate.value) {
      evtEndDate.value = new Date(inputDay(evtEndDate.value) - DAY_MS).toISOString().slice(0, 10);
    }
    syncEvtFields();
  });
  evtWho.addEventListener('change', () => {
    $('#evt-kicker').textContent = 'ONE-OFF // ' + displayName(evtColumn()).toUpperCase();
    syncEvtFields();
  });
  // Keep the end after the start while editing the start.
  function nudgeEnd() {
    if (evtEndDate.value < evtStartDate.value) evtEndDate.value = evtStartDate.value;
    if (!evtAllDay.checked && evtEndDate.value === evtStartDate.value && evtEndTime.value <= evtStartTime.value) {
      const c = evtColumn();
      const b = toInputs(fromInputs(evtStartDate.value, evtStartTime.value, c.tz) + HOUR, c.tz);
      evtEndDate.value = b.date;
      evtEndTime.value = b.time;
    }
  }
  evtStartDate.addEventListener('change', nudgeEnd);
  evtStartTime.addEventListener('change', nudgeEnd);

  function evtFail(msg) {
    evtError.textContent = msg;
    evtError.hidden = false;
  }

  function afterEventChange() {
    saveCities();
    renderView();
    if (colDialog.open) paintEventList();
  }

  $('#evt-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const c = evtColumn();
    if (!c || !canEdit(c)) return;
    const tz = c.tz;
    let start, end;
    if (evtAllDay.checked) {
      start = localToUtc(tz, inputDay(evtStartDate.value));
      end = localToUtc(tz, inputDay(evtEndDate.value) + DAY_MS);
    } else {
      start = fromInputs(evtStartDate.value, evtStartTime.value, tz);
      end = fromInputs(evtEndDate.value, evtEndTime.value, tz);
    }
    const now = Date.now();
    if (isNaN(start) || isNaN(end)) return evtFail('Pick when it starts and ends.');
    if (end <= start) return evtFail('It has to end after it starts.');
    if (end - start > EVENTS.maxDays * DAY_MS) return evtFail('Events can last up to ' + EVENTS.maxDays + ' days.');
    if (end < now - EVENTS.keepDays * DAY_MS) return evtFail('That’s over a week ago — past events are cleared after ' + EVENTS.keepDays + ' days.');
    if (start > now + EVENTS.aheadDays * DAY_MS) return evtFail('That’s too far ahead (up to 2 years).');

    const id = evtEdit.id || newId();
    const others = c.events.filter((x) => x.id !== id);
    if (others.length >= EVENTS.perColumn) return evtFail(displayName(c) + ' already has ' + EVENTS.perColumn + ' one-off events — delete a few first.');
    const ev = { id, start, end, cat: evtCat };
    const note = evtNote.value.trim().slice(0, EVENTS.note);
    if (note) ev.note = note;
    // Moved to another person: take it off the original column.
    const prev = allColumns().find((x) => x.id === evtEdit.colId);
    if (prev && prev !== c) prev.events = prev.events.filter((x) => x.id !== id);
    c.events = [...others, ev].sort((x, y) => x.start - y.start);
    evtDialog.close();
    afterEventChange();
    toast((evtEdit.id ? 'Updated ' : 'Added ') + catLabel(ev.cat).toLowerCase() + ' for ' + displayName(c) + ' · ' + eventWhen(ev, tz));
  });

  $('#evt-delete').addEventListener('click', () => {
    const c = allColumns().find((x) => x.id === evtEdit.colId);
    if (!c) return;
    c.events = c.events.filter((x) => x.id !== evtEdit.id);
    evtDialog.close();
    afterEventChange();
    toast('Event deleted');
  });

  // Upcoming events in the column editor (read-only on others' columns).
  function paintEventList() {
    const c = editCity();
    if (!c) return;
    const editable = canEdit(c);
    const list = $('#col-events');
    const now = Date.now();
    const upcoming = c.events.filter((e) => e.end > now);
    list.replaceChildren();
    if (!upcoming.length) {
      list.append(el('li', 'evt-empty', editable
        ? 'Nothing coming up. Tap an hour on the board and pick “Just <date>”, or add one here.'
        : 'Nothing coming up.'));
    }
    for (const e of upcoming) {
      const li = el('li', 'evt-row cat-' + e.cat);
      const body = editable ? button('evt-open', null, { title: 'Edit event' }) : el('div', 'evt-open');
      const main = el('span', 'evt-main');
      main.append(el('span', 'evt-when', eventWhen(e, c.tz)), el('span', 'evt-what', catLabel(e.cat) + (e.note ? ' · ' + e.note : '')));
      body.append(el('i', 'menu-swatch'), main);
      if (e.start <= now) body.append(el('span', 'evt-live', 'NOW'));
      li.append(body);
      if (editable) {
        body.addEventListener('click', () => openEventDialog({ colId: c.id, event: e }));
        const del = button('mini-btn danger', '✕', { title: 'Delete event', 'aria-label': 'Delete event' });
        del.addEventListener('click', () => {
          c.events = c.events.filter((x) => x !== e);
          afterEventChange();
        });
        li.append(del);
      }
      list.append(li);
    }
    $('#col-add-event').hidden = !editable;
    $('#col-events-hint').textContent = editable ? '· override the weekly schedule on specific dates; cleared a week after they end' : '';
  }

  $('#col-add-event').addEventListener('click', () => {
    const c = editCity();
    // Default: the next full hour, for an hour.
    const start = Math.ceil(Date.now() / HOUR) * HOUR;
    openEventDialog({ colId: c.id, start, end: start + HOUR });
  });

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
    const hint = el('span', 'legend-hint', 'Tap a cell to set status or add a one-off · tap a name to rename · drag a header to reorder');
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

  // ---------- Mobile view (hourly grid / stacked current times) ----------

  $('#view-toggle').addEventListener('click', () => {
    const next = root.dataset.view === 'stack' ? 'grid' : 'stack';
    localStorage.setItem(VIEW_KEY, next);
    applyViewMode();
    closeCellMenu();
    if (next === 'grid') scrollCurrentIntoView();
  });

  // Sync changes made in another tab.
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && !inBoard()) { cities = loadCities(); renderAll(false); }
    if (e.key === SETTINGS_KEY) { settings = loadSettings(); applyColors(); }
  });

  // ---------- Shared boards ----------
  // Signed-in friends can switch from this device's private layout to a board
  // stored on the server. Local edits are diffed against the last server copy
  // and sent as one debounced request; other people's edits arrive by polling.
  // Polling slows down when idle and stops while the tab is hidden, which keeps
  // serverless invocations (and so the hosting bill) small.

  const API = '/api/sync';
  const SYNC_KEY = 'timediff.sync';
  const SAVE_DELAY = 800;
  const POLL_ACTIVE = 20000; // tab visible and in use
  const POLL_IDLE = 90000; // no interaction for IDLE_AFTER
  const IDLE_AFTER = 5 * 60000;
  const SLEEP_AFTER = 30 * 60000; // stop polling until the next interaction
  const SHARED = ['label', 'schedule', 'workDays', 'events', 'ownerId']; // synced to everyone

  const syncBtn = $('#sync-btn');
  const syncDialog = $('#sync-dialog');
  const syncInner = $('#sync-inner');

  async function api(op, body, query) {
    let res, data;
    try {
      res = await fetch(API + '?' + new URLSearchParams({ op, ...query }), body ? {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true, // let a final save finish if the tab closes
      } : undefined);
      data = await res.json();
    } catch {
      throw Object.assign(new Error('Can’t reach the server.'), { status: 0 });
    }
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
    return data;
  }

  const snap = (c) => JSON.stringify(SHARED.map((k) => c[k] ?? null));
  const unsnap = (s) => Object.fromEntries(JSON.parse(s).map((v, i) => [SHARED[i], v]));

  // What changed in column `c` since `old` (an unsnapped copy), or null. Only
  // the differences are sent: single hours, single days, and events added,
  // edited or deleted by id. The server applies them to its current copy, so
  // edits to the same column from two people merge instead of overwriting.
  function diffCol(old, c) {
    const p = {};
    for (const k of ['label', 'ownerId']) if ((old[k] ?? null) !== (c[k] ?? null)) p[k] = c[k] ?? null;
    const oldSchedule = old.schedule || [];
    const hours = {};
    c.schedule.forEach((cat, h) => { if (cat !== (oldSchedule[h] ?? null)) hours[h] = cat; });
    if (Object.keys(hours).length) p.schedule = hours;
    const oldDays = old.workDays || [];
    const days = {};
    for (let d = 0; d < 7; d++) if (c.workDays.includes(d) !== oldDays.includes(d)) days[d] = c.workDays.includes(d);
    if (Object.keys(days).length) p.workDays = days;
    const before = new Map((old.events || []).map((e) => [e.id, JSON.stringify(e)]));
    const ids = new Set(c.events.map((e) => e.id));
    const put = c.events.filter((e) => before.get(e.id) !== JSON.stringify(e));
    const del = [...before.keys()].filter((id) => !ids.has(id));
    if (put.length || del.length) p.events = { put, del };
    return Object.keys(p).length ? p : null;
  }

  // Apply a diffCol() result to column `c` (what the server does, too).
  function applyDiff(c, p) {
    for (const k of ['label', 'ownerId']) if (k in p) { if (p[k]) c[k] = p[k]; else delete c[k]; }
    if (p.schedule) for (const h in p.schedule) c.schedule[h] = p.schedule[h];
    if (p.workDays) {
      const days = new Set(c.workDays);
      for (const d in p.workDays) { if (p.workDays[d]) days.add(+d); else days.delete(+d); }
      c.workDays = [...days].sort();
    }
    if (p.events) {
      const byId = new Map(c.events.filter((e) => !p.events.del.includes(e.id)).map((e) => [e.id, e]));
      for (const e of p.events.put) byId.set(e.id, e);
      c.events = cleanEvents([...byId.values()]);
    }
  }

  // This person's view: column order, hidden columns and header colors.
  function currentView() {
    const all = [...cities, ...sync.hiddenCols];
    return {
      order: all.map((c) => c.id),
      hidden: sync.hiddenCols.map((c) => c.id),
      colors: Object.fromEntries(all.filter((c) => c.headerColor).map((c) => [c.id, c.headerColor])),
      mine: sync.viewMine,
    };
  }

  // Arrange a board's columns by this person's saved view.
  function compose(state) {
    const cols = state.columns.map(sanitizeCity).filter(Boolean);
    const view = state.view || { order: [], hidden: [] };
    sync.viewMine = view.mine || null;
    const rank = new Map(view.order.map((id, i) => [id, i]));
    cols.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)); // new columns go last
    for (const c of cols) {
      const hex = normalizeHex((view.colors || {})[c.id]);
      if (hex) c.headerColor = hex; else delete c.headerColor;
    }
    const hidden = new Set(view.hidden);
    const visible = cols.filter((c) => !hidden.has(c.id));
    const hiddenCols = cols.filter((c) => hidden.has(c.id));
    if (!visible.length && hiddenCols.length) visible.push(hiddenCols.shift());
    return { visible, hiddenCols };
  }

  // Your assigned column is your reference: whenever the admin assigns you a
  // column you didn't have before, it moves to the front of your view (once, so
  // you can still reorder afterwards).
  function pinOwn(visible, hiddenCols) {
    const own = [...visible, ...hiddenCols].find((c) => c.ownerId === sync.user.id);
    if (own && own.id !== sync.viewMine) {
      for (const list of [visible, hiddenCols]) if (list.includes(own)) list.splice(list.indexOf(own), 1);
      visible.unshift(own);
    }
    sync.viewMine = own ? own.id : null;
  }

  function saveSyncCache() {
    if (!sync.user) { localStorage.removeItem(SYNC_KEY); return; }
    localStorage.setItem(SYNC_KEY, JSON.stringify({ user: sync.user, boards: sync.boards, state: sync.boardId ? sync.state : null }));
  }

  const setSyncStatus = (s) => { syncBtn.dataset.state = s; };

  function updateSyncUi() {
    syncBtn.hidden = $('#sync-sep').hidden = !sync.enabled;
    $('#sync-label').textContent = sync.boardId ? sync.boardName : sync.user ? 'This device' : 'Sign in';
    syncBtn.title = sync.boardId ? 'Shared board “' + sync.boardName + '” — click to switch'
      : sync.user ? 'Showing your private layout — click to open a shared board' : 'Sign in to shared boards';
    root.classList.toggle('shared', inBoard());
    root.classList.toggle('has-sync', sync.enabled);
    if (!inBoard()) setSyncStatus('local');
  }

  // Take the server's copy of the board. `sent` describes the save that returned
  // this state ({ cols: id → snapshot, view }); after our own save we keep our
  // view and anything edited while it was in flight, and only take other
  // people's changes to shared fields.
  function adopt(state, sent, render = true) {
    const key = (vis, hid) => vis.map((c) => c.id + snap(c) + (c.headerColor || '')).join() + '|' + hid.map((c) => c.id).join();
    const before = key(cities, sync.hiddenCols);
    let visible, hiddenCols;
    if (!sent) {
      ({ visible, hiddenCols } = compose(state));
    } else {
      const server = new Map(state.columns.map((c) => [c.id, sanitizeCity(c)]));
      const merge = (lc) => {
        const sc = server.get(lc.id);
        const sentSnap = sent.cols.get(lc.id);
        if (!sc) return sentSnap !== undefined ? null : lc; // removed by someone else / added meanwhile
        if (sentSnap === undefined) return lc;
        // Take the server's copy (which includes other people's changes), then
        // replay anything edited here while the save was in flight.
        const pending = snap(lc) === sentSnap ? null : diffCol(unsnap(sentSnap), lc);
        for (const k of SHARED) { if (sc[k] === undefined) delete lc[k]; else lc[k] = structuredClone(sc[k]); }
        if (pending) applyDiff(lc, pending);
        return lc;
      };
      visible = cities.map(merge).filter(Boolean);
      hiddenCols = sync.hiddenCols.map(merge).filter(Boolean);
      const known = new Set([...visible, ...hiddenCols].map((c) => c.id));
      for (const [id, sc] of server) {
        if (sc && !known.has(id) && !sent.cols.has(id)) { delete sc.headerColor; visible.push(sc); } // added by others
      }
      if (!visible.length && hiddenCols.length) visible.push(hiddenCols.shift());
    }
    pinOwn(visible, hiddenCols);

    const changed = key(visible, hiddenCols) !== before
      || sync.boardName !== state.board.name
      || JSON.stringify(sync.members) !== JSON.stringify(state.members);
    sync.state = state;
    sync.version = state.version;
    sync.boardName = state.board.name;
    sync.members = state.members;
    sync.base = new Map(state.columns.map((c) => [c.id, snap(sanitizeCity(c) || {})]));
    cities = visible;
    sync.hiddenCols = hiddenCols;
    sync.baseView = sent ? sent.view : JSON.stringify(currentView());
    saveSyncCache();
    if (!render) return;
    updateSyncUi();
    if (!changed) return;
    renderAll(false);
    if (colDialog.open) { if (editCity()) syncColDialog(); else colDialog.close(); }
  }

  // What changed locally since the last server copy, or null if nothing.
  function computeChanges() {
    const all = [...cities, ...sync.hiddenCols];
    const ids = new Set(all.map((c) => c.id));
    const create = [], patch = [];
    for (const c of all) {
      const prev = sync.base.get(c.id);
      if (prev === undefined) { create.push(c); continue; }
      if (prev === snap(c)) continue;
      const p = diffCol(unsnap(prev), c);
      if (p) patch.push({ id: c.id, ...p });
    }
    const remove = [...sync.base.keys()].filter((id) => !ids.has(id));
    const view = JSON.stringify(currentView());
    const viewChanged = view !== sync.baseView;
    if (!create.length && !patch.length && !remove.length && !viewChanged) return null;
    return { create, patch, remove, view: viewChanged ? JSON.parse(view) : undefined };
  }

  function queueSync(delay = SAVE_DELAY) {
    sync.dirty = true;
    setSyncStatus('pending');
    clearTimeout(sync.saveTimer);
    sync.saveTimer = setTimeout(flush, delay);
  }

  async function flush() {
    clearTimeout(sync.saveTimer);
    if (!sync.boardId || sync.inflight || !sync.dirty) return;
    sync.dirty = false;
    const changes = computeChanges();
    if (!changes) { setSyncStatus('ok'); return; }
    const boardId = sync.boardId;
    const sent = {
      cols: new Map([...cities, ...sync.hiddenCols].map((c) => [c.id, snap(c)])),
      view: JSON.stringify(currentView()),
    };
    sync.inflight = true;
    setSyncStatus('saving');
    try {
      const state = await api('sync', { boardId, ...changes });
      if (sync.boardId === boardId) { adopt(state, sent); setSyncStatus('ok'); }
    } catch (err) {
      if (sync.boardId === boardId) syncFailed(err, true);
    } finally {
      sync.inflight = false;
    }
    if (sync.dirty && sync.boardId) queueSync(); // edits made while saving
  }

  function syncFailed(err, saving) {
    if (err.status === 401) { signedOut('You were signed out — showing this device’s layout.'); return; }
    if (err.status === 404) { toast(err.message, true); leaveBoard(); refreshMe().catch(() => {}); return; }
    setSyncStatus('error');
    if (saving && (err.status === 0 || err.status === 429 || err.status >= 500)) {
      toast(err.message + ' Retrying shortly…', true);
      queueSync(15000); // keep the edits and try again
      setSyncStatus('error');
      return;
    }
    // Rejected (e.g. no permission): drop the local edits and reload.
    toast(err.message, true);
    reloadBoard();
  }

  async function reloadBoard() {
    const id = sync.boardId;
    clearTimeout(sync.saveTimer);
    sync.dirty = false;
    try {
      const state = await api('state', null, { board: id });
      if (sync.boardId === id) { adopt(state, null); setSyncStatus('ok'); }
    } catch (err) {
      if (sync.boardId === id && (err.status === 401 || err.status === 404)) syncFailed(err);
    }
  }

  function schedulePoll() {
    clearTimeout(sync.pollTimer);
    if (!sync.boardId || document.hidden) return;
    const idle = Date.now() - sync.lastActive;
    if (idle > SLEEP_AFTER) return; // resumes on the next interaction
    sync.pollTimer = setTimeout(poll, idle > IDLE_AFTER ? POLL_IDLE : POLL_ACTIVE);
  }

  const busyEditing = () => sync.dirty || sync.inflight || !!drag || paintValue !== undefined || !cellMenu.hidden;

  async function poll() {
    clearTimeout(sync.pollTimer);
    const id = sync.boardId;
    if (!id || sync.polling) return;
    if (busyEditing()) { schedulePoll(); return; }
    sync.polling = true;
    sync.lastPoll = Date.now();
    try {
      // `since` lets the server answer "unchanged" without reading the board.
      const state = await api('state', null, { board: id, since: sync.version });
      if (sync.boardId === id && !state.unchanged && !busyEditing()) adopt(state, null);
      if (sync.boardId === id && !sync.dirty && !sync.inflight) setSyncStatus('ok');
    } catch (err) {
      if (sync.boardId === id) {
        if (err.status === 401 || err.status === 404) syncFailed(err);
        else setSyncStatus('error');
      }
    } finally {
      sync.polling = false;
    }
    schedulePoll();
  }

  function pollSoon() {
    if (sync.boardId && !document.hidden && Date.now() - sync.lastPoll > 10000) poll();
    else schedulePoll();
  }

  function markActive() {
    const idle = Date.now() - sync.lastActive;
    sync.lastActive = Date.now();
    if (idle > IDLE_AFTER) pollSoon(); // catch up after being idle
  }
  for (const t of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(t, markActive, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(sync.pollTimer); flush(); } else pollSoon();
  });

  async function openBoard(id) {
    if (sync.boardId && sync.dirty) await flush();
    const state = await api('state', null, { board: id });
    clearTimeout(sync.saveTimer);
    sync.dirty = false;
    sync.boardId = id;
    cities = [];
    sync.hiddenCols = [];
    adopt(state, null, false);
    updateSyncUi();
    setSyncStatus('ok');
    renderAll(true);
    schedulePoll();
  }

  function leaveBoard() {
    clearTimeout(sync.saveTimer);
    clearTimeout(sync.pollTimer);
    Object.assign(sync, { boardId: null, boardName: '', state: null, members: [], hiddenCols: [], dirty: false });
    if (colDialog.open) colDialog.close();
    cities = loadCities();
    saveSyncCache();
    updateSyncUi();
    renderAll(true);
  }

  function signedOut(message) {
    sync.user = null;
    sync.boards = [];
    if (sync.boardId) leaveBoard();
    saveSyncCache();
    updateSyncUi();
    if (message) toast(message, true);
  }

  async function refreshMe() {
    const me = await api('me');
    sync.enabled = !!me.enabled;
    sync.user = me.user || null;
    sync.boards = me.boards || [];
    saveSyncCache();
    updateSyncUi();
    return me;
  }

  // Show the last known board instantly on load; initSync() then refreshes it.
  function restoreSyncCache() {
    try {
      const c = JSON.parse(localStorage.getItem(SYNC_KEY));
      if (!c || !c.user) return;
      Object.assign(sync, { enabled: true, user: c.user, boards: c.boards || [] });
      if (c.state && c.state.board) {
        sync.boardId = c.state.board.id;
        adopt(c.state, null, false);
        if (!cities.length) { sync.boardId = null; cities = loadCities(); }
      }
    } catch { /* ignore a corrupt cache */ }
  }

  async function initSync() {
    const invite = new URLSearchParams(location.search).get('invite');
    if (invite) history.replaceState(null, '', location.pathname);
    let me;
    try {
      me = await refreshMe();
    } catch {
      // Offline, or hosted without the API. Keep showing any cached board.
      sync.enabled = !!sync.user;
      updateSyncUi();
      if (sync.boardId) setSyncStatus('error');
      return;
    }
    if (!me.enabled || !me.user) {
      if (sync.boardId) signedOut(me.enabled ? 'Your session expired — showing this device’s layout.' : '');
    } else if (sync.boardId) {
      if (sync.boards.some((b) => b.id === sync.boardId)) poll();
      else { toast('You no longer have access to “' + sync.boardName + '”.', true); leaveBoard(); }
    }
    if (invite && me.enabled) {
      try {
        const info = await api('inviteInfo', { token: invite });
        renderSyncDialog('invite', { token: invite, info });
        syncDialog.showModal();
      } catch (err) {
        toast(err.message, true);
      }
    }
  }

  // ----- Sign-in / boards dialog -----

  let submitAction = null;

  const hint = (text) => el('p', 'field-hint', text);
  const inlineRow = (...kids) => { const r = el('div', 'inline-row'); r.append(...kids); return r; };

  function group(label, ...kids) {
    const g = el('div', 'field');
    g.append(el('span', 'field-label', label), ...kids);
    return g;
  }

  function input(attrs) {
    const i = document.createElement('input');
    i.className = 'text-input';
    for (const k in attrs) i[k] = attrs[k];
    return i;
  }

  function labeled(label, attrs) {
    const i = input(attrs);
    const wrap = el('label', 'field');
    wrap.append(el('span', 'field-label', label), i);
    return [wrap, i];
  }

  function onEnter(i, fn) {
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fn(); } });
  }

  function errorLine() {
    const e = el('p', 'form-error');
    e.hidden = true;
    e.setAttribute('role', 'alert');
    return e;
  }

  // Run an async action with its button disabled, reporting errors in `errEl`.
  async function attempt(btn, errEl, fn) {
    btn.disabled = true;
    errEl.hidden = true;
    try {
      await fn();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  function linkBox(url, note) {
    const i = input({ value: url, readOnly: true });
    i.addEventListener('focus', () => i.select());
    const copy = button('btn', 'Copy');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url); copy.textContent = 'Copied'; } catch { i.focus(); }
    });
    const box = el('div', 'field');
    box.append(inlineRow(i, copy), hint(note));
    return box;
  }

  const inviteUrl = (token) => location.origin + location.pathname + '?invite=' + encodeURIComponent(token);

  function dlgFrame(kicker, title, body, footKids) {
    const head = el('div', 'dlg-head');
    const t = el('div');
    t.append(el('span', 'kicker', kicker), el('h2', null, title));
    head.append(t, button('icon-btn ghost', '✕', { 'data-close': '', 'aria-label': 'Close' }));
    const foot = el('div', 'dlg-foot');
    foot.append(...footKids);
    syncInner.replaceChildren(head, body, foot);
  }

  function renderSyncDialog(view, data) {
    submitAction = null;
    if (view === 'login') loginView();
    else if (view === 'invite') inviteView(data.token, data.info);
    else boardsView();
  }

  function loginView() {
    const body = el('div', 'dlg-body');
    const [userWrap, user] = labeled('Username', { autocomplete: 'username', autocapitalize: 'none', spellcheck: false, maxLength: 40 });
    const [passWrap, pass] = labeled('Password', { type: 'password', autocomplete: 'current-password', maxLength: 200 });
    const err = errorLine();
    body.append(userWrap, passWrap, err,
      hint('Shared boards are invite-only — ask whoever runs this site for an invite link. Without signing in, everything stays on this device.'));
    const go = button('btn primary', 'Sign in');
    go.type = 'submit';
    submitAction = () => attempt(go, err, async () => {
      await api('login', { username: user.value.trim(), password: pass.value });
      await refreshMe();
      // Friends with a single board go straight to it.
      if (!isAdmin() && sync.boards.length === 1) {
        await openBoard(sync.boards[0].id);
        syncDialog.close();
        return;
      }
      renderSyncDialog('boards');
    });
    dlgFrame('SYNC', 'Sign in', body, [el('span', 'spacer'), go]);
    setTimeout(() => user.focus());
  }

  function inviteView(token, info) {
    const reset = !!info.username;
    const body = el('div', 'dlg-body');
    let user = null;
    if (!reset) {
      const [w, i] = labeled('Username', { autocomplete: 'username', autocapitalize: 'none', spellcheck: false, maxLength: 24 });
      body.append(w);
      user = i;
    }
    const [passWrap, pass] = labeled(reset ? 'New password' : 'Password', { type: 'password', autocomplete: reset ? 'new-password' : 'current-password', maxLength: 200 });
    const err = errorLine();
    body.append(passWrap, err, hint(reset
      ? 'Choose a new password (8+ characters) for @' + info.username + '.'
      : 'New here? Pick a username and a password (8+ characters). Already have an account? Enter your existing login to add this board to it.'));
    const go = button('btn primary', reset ? 'Set password' : 'Join board');
    go.type = 'submit';
    submitAction = () => attempt(go, err, async () => {
      const res = await api('acceptInvite', { token, username: user ? user.value.trim() : undefined, password: pass.value });
      await refreshMe();
      if (res.boardId) await openBoard(res.boardId);
      syncDialog.close();
      toast(reset ? 'Password updated — you’re signed in.' : 'You’re in! Your column is tagged YOU once the admin assigns it.');
    });
    dlgFrame('INVITE', reset ? 'Reset password' : 'Join “' + info.boardName + '”', body, [el('span', 'spacer'), go]);
    setTimeout(() => (user || pass).focus());
  }

  function boardsView() {
    const body = el('div', 'dlg-body');
    const err = errorLine();

    const list = el('div', 'board-list');
    const item = (id, name, sub) => {
      const b = button('board-item' + (sync.boardId === id ? ' active' : ''));
      b.append(el('span', 'board-name', name), el('span', 'board-sub', sub));
      b.addEventListener('click', () => attempt(b, err, async () => {
        if (id !== sync.boardId) { if (id) await openBoard(id); else leaveBoard(); }
        if (isAdmin()) renderSyncDialog('boards'); else syncDialog.close();
      }));
      return b;
    };
    list.append(item(null, 'This device', 'Private · stored in this browser only'));
    for (const b of sync.boards) list.append(item(b.id, b.name, 'Shared board'));
    body.append(group('Boards', list), err);

    if (isAdmin()) {
      const name = input({ placeholder: 'Board name', maxLength: 40 });
      const create = button('btn', 'Create');
      const doCreate = () => attempt(create, err, async () => {
        const { board } = await api('createBoard', { name: name.value, columns: cities.map(({ events, ...c }) => c) }); // events stay local, keeping the request small
        await refreshMe();
        await openBoard(board.id);
        renderSyncDialog('boards');
      });
      create.addEventListener('click', doCreate);
      onEnter(name, doCreate);
      body.append(group('New board', inlineRow(name, create), hint('Starts with a copy of the columns you’re looking at now.')));
    }

    if (isAdmin() && inBoard()) body.append(...boardAdmin(err));
    if (inBoard()) {
      body.append(hint((isAdmin() ? '' : 'You can edit the schedule of the column tagged YOU (the admin assigns it). ')
        + 'Column order, header colors and hidden columns are just your view — drag headers to reorder, or tap ✎ on any column.'));
    }

    const out = button('btn', 'Sign out');
    out.addEventListener('click', () => attempt(out, err, async () => {
      if (sync.dirty) await flush();
      await api('logout', {});
      signedOut();
      renderSyncDialog('login');
    }));
    const done = button('btn primary', 'Done', { 'data-close': '' });
    dlgFrame('SIGNED IN // @' + sync.user.username + (isAdmin() ? ' // ADMIN' : ''), 'Boards', body, [out, el('span', 'spacer'), done]);
  }

  // Admin tools for the open board: rename, invite, members, delete.
  function boardAdmin(err) {
    const boardId = sync.boardId;

    const name = input({ value: sync.boardName, maxLength: 40 });
    const rename = button('btn', 'Rename');
    const doRename = () => attempt(rename, err, async () => {
      await api('renameBoard', { boardId, name: name.value });
      await refreshMe();
      await reloadBoard();
      renderSyncDialog('boards');
    });
    rename.addEventListener('click', doRename);
    onEnter(name, doRename);

    const linkOut = el('div');
    const invite = button('btn', 'Create invite link');
    invite.addEventListener('click', () => attempt(invite, err, async () => {
      const r = await api('createInvite', { boardId });
      linkOut.replaceChildren(linkBox(inviteUrl(r.token), 'Anyone with this link can join (up to ' + r.uses + ' people, for ' + r.days + ' days). Friends pick their own username and password.'));
    }));

    const people = el('div', 'member-list');
    const others = sync.members.filter((m) => !m.isAdmin);
    if (!others.length) people.append(hint('No one has joined yet — send an invite link.'));
    for (const m of others) {
      const row = el('div', 'member-row');
      const reset = button('text-btn', 'Reset password');
      reset.addEventListener('click', () => attempt(reset, err, async () => {
        const r = await api('resetLink', { userId: m.id });
        linkOut.replaceChildren(linkBox(inviteUrl(r.token), 'Send this to @' + m.username + ' only. It works once, for ' + r.hours + ' hours.'));
      }));
      const remove = button('text-btn danger', 'Remove');
      remove.addEventListener('click', () => {
        if (!confirm('Remove @' + m.username + ' from “' + sync.boardName + '”? Their columns stay, unassigned.')) return;
        attempt(remove, err, async () => {
          await api('removeMember', { boardId, userId: m.id });
          await reloadBoard();
          renderSyncDialog('boards');
        });
      });
      row.append(el('span', 'member-name', '@' + m.username), reset, remove);
      people.append(row);
    }

    const del = button('btn danger', 'Delete board');
    del.addEventListener('click', () => {
      if (!confirm('Delete “' + sync.boardName + '” for everyone? This can’t be undone.')) return;
      attempt(del, err, async () => {
        await api('deleteBoard', { boardId });
        leaveBoard();
        await refreshMe();
        renderSyncDialog('boards');
      });
    });

    return [
      group('This board', inlineRow(name, rename)),
      group('People', people, inlineRow(invite), linkOut,
        hint('To give someone a column, open its editor (✎) and pick them under “Managed by”. They can then edit only that column.')),
      inlineRow(del),
    ];
  }

  syncBtn.addEventListener('click', () => {
    renderSyncDialog(sync.user ? 'boards' : 'login');
    syncDialog.showModal();
  });
  syncInner.addEventListener('submit', (e) => {
    e.preventDefault();
    if (submitAction) submitAction();
  });

  // ---------- Go ----------

  applyColors();
  restoreSyncCache();
  updateSyncUi();
  renderAll(true);
  initSync();
  (function loop() {
    tick();
    setTimeout(loop, 1000 - (Date.now() % 1000) + 5);
  })();
})();
