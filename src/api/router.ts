import { Router } from "express";
import { inboundRouter } from "./inbound";
import { toolsRouter } from "./tools";
import { cloverRouter } from "./clover";

export const apiRouter = Router();

apiRouter.use(inboundRouter);
apiRouter.use("/tools", toolsRouter);
apiRouter.use(cloverRouter);
