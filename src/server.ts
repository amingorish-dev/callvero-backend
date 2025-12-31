import { config } from "./core/config";
import { logger } from "./core/logger";
import { createApp } from "./app";

const app = createApp();

app.listen(config.port, () => {
  logger.info({ port: config.port }, "server listening");
});
