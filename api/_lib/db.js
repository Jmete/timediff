// Database access. Production uses Turso (hosted SQLite) over HTTP; local dev
// falls back to a SQLite file. Files under api/_lib are not deployed as functions.
// Foreign keys aren't enforced over HTTP, so deletes cascade explicitly in code.

const url = process.env.TURSO_DATABASE_URL || 'file:local.db';
const authToken = process.env.TURSO_AUTH_TOKEN;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS members (
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (board_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS columns (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    pos INTEGER NOT NULL,
    owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    data TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS columns_board ON columns(board_id, pos)`,
  // Each person's own view of a board: column order, hidden columns, header colors.
  `CREATE TABLE IF NOT EXISTS views (
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    PRIMARY KEY (board_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS invites (
    token_hash TEXT PRIMARY KEY,
    board_id TEXT REFERENCES boards(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    uses_left INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
  )`,
];

let ready = null;

async function connect() {
  // The web client is pure fetch (no native binary), which suits serverless.
  const mod = url.startsWith('file:') ? await import('@libsql/client') : await import('@libsql/client/web');
  const client = mod.createClient({ url, authToken });
  await client.batch(SCHEMA, 'write');
  return client;
}

// Connect and create tables once per warm function instance.
export function db() {
  if (!ready) ready = connect().catch((err) => { ready = null; throw err; });
  return ready;
}

export async function one(sql, args = []) {
  const r = await (await db()).execute({ sql, args });
  return r.rows[0] || null;
}

export async function all(sql, args = []) {
  return (await (await db()).execute({ sql, args })).rows;
}

export async function run(sql, args = []) {
  return (await db()).execute({ sql, args });
}

// Atomic multi-statement write.
export async function batch(stmts) {
  if (!stmts.length) return [];
  return (await db()).batch(stmts, 'write');
}
