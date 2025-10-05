require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const session = require('express-session');

const app = express();
app.use(express.json());

// ---- Session ----
app.use(session({
  secret: process.env.SESSION_SECRET || 'loyverse-whatsapp-bot-secret',
  resave: false,
  saveUninitialized: false
}));

// ---- Environment ----
const {
  APP_ID,
  APP_SECRET,
  REDIRECT_URI,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  PORT = 3000
} = process.env;

// ---- File Paths ----
const TOKEN_FILE = path.join(__dirname, 'loyverse_tokens.json');
const LAST_RECEIPT_FILE = path.join(__dirname, 'lastReceipt.json');

// ---- Loyverse ----
const LOYVERSE_TOKEN_URL = 'https://api.loyverse.com/oauth/token';
const LOYVERSE_API = 'https://api.loyverse.com/v1.0';

// ---- WhatsApp ----
const WHATSAPP_URL = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
const WHATSAPP_HEADERS = {
  'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
  'Content-Type': 'application/json'
};

// ========== TOKEN HELPERS ==========
async function loadTokens() {
  try { return JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8')); }
  catch { return null; }
}

async function saveTokens(tokens) {
  await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

async function getAccessToken() {
  const tokens = await loadTokens();
  if (!tokens) throw new Error('No OAuth tokens found.');

  const exp = tokens.created_at + tokens.expires_in * 1000;
  if (Date.now() > exp - 300000) {
    const res = await axios.post(LOYVERSE_TOKEN_URL, null, {
      params: {
        client_id: APP_ID,
        client_secret: APP_SECRET,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token'
      }
    });
    const newT = { ...res.data, created_at: Date.now() };
    await saveTokens(newT);
    console.log('🔄 Token refreshed');
    return newT.access_token;
  }
  return tokens.access_token;
}

// ========== LOYVERSE REQUEST ==========
async function loyverseGet(endpoint, params = '') {
  const access = await getAccessToken();
  const url = `${LOYVERSE_API}${endpoint}${params}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${access}` }
  });
  return res.data;
}

// ========== RECEIPT FETCH ==========
async function fetchRecentReceipts() {
  try {
    // 15-minute window
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const query = `?limit=10&sort_by=created_at&order=DESC&created_at_min=${encodeURIComponent(since)}`;
    const data = await loyverseGet('/receipts', query);
    const receipts = data.receipts || [];

    if (!receipts.length) {
      console.log(`📭 No receipts since ${since}`);
    } else {
      console.log(`🧾 ${receipts.length} receipts found.`);
    }
    return receipts;
  } catch (err) {
    console.error('❌ Error fetching receipts:', err.response?.data || err.message);
    return [];
  }
}

// ========== WHATSAPP SEND ==========
async function sendWhatsAppMessage(number, receipt) {
  try {
    // ensure + and country code
    const phone = number.startsWith('+') ? number : `+${number}`;

    const footer = 'Powered by Froy Store'; // <60 chars
    const body = `Hi ${receipt.customer_name || 'Customer'},\n` +
      `Your recent purchase total: ${receipt.total_money.amount} ${receipt.total_money.currency}\n` +
      `Receipt #: ${receipt.receipt_number}\n\nThank you for shopping!`;

    const payload = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        footer: { text: footer },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'rate_good', title: '👍 Good Service' } },
            { type: 'reply', reply: { id: 'rate_bad', title: '👎 Needs Work' } }
          ]
        }
      }
    };

    await axios.post(WHATSAPP_URL, payload, { headers: WHATSAPP_HEADERS });
    console.log(`✅ WhatsApp sent to ${phone}`);
  } catch (err) {
    console.error('❌ WhatsApp error:', err.response?.data || err.message);
  }
}

// ========== CHECK SALES ==========
async function checkSales() {
  console.log('🔄 Checking Loyverse sales...');
  const receipts = await fetchRecentReceipts();
  if (!receipts.length) return;

  const lastData = await fs.readFile(LAST_RECEIPT_FILE, 'utf8').catch(() => '{}');
  const last = JSON.parse(lastData);
  const lastId = last.id;

  for (const r of receipts) {
    if (r.id === lastId) break; // stop when we reach last processed
    console.log(`🧾 New sale: ${r.receipt_number}`);

    // send WhatsApp if phone exists
    if (r.customer_phone_number) {
      await sendWhatsAppMessage(r.customer_phone_number.replace(/\s/g, ''), r);
    }
    await fs.writeFile(LAST_RECEIPT_FILE, JSON.stringify({ id: r.id }));
  }
}

// ========== CRON JOB ==========
cron.schedule('*/2 * * * *', () => { // every 2 minutes
  console.log('⏰ Running scheduled sales check...');
  checkSales();
});

// ========== ROUTES ==========
app.get('/', (req, res) =>
  res.json({
    status: '✅ Running',
    next_check: 'Every 2 minutes',
    note: 'Authenticate via /auth if needed'
  })
);

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
