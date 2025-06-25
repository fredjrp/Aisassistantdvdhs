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
      await replyMessage(from, `Hi ${profileName || 'there'}! 🚀 Welcome to Fred's Inc, Official Meta Partner for WhatsApp. How can we help?`, messageId);
      await sendMainMenu(from);
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
      
      // Handle list selections
      if (userText.includes('benefits')) {
        await sendBenefitsList(from);
      } else if (userText.includes('case_')) {
        await sendMessage(from, `Great choice! Here's how we handle "${userText.replace('case_', '')}": [Detailed flow...]`);
      } else if (userText.includes('demo_')) {
        await sendMessage(from, `Let's simulate "${userText.replace('demo_', '')}"...`);
        await sendDemoFlow(from, userText);
      } else if (userText.includes('price_')) {
        await sendPricingList(from);
      } else {
        const aiReply = await getAIResponse(userText);
        await sendMessage(from, aiReply);
      }
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

        // 📨 Notify the agent
        await sendEmailAlert(agentData.email || ALERT_EMAIL, `New user assigned: ${profileName || from}`);
        await sendMessage(from, `✅ You've been connected to ${agentData.name}. They’ll respond shortly.`);
      } else if (replyId === 'to_bot') {
        await sendMessage(from, 'Welcome back to Fred\'s Inc! Explore Performance Messaging:');
        await sendMainMenu(from);
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

// ================== NEW ONBOARDING FLOW MENUS ================== //
async function sendMainMenu(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '📋 Fred\'s Inc - Official Meta Partner' },
        body: { text: 'Performance Messaging Solutions:' },
        footer: { text: '3.6x avg ROAS | 55% lower costs' },
        action: {
          button: 'Explore',
          sections: [
            {
              title: 'Core Benefits',
              rows: [
                { id: 'benefits', title: '🚀 Why WhatsApp?' },
                { id: 'proof', title: '📊 Case Studies' }
              ]
            },
            {
              title: 'Get Started',
              rows: [
                { id: 'demo', title: '🎯 Try Demo' },
                { id: 'pricing', title: '💳 Pricing' }
              ]
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
    console.error('❌ Main menu error:', err.response?.data || err.message);
  }
}

async function sendBenefitsList(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '📈 Why Fred\'s Inc?' },
        body: { text: 'Performance Messaging with Meta\'s official partner:' },
        footer: { text: 'Data from 40K+ brands' },
        action: {
          button: 'See Benefits',
          sections: [
            {
              title: 'Performance Metrics',
              rows: [
                { id: 'proof_roas', title: '3.6x Higher ROAS' },
                { id: 'proof_aov', title: '85% Higher AOV' },
                { id: 'proof_cpl', title: '80% Lower CPL' }
              ]
            },
            {
              title: 'Technical Edge',
              rows: [
                { id: 'tech_meta', title: 'Meta API Integration' },
                { id: 'tech_scale', title: '175M Daily Users' }
              ]
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
    console.error('❌ Benefits list error:', err.response?.data || err.message);
  }
}

async function sendUseCasesList(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '🎯 Fred\'s Inc Use Cases' },
        body: { text: 'Proven workflows for 40K+ brands:' },
        footer: { text: 'Official Meta Partner' },
        action: {
          button: 'Select',
          sections: [
            {
              title: 'E-Commerce',
              rows: [
                { id: 'case_cart', title: '🛒 Cart Recovery' },
                { id: 'case_upsell', title: '⬆️ Product Upselling' }
              ]
            },
            {
              title: 'Lead Gen',
              rows: [
                { id: 'case_appointment', title: '📅 Appointment Booking' },
                { id: 'case_lead', title: '📝 High-Intent Leads' }
              ]
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
    console.error('❌ Use cases error:', err.response?.data || err.message);
  }
}

async function sendDemoFlow(to, demoType) {
  try {
    let demoData;
    switch(demoType) {
      case 'demo_sales':
        demoData = {
          header: '🛍️ Sales Demo',
          body: 'Simulating a 3.6x ROAS sales campaign...',
          steps: ['1. Meta Ad Click → WhatsApp', '2. Automated Product Quiz', '3. Checkout via WhatsApp Pay']
        };
        break;
      case 'demo_leads':
        demoData = {
          header: '📩 Lead Gen Demo',
          body: 'Simulating 80% lower CPL flow...',
          steps: ['1. Instagram Lead Ad → WhatsApp', '2. Instant Qualification Chat', '3. CRM Integration']
        };
        break;
      default:
        demoData = {
          header: '🔮 Demo',
          body: 'Here\'s how Fred\'s Inc works:',
          steps: ['1. User sees Meta Ad', '2. Clicks to WhatsApp', '3. Converts in chat']
        };
    }

    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: demoData.header },
        body: { text: `${demoData.body}\n\n${demoData.steps.join('\n')}` },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'demo_next', title: 'Next Step' } },
            { type: 'reply', reply: { id: 'to_agent', title: 'Talk to Expert' } }
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
    console.error('❌ Demo flow error:', err.response?.data || err.message);
  }
}

async function sendPricingList(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '💳 Fred\'s Inc Pricing' },
        body: { text: 'Flexible plans for your growth:' },
        footer: { text: 'Official Meta Partner Rates' },
        action: {
          button: 'Options',
          sections: [
            {
              title: 'Starter Plans',
              rows: [
                { id: 'price_starter', title: '🌱 Starter ($99/mo)' },
                { id: 'price_pro', title: '🚀 Pro ($299/mo)' }
              ]
            },
            {
              title: 'Enterprise',
              rows: [
                { id: 'price_enterprise', title: '🏢 Custom Solutions' },
                { id: 'price_contact', title: '📞 Book a Call' }
              ]
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
    console.error('❌ Pricing error:', err.response?.data || err.message);
  }
}

// ✅ AI Handler (Updated for Fred's Inc Onboarding Journey)
async function getAIResponse(userText) {
  try {
    const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: "mistralai/mistral-7b-instruct",
      messages: [
        { 
          role: "system", 
          content: `You're Fred's Inc (Official Meta Partner for WhatsApp), guiding users through a Performance Messaging onboarding journey. \
                    Use this script (adapt responses under 250 chars): \
                    \
                    🚀 HERO'S JOURNEY FLOW: \
                    1. AWARENESS: "WhatsApp drives 3x higher LTV than web! Ready to explore?" -> Show [Benefits List]. \
                    2. INTEREST: "85% brands see higher AOV with us. Want case studies?" -> Show [Use Cases List]. \
                    3. TRIAL: "Let’s simulate a campaign! Pick a goal:" -> Show [Demo List]. \
                    4. SIGNUP: "Get your Meta-verified WhatsApp API now!" -> Show [Pricing List]. \
                    5. SUPPORT: "Need help? Our team is here." -> Show [Support List]. \
                    \
                    KEY PHRASES: \
                    - "Official Meta Partner" \
                    - "3.6x ROAS proven" \
                    - "55% lower costs" \
                    - "175M users message businesses daily" \
                    `
        },
        { role: "user", content: userText }
      ]
    }, {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    return res.data.choices?.[0]?.message?.content || "Let’s continue your Fred's Inc journey. Reply ‘menu’ for options.";
  } catch (err) {
    console.error('❌ AI error:', err.response?.data || err.message);
    return "🚧 Fred's Inc system busy. Try ‘help’ or ‘menu’.";
  }
}

async function sendEmailAlert(from, subjectText) {
  try {
    await transporter.sendMail({
      from: `"Fred's Inc Alerts" <${EMAIL_USER}>`,
      to: ALERT_EMAIL,
      subject: `🚨 Alert: ${subjectText}`,
      text: `User ${from} triggered this: ${subjectText}`,
    });
  } catch (error) {
    console.error('❌ Email error:', error.message);
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
