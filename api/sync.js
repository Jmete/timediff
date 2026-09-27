// TIME/DIFF sync API — a single serverless function so the whole backend is one
// cheap invocation per call. Operations are selected with ?op=<name>.
//
// Roles: the admin (ADMIN_USERNAME / ADMIN_PASSWORD env vars) creates boards and
// invite links, and adds columns and assigns each friend one. Friends join
// through an invite, then edit only the column assigned to them; the admin can
// edit every column. Column order, hidden columns and header colors are
// personal: each person has a view.

import { one, all, run, batch } from './_lib/db.js';
import {
  SESSION_COOKIE, SESSION_DAYS, randomToken, newId, sha256, hashPassword, verifyPassword,
  safeEqual, readCookie, sessionCookie, clientIp, sameOrigin, memLimit, dbLimit,
} from './_lib/security.js';
import { cleanColumn, cleanLabel, cleanColor, cleanSchedule, cleanWorkDays, cleanView, validId } from './_lib/columns.js';

// Hard caps keep storage, row reads and abuse bounded.
const LIMITS = {
  bodyBytes: 32 * 1024,
  boards: 20,
  columnsPerBoard: 30,
  users: 100,
  membersPerBoard: 50,
};
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const INVITE_USES = 10;
const INVITE_DAYS = 7;
const RESET_HOURS = 24;

const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const isAdminName = (name) => !!ADMIN_USERNAME && String(name).toLowerCase() === ADMIN_USERNAME.toLowerCase();

// On Vercel without a database configured, report sync as disabled rather than
// failing, so the app keeps working as a local-only tool.
const ENABLED = !process.env.VERCEL || !!process.env.TURSO_DATABASE_URL;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

// ---------- Sessions ----------

async function currentUser(ctx) {
  if (ctx.user !== undefined) return ctx.user;
  ctx.user = null;
  const token = readCookie(ctx.request, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const hash = sha256(token);
  const row = await one(
    'SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    [hash],
  );
  if (!row || Number(row.expires_at) < Date.now()) return null;
  // Sliding expiry, refreshed at most about twice a month to avoid writes.
  if (Number(row.expires_at) - Date.now() < (SESSION_DAYS / 2) * DAY) {
    await run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', [Date.now() + SESSION_DAYS * DAY, hash]);
    ctx.headers['set-cookie'] = sessionCookie(ctx.request, token, SESSION_DAYS * 86400);
  }
  ctx.user = { id: row.id, username: row.username, isAdmin: isAdminName(row.username) };
  return ctx.user;
}

async function requireUser(ctx) {
  const user = await currentUser(ctx);
  if (!user) fail(401, 'Please sign in.');
  return user;
}

async function requireAdmin(ctx) {
  const user = await requireUser(ctx);
  if (!user.isAdmin) fail(403, 'Only the admin can do that.');
  return user;
}

async function startSession(ctx, userId) {
  const token = randomToken();
  const now = Date.now();
  // Housekeeping piggybacks on logins so no cron job is needed.
  await batch([
    { sql: 'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', args: [sha256(token), userId, now + SESSION_DAYS * DAY] },
    { sql: 'DELETE FROM sessions WHERE expires_at < ?', args: [now] },
    { sql: 'DELETE FROM invites WHERE expires_at < ? OR uses_left <= 0', args: [now] },
    { sql: 'DELETE FROM rate_limits WHERE window_start < ?', args: [now - DAY] },
  ]);
  ctx.headers['set-cookie'] = sessionCookie(ctx.request, token, SESSION_DAYS * 86400);
}

// ---------- Boards ----------

async function boardFor(user, boardId) {
  if (!validId(boardId)) fail(400, 'Invalid board.');
  const b = await one(
    'SELECT id, name, version, EXISTS (SELECT 1 FROM members WHERE board_id = boards.id AND user_id = ?) AS member FROM boards WHERE id = ?',
    [user.id, boardId],
  );
  if (!b || (!user.isAdmin && !Number(b.member))) fail(404, 'Board not found or you no longer have access.');
  return { id: b.id, name: b.name, version: Number(b.version) };
}

// Board members plus the admin (who can access every board).
function boardMembers(boardId) {
  return all(
    `SELECT id, username FROM users
     WHERE id IN (SELECT user_id FROM members WHERE board_id = ?) OR username = ? COLLATE NOCASE
     ORDER BY username COLLATE NOCASE`,
    [boardId, ADMIN_USERNAME],
  );
}

async function boardState(board, user) {
  const [cols, members, view] = await Promise.all([
    all('SELECT id, owner_id, data FROM columns WHERE board_id = ? ORDER BY pos', [board.id]),
    boardMembers(board.id),
    one('SELECT data FROM views WHERE board_id = ? AND user_id = ?', [board.id, user.id]),
  ]);
  return {
    board: { id: board.id, name: board.name },
    version: board.version,
    columns: cols.map((r) => ({ ...JSON.parse(r.data), id: r.id, ownerId: r.owner_id || null })),
    members: members.map((m) => ({ id: m.id, username: m.username, isAdmin: isAdminName(m.username) })),
    view: view ? JSON.parse(view.data) : null, // null until they customize it
  };
}

const saveView = (boardId, userId, view) => ({
  sql: 'INSERT INTO views (board_id, user_id, data) VALUES (?, ?, ?) ON CONFLICT (board_id, user_id) DO UPDATE SET data = excluded.data',
  args: [boardId, userId, JSON.stringify(view)],
});

function listBoards(user) {
  return user.isAdmin
    ? all('SELECT id, name FROM boards ORDER BY created_at')
    : all('SELECT b.id, b.name FROM boards b JOIN members m ON m.board_id = b.id WHERE m.user_id = ? ORDER BY b.created_at', [user.id]);
}

const bump = (boardId) => ({ sql: 'UPDATE boards SET version = version + 1 WHERE id = ?', args: [boardId] });

function cleanBoardName(v) {
  const name = typeof v === 'string' ? v.trim().slice(0, 40) : '';
  if (!name) fail(400, 'Give the board a name.');
  return name;
}

function cleanPassword(v) {
  if (typeof v !== 'string' || v.length < 8) fail(400, 'Password must be at least 8 characters.');
  if (v.length > 200) fail(400, 'Password is too long.');
  return v;
}

async function writeLimit(user) {
  if (!(await dbLimit('write:' + user.id, 60, MIN))) fail(429, 'Too many changes — wait a minute and try again.');
}

async function findInvite(token) {
  if (typeof token !== 'string' || token.length > 100) fail(400, 'Invalid invite link.');
  const inv = await one(
    `SELECT i.board_id, i.user_id, b.name AS board_name, u.username
     FROM invites i LEFT JOIN boards b ON b.id = i.board_id LEFT JOIN users u ON u.id = i.user_id
     WHERE i.token_hash = ? AND i.uses_left > 0 AND i.expires_at > ?`,
    [sha256(token), Date.now()],
  );
  if (!inv || (!inv.board_name && !inv.username)) fail(404, 'This invite link is invalid or has expired.');
  return { hash: sha256(token), boardId: inv.board_id, userId: inv.user_id, boardName: inv.board_name, username: inv.username };
}

// ---------- Operations ----------

const GET = {
  async me(ctx) {
    if (!ENABLED) return { enabled: false };
    const user = await currentUser(ctx);
    if (!user) return { enabled: true, user: null };
    return { enabled: true, user, boards: await listBoards(user) };
  },

  async state(ctx) {
    const user = await requireUser(ctx);
    if (!memLimit('state:' + user.id, 40, MIN)) fail(429, 'Syncing too often — slowing down.');
    const board = await boardFor(user, ctx.url.searchParams.get('board'));
    // Cheap poll: nothing changed since the client's copy.
    if (Number(ctx.url.searchParams.get('since')) === board.version) return { unchanged: true, version: board.version };
    return boardState(board, user);
  },
};

const POST = {
  async login(ctx) {
    const { username, password } = ctx.body;
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 40 || password.length > 200) {
      fail(400, 'Enter a username and password.');
    }
    const okIp = await dbLimit('login-ip:' + ctx.ip, 10, 15 * MIN);
    const okUser = await dbLimit('login-user:' + username.toLowerCase(), 20, 15 * MIN);
    if (!okIp || !okUser) fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');

    let userId;
    if (isAdminName(username)) {
      // The admin's password lives only in the environment, never in the database.
      if (ADMIN_PASSWORD.length < 12) fail(500, 'ADMIN_PASSWORD must be set and at least 12 characters.');
      if (!safeEqual(password, ADMIN_PASSWORD)) fail(401, 'Wrong username or password.');
      const row = await one('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [username]);
      userId = row ? row.id : newId();
      if (!row) await run('INSERT INTO users (id, username, pass_hash, created_at) VALUES (?, ?, ?, ?)', [userId, ADMIN_USERNAME, '!', Date.now()]);
    } else {
      const row = await one('SELECT id, pass_hash FROM users WHERE username = ? COLLATE NOCASE', [username]);
      // Hash even for unknown users so response time doesn't reveal which names exist.
      const ok = await verifyPassword(password, row ? row.pass_hash : 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAA');
      if (!row || !ok) fail(401, 'Wrong username or password.');
      userId = row.id;
    }
    await startSession(ctx, userId);
    return { ok: true };
  },

  async logout(ctx) {
    const token = readCookie(ctx.request, SESSION_COOKIE);
    if (token && token.length <= 100) await run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
    ctx.headers['set-cookie'] = sessionCookie(ctx.request, '', 0);
    return { ok: true };
  },

  async inviteInfo(ctx) {
    if (!memLimit('invite-info:' + ctx.ip, 30, MIN)) fail(429, 'Too many requests.');
    const inv = await findInvite(ctx.body.token);
    return { boardName: inv.boardName || null, username: inv.username || null };
  },

  // Board invite: create an account (or sign in to an existing one) and join.
  // Password-reset invite: set a new password for the linked user.
  async acceptInvite(ctx) {
    if (!(await dbLimit('login-ip:' + ctx.ip, 10, 15 * MIN))) fail(429, 'Too many attempts. Try again in 15 minutes.');
    const inv = await findInvite(ctx.body.token);
    const password = cleanPassword(ctx.body.password);
    const useInvite = { sql: 'UPDATE invites SET uses_left = uses_left - 1 WHERE token_hash = ?', args: [inv.hash] };

    if (inv.userId) {
      await batch([
        { sql: 'UPDATE users SET pass_hash = ? WHERE id = ?', args: [await hashPassword(password), inv.userId] },
        { sql: 'DELETE FROM sessions WHERE user_id = ?', args: [inv.userId] },
        useInvite,
      ]);
      await startSession(ctx, inv.userId);
      return { ok: true };
    }

    const username = typeof ctx.body.username === 'string' ? ctx.body.username.trim() : '';
    if (!/^[A-Za-z0-9_.-]{2,24}$/.test(username)) fail(400, 'Username must be 2–24 letters, numbers, dots, dashes or underscores.');
    if (isAdminName(username)) fail(400, 'That username is reserved.');

    const existing = await one('SELECT id, pass_hash FROM users WHERE username = ? COLLATE NOCASE', [username]);
    let userId;
    const stmts = [];
    if (existing) {
      if (!(await verifyPassword(password, existing.pass_hash))) fail(401, 'That username is taken. If it’s yours, enter your current password.');
      userId = existing.id;
    } else {
      const { n } = await one('SELECT COUNT(*) AS n FROM users');
      if (Number(n) >= LIMITS.users) fail(403, 'This app has reached its user limit.');
      userId = newId();
      stmts.push({ sql: 'INSERT INTO users (id, username, pass_hash, created_at) VALUES (?, ?, ?, ?)', args: [userId, username, await hashPassword(password), Date.now()] });
    }
    const { n: members } = await one('SELECT COUNT(*) AS n FROM members WHERE board_id = ?', [inv.boardId]);
    if (Number(members) >= LIMITS.membersPerBoard) fail(403, 'This board is full.');
    stmts.push(
      { sql: 'INSERT INTO members (board_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING', args: [inv.boardId, userId] },
      useInvite,
      bump(inv.boardId),
    );
    await batch(stmts);
    await startSession(ctx, userId);
    return { ok: true, boardId: inv.boardId };
  },

  // Apply a batch of changes from one client in a single request.
  // Body: { boardId, create: [col], patch: [{ id, ...fields }], remove: [id], view?: { order, hidden, colors } }
  async sync(ctx) {
    const user = await requireUser(ctx);
    await writeLimit(user);
    const board = await boardFor(user, ctx.body.boardId);
    const { create = [], patch = [], remove = [], view = null } = ctx.body;
    if (![create, patch, remove].every(Array.isArray)) fail(400, 'Malformed changes.');
    if (!user.isAdmin && (create.length || remove.length)) fail(403, 'Only the admin can add or remove columns.');
    if (create.length + patch.length + remove.length > 100) fail(400, 'Too many changes at once.');

    const rows = await all('SELECT id, pos, owner_id, data FROM columns WHERE board_id = ? ORDER BY pos', [board.id]);
    const cols = new Map(rows.map((r) => [r.id, { ownerId: r.owner_id || null, data: JSON.parse(r.data) }]));
    const memberIds = new Set((await boardMembers(board.id)).map((m) => m.id));
    const canEdit = (c) => user.isAdmin || c.ownerId === user.id;
    const stmts = [];

    for (const id of remove) {
      const c = cols.get(id);
      if (!c) continue; // already gone
      cols.delete(id);
      stmts.push({ sql: 'DELETE FROM columns WHERE id = ?', args: [id] });
    }

    for (const p of patch) {
      const c = p && cols.get(p.id);
      if (!c) fail(409, 'A column you edited was removed by someone else.');
      if (!canEdit(c)) fail(403, 'You can only edit your own column.');
      const d = c.data;
      if ('label' in p) { const v = cleanLabel(p.label); if (v) d.label = v; else delete d.label; }
      if ('schedule' in p) d.schedule = cleanSchedule(p.schedule) || d.schedule;
      if ('workDays' in p) d.workDays = cleanWorkDays(p.workDays) || d.workDays;
      if ('ownerId' in p && p.ownerId !== c.ownerId) {
        if (!user.isAdmin) fail(403, 'Only the admin can reassign columns.');
        if (p.ownerId !== null && !memberIds.has(p.ownerId)) fail(400, 'That person isn’t on this board.');
        c.ownerId = p.ownerId;
      }
      stmts.push({ sql: 'UPDATE columns SET data = ?, owner_id = ? WHERE id = ?', args: [JSON.stringify(d), c.ownerId, p.id] });
    }

    let nextPos = rows.reduce((m, r) => Math.max(m, Number(r.pos)), -1) + 1;
    for (const raw of create) {
      const data = cleanColumn(raw);
      if (!data || !validId(raw.id) || cols.has(raw.id)) fail(400, 'Invalid new column.');
      const ownerId = raw.ownerId && memberIds.has(raw.ownerId) ? raw.ownerId : null;
      cols.set(raw.id, { ownerId, data });
      stmts.push({ sql: 'INSERT INTO columns (id, board_id, pos, owner_id, data) VALUES (?, ?, ?, ?, ?)', args: [raw.id, board.id, nextPos++, ownerId, JSON.stringify(data)] });
    }

    if (cols.size === 0) fail(400, 'A board needs at least one column.');
    if (cols.size > LIMITS.columnsPerBoard) fail(403, `Boards are limited to ${LIMITS.columnsPerBoard} columns.`);
    // Each person manages exactly one column per board.
    const owners = [...cols.values()].map((c) => c.ownerId).filter(Boolean);
    if (new Set(owners).size !== owners.length) fail(400, 'Each person can only be assigned one column.');

    // Shared changes bump the board version so everyone's poll picks them up.
    const shared = stmts.length > 0;
    if (shared) stmts.push(bump(board.id));
    // A personal view only matters to its owner, so it doesn't bump the version.
    if (view) stmts.push(saveView(board.id, user.id, cleanView(view, new Set(cols.keys()))));

    if (stmts.length) {
      try { await batch(stmts); } catch (err) {
        if (/UNIQUE|PRIMARY KEY/i.test(String(err && err.message))) fail(409, 'Conflicting change — reloading.');
        throw err;
      }
      if (shared) board.version++;
    }
    return boardState(board, user);
  },

  // ----- Admin -----

  async createBoard(ctx) {
    await writeLimit(await requireAdmin(ctx));
    const name = cleanBoardName(ctx.body.name);
    const { n } = await one('SELECT COUNT(*) AS n FROM boards');
    if (Number(n) >= LIMITS.boards) fail(403, `You can have up to ${LIMITS.boards} boards.`);
    const raw = (Array.isArray(ctx.body.columns) ? ctx.body.columns : []).slice(0, LIMITS.columnsPerBoard);
    const columns = raw.map((c) => ({ id: newId(), data: cleanColumn(c), color: c && cleanColor(c.headerColor) })).filter((c) => c.data);
    if (!columns.length) fail(400, 'A board needs at least one column.');
    const id = newId();
    // The admin's header colors carry over into their own view of the new board.
    const colors = Object.fromEntries(columns.filter((c) => c.color).map((c) => [c.id, c.color]));
    await batch([
      { sql: 'INSERT INTO boards (id, name, created_at) VALUES (?, ?, ?)', args: [id, name, Date.now()] },
      ...columns.map((c, i) => ({
        sql: 'INSERT INTO columns (id, board_id, pos, owner_id, data) VALUES (?, ?, ?, NULL, ?)',
        args: [c.id, id, i, JSON.stringify(c.data)],
      })),
      saveView(id, ctx.user.id, { order: columns.map((c) => c.id), hidden: [], colors }),
    ]);
    return { board: { id, name } };
  },

  async renameBoard(ctx) {
    const user = await requireAdmin(ctx);
    await writeLimit(user);
    const board = await boardFor(user, ctx.body.boardId);
    await batch([{ sql: 'UPDATE boards SET name = ? WHERE id = ?', args: [cleanBoardName(ctx.body.name), board.id] }, bump(board.id)]);
    return { ok: true };
  },

  async deleteBoard(ctx) {
    const user = await requireAdmin(ctx);
    await writeLimit(user);
    const board = await boardFor(user, ctx.body.boardId);
    await batch(['columns', 'members', 'views', 'invites', 'boards'].map((t) => ({
      sql: `DELETE FROM ${t} WHERE ${t === 'boards' ? 'id' : 'board_id'} = ?`, args: [board.id],
    })));
    return { ok: true };
  },

  async createInvite(ctx) {
    const user = await requireAdmin(ctx);
    await writeLimit(user);
    const board = await boardFor(user, ctx.body.boardId);
    const token = randomToken();
    await run('INSERT INTO invites (token_hash, board_id, user_id, uses_left, expires_at) VALUES (?, ?, NULL, ?, ?)',
      [sha256(token), board.id, INVITE_USES, Date.now() + INVITE_DAYS * DAY]);
    return { token, uses: INVITE_USES, days: INVITE_DAYS };
  },

  async removeMember(ctx) {
    const user = await requireAdmin(ctx);
    await writeLimit(user);
    const board = await boardFor(user, ctx.body.boardId);
    await batch([
      { sql: 'DELETE FROM members WHERE board_id = ? AND user_id = ?', args: [board.id, ctx.body.userId] },
      { sql: 'DELETE FROM views WHERE board_id = ? AND user_id = ?', args: [board.id, ctx.body.userId] },
      { sql: 'UPDATE columns SET owner_id = NULL WHERE board_id = ? AND owner_id = ?', args: [board.id, ctx.body.userId] },
      bump(board.id),
    ]);
    return { ok: true };
  },

  async resetLink(ctx) {
    await writeLimit(await requireAdmin(ctx));
    const target = validId(ctx.body.userId) && await one('SELECT id, username FROM users WHERE id = ?', [ctx.body.userId]);
    if (!target || isAdminName(target.username)) fail(404, 'User not found.');
    const token = randomToken();
    await run('INSERT INTO invites (token_hash, board_id, user_id, uses_left, expires_at) VALUES (?, NULL, ?, 1, ?)',
      [sha256(token), target.id, Date.now() + RESET_HOURS * 60 * MIN]);
    return { token, hours: RESET_HOURS };
  },
};

// ---------- Entry points ----------

async function handle(request, routes) {
  const url = new URL(request.url);
  const ip = clientIp(request);
  const headers = {};
  try {
    // First line of defence: per-instance burst limit, no database cost.
    if (!memLimit('ip:' + ip, 240, MIN)) fail(429, 'Too many requests — slow down a little.');
    const route = Object.hasOwn(routes, url.searchParams.get('op')) && routes[url.searchParams.get('op')];
    if (!route) fail(404, 'Unknown operation.');

    let body = {};
    if (routes === POST) {
      if (!sameOrigin(request)) fail(403, 'Cross-origin request blocked.');
      if (!(request.headers.get('content-type') || '').startsWith('application/json')) fail(415, 'Expected JSON.');
      if (Number(request.headers.get('content-length')) > LIMITS.bodyBytes) fail(413, 'Request too large.');
      const text = await request.text();
      if (text.length > LIMITS.bodyBytes) fail(413, 'Request too large.');
      try { body = JSON.parse(text || '{}'); } catch { fail(400, 'Invalid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Invalid request.');
    }
    if (!ENABLED && url.searchParams.get('op') !== 'me') fail(503, 'Sync is not configured on this server.');

    const data = await route({ request, url, ip, body, headers, user: undefined });
    return json(data, 200, headers);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status, headers);
    console.error(err);
    return json({ error: 'Server error.' }, 500);
  }
}

const handleGet = (request) => handle(request, GET);
const handlePost = (request) => handle(request, POST);
export { handleGet as GET, handlePost as POST };
