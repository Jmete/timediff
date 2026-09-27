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
  };
}

export const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{6,24}$/.test(id);
