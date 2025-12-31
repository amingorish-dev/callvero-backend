import fs from "fs/promises";
import path from "path";
import { Pool } from "pg";
import { logger } from "../core/logger";

export async function runMigrations(databaseUrl: string) {
  const migrationsDir = path.resolve(__dirname, "migrations");
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (filename text primary key, applied_at timestamptz not null default now())"
    );

    const entries = await fs.readdir(migrationsDir);
    const files = entries.filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      const applied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [file]
      );
      if (applied.rowCount) {
        continue;
      }

      const sql = await fs.readFile(path.join(migrationsDir, file), "utf-8");
      logger.info({ file }, "applying migration");

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}
