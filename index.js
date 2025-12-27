/*
 * Callvero Backend (Express)
 * Twilio -> (WSS) -> Your Railway Server -> (WSS) -> Vapi
 */

const express = require("express");
const bodyParser = require("body-parser");
const http = require("http");
const WebSocket = require("ws");

let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    const twilio = require("twilio");
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  } catch (err) {
    console.warn("Twilio module not installed. SMS disabled.");
  }
}

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.status(200).send("ok"));

/**
 * /voice — Twilio webhook
 */
app.post("/voice", (req, res) => {
  const from = req.body.From || "";
  const to = req.body.To || "";
  const callSid = req.body.CallSid || "";

  console.log("📞 Twilio /voice webhook hit");
  console.log("From:", from, "To:", to, "CallSid:", callSid);

  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const wsUrl = `wss://${host}/twilio-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Connecting you to our AI assistant now.</Say>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}">
      <Parameter name="callerId" value="${escapeXml(from)}" />
      <Parameter name="callSid" value="${escapeXml(callSid)}" />
      <Parameter name="from" value="${escapeXml(from)}" />
      <Parameter name="to" value="${escapeXml(to)}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml").status(200).send(twiml);
});

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Demo store routes (unchanged)
 */
const store = {
  id: 1,
  name: "Example Restaurant",
  hours: {
    monday: "11:00–21:00",
    tuesday: "11:00–21:00",
    wednesday: "11:00–21:00",
    thursday: "11:00–21:00",
    friday: "11:00–22:00",
    saturday: "11:00–22:00",
    sunday: "11:00–20:00",
  },
  menu: [
    { id: 1, name: "Classic Burger", price: 9.99 },
    { id: 2, name: "Veggie Burger", price: 10.99 },
    { id: 3, name: "Fries", price: 3.49 },
    { id: 4, name: "Soft Drink", price: 1.99 },
  ],
};

app.get("/hours", (req, res) => res.json({ hours: store.hours }));

app.post("/search_menu", (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "query is required" });
  const results = store.menu.filter((i) =>
    i.name.toLowerCase().includes(query.toLowerCase())
  );
  res.json({ results });
});

app.post("/create_order", (req, res) => {
  const { cart, customerPhone, customerName, type } = req.body;
  if (!cart || !Array.isArray(cart) || cart.length === 0) {
    return res.status(400).json({ error: "cart is required" });
  }

  try {
    let total = 0;
    const items = cart.map(({ id, quantity }) => {
      const menuItem = store.menu.find((m) => m.id === id);
      if (!menuItem) throw new Error("Unknown item");
      total += menuItem.price * (quantity || 1);
      return { ...menuItem, quantity: quantity || 1 };
    });

    const order = {
      id: Date.now(),
      items,
      total,
      type,
      customer: { phone: customerPhone, name: customerName },
      status: "CREATED",
    };

    res.json({ order });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/send_sms", async (req, res) => {
  const { to, link } = req.body;
  if (!to || !link) return res.status(400).json({ error: "to and link required" });
  if (!twilioClient) return res.status(500).json({ error: "SMS not configured" });

  if (!process.env.TWILIO_FROM_NUMBER) {
    return res.status(500).json({ error: "TWILIO_FROM_NUMBER is not set" });
  }

  try {
    const message = await twilioClient.messages.create({
      to,
      from: process.env.TWILIO_FROM_NUMBER,
      body: `Please complete your payment: ${link}`,
    });
    res.json({ success: true, sid: message.sid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/handoff", (req, res) => res.json({ success: true }));

/**
 * --------------------------
 * VAPI BRIDGE
 * --------------------------
 */

function needEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function createVapiWebsocketCallUrl() {
  if (typeof fetch !== "function") {
    throw new Error("fetch() not found. Use Node 18+ runtime.");
  }

  const VAPI_API_KEY = needEnv("VAPI_API_KEY");
  const VAPI_ASSISTANT_ID = needEnv("VAPI_ASSISTANT_ID");

  const resp = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      assistantId: VAPI_ASSISTANT_ID,
      transport: {
        provider: "vapi.websocket",
        audioFormat: {
          format: "mulaw",
          sampleRate: 8000,
          container: "raw",
        },
      },
    }),
  });

  const text = await resp.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!resp.ok) {
    throw new Error(`Vapi /call failed: ${resp.status} ${text}`);
  }

  const wsUrl = data?.transport?.websocketCallUrl;
  if (!wsUrl) {
    throw new Error(`Vapi did not return transport.websocketCallUrl. Response: ${text}`);
  }
  return wsUrl;
}

/**
 * ✅ WebSocket server for Twilio Media Streams
 */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-stream" });

wss.on("connection", (twilioWs) => {
  console.log("✅ /twilio-stream WS CONNECTED");

  let streamSid = null;
  let vapiWs = null;
  let vapiReady = false;

  // Keep a small "last sent" guard to avoid bursts
  const MIN_AUDIO_BYTES = 160; // ~20ms mulaw @ 8k (roughly)

  const cleanup = () => {
    try { twilioWs.close(); } catch {}
    try { vapiWs?.close(); } catch {}
  };

  const sendToTwilio = (audioBuf) => {
    if (!streamSid) return;
    twilioWs.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: audioBuf.toString("base64") },
    }));
  };

  twilioWs.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      console.log("WS event: start | streamSid:", streamSid);

      try {
        const vapiUrl = await createVapiWebsocketCallUrl();
        console.log("✅ Vapi websocketCallUrl received");

        vapiWs = new WebSocket(vapiUrl);

        vapiWs.on("open", () => {
          vapiReady = true;
          console.log("✅ Vapi WS connected");
        });

        vapiWs.on("message", (data) => {
          if (!streamSid) return;

          // ✅ Only forward binary audio buffers
          if (!Buffer.isBuffer(data)) return;

          // ✅ Drop tiny frames / keepalives (often cause crackle)
          if (data.length < MIN_AUDIO_BYTES) return;

          // ✅ Twilio expects mulaw bytes base64
          sendToTwilio(data);
        });

        vapiWs.on("close", () => {
          console.log("🔌 Vapi WS closed");
          cleanup();
        });

        vapiWs.on("error", (e) => {
          console.error("❌ Vapi WS error:", e);
          cleanup();
        });
      } catch (e) {
        console.error("❌ Failed to start Vapi call:", e.message || e);
        cleanup();
      }
      return;
    }

    if (msg.event === "media") {
      // Twilio -> Vapi
      if (!vapiWs || !vapiReady) return;
      const payload = msg.media?.payload;
      if (!payload) return;

      const audioBytes = Buffer.from(payload, "base64");
      try {
        vapiWs.send(audioBytes);
      } catch (e) {
        console.error("❌ Failed sending audio to Vapi:", e);
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("WS event: stop");
      cleanup();
    }
  });

  twilioWs.on("close", () => {
    console.log("🔌 Twilio WS closed");
    cleanup();
  });

  twilioWs.on("error", (err) => {
    console.error("❌ Twilio WS error:", err);
    cleanup();
  });
});

// Listen (Railway)
const port = process.env.PORT || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log(`Callvero backend listening on port ${port}`);
});
