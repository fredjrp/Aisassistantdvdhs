require('dotenv').config();
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const app = express();
const usersRef = require('./firebase'); // Your existing Firebase setup

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

// Trigger words
const WELCOME_TRIGGERS = ["hello", "hi", "hey", "start"];
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const WELCOME_INTERACTIVE_MESSAGE = async (to) => {
  await axios({
    url: `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    method: 'post',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    data: {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: {
          type: 'text',
          text: 'Message Header'
        },
        body: {
          text: 'This is an interactive list message'
        },
        footer: {
          text: 'This is the message footer'
        },
        action: {
          button: 'Tap for the options',
          sections: [
            {
              title: 'First Section',
              rows: [
                {
                  id: 'first_option',
                  title: 'First option',
                  description: 'This is the description of the first option'
                },
                {
                  id: 'second_option',
                  title: 'Second option',
                  description: 'This is the description of the second option'
                }
              ]
            },
            {
              title: 'Second Section',
              rows: [
                {
                  id: 'third_option',
                  title: 'Third option'
                }
              ]
            }
          ]
        }
      }
    }
  });
};

// Initialize templates collection on startup
async function initializeTemplates() {
  try {
    const templatesRef = usersRef.firestore.collection('whatsapp_templates');
    const welcomeTemplate = await templatesRef.doc('welcome_message').get();
    
    if (!welcomeTemplate.exists) {
      await templatesRef.doc('welcome_message').set({
        triggers: WELCOME_TRIGGERS,
        content: WELCOME_INTERACTIVE_MESSAGE
      });
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
    res.status(201).send(`Template created`);
  } catch (error) {
    console.error('Error creating template:', error);
    res.status(500).send('Error creating template');
  }
});

// Support ticket functions
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

// Updated webhook handler with interactive message support
app.post('/webhook', async (req, res) => {
  const { entry } = req.body;

  if (!entry || !entry[0]?.changes?.[0]?.value) {
    return res.status(400).send('Invalid Request');
  }

  const changes = entry[0].changes[0].value;
  const statuses = changes.statuses ? changes.statuses[0] : null;
  const messages = changes.messages ? changes.messages[0] : null;

  // Handle message status updates
  if (statuses) {
    console.log(`
      MESSAGE STATUS UPDATE:
      ID: ${statuses.id},
      STATUS: ${statuses.status}
    `);
    return res.status(200).send('OK');
  }

  // Handle incoming messages
  if (messages) {
    const from = messages.from;
    const messageId = messages.id;

    try {
      // Handle interactive messages (list replies or button replies)
      if (messages.type === 'interactive') {
        const interactive = messages.interactive;
        
        if (interactive.type === 'list_reply') {
          const selectedId = interactive.list_reply.id;
          const selectedTitle = interactive.list_reply.title;
          
          console.log(`User selected list option: ${selectedId} - ${selectedTitle}`);
          
          // Handle the selected option
          await handleListReply(from, messageId, selectedId, selectedTitle);
          return res.status(200).send('OK');
        }
        
        if (interactive.type === 'button_reply') {
          const selectedId = interactive.button_reply.id;
          const selectedTitle = interactive.button_reply.title;
          
          console.log(`User clicked button: ${selectedId} - ${selectedTitle}`);
          
          // Handle the button click
          await handleButtonReply(from, messageId, selectedId, selectedTitle);
          return res.status(200).send('OK');
        }
      }

      // Handle text messages
      if (messages.type === 'text') {
        const userMessage = messages.text.body;
        console.log(`📩 Message from ${from}: ${userMessage}`);

        // Check for ticket status requests
        if (userMessage.toLowerCase().startsWith('track')) {
          const trackingId = userMessage.split(' ')[1]?.trim();
          if (!trackingId) {
            await sendTextMessage(from, "⚠️ Please include a tracking ID", messageId);
            return res.status(200).send('OK');
          }

          const ticket = await checkTicketStatus(from, trackingId);
          if (ticket.error) {
            await sendTextMessage(from, ticket.error, messageId);
          } else {
            await sendTextMessage(from, 
              `📋 Ticket #${ticket.id}\nStatus: ${ticket.status}\nIssue: ${ticket.issue}`,
              messageId
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
        await sendTextMessage(from, aiResponse, messageId);
      }
    } catch (error) {
      console.error('Error handling message:', error);
      await sendTextMessage(from, "Oops! Something went wrong. Please try again.", messageId);
    }
  }

  res.status(200).send('OK');
});

// Handle list reply selections
async function handleListReply(from, messageId, selectedId, selectedTitle) {
  switch (selectedId) {
    case 'first_option':
      await sendTextMessage(
        from, 
        "You selected the first option. How can we assist you further?",
        messageId
      );
      break;
    case 'second_option':
      await sendTextMessage(
        from,
        "You selected the second option. How can we assist you further?",
        messageId
      );
      break;
    case 'third_option':
      await sendTextMessage(
        from,
        "You selected the third option. How can we assist you further?",
        messageId
      );
      break;
    default:
      await sendTextMessage(
        from,
        `You selected: ${selectedTitle}. How can we assist you further?`,
        messageId
      );
  }
}

// Handle button reply clicks
async function handleButtonReply(from, messageId, selectedId, selectedTitle) {
  await sendTextMessage(
    from,
    `You clicked: ${selectedTitle}. How can we assist you further?`,
    messageId
  );
}

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
async function sendTextMessage(to, text, contextMessageId = null) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text }
  };

  if (contextMessageId) {
    payload.context = { message_id: contextMessageId };
  }

  await axios.post(
    `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
  console.log("💬 Sent text to", to);
}

async function sendInteractiveMessage(to, templateContent) {
  try {
    const payload = JSON.parse(JSON.stringify(templateContent));
    payload.to = to;
    
    if (!payload.interactive) {
      throw new Error("Invalid template format: missing interactive property");
    }

    const response = await axios.post(
      `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log("📋 Sent interactive message to", to);
    return response.data;
  } catch (error) {
    console.error("❌ Failed to send interactive message:", error.response?.data || error.message);
    throw error;
  }
}

// Initialize server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initializeTemplates();
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("📞 PHONE ID:", process.env.WHATSAPP_PHONE_NUMBER_ID);
  console.log("🔐 TOKEN:", WHATSAPP_ACCESS_TOKEN?.slice(0, 6) + '...');
});
