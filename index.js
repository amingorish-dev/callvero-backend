/*
 * Callvero Backend (Express)
 *
 * Lightweight backend for a voice-enabled business phone agent.
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

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Default root
app.get("/", (req, res) => res.status(200).send("ok"));

/**
 * ✅ /voice ROUTE (Twilio Media Stream -> YOUR server)
 */
app.post("/voice", (req, res) => {
  const from = req.body.From || "";
  const to = req.body.To || "";
  const callSid = req.body.CallSid || "";

  console.log("📞 Twilio /voice webhook hit");
  console.log("From:", from, "To:", to, "CallSid:", callSid);

  // Build YOUR websocket URL (Railway domain)
  // This becomes: wss://callvero-backend-production.up.railway.app/twilio-stream
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

  res.type("text/xml").send(twiml);
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
 * ✅ WebSocket Server for Twilio Media Streams
 * This is the endpoint Twilio will connect to:
 * wss://callvero-backend-production.up.railway.app/twilio-stream
 */
const server = http.createServer(app);

const wss = new WebSocket.Server({ server, path: "/twilio-stream" });

wss.on("connection", (ws) => {
  console.log("✅ /twilio-stream WS CONNECTED");

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      console.log("WS event:", msg.event);
    } catch {
      console.log("WS message (non-json)");
    }
  });

  ws.on("close", () => console.log("🔌 /twilio-stream WS CLOSED"));
  ws.on("error", (err) => console.log("❌ /twilio-stream WS ERROR", err));
});

const port = process.env.PORT || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log(`Callvero backend listening on port ${port}`);
});
