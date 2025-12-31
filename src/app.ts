import express from "express";
import pinoHttp from "pino-http";
import { logger } from "./core/logger";
import { ApiError } from "./core/errors";
import { apiRouter } from "./api/router";
import { VAPI_SYSTEM_PROMPT } from "./core/vapiPrompt";

export function createApp() {
  const app = express();

  app.use(pinoHttp());
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  app.get("/", (req, res) => {
    res.json({
      ok: true,
      service: "callvero-backend",
    });
  });

  app.get("/vapi/system-prompt", (req, res) => {
    res.json({ prompt: VAPI_SYSTEM_PROMPT });
  });

  app.use(apiRouter);

  app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.message, details: error.details });
      return;
    }

    logger.error({ error }, "unhandled error");
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}
