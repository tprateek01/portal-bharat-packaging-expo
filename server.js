require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const pool = require("./db");

const app = express();
const PORT = process.env.PORT || 4000;
const IS_PROD = process.env.NODE_ENV === "production";
const COOKIE_NAME = "portal_token";
const STATUSES = ["Registered", "Approved", "Rejected", "Inactive"];

// Vercel (and most PaaS) sit behind a proxy — without this, req.ip is the
// proxy's internal address for every request, which would bucket every
// visitor under the same login rate-limit key.
app.set("trust proxy", 1);

// ---------------------------------------------------------------------
// EVENT / BRANDING CONFIG — the ONLY place that changes when this same
// portal is pointed at a different event. To spin up a new event, don't
// touch any code — just set these env vars (and DATABASE_URL) for that
// deployment and drop the new logo file into public/images/.
// Every value has a fallback so the app still runs if a var is unset.
// ---------------------------------------------------------------------
const BRANDING = {
  eventName: process.env.EVENT_NAME || "Bharat Packaging Expo",
  tagline: process.env.EVENT_TAGLINE || "PACKAGING · SUSTAINABILITY · INNOVATION",
  dateRange: process.env.EVENT_DATE_RANGE || "30 Aug – 02 Sept 2027",
  venue: process.env.EVENT_VENUE || "India Expo Centre & Mart, Greater Noida",
  logo: process.env.EVENT_LOGO || "bharat-packaging-expo-logo.png",
  logo2x: process.env.EVENT_LOGO_2X || process.env.EVENT_LOGO || "bharat-packaging-expo-logo@2x.png",
  copyrightYear: process.env.EVENT_COPYRIGHT_YEAR || "2026–27",
  // Feature flags — used by later sections (e.g. Buyers) to show/hide
  // things that vary event to event.
  hasOverseasBuyers: (process.env.HAS_OVERSEAS_BUYERS || "false").toLowerCase() === "true",
};

app.use(express.json());
app.use(cookieParser());

// Visiting the bare root should land on the login page.
app.get("/", (req, res) => res.redirect("/login.html"));

// Public branding endpoint — no login required, since the login page
// itself needs this to show the right logo/name/dates before sign-in.
app.get("/api/branding", (req, res) => res.json(BRANDING));

app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------
// Small reference lists used to render proper dropdowns in the Edit
// modal for fields that are pill/select inputs on the registration
// site (rather than free text) — kept in sync with that site's
// public/js/location-data.js.
// ---------------------------------------------------------------------
const COUNTRIES = [
  "India", "United States", "United Kingdom", "United Arab Emirates", "Germany", "China",
  "Japan", "South Korea", "Singapore", "Australia", "Canada", "France", "Italy", "Spain",
  "Netherlands", "Switzerland", "Saudi Arabia", "Turkey", "South Africa", "Brazil",
  "Bangladesh", "Sri Lanka", "Nepal", "Vietnam", "Thailand", "Indonesia", "Malaysia",
  "Egypt", "Israel", "Russia", "Other",
];
const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat",
  "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh",
  "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab",
  "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh",
  "Uttarakhand", "West Bengal", "Andaman and Nicobar Islands", "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Jammu and Kashmir", "Ladakh",
  "Lakshadweep", "Puducherry", "Other / Outside India",
];

// ---------------------------------------------------------------------
// Table configuration — every table/column name the API can touch is
// defined here. Route params are always validated against this object,
// so nothing user-supplied is ever interpolated into SQL unchecked.
//
// Per-column options:
//   type        — "date" | "number" | "boolean" | "select" | (default: text)
//   options     — required when type is "select"; array of allowed values
//   hideInTable — true to keep a field out of the main list table (it still
//                 shows in the View/Edit modals) — keeps operationally
//                 secondary fields from making the table unreadably wide
//   editable    — false to make a field read-only in the Edit modal and
//                 reject it server-side even if sent in a PATCH body
//                 (used for computed/derived and structured fields like
//                 JSON arrays that a single text input can't safely edit)
// ---------------------------------------------------------------------
const TYPE_CONFIG = {
  visitors_buyers: {
    table: "visitors",
    label: "Buyers",
    group: "Visitors",
    fixedFilter: { column: "interest_type", value: "Buyer" },
    searchable: ["full_name", "company_name", "email", "mobile_number"],
    filters: { country: "country" },
    columns: [
      { key: "full_name", label: "Full Name" },
      { key: "company_name", label: "Company Name" },
      { key: "designation", label: "Designation" },
      { key: "mobile_number", label: "Mobile" },
      { key: "email", label: "Email" },
      { key: "country", label: "Country" },
      { key: "created_at", label: "Registered Date", type: "date", editable: false },
    ],
  },
  visitors_delegates: {
    table: "visitors",
    label: "Delegates",
    group: "Visitors",
    fixedFilter: { column: "interest_type", value: "Delegate" },
    searchable: ["full_name", "company_name", "email", "mobile_number"],
    filters: { country: "country" },
    columns: [
      { key: "full_name", label: "Full Name" },
      { key: "company_name", label: "Company Name" },
      { key: "designation", label: "Designation" },
      { key: "mobile_number", label: "Mobile" },
      { key: "email", label: "Email" },
      { key: "country", label: "Country" },
      { key: "created_at", label: "Registered Date", type: "date", editable: false },
    ],
  },
  exhibitor_eoi: {
    table: "exhibitor_eoi",
    label: "Exhibitor EOI",
    searchable: ["full_name", "company_name", "email", "mobile_number"],
    filters: { country: "country", state: "state" },
    columns: [
      { key: "full_name", label: "Full Name" },
      { key: "company_name", label: "Company Name" },
      { key: "area_sqm", label: "Area (SQM)", type: "number" },
      { key: "designation", label: "Designation" },
      { key: "mobile_number", label: "Mobile" },
      { key: "email", label: "Email" },
      { key: "country", label: "Country" },
      { key: "state", label: "State" },
      { key: "created_at", label: "Registered Date", type: "date", editable: false },
    ],
  },
  exhibitor_booking: {
    table: "exhibitor_booking",
    label: "Exhibitor Booking",
    searchable: [
      "company_name",
      "corporate_email",
      "company_mobile_number",
      "contact_first_name",
      "contact_last_name",
      "contact_email",
      "contact_mobile_number",
    ],
    filters: {
      billing_country: "billing_country",
      billing_state: "billing_state",
      participation_category: "participation_category",
    },
    columns: [
      // ---- always visible in the table ----
      { key: "company_name", label: "Company Name" },
      { key: "corporate_email", label: "Corporate Email" },
      { key: "company_mobile_number", label: "Company Mobile" },
      { key: "contact_first_name", label: "Contact First Name" },
      { key: "contact_last_name", label: "Contact Last Name" },
      { key: "contact_email", label: "Contact Email" },
      { key: "contact_mobile_number", label: "Contact Mobile" },
      {
        key: "participation_category", label: "Participation", type: "select",
        options: ["Indian participant", "Overseas participant"],
      },
      { key: "stall_type", label: "Stall Type", type: "select", options: ["Raw Space", "Shell Scheme"] },
      { key: "stall_size_sqm", label: "Stall Size (sqm)", type: "number" },
      { key: "primary_preferred_stall_number", label: "Preferred Stall No." },
      { key: "total_payable", label: "Total Payable", type: "number" },
      { key: "billing_country", label: "Country", type: "select", options: COUNTRIES },
      { key: "billing_state", label: "State", type: "select", options: INDIAN_STATES },
      { key: "created_at", label: "Registered Date", type: "date", editable: false },

      // ---- detail/edit only — shown in View & Edit modals, kept out of
      //      the table so it stays readable ----
      { key: "website", label: "Website", hideInTable: true },
      { key: "billing_address_line1", label: "Billing Address", hideInTable: true },
      { key: "billing_city", label: "Billing City", hideInTable: true },
      { key: "billing_postal_code", label: "Billing Postal Code", hideInTable: true },
      {
        key: "contact_prefix", label: "Contact Prefix", type: "select",
        options: ["Mr.", "Ms.", "Mrs.", "Dr."], hideInTable: true,
      },
      { key: "contact_middle_name", label: "Contact Middle Name", hideInTable: true },
      { key: "contact_designation", label: "Contact Designation", hideInTable: true },
      {
        key: "product_categories", label: "Product Categories",
        hideInTable: true, editable: false,
      },
      { key: "location_preference", label: "Preferred Hall / Location", hideInTable: true },
      { key: "special_requirements", label: "Special Requirements", hideInTable: true },
      {
        key: "primary_preferred_stall", label: "Primary Preferred Stall",
        type: "boolean", hideInTable: true, editable: false,
      },
      {
        key: "secondary_preferred_stall", label: "Secondary Preferred Stall",
        type: "boolean", hideInTable: true, editable: false,
      },
      { key: "secondary_preferred_stall_number", label: "Secondary Preferred Stall No.", hideInTable: true },
      { key: "currency", label: "Currency", hideInTable: true },
      { key: "booth_cost", label: "Booth Cost", type: "number", hideInTable: true },
      { key: "gst_amount", label: "GST Amount", type: "number", hideInTable: true },
    ],
  },
};

function getTypeConfig(type) {
  return TYPE_CONFIG[type] || null;
}

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------

// Never fall back to a guessable default secret in production — doing so
// would let anyone forge a valid admin session cookie. In production, if
// JWT_SECRET isn't set, JWT_SECRET below is `null` and every route that
// signs/verifies a token refuses to run (via requireJwtSecret) instead of
// silently trusting a known string. Locally, a fixed dev default is kept
// for convenience.
const CONFIGURED_JWT_SECRET = process.env.JWT_SECRET || null;
const JWT_SECRET = CONFIGURED_JWT_SECRET || (IS_PROD ? null : "dev-only-secret-change-me");

if (IS_PROD && !CONFIGURED_JWT_SECRET) {
  console.error(
    "[fatal] JWT_SECRET is not set. Refusing to sign or verify sessions in production — " +
      "set a real JWT_SECRET env var (see .env.example). Login and session checks will " +
      "return 500 until this is fixed."
  );
}

function requireJwtSecret(res) {
  if (JWT_SECRET) return true;
  res.status(500).json({ error: "Server is misconfigured (JWT_SECRET is not set). Contact the site admin." });
  return false;
}

function signToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: "12h" });
}

function requireAuth(req, res, next) {
  if (!requireJwtSecret(res)) return;
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not signed in." });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired. Please sign in again." });
  }
}

// Constant-time string compare so login doesn't leak how many leading
// characters of the username/password were correct via response timing.
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  if (bufA.length !== bufB.length) {
    // Still do a same-cost compare so a length mismatch doesn't return
    // measurably faster than a same-length mismatch.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---- Login rate limiting -----------------------------------------------
// Simple in-memory per-IP limiter on failed attempts. Note: on serverless
// platforms this state lives per warm instance and resets on cold start —
// it raises the bar against casual brute-forcing but isn't a substitute
// for a durable store (e.g. Redis/Upstash) if this ever needs to be
// bulletproof against a distributed attack.
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;
const loginAttemptsByIp = new Map(); // ip -> { count, windowStart }

function isLoginRateLimited(ip) {
  const entry = loginAttemptsByIp.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > LOGIN_RATE_LIMIT_WINDOW_MS) {
    loginAttemptsByIp.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS;
}
function recordFailedLogin(ip) {
  const now = Date.now();
  const entry = loginAttemptsByIp.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_RATE_LIMIT_WINDOW_MS) {
    loginAttemptsByIp.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
}
function clearLoginAttempts(ip) {
  loginAttemptsByIp.delete(ip);
}
// Periodically forget stale entries so this Map doesn't grow forever on a
// long-lived instance. Harmless no-op on serverless, where the instance
// itself gets recycled before this would matter.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttemptsByIp) {
    if (now - entry.windowStart > LOGIN_RATE_LIMIT_WINDOW_MS) loginAttemptsByIp.delete(ip);
  }
}, LOGIN_RATE_LIMIT_WINDOW_MS);
if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

app.post("/api/login", (req, res) => {
  if (!requireJwtSecret(res)) return;

  const ip = req.ip;
  if (isLoginRateLimited(ip)) {
    res.set("Retry-After", String(Math.ceil(LOGIN_RATE_LIMIT_WINDOW_MS / 1000)));
    return res.status(429).json({ error: "Too many sign-in attempts. Please wait 15 minutes and try again." });
  }

  const { username, password } = req.body || {};
  const validUser = process.env.ADMIN_USERNAME;
  const validPass = process.env.ADMIN_PASSWORD;

  if (!validUser || !validPass) {
    return res.status(500).json({ error: "Admin credentials are not configured on the server." });
  }
  if (!safeCompare(username, validUser) || !safeCompare(password, validPass)) {
    recordFailedLogin(ip);
    return res.status(401).json({ error: "Invalid username or password." });
  }
  clearLoginAttempts(ip);

  const token = signToken(username);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PROD,
    maxAge: 12 * 60 * 60 * 1000,
  });
  res.json({ success: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true });
});

app.get("/api/session", (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token || !JWT_SECRET) return res.json({ authenticated: false });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true, username: payload.username });
  } catch {
    res.json({ authenticated: false });
  }
});

// ---------------------------------------------------------------------
// Duplicate-key handling — shared with the registration site's schema.
// Lets an Edit-modal save that collides with an existing email/mobile
// show a specific, friendly message instead of a generic 500.
// ---------------------------------------------------------------------
const UNIQUE_CONSTRAINT_MESSAGES = {
  visitors_email_unique: "That email is already registered to another record.",
  visitors_mobile_unique: "That mobile number is already registered to another record.",
  exhibitor_eoi_email_unique: "That email is already registered to another record.",
  exhibitor_eoi_mobile_unique: "That mobile number is already registered to another record.",
  exhibitor_booking_corporate_email_unique: "That corporate email is already registered to another record.",
  exhibitor_booking_company_mobile_unique: "That company mobile number is already registered to another record.",
  exhibitor_booking_contact_email_unique: "That contact email is already registered to another record.",
  exhibitor_booking_contact_mobile_unique: "That contact mobile number is already registered to another record.",
};

function handleDuplicateError(err, res) {
  if (err.code === "23505" && UNIQUE_CONSTRAINT_MESSAGES[err.constraint]) {
    res.status(409).json({ error: UNIQUE_CONSTRAINT_MESSAGES[err.constraint] });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// Data APIs (all protected)
// ---------------------------------------------------------------------

// GET /api/types — lets the frontend build its nav + filter UI generically
app.get("/api/types", requireAuth, (req, res) => {
  const types = Object.entries(TYPE_CONFIG).map(([key, cfg]) => ({
    key,
    label: cfg.label,
    group: cfg.group || null,
    columns: cfg.columns,
    filters: Object.keys(cfg.filters),
  }));
  res.json({ types, statuses: STATUSES });
});

// GET /api/summary — counts per type, broken down by status, for the
// dashboard's Overview landing page.
app.get("/api/summary", requireAuth, async (req, res) => {
  try {
    const perType = await Promise.all(
      Object.entries(TYPE_CONFIG).map(async ([key, cfg]) => {
        const clauses = [];
        const values = [];
        if (cfg.fixedFilter) {
          values.push(cfg.fixedFilter.value);
          clauses.push(`${cfg.fixedFilter.column} = $${values.length}`);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const result = await pool.query(
          `SELECT status, COUNT(*) FROM ${cfg.table} ${where} GROUP BY status`,
          values
        );
        const byStatus = {};
        STATUSES.forEach((s) => (byStatus[s] = 0));
        let total = 0;
        result.rows.forEach((row) => {
          const count = parseInt(row.count, 10);
          if (byStatus[row.status] !== undefined) byStatus[row.status] = count;
          total += count;
        });
        return { key, label: cfg.label, group: cfg.group || null, total, byStatus };
      })
    );
    const grandTotal = perType.reduce((sum, t) => sum + t.total, 0);
    res.json({ types: perType, grandTotal, statuses: STATUSES });
  } catch (err) {
    console.error("summary failed:", err.message);
    res.status(500).json({ error: "Could not load summary." });
  }
});

function buildWhereClause(cfg, query) {
  const clauses = [];
  const values = [];

  if (cfg.fixedFilter) {
    values.push(cfg.fixedFilter.value);
    clauses.push(`${cfg.fixedFilter.column} = $${values.length}`);
  }

  if (query.status && STATUSES.includes(query.status)) {
    values.push(query.status);
    clauses.push(`status = $${values.length}`);
  }

  if (query.search && query.search.trim()) {
    values.push(`%${query.search.trim()}%`);
    const idx = values.length;
    const orParts = cfg.searchable.map((col) => `${col} ILIKE $${idx}`);
    clauses.push(`(${orParts.join(" OR ")})`);
  }

  for (const [param, column] of Object.entries(cfg.filters)) {
    const value = query[param];
    if (value && String(value).trim()) {
      values.push(String(value).trim());
      clauses.push(`${column} ILIKE $${values.length}`);
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, values };
}

// GET /api/records/:type?status=&search=&page=&pageSize=&<filters>
app.get("/api/records/:type", requireAuth, async (req, res) => {
  const cfg = getTypeConfig(req.params.type);
  if (!cfg) return res.status(404).json({ error: "Unknown record type." });

  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
  const offset = (page - 1) * pageSize;

  const { where, values } = buildWhereClause(cfg, req.query);

  try {
    const countResult = await pool.query(`SELECT COUNT(*) FROM ${cfg.table} ${where}`, values);
    const total = parseInt(countResult.rows[0].count, 10);

    const dataValues = [...values, pageSize, offset];
    const dataResult = await pool.query(
      `SELECT * FROM ${cfg.table} ${where} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      dataValues
    );

    res.json({ rows: dataResult.rows, total, page, pageSize });
  } catch (err) {
    console.error(`list ${cfg.table} failed:`, err.message);
    res.status(500).json({ error: "Could not load records." });
  }
});

// GET /api/records/:type/export?status=&search=&<filters> — CSV download
app.get("/api/records/:type/export", requireAuth, async (req, res) => {
  const cfg = getTypeConfig(req.params.type);
  if (!cfg) return res.status(404).json({ error: "Unknown record type." });

  const { where, values } = buildWhereClause(cfg, req.query);

  try {
    const result = await pool.query(`SELECT * FROM ${cfg.table} ${where} ORDER BY created_at DESC`, values);

    const headers = ["id", ...cfg.columns.map((c) => c.key), "status"];
    const escape = (val) => {
      if (val === null || val === undefined) return "";
      const str = typeof val === "object" ? JSON.stringify(val) : String(val);
      return `"${str.replace(/"/g, '""')}"`;
    };
    const lines = [headers.join(",")];
    for (const row of result.rows) {
      lines.push(headers.map((h) => escape(row[h])).join(","));
    }
    const csv = lines.join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${cfg.table}.csv"`);
    // Leading UTF-8 BOM so Excel (which otherwise assumes the system's
    // default codepage) renders non-ASCII characters — e.g. the ₹ symbol
    // in `currency` — correctly instead of as garbled characters.
    res.send("\uFEFF" + csv);
  } catch (err) {
    console.error(`export ${cfg.table} failed:`, err.message);
    res.status(500).json({ error: "Could not export records." });
  }
});

// PATCH /api/records/:type/:id  { status } and/or { <editable column>: value, ... }
// Used both by the quick-action buttons (status only) and the pencil/Edit
// form (any subset of the type's own editable columns, plus optionally status).
app.patch("/api/records/:type/:id", requireAuth, async (req, res) => {
  const cfg = getTypeConfig(req.params.type);
  if (!cfg) return res.status(404).json({ error: "Unknown record type." });

  const body = req.body || {};
  // Whitelist: only columns this type declares AND marks editable
  // (created_at and structured fields like product_categories opt out
  // via `editable: false` in TYPE_CONFIG).
  const editableColumns = new Set(
    cfg.columns.filter((c) => c.editable !== false).map((c) => c.key)
  );

  const setClauses = [];
  const values = [];

  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) {
      return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(", ")}` });
    }
    values.push(body.status);
    setClauses.push(`status = $${values.length}`);
  }

  for (const [key, value] of Object.entries(body)) {
    if (key === "status" || !editableColumns.has(key)) continue;
    values.push(value === "" ? null : value);
    setClauses.push(`${key} = $${values.length}`);
  }

  if (setClauses.length === 0) {
    return res.status(400).json({ error: "No valid fields to update." });
  }

  values.push(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE ${cfg.table} SET ${setClauses.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Record not found." });
    res.json({ success: true, row: result.rows[0] });
  } catch (err) {
    if (handleDuplicateError(err, res)) return;
    console.error(`update ${cfg.table} failed:`, err.message);
    res.status(500).json({ error: "Could not update record." });
  }
});

// DELETE /api/records/:type/:id
app.delete("/api/records/:type/:id", requireAuth, async (req, res) => {
  const cfg = getTypeConfig(req.params.type);
  if (!cfg) return res.status(404).json({ error: "Unknown record type." });

  try {
    const result = await pool.query(`DELETE FROM ${cfg.table} WHERE id = $1`, [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Record not found." });
    res.json({ success: true });
  } catch (err) {
    console.error(`delete from ${cfg.table} failed:`, err.message);
    res.status(500).json({ error: "Could not delete record." });
  }
});

// health check — also confirms DB connectivity
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected" });
  } catch (err) {
    res.status(500).json({ ok: false, db: "not connected", error: err.message });
  }
});

// Vercel invokes this file as a serverless function and imports `app`
// directly — it never runs `node server.js`, so app.listen() must only
// fire for local/traditional hosting (`npm start`), not on import.
if (require.main === module) {
  if (IS_PROD && !CONFIGURED_JWT_SECRET) {
    console.error("[fatal] Refusing to start: JWT_SECRET is required in production.");
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`Bharat Packaging Expo admin portal running at http://localhost:${PORT}`);
  });
}

module.exports = app;