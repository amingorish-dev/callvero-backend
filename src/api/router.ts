import { Router } from "express";
import { inboundRouter } from "./inbound";
import { toolsRouter } from "./tools";

export const apiRouter = Router();

apiRouter.use(inboundRouter);
apiRouter.use("/tools", toolsRouter);
