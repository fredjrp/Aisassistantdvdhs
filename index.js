require('dotenv').config();
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

// 🌍 ENV
const {
  WHATSAPP_ACCESS_TOKEN,
  WEBHOOK_VERIFY_TOKEN,
  PHONE_NUMBER_ID,
  OPENROUTER_API_KEY,
  EMAIL_USER,
  EMAIL_PASS,
  ALERT_EMAIL
} = process.env;

// 🔥 Firebase Setup
const rawConfig = JSON.parse(process.env.FIREBASE_CONFIG);
rawConfig.private_key = rawConfig.private_key.replace(/\\n/g, '\n');
admin.initializeApp({ credential: admin.credential.cert(rawConfig) });
const db = admin.firestore();

// 📧 Nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

// ✅ Webhook Verification
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode && token === WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ✅ Webhook Listener
app.post('/webhook', async (req, res) => {
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const status = req.body.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];

  if (status) console.log(`📦 Status: ${status.status} | ID: ${status.id}`);
  if (!message) return res.sendStatus(200);

  const { from, type, id: messageId } = message;
  const text = message.text?.body?.toLowerCase();

  await db.collection('whatsapp_logs').add({
    from, type, message,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  if (type === 'text') {
    if (text === 'hello') await replyMessage(from, 'Hello there 👋', messageId);
    else if (text === 'list') await sendDynamicList(from);
    else if (text === 'buttons') await sendReplyButtons(from);
    else if (text === 'help') {
      await sendMessage(from, 'We are here to help. An agent has been notified.');
      await sendEmailAlert(from, 'User requested help');
    } else {
      const aiReply = await getAIResponse(text);
      if (aiReply.includes('[LIST]')) {
        const parsed = parseAiList(aiReply);
        await sendDynamicList(from, parsed);
      } else {
        await sendMessage(from, aiReply);
      }
    }
  }

  if (type === 'interactive') {
    const i = message.interactive;
    if (i.type === 'list_reply') await sendMessage(from, `✅ You selected: ${i.list_reply.title}`);
    if (i.type === 'button_reply') await sendMessage(from, `✅ You clicked: ${i.button_reply.title}`);
  }

  console.log("📩 Message:", JSON.stringify(message, null, 2));
  res.sendStatus(200);
});

// ✅ Message Helpers
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
  } catch (err) {
    console.error('❌ sendMessage:', err.response?.data || err.message);
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
  } catch (err) {
    console.error('❌ replyMessage:', err.response?.data || err.message);
  }
}

// ✅ Dynamic List (Your format)
async function sendDynamicList(to, aiData = {}) {
  const variables = {
    to,
    headerText: aiData.headerText || '📋 Menu',
    bodyText: aiData.bodyText || 'Choose from the list:',
    footerText: aiData.footerText || 'Fred Assistant',
    buttonText: aiData.buttonText || 'Open Menu',
    section1Title: aiData.section1Title || 'Main',
    section2Title: aiData.section2Title || 'Support',
    section1Rows: JSON.stringify(aiData.section1Rows || [
      { id: "opt1", title: "Option A", description: "Details about A" },
      { id: "opt2", title: "Option B", description: "Details about B" },
    ]),
    section2Rows: JSON.stringify(aiData.section2Rows || [
      { id: "help", title: "Help & Support" }
    ])
  };

  const template = `
  {
    "messaging_product": "whatsapp",
    "to": "${variables.to}",
    "type": "interactive",
    "interactive": {
      "type": "list",
      "header": { "type": "text", "text": "${variables.headerText}" },
      "body": { "text": "${variables.bodyText}" },
      "footer": { "text": "${variables.footerText}" },
      "action": {
        "button": "${variables.buttonText}",
        "sections": [
          {
            "title": "${variables.section1Title}",
            "rows": ${variables.section1Rows}
          },
          {
            "title": "${variables.section2Title}",
            "rows": ${variables.section2Rows}
          }
        ]
      }
    }
  }`;

  try {
    const parsedBody = JSON.parse(template);
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, parsedBody, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error("❌ Dynamic list error:", error.response?.data || error.message);
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
        footer: { text: 'FredBot' },
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
  } catch (err) {
    console.error('❌ sendReplyButtons:', err.response?.data || err.message);
  }
}

// ✅ Email Alerts
async function sendEmailAlert(from, subjectText) {
  try {
    await transporter.sendMail({
      from: `"FredBot Alerts" <${EMAIL_USER}>`,
      to: ALERT_EMAIL,
      subject: `🚨 Alert: ${subjectText}`,
      text: `User ${from} triggered an alert.`,
    });
  } catch (err) {
    console.error('❌ Email error:', err.message);
  }
}

// ✅ AI Handler
async function getAIResponse(userText) {
  try {
    const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: "mistralai/mistral-7b-instruct",
      messages: [
        { role: "system", content: "You are a helpful WhatsApp assistant. If asked for a menu, respond with [LIST] format." },
        { role: "user", content: userText }
      ]
    }, {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    return res.data.choices?.[0]?.message?.content || "🤖 Sorry, I couldn't respond.";
  } catch (err) {
    console.error("❌ AI Error:", err.response?.data || err.message);
    return "🤖 Sorry, I had trouble responding.";
  }
}

// ✅ AI → JSON Parser
function parseAiList(text) {
  const result = {};
  try {
    const lines = text.split('\n').filter(line => line.trim() && !line.startsWith('[LIST]'));
    for (const line of lines) {
      if (line.startsWith('-')) {
        const match = line.match(/id:\s*(\w+),\s*title:\s*([^,]+),?\s*description?:?\s*(.*)?/);
        if (match) {
          const row = { id: match[1], title: match[2], description: match[3] || "" };
          const lastArrayKey = Object.keys(result).filter(k => Array.isArray(result[k])).pop();
          if (lastArrayKey) result[lastArrayKey].push(row);
        }
      } else if (line.includes(':')) {
        const [key, ...rest] = line.split(':');
        const value = rest.join(':').trim();
        if (key.includes("Rows")) result[key.trim()] = [];
        else result[key.trim()] = value;
      }
    }
  } catch (err) {
    console.error('⚠️ AI parse error:', err.message);
  }
  return result;
}

// ✅ Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp bot running on port ${PORT}`);
});
