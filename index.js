/*
 * Callvero Backend (Express)
 * Twilio -> (wss) -> Your Server -> (wss) -> Vapi
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

/**
 * Twilio sends webhook payloads as application/x-www-form-urlencoded by default.
 */
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use((req, res, next) => {
  if (req.path === "/" || req.path === "/health") {
    console.log(`Health check hit: ${req.method} ${req.path}`);
  }
  next();
});

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Default root
app.get("/", (req, res) => res.status(200).send("ok"));

/**
 * ✅ /voice
 * Twilio hits this on incoming call.
 * We return TwiML that opens a Media Stream to OUR server:
 *   wss://<your-domain>/twilio-stream
 */
app.post("/voice", (req, res) => {
  const from = req.body.From || "";
  const to = req.body.To || "";
  const callSid = req.body.CallSid || "";

  console.log("📞 Twilio /voice webhook hit");
  console.log("From:", from, "To:", to, "CallSid:", callSid);

  // Force WSS (Twilio Media Streams needs secure WS in production)
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

// XML helper
function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * ---- Demo store routes (unchanged) ----
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
 * -------------------------
 * VAPI BRIDGE (IMPORTANT)
 * -------------------------
 * Twilio Media Stream audio is base64 mulaw/8000.
 * We create a Vapi websocket call and pass raw audio bytes.
 */

function needEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function fetchJson(url, options) {
  // Node 18+ has global fetch. If not, fail clearly.
  if (typeof fetch !== "function") {
    throw new Error("Global fetch() not found. Use Node 18+ or install node-fetch.");
  }
  const resp = await fetch(url, options);
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${text}`);
  }
  return json ?? {};
}

// Create a Vapi websocket call and get the websocket URL to connect to
async function createVapiWebsocketCall() {
  const VAPI_API_KEY = needEnv("VAPI_API_KEY"); // PRIVATE key
  const VAPI_ASSISTANT_ID = needEnv("VAPI_ASSISTANT_ID");

  const data = await fetchJson("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      authorization: `Bearer ${VAPI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      assistantId: VAPI_ASSISTANT_ID,
      transport: {
        provider: "vapi.websocket",
        audioFormat: {
          format: "mulaw",
          container: "raw",
          sampleRate: 8000,
        },
      },
    }),
  });

  const wsUrl = data?.transport?.websocketCallUrl;
  if (!wsUrl) throw new Error("Vapi did not return transport.websocketCallUrl");
  return wsUrl;
}

/**
 * Create real HTTP server and attach WS server to it
 * (CRITICAL: do NOT use app.listen)
 */
const server = http.createServer(app);

const wss = new WebSocket.Server({ server, path: "/twilio-stream" });

wss.on("connection", async (twilioWs, req) => {
  console.log("✅ /twilio-stream WS CONNECTED");

  let streamSid = null;
  let vapiWs = null;
  let vapiOpen = false;

  const safeClose = () => {
    try { twilioWs.close(); } catch {}
    try { vapiWs?.close(); } catch {}
  };

  twilioWs.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Twilio start event
    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      console.log("🎧 Twilio stream started:", streamSid);

      try {
        const vapiUrl = await createVapiWebsocketCall();
        console.log("✅ Vapi websocketCallUrl received");

        vapiWs = new WebSocket(vapiUrl);

        vapiWs.on("open", () => {
          vapiOpen = true;
          console.log("✅ Vapi WS connected");
        });

        // Vapi -> Twilio (audio back)
        vapiWs.on("message", (data) => {
          // If Vapi sends raw audio bytes (Buffer)
          if (Buffer.isBuffer(data)) {
            if (!streamSid) return;
            twilioWs.send(
              JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: data.toString("base64") },
              })
            );
            return;
          }

          // Optional: JSON control messages
          try {
            const j = JSON.parse(data.toString());
            if (j.type === "error") console.error("❌ Vapi error:", j);
          } catch {}
        });

        vapiWs.on("close", () => {
          console.log("🔌 Vapi WS closed");
          safeClose();
        });

        vapiWs.on("error", (e) => {
          console.error("❌ Vapi WS error:", e);
          safeClose();
        });
      } catch (e) {
        console.error("❌ Failed to start Vapi call:", e.message || e);
        safeClose();
      }
      return;
    }

    // Twilio media event (audio)
    if (msg.event === "media") {
      if (!vapiWs || !vapiOpen) return;
      const payload = msg.media?.payload;
      if (!payload) return;

      // Twilio payload = base64 mulaw bytes
      const audioBytes = Buffer.from(payload, "base64");
      try {
        vapiWs.send(audioBytes); // send raw bytes
      } catch (e) {
        console.error("❌ Failed sending audio to Vapi:", e);
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("🛑 Twilio stream stopped");
      safeClose();
      return;
    }
  });

  twilioWs.on("close", (code, reason) => {
    console.log("🔌 Twilio WS closed", code, reason?.toString?.() || "");
    safeClose();
  });

  twilioWs.on("error", (err) => {
    console.error("❌ Twilio WS error:", err);
    safeClose();
  });
});

// Start server (Railway needs process.env.PORT)
const port = process.env.PORT || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log(`Callvero backend listening on port ${port}`);
});
