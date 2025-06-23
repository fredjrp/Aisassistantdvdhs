require('dotenv').config();
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const app = express();
const usersRef = require('./firebase'); // Your existing Firebase setup

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "your_custom_token";

app.use(express.json());

// Email transporter setup (unchanged)
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Default welcome template
const WELCOME_TEMPLATE = {
  name: "welcome_message",
  description: "Default welcome message for new clients",
  triggers: ["hello", "hi", "hey", "start"],
  content: {
    type: "interactive",
    interactive: {
      type: "list",
      header: {
        type: "text",
        text: "Welcome to Fred's Services! 👋"
      },
      body: {
        text: "How can we help you today?"
      },
      footer: {
        text: "Select an option below to get started"
      },
      action: {
        button: "Menu Options",
        sections: [
          {
            title: "Main Menu",
            rows: [
              {
                id: "support_option",
                title: "Get Support",
                description: "Contact our support team"
              },
              {
                id: "products_option",
                title: "View Products",
                description: "See what we offer"
              },
              {
                id: "account_option",
                title: "Account Help",
                description: "Manage your account"
              }
            ]
          }
        ]
      }
    }
  }
};

// Initialize templates collection on startup
async function initializeTemplates() {
  try {
    const templatesRef = usersRef.firestore.collection('whatsapp_templates');
    const welcomeTemplate = await templatesRef.doc('welcome_message').get();
    
    if (!welcomeTemplate.exists) {
      await templatesRef.doc('welcome_message').set(WELCOME_TEMPLATE);
      console.log('✅ Created default welcome template');
    }
  } catch (error) {
    console.error('❌ Error initializing templates:', error);
  }
}

// Routes
app.get('/', (req, res) => {
  res.send('WhatsApp Business API with Auto Templates');
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

// Template management endpoints
app.get('/templates', async (req, res) => {
  try {
    const templates = [];
    const snapshot = await usersRef.firestore.collection('whatsapp_templates').get();
    snapshot.forEach(doc => {
      templates.push({ id: doc.id, ...doc.data() });
    });
    res.json(templates);
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).send('Error fetching templates');
  }
});

app.post('/templates', async (req, res) => {
  try {
    const newTemplate = req.body;
    await usersRef.firestore.collection('whatsapp_templates').doc(newTemplate.name).set(newTemplate);
    res.status(201).send(`Template ${newTemplate.name} created`);
  } catch (error) {
    console.error('Error creating template:', error);
    res.status(500).send('Error creating template');
  }
});

// Support ticket functions (unchanged)
async function createSupportTicket(from, userMessage) {
  const trackingId = 'TKT-' + Date.now().toString(36).toUpperCase();
  
  await usersRef.doc(from)
    .collection('tickets')
    .doc(trackingId)
    .set({
      id: trackingId,
      issue: userMessage,
      status: 'pending',
      createdAt: new Date(),
      resolved: false,
      from,
      lastUpdated: new Date()
    });

  await sendSupportEmail(from, userMessage, trackingId);
  return trackingId;
}

async function sendSupportEmail(from, userMessage, trackingId) {
  try {
    const info = await transporter.sendMail({
      from: `"Fred AI Support" <${process.env.EMAIL_USER}>`,
      to: process.env.SUPPORT_EMAIL || 'support@yourdomain.com',
      subject: `New Support Ticket: ${trackingId}`,
      text: `New support ticket created:\n\nFrom: ${from}\nIssue: ${userMessage}\nTracking ID: ${trackingId}`,
      html: `
        <h1>New Support Ticket: ${trackingId}</h1>
        <p><strong>From:</strong> ${from}</p>
        <p><strong>Issue:</strong> ${userMessage}</p>
        <p><strong>Tracking ID:</strong> ${trackingId}</p>
      `
    });
    console.log("📧 Support email sent:", info.messageId);
  } catch (error) {
    console.error("❌ Failed to send support email:", error);
  }
}

// Webhook handler with template matching
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

      const ticket = await checkTicketStatus(from, trackingId);
      if (ticket.error) {
        await sendTextMessage(from, ticket.error);
      } else {
        await sendTextMessage(from, 
          `📋 Ticket #${ticket.id}\nStatus: ${ticket.status}\nIssue: ${ticket.issue}`
        );
      }
      return res.status(200).send('OK');
    }

    // Check if first-time user
    const userDoc = await usersRef.doc(from).get();
    const firstTime = !userDoc.exists || !userDoc.data().greeted;

    // Send welcome template for first-time users
    if (firstTime) {
      const welcomeTemplate = await usersRef.firestore.collection('whatsapp_templates')
        .doc('welcome_message').get();
      
      if (welcomeTemplate.exists) {
        await usersRef.doc(from).set({ greeted: true }, { merge: true });
        await sendInteractiveMessage(from, welcomeTemplate.data().content);
        return res.status(200).send('OK');
      }
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
  const snapshot = await usersRef.firestore.collection('whatsapp_templates').get();
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

async function checkTicketStatus(from, trackingId) {
  try {
    const ticketDoc = await usersRef.doc(from)
      .collection('tickets')
      .doc(trackingId)
      .get();

    return ticketDoc.exists ? ticketDoc.data() : { error: `Ticket ${trackingId} not found` };
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

// Initialize server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initializeTemplates(); // Create default templates on startup
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("📞 PHONE ID:", process.env.WHATSAPP_PHONE_NUMBER_ID);
  console.log("🔐 TOKEN:", WHATSAPP_ACCESS_TOKEN?.slice(0, 6) + '...');
});
