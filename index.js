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

// 🔥 Firebase Init
const rawConfig = JSON.parse(process.env.FIREBASE_CONFIG);
rawConfig.private_key = rawConfig.private_key.replace(/\\n/g, '\n');
admin.initializeApp({ credential: admin.credential.cert(rawConfig) });
const db = admin.firestore();

// 📧 Email
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

// ✅ GET Root
app.get('/', (req, res) => res.send('✅ WhatsApp Bot running'));

// ✅ Webhook Verification
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode && token === WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ✅ Webhook Receiver
app.post('/webhook', async (req, res) => {
  const changes = req.body.entry?.[0]?.changes?.[0];
  const message = changes?.value?.messages?.[0];
  const profileName = message?.profile?.name;
  const from = message?.from;

  if (!message || !from) return res.sendStatus(200);

  const type = message.type;
  const messageId = message.id;
  let lastMessageText = null;

  // Extract message content properly
  if (type === 'text') {
    lastMessageText = message.text?.body;
  } else if (type === 'interactive') {
    const interactive = message.interactive;
    if (interactive?.type === 'button_reply') {
      lastMessageText = interactive.button_reply?.title || interactive.button_reply?.id;
    } else if (interactive?.type === 'list_reply') {
      lastMessageText = interactive.list_reply?.title || interactive.list_reply?.id;
    }
  }

  // 📝 Prepare data for Firestore
  const updateData = {
    lastActive: Date.now(),
  };
  if (lastMessageText !== undefined) {
    updateData.lastMessage = lastMessageText.toLowerCase();
  }
  if (profileName !== undefined) {
    updateData.profileName = profileName;
  }

  await db.collection('users').doc(from).set(updateData, { merge: true });

  // 📦 Log message
  await db.collection('whatsapp_logs').add({
    from,
    type,
    message,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });

  // 🤖 Handle message logic
  if (type === 'text') {
    const text = lastMessageText.toLowerCase();
    if (text === 'hi') {
      await replyMessage(from, `Hi ${profileName || 'there'} 😊, welcome!`, messageId);
      await sendReplyButtons(from);
    } else if (text === 'help') {
      await sendMessage(from, 'An agent will contact you shortly.');
      await sendEmailAlert(from, 'User requested help');
    } else {
      const aiReply = await getAIResponse(text);
      await sendMessage(from, aiReply);
    }
  }

  if (type === 'interactive') {
    const interactive = message.interactive;
    if (interactive.type === 'list_reply') {
      const userText = interactive.list_reply?.title || interactive.list_reply?.id;
      const aiReply = await getAIResponse(userText);
      await sendMessage(from, aiReply);
    } else if (interactive.type === 'button_reply') {
      const replyId = interactive.button_reply.id;
if (replyId === 'to_agent') {
  await sendMessage(from, 'Connecting you to a human agent. Please wait...');

  // 🔍 Get the least busy or first available agent
  const agentSnapshot = await db.collection('agents')
    .where('active', '==', true)
    .orderBy('assignedCount')
    .limit(1)
    .get();

  if (agentSnapshot.empty) {
    await sendMessage(from, 'All agents are currently busy. Please wait a moment.');
    return;
  }

  const agentDoc = agentSnapshot.docs[0];
  const agentId = agentDoc.id;
  const agentData = agentDoc.data();

  // 🤝 Assign user to this agent
  await db.collection('users').doc(from).set({
    assignedAgent: agentId,
    agentName: agentData.name,
    status: 'awaiting_response',
    assignedAt: Date.now()
  }, { merge: true });

  // Update agent's assigned count
  await db.collection('agents').doc(agentId).update({
    assignedCount: admin.firestore.FieldValue.increment(1)
  });

  // 📨 Notify the agent (optional email or dashboard)
  await sendEmailAlert(agentData.email || ALERT_EMAIL, `New user assigned: ${profileName || from}`);

  await sendMessage(from, `✅ You've been connected to ${agentData.name}. They’ll respond shortly.`);
}

      } else if (replyId === 'to_bot') {
        await sendMessage(from, 'Hi! Am Linda How May I be of Help Today?');
        await sendList(from);
      }
    }
  }

  res.sendStatus(200);
});

// ✅ Follow-up every 1 min for inactive users
setInterval(async () => {
  const snapshot = await db.collection('users').get();
  const now = Date.now();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (now - data.lastActive > 5 * 60 * 1000 && !data.closed) {
      const from = doc.id;
      await sendMessage(from, `Hey ${data.profileName || ''}, we noticed you haven't replied. Let us know if you'd like to continue or restart later.`);
      await db.collection('users').doc(from).update({ closed: true });
    }
  }
}, 60 * 1000);

// ✅ Messaging Utils
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
    console.error('❌ Send error:', err.response?.data || err.message);
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
    console.error('❌ Reply error:', err.response?.data || err.message);
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
        header: { type: 'text', text: '📋 What do you need?' },
        body: { text: 'Select a service below:' },
        footer: { text: 'FredBot' },
        action: {
          button: 'Show Options',
          sections: [
            {
              title: 'Get Support',
              rows: [
                { id: 'support', title: 'Talk to Support' },
                { id: 'info', title: 'More Info' }
              ]
            },
            {
              title: 'Learn',
              rows: [{ id: 'learn', title: 'Product Tutorials' }]
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
  } catch (err) {
    console.error('❌ List error:', err.response?.data || err.message);
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
        header: { type: 'text', text: 'Hi there!' },
        body: { text: 'Would you like to continue with the Bot or talk to an Agent?' },
        footer: { text: 'Fred Assistant' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'to_bot', title: 'Continue with Bot' } },
            { type: 'reply', reply: { id: 'to_agent', title: 'Talk to Agent' } }
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
    console.error('❌ Button error:', err.response?.data || err.message);
  }
}

async function sendEmailAlert(from, subjectText) {
  try {
    await transporter.sendMail({
      from: `"FredBot Alerts" <${EMAIL_USER}>`,
      to: ALERT_EMAIL,
      subject: `🚨 Alert: ${subjectText}`,
      text: `User ${from} triggered this: ${subjectText}`,
    });
  } catch (error) {
    console.error('❌ Email error:', error.message);
  }
}

// ✅ AI Handler
async function getAIResponse(userText) {
  try {
    const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: "mistralai/mistral-7b-instruct",
      messages: [
        { role: "system", content: "You're a helpful, friendly WhatsApp assistant. Keep replies under 250 characters." },
        { role: "user", content: userText }
      ]
    }, {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    return res.data.choices?.[0]?.message?.content || "🤖 Hmm, I didn't catch that.";
  } catch (err) {
    console.error('❌ AI error:', err.response?.data || err.message);
    return "🤖 Sorry, something went wrong.";
  }
}

// ✅ Add this endpoint to allow agents to send manual replies
app.post('/send', async (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'Missing recipient or message' });
  }

  try {
    await sendMessage(to, `👨‍💼 ${message}`);
    
    // Also log it into whatsapp_logs for the dashboard to display
    await db.collection('whatsapp_logs').add({
      from: to,
      type: 'agent_reply',
      message: { text: { body: message } },
      sentByAgent: true,
      agent: 'DashboardAgent',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error in /send:', error.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ✅ Create default agent if not exists
(async () => {
  const agentId = 'fred-jr';
  const agentRef = db.collection('agents').doc(agentId);
  const agentDoc = await agentRef.get();

  if (!agentDoc.exists) {
    await agentRef.set({
      name: 'Fred Jr',
      email: 'Juniorokovagng@gmail.com',
      active: true,
      assignedCount: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('✅ Default agent "Fred Jr" created.');
  } else {
    console.log('✅ Default agent "Fred Jr" already exists.');
  }
})();



// ✅ Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
