/*
 * Callvero Backend (Express)
 *
 * Lightweight backend for a voice-enabled business phone agent.
 */

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio'); // ✅ needed for TwiML builder + client

let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  } catch (err) {
    console.warn('Twilio module not installed. SMS disabled.');
  }
}

const app = express();

/**
 * Twilio sends webhook payloads as application/x-www-form-urlencoded by default.
 */
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/health') {
    console.log(`Health check hit: ${req.method} ${req.path}`);
  }
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Default root for platform health checks
app.get('/', (req, res) => {
  res.status(200).send('ok');
});

/**
 * ✅ VAPI STREAMING FIX:
 * Twilio inbound call webhook -> stream audio to Vapi via <Connect><Stream>.
 *
 * Requires Railway env var:
 *   VAPI_STREAM_URL = wss://api.vapi.ai/stream/twilio   (or the exact Vapi URL you use)
 */
app.post('/voice', (req, res) => {
  console.log('📞 Twilio /voice webhook hit');
  console.log('From:', req.body.From, 'To:', req.body.To, 'CallSid:', req.body.CallSid);

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const streamUrl = process.env.VAPI_STREAM_URL;

  // If not configured, tell caller clearly (helps debugging)
  if (!streamUrl) {
    twiml.say({ voice: 'alice' }, 'The AI stream is not configured yet. Please try again later.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // Optional quick greeting
  twiml.say({ voice: 'alice' }, 'Connecting you to our AI assistant now.');

  // Stream call audio to Vapi
  const connect = twiml.connect();
  connect.stream({
    url: streamUrl,
    name: 'callvero-vapi-stream',
  });

  // Respond with TwiML
  res.type('text/xml').send(twiml.toString());
});

const store = {
  id: 1,
  name: 'Example Restaurant',
  hours: {
    monday: '11:00–21:00',
    tuesday: '11:00–21:00',
    wednesday: '11:00–21:00',
    thursday: '11:00–21:00',
    friday: '11:00–22:00',
    saturday: '11:00–22:00',
    sunday: '11:00–20:00',
  },
  menu: [
    { id: 1, name: 'Classic Burger', price: 9.99 },
    { id: 2, name: 'Veggie Burger', price: 10.99 },
    { id: 3, name: 'Fries', price: 3.49 },
    { id: 4, name: 'Soft Drink', price: 1.99 },
  ],
};

app.get('/hours', (req, res) => {
  res.json({ hours: store.hours });
});

app.post('/search_menu', (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  const results = store.menu.filter(i =>
    i.name.toLowerCase().includes(String(query).toLowerCase())
  );
  res.json({ results });
});

app.post('/create_order', (req, res) => {
  const { cart, customerPhone, customerName, type } = req.body;
  if (!cart || !Array.isArray(cart) || cart.length === 0) {
    return res.status(400).json({ error: 'cart is required' });
  }

  try {
    let total = 0;
    const items = cart.map(({ id, quantity }) => {
      const menuItem = store.menu.find(m => m.id === id);
      if (!menuItem) throw new Error('Unknown item');
      total += menuItem.price * (quantity || 1);
      return { ...menuItem, quantity: quantity || 1 };
    });

    const order = {
      id: Date.now(),
      items,
      total,
      type,
      customer: { phone: customerPhone, name: customerName },
      status: 'CREATED',
    };

    res.json({ order });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/send_sms', async (req, res) => {
  const { to, link } = req.body;
  if (!to || !link) return res.status(400).json({ error: 'to and link required' });
  if (!twilioClient) return res.status(500).json({ error: 'SMS not configured' });

  if (!process.env.TWILIO_FROM_NUMBER) {
    return res.status(500).json({ error: 'TWILIO_FROM_NUMBER is not set' });
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

app.post('/handoff', (req, res) => {
  res.json({ success: true });
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Callvero backend listening on port ${port}`);
});
