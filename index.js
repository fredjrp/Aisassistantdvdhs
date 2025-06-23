require('dotenv').config();
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const admin = require('firebase-admin');

// Initialize Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = getFirestore();

const app = express();
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "your_custom_token";

app.use(express.json());

// Email transporter setup
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Routes
app.get('/', (req, res) => {
  res.send('WhatsApp Business API with Firebase Templates');
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const challenge = req.query['hub.challenge'];
  const token = req.query['hub.verify_token'];

  if (mode && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    console.warn('❌ Webhook verification failed');
    res.sendStatus(403);
  }
});

// Template endpoints
app.get('/templates', async (req, res) => {
  try {
    const templates = [];
    const snapshot = await db.collection('whatsapp_templates').get();
    snapshot.forEach(doc => {
      templates.push({ id: doc.id, ...doc.data() });
    });
    res.json(templates);
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).send('Error fetching templates');
  }
});

app.get('/send-template/:templateName/:phone', async (req, res) => {
  try {
    const { templateName, phone } = req.params;
    const docRef = db.collection('whatsapp_templates').doc(templateName);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).send('Template not found');
    }

    const template = docSnap.data();
    await sendInteractiveMessage(phone, template.content);
    res.send(`Template "${templateName}" sent to ${phone}`);
  } catch (error) {
    console.error('Error sending template:', error);
    res.status(500).send('Error sending template');
  }
});

// Support ticket functions
async function createSupportTicket(from, userMessage) {
  const trackingId = 'TKT-' + Date.now().toString(36).toUpperCase();
  
  await db.collection('support_tickets').doc(trackingId).set({
    id: trackingId,
    issue: userMessage,
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    resolved: false,
    from,
    lastUpdated: admin.firestore.FieldValue.serverTimestamp()
  });

  await sendSupportEmail(from, userMessage, trackingId);
  return trackingId;
}

async function sendSupportEmail(from, userMessage, trackingId) {
  try {
    const info = await transporter.sendMail({
      from: `"Support Bot" <${process.env.EMAIL_USER}>`,
      to: process.env.SUPPORT_EMAIL,
      subject: `New Support Ticket: ${trackingId}`,
      text: `New ticket from ${from}:\n\n${userMessage}\n\nTracking ID: ${trackingId}`
    });
    console.log("📧 Support email sent:", info.messageId);
  } catch (error) {
    console.error("❌ Failed to send support email:", error);
  }
}

// Webhook handler
app.post('/webhook', async (req, res) => {
  const { entry } = req.body;

  if (!entry || !entry[0]?.changes?.[0]?.value?.messages?.[0]) {
    return res.status(400).send('Invalid Request');
  }

  const message = entry[0].changes[0].value.messages[0];
  const from = message.from;
  const userMessage = message.type === 'text' ? message.text.body : '';

  console.log(`📩 Message from ${from}: ${userMessage}`);

  try {
    // Check for ticket status requests
    if (userMessage.toLowerCase().startsWith('track')) {
      const trackingId = userMessage.split(' ')[1]?.trim();
      if (!trackingId) {
        await sendTextMessage(from, "⚠️ Please include a tracking ID");
        return res.status(200).send('OK');
      }

      const ticket = await checkTicketStatus(trackingId);
      if (ticket.error) {
        await sendTextMessage(from, ticket.error);
      } else {
        await sendTextMessage(from, 
          `📋 Ticket #${ticket.id}\nStatus: ${ticket.status}\nIssue: ${ticket.issue}`
        );
      }
      return res.status(200).send('OK');
    }

    // Check for matching template
    const template = await findMatchingTemplate(userMessage);
    if (template) {
      await sendInteractiveMessage(from, template.content);
      return res.status(200).send('OK');
    }

    // Default AI response
    const aiResponse = await generateAIResponse(userMessage);
    await sendTextMessage(from, aiResponse);

  } catch (error) {
    console.error('Error handling message:', error);
    await sendTextMessage(from, "Oops! Something went wrong. Please try again.");
  }

  res.status(200).send('OK');
});

// Helper functions
async function findMatchingTemplate(message) {
  const snapshot = await db.collection('whatsapp_templates').get();
  for (const doc of snapshot.docs) {
    const template = doc.data();
    if (template.triggers?.some(trigger => 
      message.toLowerCase().includes(trigger.toLowerCase())
    )) {
      return { id: doc.id, ...template };
    }
  }
  return null;
}

async function checkTicketStatus(trackingId) {
  try {
    const docRef = db.collection('support_tickets').doc(trackingId);
    const docSnap = await docRef.get();
    return docSnap.exists ? docSnap.data() : { error: `Ticket ${trackingId} not found` };
  } catch (error) {
    console.error('Error checking ticket:', error);
    return { error: "Failed to check ticket status" };
  }
}

async function generateAIResponse(message) {
  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: "mistralai/mistral-7b-instruct",
      messages: [{
        role: "system",
        content: "You are a helpful WhatsApp assistant. Keep responses concise."
      }, {
        role: "user",
        content: message
      }],
      max_tokens: 1000,
      temperature: 0.7
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );
  return response.data.choices[0].message.content;
}

// Messaging functions
async function sendTextMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
  console.log("💬 Sent text to", to);
}

async function sendInteractiveMessage(to, interactiveContent) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: interactiveContent
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
  console.log("📋 Sent interactive message to", to);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("📞 PHONE ID:", process.env.WHATSAPP_PHONE_NUMBER_ID);
  console.log("🔐 TOKEN:", WHATSAPP_ACCESS_TOKEN?.slice(0, 6) + '...');
});
