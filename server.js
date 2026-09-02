require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const ExcelJS = require("exceljs");
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

// Task 6 (Payments) / Task 7 (Service Request Forms) — small reference
// lists for their dropdowns, same pattern as COUNTRIES/INDIAN_STATES above.
const PAYMENT_MODES = ["Cash", "Cheque", "NEFT", "RTGS", "UPI", "Credit Card", "Debit Card", "Other"];
const SERVICE_REQUEST_TYPES = [
  "Electrical", "Furniture", "Internet / Wi-Fi", "Housekeeping", "Security",
  "Carpentry", "Signage", "Water Supply", "Other",
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
    label: "All Buyers",
    group: "Domestic Buyers",
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
    label: "General Visitors",
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
    label: "Exhibitors",
    group: "Space Booking",
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
      // ---- Task 4: Space Booking <-> Stall linking. Populated via a
      // LEFT JOIN against `stalls` (see FROM_OVERRIDES below) — not a real
      // column on exhibitor_booking, so it's read-only here. The actual
      // allot/unallot action lives in its own button (see the
      // "Allot Stall" row action), not the generic Edit modal.
      { key: "allotted_hall_number", label: "Allotted Hall", editable: false },
      { key: "allotted_stall_number", label: "Allotted Stall", editable: false },
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

  // ---------------------------------------------------------------------
  // Task 6: Payments — this portal's own table (not the registration
  // site's). New payments are recorded via the dedicated
  // POST /api/payments endpoint below (needs an exhibitor picker, which
  // the generic Add-a-record flow doesn't have); everything else — list,
  // search, status tabs, edit, delete, export, Overview card — comes free
  // from the generic records system via FROM_OVERRIDES' join below.
  // ---------------------------------------------------------------------
  payments: {
    table: "payments",
    label: "Payments",
    searchable: ["company_name", "transaction_reference"],
    filters: { payment_mode: "payment_mode" },
    columns: [
      { key: "company_name", label: "Exhibitor / Company", editable: false },
      { key: "amount", label: "Amount (₹)", type: "number" },
      { key: "payment_mode", label: "Payment Mode", type: "select", options: PAYMENT_MODES },
      { key: "transaction_reference", label: "Transaction / Reference No." },
      { key: "payment_date", label: "Payment Date", type: "date-only" },
      { key: "remarks", label: "Remarks", hideInTable: true },
      { key: "created_at", label: "Recorded On", type: "date", editable: false },
    ],
  },

  // ---------------------------------------------------------------------
  // Task 7: Service Request Forms — same shape as Payments: the portal's
  // own table, new requests added via POST /api/service-requests, rest of
  // the workflow (approve/reject a request, search, export…) reuses the
  // generic records system.
  // ---------------------------------------------------------------------
  service_requests: {
    table: "service_requests",
    label: "Service Request Forms",
    searchable: ["company_name", "description"],
    filters: { request_type: "request_type" },
    columns: [
      { key: "company_name", label: "Exhibitor / Company", editable: false },
      { key: "request_type", label: "Service Type", type: "select", options: SERVICE_REQUEST_TYPES },
      { key: "description", label: "Description" },
      { key: "requested_date", label: "Requested Date", type: "date-only" },
      { key: "created_at", label: "Raised On", type: "date", editable: false },
    ],
  },
};

function getTypeConfig(type) {
  return TYPE_CONFIG[type] || null;
}

// ---------------------------------------------------------------------
// Task 4: Space Booking <-> Stall linking
// ---------------------------------------------------------------------
// exhibitor_booking's list/export reads need to show which stall (if any)
// is allotted to each exhibitor. That's a LEFT JOIN against `stalls`, not
// a real column — so list/export use this subquery as their FROM source
// instead of the bare table name, while PATCH/DELETE (which write) keep
// using the real `exhibitor_booking` table untouched.
const FROM_OVERRIDES = {
  exhibitor_booking: `(
    SELECT eb.*, s.hall_number AS allotted_hall_number, s.stall_number AS allotted_stall_number
    FROM exhibitor_booking eb
    LEFT JOIN stalls s ON s.exhibitor_booking_id = eb.id
  ) AS exhibitor_booking`,
  // Task 6/7: payments and service_requests each belong to one exhibitor —
  // pull the company name in via this join so the list/export/search
  // don't need a second round trip. Real INSERT/UPDATE/DELETE still target
  // the plain `payments` / `service_requests` tables (see cfg.table).
  payments: `(
    SELECT p.*, eb.company_name, eb.contact_email, eb.contact_mobile_number
    FROM payments p
    LEFT JOIN exhibitor_booking eb ON eb.id = p.exhibitor_booking_id
  ) AS payments`,
  service_requests: `(
    SELECT sr.*, eb.company_name, eb.contact_email, eb.contact_mobile_number
    FROM service_requests sr
    LEFT JOIN exhibitor_booking eb ON eb.id = sr.exhibitor_booking_id
  ) AS service_requests`,
};
function fromClause(cfg) {
  return FROM_OVERRIDES[cfg.table] || cfg.table;
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
// Domestic Buyers — Bulk Upload (.xlsx)
// ---------------------------------------------------------------------

// Memory storage only — this app runs as a stateless serverless function
// on Vercel, so there's no durable disk to write to. The whole file is
// parsed straight out of the uploaded buffer.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const okExt = /\.xlsx$/i.test(file.originalname);
    const okMime = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream", // some browsers send this for .xlsx
    ].includes(file.mimetype);
    if (okExt && okMime) return cb(null, true);
    cb(new Error("Only .xlsx files are supported."));
  },
});

// Column order here is also the exact column order of the downloadable
// template, so a file the admin exports and re-uploads always lines up.
const BUYER_UPLOAD_COLUMNS = [
  { header: "Full Name", key: "full_name", required: true },
  { header: "Company Name", key: "company_name", required: false },
  { header: "Designation", key: "designation", required: false },
  { header: "Mobile Number", key: "mobile_number", required: true },
  { header: "Email", key: "email", required: true },
  { header: "Country", key: "country", required: false },
];

function normalizeHeader(str) {
  return String(str ?? "").trim().toLowerCase().replace(/[\s_]+/g, "");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RE = /^[0-9+\-\s()]{7,15}$/;

// GET /api/domestic-buyers/bulk-upload/template — downloadable .xlsx
// with the exact headers this endpoint expects, so admins don't have to
// guess column names.
app.get("/api/domestic-buyers/bulk-upload/template", requireAuth, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Domestic Buyers");
    sheet.columns = BUYER_UPLOAD_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: 24 }));
    sheet.getRow(1).font = { bold: true };
    // One example row so the expected format is obvious, not just labels.
    sheet.addRow({
      full_name: "Raju Kumar Jaiswal",
      company_name: "Govind Food Products",
      designation: "Owner",
      mobile_number: "9935268221",
      email: "raju@example.com",
      country: "India",
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="domestic_buyer_bulk_upload_template.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("template generation failed:", err.message);
    res.status(500).json({ error: "Could not generate template." });
  }
});

// GET /api/domestic-buyers/bulk-uploads — upload history for the panel
// on the right of the Bulk Upload page.
app.get("/api/domestic-buyers/bulk-uploads", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, filename, uploaded_by, total_rows, success_count, failed_count, status, created_at
       FROM bulk_uploads WHERE upload_type = 'domestic_buyers'
       ORDER BY created_at DESC LIMIT 25`
    );
    res.json({ uploads: result.rows });
  } catch (err) {
    console.error("list bulk_uploads failed:", err.message);
    res.status(500).json({ error: "Could not load upload history." });
  }
});

// GET /api/domestic-buyers/bulk-uploads/:id/failure-report — CSV of the
// rows that failed to import for a given upload run.
app.get("/api/domestic-buyers/bulk-uploads/:id/failure-report", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT filename, failure_report FROM bulk_uploads WHERE id = $1 AND upload_type = 'domestic_buyers'`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Upload not found." });
    const { failure_report: failures } = result.rows[0];
    const lines = ["Row,Reason"];
    (failures || []).forEach((f) => {
      lines.push(`${f.row},"${String(f.reason).replace(/"/g, '""')}"`);
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="bulk_upload_${req.params.id}_failures.csv"`);
    res.send("\uFEFF" + lines.join("\n"));
  } catch (err) {
    console.error("failure report failed:", err.message);
    res.status(500).json({ error: "Could not generate failure report." });
  }
});

// POST /api/domestic-buyers/bulk-upload — parses the uploaded .xlsx,
// validates + inserts each row into visitors (interest_type='Buyer'),
// and logs a run summary (+ per-row failure reasons) into bulk_uploads.
app.post("/api/domestic-buyers/bulk-upload", requireAuth, (req, res) => {
  upload.single("file")(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });
    if (!req.file) return res.status(400).json({ error: "No file was uploaded." });

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const sheet = workbook.worksheets[0];
      if (!sheet) return res.status(400).json({ error: "The file has no sheets." });

      // Map whatever header text is actually in row 1 to our known
      // columns, tolerant of case/spacing differences (e.g. "mobile_number"
      // vs "Mobile Number").
      const headerRow = sheet.getRow(1);
      const colIndexByKey = {};
      headerRow.eachCell((cell, colNumber) => {
        const norm = normalizeHeader(cell.value);
        const match = BUYER_UPLOAD_COLUMNS.find((c) => normalizeHeader(c.header) === norm || c.key === norm);
        if (match) colIndexByKey[match.key] = colNumber;
      });
      const missingRequired = BUYER_UPLOAD_COLUMNS.filter((c) => c.required && !colIndexByKey[c.key]);
      if (missingRequired.length > 0) {
        return res.status(400).json({
          error: `File is missing required column(s): ${missingRequired.map((c) => c.header).join(", ")}. Use "Download Template" to get the exact format.`,
        });
      }

      const MAX_ROWS = 1000; // keeps a single upload well inside a serverless function's execution time budget
      const dataRowCount = sheet.rowCount - 1;
      if (dataRowCount > MAX_ROWS) {
        return res.status(400).json({ error: `This file has ${dataRowCount} rows. Please split it into batches of ${MAX_ROWS} or fewer.` });
      }

      let successCount = 0;
      const failures = [];

      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
        const row = sheet.getRow(rowNumber);
        // Skip fully blank rows (common at the end of a sheet) without
        // counting them as failures.
        if (row.cellCount === 0 || row.values.every((v) => v === null || v === undefined || v === "")) continue;

        const getCell = (key) => {
          const idx = colIndexByKey[key];
          if (!idx) return "";
          const val = row.getCell(idx).value;
          if (val === null || val === undefined) return "";
          // ExcelJS returns { text } for rich text and { result } for formulas
          if (typeof val === "object") return String(val.text ?? val.result ?? "").trim();
          return String(val).trim();
        };

        const record = {
          full_name: getCell("full_name"),
          company_name: getCell("company_name"),
          designation: getCell("designation"),
          mobile_number: getCell("mobile_number"),
          email: getCell("email"),
          country: getCell("country"),
        };

        if (!record.full_name || !record.mobile_number || !record.email) {
          failures.push({ row: rowNumber, reason: "Full Name, Mobile Number and Email are required." });
          continue;
        }
        if (!EMAIL_RE.test(record.email)) {
          failures.push({ row: rowNumber, reason: `Invalid email: "${record.email}"` });
          continue;
        }
        if (!MOBILE_RE.test(record.mobile_number)) {
          failures.push({ row: rowNumber, reason: `Invalid mobile number: "${record.mobile_number}"` });
          continue;
        }

        try {
          await pool.query(
            `INSERT INTO visitors (full_name, company_name, designation, mobile_number, email, country, interest_type, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'Buyer', 'Registered')`,
            [
              record.full_name,
              record.company_name || null,
              record.designation || null,
              record.mobile_number,
              record.email,
              record.country || null,
            ]
          );
          successCount += 1;
        } catch (err) {
          if (err.code === "23505") {
            failures.push({ row: rowNumber, reason: "A buyer with this email or mobile number is already registered." });
          } else {
            failures.push({ row: rowNumber, reason: "Could not save this row — please check its data." });
          }
        }
      }

      const totalRows = successCount + failures.length;
      const logResult = await pool.query(
        `INSERT INTO bulk_uploads (upload_type, filename, uploaded_by, total_rows, success_count, failed_count, status, failure_report)
         VALUES ('domestic_buyers', $1, $2, $3, $4, $5, $6, $7)
         RETURNING id, filename, uploaded_by, total_rows, success_count, failed_count, status, created_at`,
        [
          req.file.originalname,
          req.admin?.username || null,
          totalRows,
          successCount,
          failures.length,
          failures.length === 0 ? "Completed" : "Completed with errors",
          JSON.stringify(failures),
        ]
      );

      res.json({
        success: true,
        totalRows,
        successCount,
        failedCount: failures.length,
        upload: logResult.rows[0],
        // sendEmail is accepted but not acted on yet — actual registration
        // emails need SMTP credentials to be configured first.
        emailRequested: req.body.sendEmail === "true",
      });
    } catch (err) {
      console.error("bulk upload failed:", err.message);
      res.status(500).json({ error: "Could not process the file. Make sure it's a valid .xlsx file matching the template." });
    }
  });
});

// ---------------------------------------------------------------------
// Hall & Stall Management (Task 3)
// ---------------------------------------------------------------------
// This is data the admin portal itself owns (not the registration site),
// so it doesn't go through the generic TYPE_CONFIG/records system above —
// it gets its own small set of routes instead.

const FLOOR_OPTIONS = ["Ground Floor", "First Floor", "Second Floor"];
const OPEN_SIDES_OPTIONS = ["One Side Open", "Two Sides Open", "Three Sides Open", "Four Sides Open"];
const STALL_STATUSES = ["Vacant", "Allotted"];

function computeArea(length, breadth) {
  const l = parseFloat(length);
  const b = parseFloat(breadth);
  if (Number.isFinite(l) && Number.isFinite(b)) return l * b;
  return null;
}

// GET /api/stalls/counts — badge counts for the Vacant/Allotted tabs.
app.get("/api/stalls/counts", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT status, COUNT(*) FROM stalls GROUP BY status`);
    const counts = { Vacant: 0, Allotted: 0 };
    result.rows.forEach((r) => (counts[r.status] = parseInt(r.count, 10)));
    res.json(counts);
  } catch (err) {
    console.error("stall counts failed:", err.message);
    res.status(500).json({ error: "Could not load stall counts." });
  }
});

// GET /api/stalls?status=Vacant&search=&floor=&openSides=&page=&pageSize=
app.get("/api/stalls", requireAuth, async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
  const offset = (page - 1) * pageSize;

  const clauses = [];
  const values = [];
  if (req.query.status && STALL_STATUSES.includes(req.query.status)) {
    values.push(req.query.status);
    clauses.push(`status = $${values.length}`);
  }
  if (req.query.search && req.query.search.trim()) {
    values.push(`%${req.query.search.trim()}%`);
    clauses.push(`(hall_number ILIKE $${values.length} OR stall_number ILIKE $${values.length})`);
  }
  if (req.query.floor && req.query.floor.trim()) {
    values.push(req.query.floor.trim());
    clauses.push(`floor = $${values.length}`);
  }
  if (req.query.openSides && req.query.openSides.trim()) {
    values.push(req.query.openSides.trim());
    clauses.push(`open_sides = $${values.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  try {
    const countResult = await pool.query(`SELECT COUNT(*) FROM stalls ${where}`, values);
    const total = parseInt(countResult.rows[0].count, 10);
    const dataResult = await pool.query(
      `SELECT * FROM stalls ${where} ORDER BY hall_number, stall_number LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, pageSize, offset]
    );
    res.json({ rows: dataResult.rows, total, page, pageSize });
  } catch (err) {
    console.error("list stalls failed:", err.message);
    res.status(500).json({ error: "Could not load stalls." });
  }
});

// POST /api/stalls — Add Stalls modal (single stall)
app.post("/api/stalls", requireAuth, async (req, res) => {
  const { hall_number, stall_number, floor, open_sides, length, breadth } = req.body || {};
  if (!hall_number || !String(hall_number).trim()) return res.status(400).json({ error: "Hall Number is required." });
  if (!stall_number || !String(stall_number).trim()) return res.status(400).json({ error: "Stall Number is required." });

  try {
    const result = await pool.query(
      `INSERT INTO stalls (hall_number, stall_number, floor, open_sides, length, breadth, area_sqm)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        String(hall_number).trim(),
        String(stall_number).trim(),
        floor || null,
        open_sides || null,
        length || null,
        breadth || null,
        computeArea(length, breadth),
      ]
    );
    res.json({ success: true, row: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "This Hall + Stall Number combination already exists." });
    }
    console.error("create stall failed:", err.message);
    res.status(500).json({ error: "Could not add stall." });
  }
});

// PATCH /api/stalls/:id — edit modal (also used to flip status Vacant<->Allotted)
app.patch("/api/stalls/:id", requireAuth, async (req, res) => {
  const body = req.body || {};
  const editable = ["hall_number", "stall_number", "floor", "open_sides", "length", "breadth", "status"];
  const setClauses = [];
  const values = [];

  for (const key of editable) {
    if (body[key] === undefined) continue;
    if (key === "status" && !STALL_STATUSES.includes(body.status)) {
      return res.status(400).json({ error: `Status must be one of: ${STALL_STATUSES.join(", ")}` });
    }
    values.push(body[key] === "" ? null : body[key]);
    setClauses.push(`${key} = $${values.length}`);
  }

  // Recompute area whenever either dimension changes — using whichever new
  // value was sent, falling back to what's already stored for the other.
  if (body.length !== undefined || body.breadth !== undefined) {
    try {
      const existing = await pool.query(`SELECT length, breadth FROM stalls WHERE id = $1`, [req.params.id]);
      if (existing.rowCount === 0) return res.status(404).json({ error: "Stall not found." });
      const newLength = body.length !== undefined ? body.length : existing.rows[0].length;
      const newBreadth = body.breadth !== undefined ? body.breadth : existing.rows[0].breadth;
      values.push(computeArea(newLength, newBreadth));
      setClauses.push(`area_sqm = $${values.length}`);
    } catch (err) {
      console.error("recompute area failed:", err.message);
    }
  }

  if (setClauses.length === 0) return res.status(400).json({ error: "No valid fields to update." });

  values.push(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE stalls SET ${setClauses.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Stall not found." });
    res.json({ success: true, row: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "This Hall + Stall Number combination already exists." });
    }
    console.error("update stall failed:", err.message);
    res.status(500).json({ error: "Could not update stall." });
  }
});

// DELETE /api/stalls/:id
app.delete("/api/stalls/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM stalls WHERE id = $1`, [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Stall not found." });
    res.json({ success: true });
  } catch (err) {
    console.error("delete stall failed:", err.message);
    res.status(500).json({ error: "Could not delete stall." });
  }
});

// ---- Stall bulk upload (.xlsx) — same pattern as Domestic Buyers ----
const STALL_UPLOAD_COLUMNS = [
  { header: "Hall Number", key: "hall_number", required: true },
  { header: "Stall Number", key: "stall_number", required: true },
  { header: "Floor", key: "floor", required: false },
  { header: "Open Sides", key: "open_sides", required: false },
  { header: "Length", key: "length", required: false },
  { header: "Breadth", key: "breadth", required: false },
];

app.get("/api/stalls/upload/template", requireAuth, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Stalls");
    sheet.columns = STALL_UPLOAD_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: 22 }));
    sheet.getRow(1).font = { bold: true };
    sheet.addRow({ hall_number: "H10", stall_number: "H10-06/348", floor: "Ground Floor", open_sides: "Two Sides Open", length: 3, breadth: 3 });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="stall_bulk_upload_template.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("stall template generation failed:", err.message);
    res.status(500).json({ error: "Could not generate template." });
  }
});

app.get("/api/stalls/bulk-uploads", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, filename, uploaded_by, total_rows, success_count, failed_count, status, created_at
       FROM bulk_uploads WHERE upload_type = 'stalls' ORDER BY created_at DESC LIMIT 25`
    );
    res.json({ uploads: result.rows });
  } catch (err) {
    console.error("list stall bulk_uploads failed:", err.message);
    res.status(500).json({ error: "Could not load upload history." });
  }
});

app.get("/api/stalls/bulk-uploads/:id/failure-report", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT failure_report FROM bulk_uploads WHERE id = $1 AND upload_type = 'stalls'`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Upload not found." });
    const lines = ["Row,Reason"];
    (result.rows[0].failure_report || []).forEach((f) => lines.push(`${f.row},"${String(f.reason).replace(/"/g, '""')}"`));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="stall_upload_${req.params.id}_failures.csv"`);
    res.send("\uFEFF" + lines.join("\n"));
  } catch (err) {
    console.error("stall failure report failed:", err.message);
    res.status(500).json({ error: "Could not generate failure report." });
  }
});

app.post("/api/stalls/bulk-upload", requireAuth, (req, res) => {
  upload.single("file")(req, res, async (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message });
    if (!req.file) return res.status(400).json({ error: "No file was uploaded." });

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const sheet = workbook.worksheets[0];
      if (!sheet) return res.status(400).json({ error: "The file has no sheets." });

      const headerRow = sheet.getRow(1);
      const colIndexByKey = {};
      headerRow.eachCell((cell, colNumber) => {
        const norm = normalizeHeader(cell.value);
        const match = STALL_UPLOAD_COLUMNS.find((c) => normalizeHeader(c.header) === norm || c.key === norm);
        if (match) colIndexByKey[match.key] = colNumber;
      });
      const missingRequired = STALL_UPLOAD_COLUMNS.filter((c) => c.required && !colIndexByKey[c.key]);
      if (missingRequired.length > 0) {
        return res.status(400).json({
          error: `File is missing required column(s): ${missingRequired.map((c) => c.header).join(", ")}. Use "Download Template" to get the exact format.`,
        });
      }

      const MAX_ROWS = 2000;
      const dataRowCount = sheet.rowCount - 1;
      if (dataRowCount > MAX_ROWS) {
        return res.status(400).json({ error: `This file has ${dataRowCount} rows. Please split it into batches of ${MAX_ROWS} or fewer.` });
      }

      let successCount = 0;
      const failures = [];

      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
        const row = sheet.getRow(rowNumber);
        if (row.cellCount === 0 || row.values.every((v) => v === null || v === undefined || v === "")) continue;

        const getCell = (key) => {
          const idx = colIndexByKey[key];
          if (!idx) return "";
          const val = row.getCell(idx).value;
          if (val === null || val === undefined) return "";
          if (typeof val === "object") return String(val.text ?? val.result ?? "").trim();
          return String(val).trim();
        };

        const record = {
          hall_number: getCell("hall_number"),
          stall_number: getCell("stall_number"),
          floor: getCell("floor"),
          open_sides: getCell("open_sides"),
          length: getCell("length"),
          breadth: getCell("breadth"),
        };

        if (!record.hall_number || !record.stall_number) {
          failures.push({ row: rowNumber, reason: "Hall Number and Stall Number are required." });
          continue;
        }

        try {
          await pool.query(
            `INSERT INTO stalls (hall_number, stall_number, floor, open_sides, length, breadth, area_sqm)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              record.hall_number,
              record.stall_number,
              record.floor || null,
              record.open_sides || null,
              record.length || null,
              record.breadth || null,
              computeArea(record.length, record.breadth),
            ]
          );
          successCount += 1;
        } catch (err) {
          if (err.code === "23505") {
            failures.push({ row: rowNumber, reason: "This Hall + Stall Number combination already exists." });
          } else {
            failures.push({ row: rowNumber, reason: "Could not save this row — please check its data." });
          }
        }
      }

      const totalRows = successCount + failures.length;
      const logResult = await pool.query(
        `INSERT INTO bulk_uploads (upload_type, filename, uploaded_by, total_rows, success_count, failed_count, status, failure_report)
         VALUES ('stalls', $1, $2, $3, $4, $5, $6, $7)
         RETURNING id, filename, uploaded_by, total_rows, success_count, failed_count, status, created_at`,
        [
          req.file.originalname,
          req.admin?.username || null,
          totalRows,
          successCount,
          failures.length,
          failures.length === 0 ? "Completed" : "Completed with errors",
          JSON.stringify(failures),
        ]
      );

      res.json({ success: true, totalRows, successCount, failedCount: failures.length, upload: logResult.rows[0] });
    } catch (err) {
      console.error("stall bulk upload failed:", err.message);
      res.status(500).json({ error: "Could not process the file. Make sure it's a valid .xlsx file matching the template." });
    }
  });
});

// ---- Hall Managers (third tab on the Hall & Stall Management page) ----
app.get("/api/hall-managers", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM hall_managers ORDER BY hall_number`);
    res.json({ rows: result.rows });
  } catch (err) {
    console.error("list hall_managers failed:", err.message);
    res.status(500).json({ error: "Could not load hall managers." });
  }
});

app.post("/api/hall-managers", requireAuth, async (req, res) => {
  const { hall_number, manager_name, mobile_number, email } = req.body || {};
  if (!hall_number || !String(hall_number).trim()) return res.status(400).json({ error: "Hall Number is required." });
  if (!manager_name || !String(manager_name).trim()) return res.status(400).json({ error: "Manager Name is required." });
  try {
    const result = await pool.query(
      `INSERT INTO hall_managers (hall_number, manager_name, mobile_number, email) VALUES ($1, $2, $3, $4) RETURNING *`,
      [String(hall_number).trim(), String(manager_name).trim(), mobile_number || null, email || null]
    );
    res.json({ success: true, row: result.rows[0] });
  } catch (err) {
    console.error("create hall_manager failed:", err.message);
    res.status(500).json({ error: "Could not add hall manager." });
  }
});

app.patch("/api/hall-managers/:id", requireAuth, async (req, res) => {
  const body = req.body || {};
  const editable = ["hall_number", "manager_name", "mobile_number", "email"];
  const setClauses = [];
  const values = [];
  for (const key of editable) {
    if (body[key] === undefined) continue;
    values.push(body[key] === "" ? null : body[key]);
    setClauses.push(`${key} = $${values.length}`);
  }
  if (setClauses.length === 0) return res.status(400).json({ error: "No valid fields to update." });
  values.push(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE hall_managers SET ${setClauses.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Hall manager not found." });
    res.json({ success: true, row: result.rows[0] });
  } catch (err) {
    console.error("update hall_manager failed:", err.message);
    res.status(500).json({ error: "Could not update hall manager." });
  }
});

app.delete("/api/hall-managers/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM hall_managers WHERE id = $1`, [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Hall manager not found." });
    res.json({ success: true });
  } catch (err) {
    console.error("delete hall_manager failed:", err.message);
    res.status(500).json({ error: "Could not delete hall manager." });
  }
});

// GET /api/stalls/meta — floor & open-sides option lists, for the filter
// dropdowns and the Add/Edit Stall form.
app.get("/api/stalls/meta", requireAuth, (req, res) => {
  res.json({ floors: FLOOR_OPTIONS, openSides: OPEN_SIDES_OPTIONS, statuses: STALL_STATUSES });
});

// POST /api/exhibitor-booking/:id/allot-stall  { stallId }
// Allots the given (vacant) stall to this exhibitor. If the exhibitor
// already had a different stall allotted via this action, that old stall
// is freed back to Vacant first — keeping "one exhibitor -> one stall"
// simple, matching how this portal is meant to be used day to day.
app.post("/api/exhibitor-booking/:id/allot-stall", requireAuth, async (req, res) => {
  const exhibitorId = req.params.id;
  const { stallId } = req.body || {};
  if (!stallId) return res.status(400).json({ error: "stallId is required." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const exhibitorCheck = await client.query(`SELECT id FROM exhibitor_booking WHERE id = $1`, [exhibitorId]);
    if (exhibitorCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Exhibitor not found." });
    }

    const stallCheck = await client.query(`SELECT id, status, exhibitor_booking_id FROM stalls WHERE id = $1`, [stallId]);
    if (stallCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Stall not found." });
    }
    const stall = stallCheck.rows[0];
    if (stall.status === "Allotted" && stall.exhibitor_booking_id !== Number(exhibitorId)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This stall is already allotted to another exhibitor." });
    }

    // Free any stall this exhibitor previously held, if it's a different one.
    await client.query(
      `UPDATE stalls SET status = 'Vacant', exhibitor_booking_id = NULL
       WHERE exhibitor_booking_id = $1 AND id != $2`,
      [exhibitorId, stallId]
    );

    const result = await client.query(
      `UPDATE stalls SET status = 'Allotted', exhibitor_booking_id = $1 WHERE id = $2 RETURNING *`,
      [exhibitorId, stallId]
    );

    await client.query("COMMIT");
    res.json({ success: true, stall: result.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("allot stall failed:", err.message);
    res.status(500).json({ error: "Could not allot stall." });
  } finally {
    client.release();
  }
});

// POST /api/exhibitor-booking/:id/unallot-stall — frees whatever stall
// (if any) is currently allotted to this exhibitor.
app.post("/api/exhibitor-booking/:id/unallot-stall", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE stalls SET status = 'Vacant', exhibitor_booking_id = NULL WHERE exhibitor_booking_id = $1 RETURNING *`,
      [req.params.id]
    );
    res.json({ success: true, freed: result.rowCount });
  } catch (err) {
    console.error("unallot stall failed:", err.message);
    res.status(500).json({ error: "Could not unallot stall." });
  }
});

// ---------------------------------------------------------------------
// Task 6: Payments — manual "record a payment" entry point. Everything
// else about Payments (list/search/status/edit/delete/export) is handled
// generically below via TYPE_CONFIG.payments + /api/records/:type.
// ---------------------------------------------------------------------
app.post("/api/payments", requireAuth, async (req, res) => {
  const { exhibitorBookingId, amount, payment_mode, transaction_reference, payment_date, remarks } = req.body || {};
  if (!exhibitorBookingId) return res.status(400).json({ error: "Select an exhibitor first." });
  const amountNum = parseFloat(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) return res.status(400).json({ error: "Enter a valid amount." });

  try {
    const exhibitorCheck = await pool.query(`SELECT id FROM exhibitor_booking WHERE id = $1`, [exhibitorBookingId]);
    if (exhibitorCheck.rowCount === 0) return res.status(404).json({ error: "Exhibitor not found." });

    const inserted = await pool.query(
      `INSERT INTO payments (exhibitor_booking_id, amount, payment_mode, transaction_reference, payment_date, remarks)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        exhibitorBookingId,
        amountNum,
        payment_mode || null,
        transaction_reference || null,
        payment_date || null,
        remarks || null,
      ]
    );
    // Re-select through the same join used by the list view so the row
    // shape returned here matches what a page refresh would show.
    const result = await pool.query(
      `SELECT p.*, eb.company_name, eb.contact_email, eb.contact_mobile_number
       FROM payments p LEFT JOIN exhibitor_booking eb ON eb.id = p.exhibitor_booking_id
       WHERE p.id = $1`,
      [inserted.rows[0].id]
    );
    res.json({ success: true, row: result.rows[0] });
  } catch (err) {
    console.error("create payment failed:", err.message);
    res.status(500).json({ error: "Could not record payment." });
  }
});

// ---------------------------------------------------------------------
// Task 7: Service Request Forms — same "manual add" pattern as Payments.
// ---------------------------------------------------------------------
app.post("/api/service-requests", requireAuth, async (req, res) => {
  const { exhibitorBookingId, request_type, description, requested_date } = req.body || {};
  if (!exhibitorBookingId) return res.status(400).json({ error: "Select an exhibitor first." });
  if (!request_type || !String(request_type).trim()) return res.status(400).json({ error: "Select a service type." });

  try {
    const exhibitorCheck = await pool.query(`SELECT id FROM exhibitor_booking WHERE id = $1`, [exhibitorBookingId]);
    if (exhibitorCheck.rowCount === 0) return res.status(404).json({ error: "Exhibitor not found." });

    const inserted = await pool.query(
      `INSERT INTO service_requests (exhibitor_booking_id, request_type, description, requested_date)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [exhibitorBookingId, request_type, description || null, requested_date || null]
    );
    const result = await pool.query(
      `SELECT sr.*, eb.company_name, eb.contact_email, eb.contact_mobile_number
       FROM service_requests sr LEFT JOIN exhibitor_booking eb ON eb.id = sr.exhibitor_booking_id
       WHERE sr.id = $1`,
      [inserted.rows[0].id]
    );
    res.json({ success: true, row: result.rows[0] });
  } catch (err) {
    console.error("create service request failed:", err.message);
    res.status(500).json({ error: "Could not save service request." });
  }
});

// ---------------------------------------------------------------------
// Task 8: Analytics
// ---------------------------------------------------------------------

// GET /api/analytics/exhibitors — Space Booking summary: totals, area,
// amounts (from exhibitor_booking + payments), and breakdowns by
// participation category / country / state / product-sector / trend.
app.get("/api/analytics/exhibitors", requireAuth, async (req, res) => {
  try {
    // exhibitor_booking is owned by the external registration site, not
    // this codebase — its numeric-looking fields (stall_size_sqm,
    // total_payable) aren't guaranteed to be clean numbers on every row
    // (blank/garbled values slip through free-text registration forms).
    // Strip anything that isn't a digit/dot/minus before casting, so a
    // stray non-numeric value degrades to "0" for that row instead of
    // throwing and failing the whole SUM().
    const safeNumeric = (col) => `NULLIF(regexp_replace(${col}::text, '[^0-9.\\-]', '', 'g'), '')::numeric`;

    // Six independent queries used to run inside a single Promise.all,
    // so a single bad query (e.g. one row with unparseable data) failed
    // ALL of them and the whole panel showed "Could not load exhibitor
    // analytics." with no indication which query broke. Promise.allSettled
    // lets each section degrade independently — one broken chart doesn't
    // blank the rest — and logs which query failed for easier debugging.
    const labels = ["totals", "paid", "participation", "country", "state", "trend"];
    const results = await Promise.allSettled([
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COALESCE(SUM(${safeNumeric("stall_size_sqm")}), 0)::float AS area_sqm,
                COALESCE(SUM(${safeNumeric("total_payable")}), 0)::float AS total_amount
         FROM exhibitor_booking`
      ),
      pool.query(`SELECT COALESCE(SUM(amount), 0)::float AS paid FROM payments WHERE status = 'Approved'`),
      pool.query(
        `SELECT COALESCE(NULLIF(TRIM(participation_category), ''), 'Not specified') AS label, COUNT(*)::int AS count
         FROM exhibitor_booking GROUP BY 1 ORDER BY count DESC`
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(TRIM(billing_country), ''), 'Not specified') AS label, COUNT(*)::int AS count
         FROM exhibitor_booking GROUP BY 1 ORDER BY count DESC LIMIT 10`
      ),
      pool.query(
        `SELECT COALESCE(NULLIF(TRIM(billing_state), ''), 'Not specified') AS label, COUNT(*)::int AS count
         FROM exhibitor_booking WHERE billing_country ILIKE 'india' GROUP BY 1 ORDER BY count DESC LIMIT 10`
      ),
      pool.query(
        `SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS label, COUNT(*)::int AS count
         FROM exhibitor_booking GROUP BY 1 ORDER BY 1`
      ),
    ]);

    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`exhibitor analytics: "${labels[i]}" query failed:`, r.reason && r.reason.message);
      }
    });

    const emptyRows = { rows: [] };
    const [totals, paid, participation, country, state, trend] = results.map((r, i) =>
      r.status === "fulfilled" ? r.value : i === 0 ? { rows: [{ total: 0, area_sqm: 0, total_amount: 0 }] } : i === 1 ? { rows: [{ paid: 0 }] } : emptyRows
    );

    // product_categories is stored per-exhibitor as a small structured
    // field on the registration site — its exact type can vary, so this
    // is wrapped separately: if it isn't a JSON array on this database,
    // skip the sector chart instead of failing the whole page.
    let bySector = null;
    try {
      const sectorResult = await pool.query(
        `SELECT COALESCE(NULLIF(TRIM(value::text), ''), 'Other') AS label, COUNT(*)::int AS count
         FROM exhibitor_booking,
              LATERAL jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(product_categories::jsonb) = 'array'
                     THEN product_categories::jsonb ELSE '[]'::jsonb END
              ) AS value
         GROUP BY 1 ORDER BY count DESC LIMIT 12`
      );
      bySector = sectorResult.rows.map((r) => ({ label: r.label, count: parseInt(r.count, 10) }));
    } catch (sectorErr) {
      bySector = null;
    }

    const totalAmount = parseFloat(totals.rows[0].total_amount) || 0;
    const paidAmount = parseFloat(paid.rows[0].paid) || 0;

    res.json({
      totals: {
        totalExhibitors: totals.rows[0].total,
        areaSqm: parseFloat(totals.rows[0].area_sqm) || 0,
        totalAmount,
        paidAmount,
        outstandingAmount: Math.max(totalAmount - paidAmount, 0),
      },
      byParticipation: participation.rows.map((r) => ({ label: r.label, count: parseInt(r.count, 10) })),
      byCountry: country.rows.map((r) => ({ label: r.label, count: parseInt(r.count, 10) })),
      byState: state.rows.map((r) => ({ label: r.label, count: parseInt(r.count, 10) })),
      bySector,
      trend: trend.rows.map((r) => ({ label: r.label, count: parseInt(r.count, 10) })),
    });
  } catch (err) {
    console.error("exhibitor analytics failed:", err.message);
    res.status(500).json({ error: "Could not load exhibitor analytics." });
  }
});

// GET /api/analytics/buyers — Domestic Buyers summary: totals by status,
// country breakdown, registration trend.
app.get("/api/analytics/buyers", requireAuth, async (req, res) => {
  try {
    const buyerLabels = ["statusBreakdown", "country", "trend"];
    const buyerResults = await Promise.allSettled([
      pool.query(`SELECT status, COUNT(*)::int AS count FROM visitors WHERE interest_type = 'Buyer' GROUP BY status`),
      pool.query(
        `SELECT COALESCE(NULLIF(TRIM(country), ''), 'Not specified') AS label, COUNT(*)::int AS count
         FROM visitors WHERE interest_type = 'Buyer' GROUP BY 1 ORDER BY count DESC LIMIT 10`
      ),
      pool.query(
        `SELECT TO_CHAR(created_at, 'YYYY-MM-DD') AS label, COUNT(*)::int AS count
         FROM visitors WHERE interest_type = 'Buyer' GROUP BY 1 ORDER BY 1`
      ),
    ]);
    buyerResults.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`buyer analytics: "${buyerLabels[i]}" query failed:`, r.reason && r.reason.message);
      }
    });
    const [statusBreakdown, country, trend] = buyerResults.map((r) => (r.status === "fulfilled" ? r.value : { rows: [] }));
    const byStatus = {};
    STATUSES.forEach((s) => (byStatus[s] = 0));
    let total = 0;
    statusBreakdown.rows.forEach((row) => {
      const count = parseInt(row.count, 10);
      if (byStatus[row.status] !== undefined) byStatus[row.status] = count;
      total += count;
    });

    res.json({
      totals: { totalBuyers: total, byStatus },
      byCountry: country.rows.map((r) => ({ label: r.label, count: parseInt(r.count, 10) })),
      trend: trend.rows.map((r) => ({ label: r.label, count: parseInt(r.count, 10) })),
    });
  } catch (err) {
    console.error("buyer analytics failed:", err.message);
    res.status(500).json({ error: "Could not load buyer analytics." });
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
    const countResult = await pool.query(`SELECT COUNT(*) FROM ${fromClause(cfg)} ${where}`, values);
    const total = parseInt(countResult.rows[0].count, 10);

    const dataValues = [...values, pageSize, offset];
    const dataResult = await pool.query(
      `SELECT * FROM ${fromClause(cfg)} ${where} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
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
    const result = await pool.query(`SELECT * FROM ${fromClause(cfg)} ${where} ORDER BY created_at DESC`, values);

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