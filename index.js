require('dotenv').config();
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const fs = require('fs');

const app = express();
app.use(express.json());

// 🌍 ENV
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const ALERT_EMAIL = process.env.ALERT_EMAIL;

// 🔥 Initialize Firebase
const serviceAccount = require('./firebase.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// 📧 Nodemailer setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

// ✅ Root
app.get('/', (req, res) => {
  res.send('✅ WhatsApp Webhook + Firebase + AI + Email running');
});

// ✅ Webhook verify
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token === WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ✅ Webhook listener
app.post('/webhook', async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];
  const status = changes?.value?.statuses?.[0];

  if (status) {
    console.log(`📦 Message Status: ${status.status}, ID: ${status.id}`);
  }

  if (message) {
    const from = message.from;
    const type = message.type;
    const text = message.text?.body?.toLowerCase();
    const messageId = message.id;

    // 🧠 Log to Firebase
    await db.collection('whatsapp_logs').add({
      from,
      type,
      message,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (type === 'text') {
      if (text === 'hello') await replyMessage(from, 'Hello. How are you?', messageId);
      else if (text === 'list') await sendList(from);
      else if (text === 'buttons') await sendReplyButtons(from);
      else if (text === 'help') {
        await sendMessage(from, 'We are here to help. An agent has been notified.');
        await sendEmailAlert(from, 'User requested help');
      } else {
        // 🧠 AI Fallback
        const aiReply = await getAIResponse(text);
        await sendMessage(from, aiReply);
      }
    }

    if (type === 'interactive') {
      const interactive = message.interactive;
      if (interactive.type === 'list_reply') {
        await sendMessage(from, `✅ You selected: ${interactive.list_reply.title}`);
      } else if (interactive.type === 'button_reply') {
        await sendMessage(from, `✅ You clicked: ${interactive.button_reply.title}`);
      }
    }

    console.log("📩 Message Received:", JSON.stringify(message, null, 2));
  }

  res.sendStatus(200);
});

// ✅ Message functions (NO CHANGE TO YOUR LIST/BUTTON DESIGN)

async function sendMessage(to, body) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('❌ Error sending message:', error.response?.data || error.message);
  }
}

async function replyMessage(to, body, messageId) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      context: { message_id: messageId },
      type: 'text',
      text: { body }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('❌ Error sending reply:', error.response?.data || error.message);
  }
}

async function sendList(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '📋 Menu' },
        body: { text: 'Choose an option from the list:' },
        footer: { text: 'Powered by Fred' },
        action: {
          button: 'Open Menu',
          sections: [
            {
              title: 'Main Options',
              rows: [
                { id: 'opt1', title: 'First Option', description: 'This is the first option' },
                { id: 'opt2', title: 'Second Option', description: 'This is the second option' }
              ]
            },
            {
              title: 'Other',
              rows: [{ id: 'help', title: 'Help & Support' }]
            }
          ]
        }
      }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('❌ Error sending list:', error.response?.data || error.message);
  }
}

async function sendReplyButtons(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: '⚡ Quick Action' },
        body: { text: 'Click a button below:' },
        footer: { text: 'Fred\'s Assistant' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'btn1', title: 'Option A' } },
            { type: 'reply', reply: { id: 'btn2', title: 'Option B' } }
          ]
        }
      }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('❌ Error sending buttons:', error.response?.data || error.message);
  }
}

// ✅ Email alert
async function sendEmailAlert(from, subjectText) {
  try {
    await transporter.sendMail({
      from: `"FredBot Alerts" <${EMAIL_USER}>`,
      to: ALERT_EMAIL,
      subject: `🚨 Alert: ${subjectText}`,
      text: `User ${from} triggered an alert.`,
    });
    console.log('📧 Email sent to admin');
  } catch (error) {
    console.error('❌ Email error:', error.message);
  }
}

// ✅ OpenRouter AI
async function getAIResponse(userText) {
  try {
    const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: "mistral/mistral-7b-instruct",
      messages: [
        { role: "system", content: "You are a helpful WhatsApp assistant." },
        { role: "user", content: userText }
      ]
    }, {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return res.data.choices?.[0]?.message?.content || "🤖 Sorry, I couldn't respond.";
  } catch (error) {
    console.error('❌ AI Error:', error.response?.data || error.message);
    return "🤖 Sorry, I had trouble responding.";
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
