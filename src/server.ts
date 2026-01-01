import http from "http";
import { config } from "./core/config";
import { logger } from "./core/logger";
import { createApp } from "./app";
import { attachTwilioStreamServer } from "./vapi/bridge";

const app = createApp();
const server = http.createServer(app);

attachTwilioStreamServer(server);

server.listen(config.port, () => {
  logger.info({ port: config.port }, "server listening");
});
