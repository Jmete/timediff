// Server-side validation of column data (mirrors sanitizeCity in app.js).

const CAT_IDS = ['work', 'busy', 'sleep', 'free'];

function isValidTz(tz) {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function normalizeHex(s) {
  return typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : null;
}

export const cleanLabel = (v) => str(v, 40) || undefined;
export const cleanColor = (v) => normalizeHex(v) || undefined;

// A person's view of a board, limited to columns that exist (`ids`).
export function cleanView(v, ids) {
  if (!v || typeof v !== 'object') return null;
  const known = (a) => (Array.isArray(a) ? [...new Set(a.filter((id) => ids.has(id)))] : []);
  const colors = {};
  if (v.colors && typeof v.colors === 'object') {
    for (const id of Object.keys(v.colors).slice(0, 100)) {
      const hex = ids.has(id) && cleanColor(v.colors[id]);
      if (hex) colors[id] = hex;
    }
  }
  // `mine`: the column that was assigned to them when the view was saved.
  return { order: known(v.order), hidden: known(v.hidden), colors, mine: ids.has(v.mine) ? v.mine : null };
}

export function cleanSchedule(v) {
  if (!Array.isArray(v) || v.length !== 24) return null;
  return v.map((s) => (CAT_IDS.includes(s) ? s : null));
}

// One-off events override the weekly schedule for a stretch of time. They are
// stored inside the column's row (Turso bills per row read, not per byte), and
// pruned a week after they end every time the column is written, so storage
// stays bounded without a cron job. Limits here mirror cleanEvents in app.js.
export const EVENT_LIMITS = { perColumn: 60, maxDays: 31, keepDays: 7, aheadDays: 730, note: 60 };
const DAY = 86400000;

export function cleanEvents(v, now = Date.now(), limit = EVENT_LIMITS.perColumn) {
  if (!Array.isArray(v)) return [];
  const oldest = now - EVENT_LIMITS.keepDays * DAY;
  const latest = now + EVENT_LIMITS.aheadDays * DAY;
  const out = [];
  const seen = new Set();
  for (const e of v.slice(0, EVENT_LIMITS.perColumn * 3)) {
    if (!e || typeof e !== 'object' || !CAT_IDS.includes(e.cat)) continue;
    const { start, end } = e;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) continue;
    if (end - start > EVENT_LIMITS.maxDays * DAY || end < oldest || start > latest) continue;
    if (typeof e.id !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(e.id) || seen.has(e.id)) continue;
    seen.add(e.id);
    const ev = { id: e.id, start, end, cat: e.cat };
    const note = str(e.note, EVENT_LIMITS.note);
    if (note) ev.note = note;
    out.push(ev);
  }
  return out.sort((a, b) => a.start - b.start).slice(0, limit);
}

// ----- Change-based saves -----
// Clients send only what changed, and the server applies it to the column as
// currently stored, so two people editing the same column don't undo each
// other's work. A full array (from older clients) still replaces the field.

// { "9": "work", "10": null } sets just those hours.
export function patchSchedule(cur, v) {
  if (Array.isArray(v)) return cleanSchedule(v) || cur;
  if (!v || typeof v !== 'object') return cur;
  const out = cur.slice();
  for (const [k, cat] of Object.entries(v)) {
    const h = Number(k);
    if (Number.isInteger(h) && h >= 0 && h < 24) out[h] = CAT_IDS.includes(cat) ? cat : null;
  }
  return out;
}

// { "6": true, "1": false } turns just those days on or off.
export function patchWorkDays(cur, v) {
  if (Array.isArray(v)) return cleanWorkDays(v) || cur;
  if (!v || typeof v !== 'object') return cur;
  const days = new Set(cur);
  for (const [k, on] of Object.entries(v)) {
    const d = Number(k);
    if (Number.isInteger(d) && d >= 0 && d <= 6) { if (on) days.add(d); else days.delete(d); }
  }
  return [...days].sort();
}

// { put: [events added or edited], del: [ids] }. Returns null if the result
// would exceed the per-column limit.
export function patchEvents(cur, v) {
  let merged;
  if (Array.isArray(v)) {
    merged = cleanEvents(v, undefined, Infinity);
  } else {
    const del = new Set(v && Array.isArray(v.del) ? v.del.slice(0, EVENT_LIMITS.perColumn * 3) : []);
    const byId = new Map(cleanEvents(cur, undefined, Infinity).filter((e) => !del.has(e.id)).map((e) => [e.id, e]));
    for (const e of cleanEvents(v && Array.isArray(v.put) ? v.put : [])) byId.set(e.id, e);
    merged = cleanEvents([...byId.values()], undefined, Infinity);
  }
  return merged.length > EVENT_LIMITS.perColumn ? null : merged;
}

export function cleanWorkDays(v) {
  if (!Array.isArray(v)) return null;
  return [...new Set(v.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
}

// Full column for creation; returns null if unusable.
export function cleanColumn(c) {
  if (!c || typeof c !== 'object' || !isValidTz(c.tz)) return null;
  const city = str(c.city, 80);
  if (!city) return null;
  return {
    city,
    country: str(c.country, 80),
    tz: c.tz,
    label: cleanLabel(c.label),
    schedule: cleanSchedule(c.schedule) || Array.from({ length: 24 }, (_, h) => (h >= 9 && h < 17 ? 'work' : null)),
    workDays: cleanWorkDays(c.workDays) || [1, 2, 3, 4, 5],
    ...withEvents(cleanEvents(c.events)),
  };
}

// Empty event lists aren't stored at all.
export const withEvents = (events) => (events.length ? { events } : {});

export const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{6,24}$/.test(id);
