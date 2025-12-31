import { config } from "../core/config";
import { logger } from "../core/logger";
import { runMigrations } from "./migrationsRunner";

runMigrations(config.databaseUrl).catch((error) => {
  logger.error({ error }, "migration failed");
  process.exit(1);
});
