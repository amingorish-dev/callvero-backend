import { Client } from "pg";
import { randomUUID } from "crypto";

export type TestDatabase = {
  adminUrl: string;
  databaseUrl: string;
  dbName: string;
};

function getAdminUrl(): string {
  const explicit = process.env.TEST_DATABASE_ADMIN_URL || process.env.DATABASE_URL;
  if (explicit) {
    const url = new URL(explicit);
    url.pathname = "/postgres";
    return url.toString();
  }

  const host = process.env.PGHOST || "localhost";
  const port = process.env.PGPORT || "5432";
  const user = process.env.PGUSER || process.env.USER;
  const password = process.env.PGPASSWORD;

  if (!user) {
    throw new Error("Set DATABASE_URL, TEST_DATABASE_ADMIN_URL, or PGUSER for tests");
  }

  const encodedUser = encodeURIComponent(user);
  const encodedPass = password ? `:${encodeURIComponent(password)}` : "";
  return `postgres://${encodedUser}${encodedPass}@${host}:${port}/postgres`;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = getAdminUrl();
  const dbName = `callvero_test_${Date.now()}_${randomUUID().slice(0, 8)}`;

  const adminClient = new Client({ connectionString: adminUrl });
  await adminClient.connect();
  await adminClient.query(`CREATE DATABASE "${dbName}"`);
  await adminClient.end();

  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${dbName}`;

  return {
    adminUrl,
    databaseUrl: databaseUrl.toString(),
    dbName,
  };
}

export async function dropTestDatabase(info: TestDatabase): Promise<void> {
  const adminClient = new Client({ connectionString: info.adminUrl });
  await adminClient.connect();
  await adminClient.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [info.dbName]);
  await adminClient.query(`DROP DATABASE IF EXISTS "${info.dbName}"`);
  await adminClient.end();
}
