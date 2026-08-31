# Bharat Packaging Expo — Admin Portal

A separate admin app that reads the **same Neon database** used by the
public registration site (`bharat-expo`). Deploy it as its own project
so it lives on its own URL (e.g. `admin.yoursite.com` or
`bharat-expo-portal.vercel.app`).

## What it does

- Login page (single admin account, via environment variables)
- Sidebar with three sections: **Visitors**, **Exhibitor EOI**, **Exhibitor Booking**, topped by an expo details card (dates + venue)
- Status tabs: All / Registered / Approved / Rejected / Inactive
- Search + filters (country, state, participation category depending on the table)
- Per-row actions: view details, **edit (pencil) — edit any field and status**, approve, reject, delete
- A "results found" summary with removable filter chips + a Clear action whenever search/filters are active
- **Export Data** button — downloads the current filtered view as CSV
- Pagination (20 rows per page)

## 1. Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- `DATABASE_URL` — **use the exact same Neon connection string** as your
  `bharat-expo` registration site, so this portal reads the same data.
- `JWT_SECRET` — any long random string (used to sign the login session).
  Generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — the login credentials for this portal.

## 2. Add the status column to your database (one-time)

This portal needs a `status` column on the existing tables to support
Approve/Reject/Inactive. It does **not** touch your existing data — every
existing row just defaults to `status = 'Registered'`.

```bash
npm run migrate
```

Safe to re-run.

## 3. Run locally

```bash
npm start
```

Visit `http://localhost:4000`, sign in, and you should see your live
registration data.

## 4. Deploy

Deploy this folder as its **own** Vercel project (separate from
`bharat-expo`), so it gets its own URL:

1. Push this folder to its own GitHub repo (or a subfolder with its own
   Vercel "Root Directory" setting).
2. Import it into Vercel.
3. Add the same four environment variables from `.env` (`DATABASE_URL`,
   `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`) in the Vercel
   project settings.
4. Deploy.

## Notes / next steps

- Credentials are compared directly against environment variables — fine
  for a single-admin internal tool, but if you need multiple admin users
  or password hashing, that's a reasonable next addition.
- The login session is a signed JWT stored in an httpOnly cookie, so it
  works fine on serverless platforms like Vercel (no server-side session
  store needed).
- The pencil (Edit) action opens a form for every field on the record,
  plus its status, and saves via `PATCH /api/records/:type/:id`. The
  registration date column is shown but left read-only.