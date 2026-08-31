// Runs migrations/schema.sql against the database in DATABASE_URL.
// Usage: npm run migrate
const fs = require("fs");
const path = require("path");
const pool = require("../db");

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  console.log("Adding status columns to visitors, exhibitor_eoi, exhibitor_booking...");
  try {
    await pool.query(sql);
    console.log("Done. Your existing data is untouched — every row now defaults to status = 'Registered'.");
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
