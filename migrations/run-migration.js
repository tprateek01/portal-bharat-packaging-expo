// Runs every .sql file in this folder against the database in DATABASE_URL,
// in filename order (schema.sql first, then 002_..., 003_..., etc.) — so a
// new migration file just needs to be dropped in here and it gets picked up
// automatically next time this runs. Every file is written to be safe to
// re-run, so running the whole set again after adding one new file is fine.
// Usage: npm run migrate
const fs = require("fs");
const path = require("path");
const pool = require("../db");

async function main() {
  const dir = __dirname;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => {
      // schema.sql always first, everything else in filename order
      // (numbered prefixes like 002_..., 003_... sort naturally after it).
      if (a === "schema.sql") return -1;
      if (b === "schema.sql") return 1;
      return a.localeCompare(b);
    });

  if (files.length === 0) {
    console.log("No .sql migration files found.");
    return;
  }

  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      console.log(`Running ${file}...`);
      await pool.query(sql);
    }
    console.log("Done. Every migration is safe to re-run, and your existing data is untouched.");
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();