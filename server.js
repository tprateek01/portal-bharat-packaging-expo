require("dotenv").config();
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const pool = require("./db");

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-secret-change-me";
const COOKIE_NAME = "portal_token";
const STATUSES = ["Registered", "Approved", "Rejected", "Inactive"];

app.use(express.json());
app.use(cookieParser());

// Visiting the bare root should land on the login page.
app.get("/", (req, res) => res.redirect("/login.html"));

app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------
// Table configuration — every table/column name the API can touch is
// defined here. Route params are always validated against this object,
// so nothing user-supplied is ever interpolated into SQL unchecked.
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
      { key: "created_at", label: "Registered Date", type: "date" },
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
      { key: "created_at", label: "Registered Date", type: "date" },
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
      { key: "area_sqm", label: "Area (SQM)" },
      { key: "designation", label: "Designation" },
      { key: "mobile_number", label: "Mobile" },
      { key: "email", label: "Email" },
      { key: "country", label: "Country" },
      { key: "state", label: "State" },
      { key: "created_at", label: "Registered Date", type: "date" },
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
      { key: "company_name", label: "Company Name" },
      { key: "corporate_email", label: "Corporate Email" },
      { key: "company_mobile_number", label: "Company Mobile" },
      { key: "contact_first_name", label: "Contact First Name" },
      { key: "contact_last_name", label: "Contact Last Name" },
      { key: "contact_email", label: "Contact Email" },
      { key: "contact_mobile_number", label: "Contact Mobile" },
      { key: "participation_category", label: "Participation" },
      { key: "stall_type", label: "Stall Type" },
      { key: "total_payable", label: "Total Payable" },
      { key: "billing_country", label: "Country" },
      { key: "billing_state", label: "State" },
      { key: "created_at", label: "Registered Date", type: "date" },
    ],
  },
};

function getTypeConfig(type) {
  return TYPE_CONFIG[type] || null;
}

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------
function signToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: "12h" });
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not signed in." });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired. Please sign in again." });
  }
}

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const validUser = process.env.ADMIN_USERNAME;
  const validPass = process.env.ADMIN_PASSWORD;

  if (!validUser || !validPass) {
    return res.status(500).json({ error: "Admin credentials are not configured on the server." });
  }
  if (username !== validUser || password !== validPass) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  const token = signToken(username);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
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
  if (!token) return res.json({ authenticated: false });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true, username: payload.username });
  } catch {
    res.json({ authenticated: false });
  }
});

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

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${cfg.table}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(`export ${cfg.table} failed:`, err.message);
    res.status(500).json({ error: "Could not export records." });
  }
});

// PATCH /api/records/:type/:id  { status }
app.patch("/api/records/:type/:id", requireAuth, async (req, res) => {
  const cfg = getTypeConfig(req.params.type);
  if (!cfg) return res.status(404).json({ error: "Unknown record type." });

  const { status } = req.body || {};
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(", ")}` });
  }

  try {
    const result = await pool.query(
      `UPDATE ${cfg.table} SET status = $1 WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Record not found." });
    res.json({ success: true, row: result.rows[0] });
  } catch (err) {
    console.error(`update ${cfg.table} failed:`, err.message);
    res.status(500).json({ error: "Could not update status." });
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

app.listen(PORT, () => {
  console.log(`Bharat Packaging Expo admin portal running at http://localhost:${PORT}`);
});