import { Pool, QueryResult, QueryResultRow } from "pg";
import { config } from "../core/config";

const pool = new Pool({
  connectionString: config.databaseUrl,
});

export const db = {
  async query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    return pool.query<T>(text, params);
  },
};

export async function closeDb(): Promise<void> {
  await pool.end();
}
