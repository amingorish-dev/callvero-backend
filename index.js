/*
 * Callvero Backend (Express)
 *
 * Lightweight backend for a voice-enabled business phone agent.
 */

const express = require('express');
const bodyParser = require('body-parser');

let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    const twilio = require('twilio');
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
 * ✅ FIX #1:
 * Twilio sends webhook payloads as application/x-www-form-urlencoded by default.
 * If you only parse JSON, req.body will be empty and some flows break.
 */
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true });
});
// Default root for platform health checks
app.get('/', (req, res) => {
  res.status(200).send('ok');
});

/**
 * ✅ FIX #2 (YOUR MAIN ISSUE):
 * Twilio is POSTing to /voice but your server didn’t have that route,
 * so Twilio got "Cannot POST /voice" (404).
 *
 * This route returns TwiML (XML) so Twilio knows what to do with the call.
 */
app.post('/voice', (req, res) => {
  // Helpful debug logs (will show in Railway logs)
  console.log('📞 Twilio /voice webhook hit');
  console.log('From:', req.body.From, 'To:', req.body.To, 'CallSid:', req.body.CallSid);

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello. Callvero backend is connected.</Say>
</Response>`);
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
    i.name.toLowerCase().includes(query.toLowerCase())
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
app.listen(port, () => {
  console.log(`Callvero backend listening on port ${port}`);
});
