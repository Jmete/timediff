# TIME/DIFF

World time comparison board. Works fully offline in the browser (layout saved to
`localStorage`), with optional **shared boards** so friends can sign in and keep
their own column's schedule up to date for everyone.

## Shared boards

- **Admin** (you) signs in with the credentials from environment variables,
  creates boards (each starts as a copy of the columns you're looking at), and
  sends out invite links.
- **Friends** open an invite link, pick a username and password, and join.
  Only the admin adds and removes columns; give each friend their column from
  its editor (✎ → *Managed by*). A person manages one column per board, and
  only they (and the admin) can change its name, schedule and work days.
- **Everyone has their own view** of a board. Their assigned column starts as
  their reference (and moves to the front again if you assign them a different
  one), but they can drag columns into any order (the first column is the
  reference), recolor any column's header, and
  hide columns they don't care about (✎ → *Hide*; bring them back from
  *N HIDDEN* under the + button). Views are saved to each person's account, so
  they follow them across devices and never affect anyone else.
- The board switcher in the top-right switches between boards and **This
  device** (your private, unsynced layout).
- If someone forgets their password: open the board → *Reset password* next to
  their name, and send them the one-time link.

### Setup on Vercel

1. **Create a free Turso database** (hosted SQLite; the free plan needs no card):
   ```sh
   turso db create timediff
   turso db show timediff --url      # → TURSO_DATABASE_URL
   turso db tokens create timediff   # → TURSO_AUTH_TOKEN
   ```
   Or do the same from the dashboard at turso.tech. Vercel's filesystem is
   read-only and temporary, so a plain SQLite file can't be used there.
2. In Vercel → Project → Settings → Environment Variables, add:
   | Name | Value |
   | --- | --- |
   | `TURSO_DATABASE_URL` | `libsql://…turso.io` |
   | `TURSO_AUTH_TOKEN` | token from step 1 |
   | `ADMIN_USERNAME` | e.g. `james` |
   | `ADMIN_PASSWORD` | 12+ characters; this is your admin login |
3. Redeploy. Tables are created automatically on first request.

Without `TURSO_DATABASE_URL` the deployed app behaves like it always did, with
no sign-in button.

### Local development

```sh
npm install
cp .env.example .env.local   # set ADMIN_USERNAME / ADMIN_PASSWORD
npm run dev                  # http://localhost:3000, data in ./local.db
```

## Cost and abuse safeguards

Everything runs in one serverless function (`api/sync.js`), and each request is
a few small SQLite queries.

- **Polling is lazy.** It runs every 20 s while the tab is visible and in use,
  every 90 s after 5 idle minutes, and stops after 30 idle minutes or when the
  tab is hidden. Polls send the board version, so an unchanged board costs one
  indexed row read. Edits are batched into one request per ~1 s burst.
- **Rate limits.** Sign-in and invite attempts are limited to 10 per IP and
  20 per username per 15 min (stored in the DB, so they hold across instances).
  Writes are limited to 60 per user per minute, and each instance also caps
  reads per IP and per user.
- **Hard caps.** Request bodies are limited to 32 KB. The app allows at most
  20 boards, 30 columns per board, 50 members per board and 100 users. Invite
  links expire after 7 days / 10 uses; reset links after 24 h / 1 use.
- **Security.** Passwords are hashed with scrypt. Sessions are random tokens
  (stored hashed) in `HttpOnly` / `SameSite=Lax` / `Secure` cookies. Writes
  must be same-origin JSON (CSRF protection). The admin password only lives
  in env vars.
- **Billing.** On Vercel's **Hobby** plan, going over the included usage pauses
  the project instead of charging you. On Pro, set a spend limit under
  Settings → Billing. Turso's free plan also can't bill without a card.
  For an extra layer, you can add a rate-limit rule for `/api/sync` in Vercel's
  Firewall.

Rough budget: 10 friends each keeping the tab open and active for 2 h a day is
about 10 × 120 min × 3 polls ≈ 3,600 invocations a day. That's ~110k a month,
well under the Hobby allowance.
