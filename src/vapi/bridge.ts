import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { config } from "../core/config";
import { logger } from "../core/logger";

type TwilioStreamStart = {
  streamSid?: string;
  customParameters?: Record<string, string>;
};

type TwilioMessage = {
  event?: string;
  start?: TwilioStreamStart;
  media?: { payload?: string };
};

type VapiCallPayload = {
  assistantId: string;
  metadata?: Record<string, string>;
  transport: {
    provider: "vapi.websocket";
    audioFormat: {
      format: "mulaw";
      sampleRate: number;
      container: "raw";
    };
  };
};

function bufferLooksLikeText(buf: Buffer) {
  let printable = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i];
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) {
      printable += 1;
    }
  }
  return printable / buf.length > 0.85;
}

async function createVapiWebsocketCallUrl(metadata?: Record<string, string>): Promise<string> {
  if (!config.vapiApiKey || !config.vapiAssistantId) {
    throw new Error("Missing VAPI_API_KEY or VAPI_ASSISTANT_ID");
  }

  const payload: VapiCallPayload = {
    assistantId: config.vapiAssistantId,
    transport: {
      provider: "vapi.websocket",
      audioFormat: {
        format: "mulaw",
        sampleRate: 8000,
        container: "raw",
      },
    },
  };

  if (metadata && Object.keys(metadata).length > 0) {
    payload.metadata = metadata;
  }

  const response = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.vapiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(`Vapi /call failed: ${response.status} ${text}`);
  }

  const wsUrl = data?.transport?.websocketCallUrl;
  if (!wsUrl) {
    throw new Error(`Vapi did not return websocketCallUrl: ${text}`);
  }

  return wsUrl;
}

export function attachTwilioStreamServer(server: http.Server) {
  const wss = new WebSocketServer({ server, path: "/twilio-stream" });

  wss.on("connection", (twilioWs) => {
    let streamSid: string | null = null;
    let vapiWs: WebSocket | null = null;
    let vapiReady = false;

    const cleanup = () => {
      try {
        twilioWs.close();
      } catch {}
      try {
        vapiWs?.close();
      } catch {}
    };

    const sendToTwilio = (audioBuf: Buffer) => {
      if (!streamSid) return;
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: audioBuf.toString("base64") },
        })
      );
    };

    twilioWs.on("message", async (raw) => {
      let msg: TwilioMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start?.streamSid || null;
        const metadata = msg.start?.customParameters || {};

        try {
          const vapiUrl = await createVapiWebsocketCallUrl(metadata);
          vapiWs = new WebSocket(vapiUrl);

          vapiWs.on("open", () => {
            vapiReady = true;
          });

          vapiWs.on("message", (data, isBinary) => {
            if (!streamSid) return;
            if (typeof isBinary === "boolean" && !isBinary) return;
            if (!Buffer.isBuffer(data) || data.length === 0) return;
            if (bufferLooksLikeText(data)) return;
            sendToTwilio(data);
          });

          vapiWs.on("close", () => {
            cleanup();
          });

          vapiWs.on("error", (error) => {
            logger.error({ error }, "vapi websocket error");
            cleanup();
          });
        } catch (error) {
          logger.error({ error }, "failed to start vapi websocket");
          cleanup();
        }
        return;
      }

      if (msg.event === "media") {
        if (!vapiWs || !vapiReady) return;
        const payload = msg.media?.payload;
        if (!payload) return;
        const audioBytes = Buffer.from(payload, "base64");
        try {
          vapiWs.send(audioBytes);
        } catch (error) {
          logger.error({ error }, "failed sending audio to vapi");
          cleanup();
        }
        return;
      }

      if (msg.event === "stop") {
        cleanup();
      }
    });

    twilioWs.on("close", () => {
      cleanup();
    });

    twilioWs.on("error", (error) => {
      logger.error({ error }, "twilio websocket error");
      cleanup();
    });
  });
}
