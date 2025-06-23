require('dotenv').config();
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const app = express();
const usersRef = require('./firebase');

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WEBHOOK_VERIFY_TOKEN = "your_custom_token";

app.use(express.json());

// Email transporter setup
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

app.get('/', (req, res) => {
  res.send('WhatsApp Business API with Node.js and Webhooks');
});

// Webhook verification
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

// Incoming message handler
app.post('/webhook', async (req, res) => {
  const { entry } = req.body;

  if (!entry || entry.length === 0) {
    return res.status(400).send('Invalid Request');
  }

  const changes = entry[0].changes;

  if (!changes || changes.length === 0) {
    return res.status(400).send('Invalid Request');
  }

  const statuses = changes[0].value.statuses ? changes[0].value.statuses[0] : null;
  const messages = changes[0].value.messages ? changes[0].value.messages[0] : null;

  if (statuses) {
    console.log(`MESSAGE STATUS UPDATE: ID: ${statuses.id}, STATUS: ${statuses.status}`);
  }

  if (messages) {
    const from = messages.from;
    const userMessage = messages.type === 'text' ? messages.text.body : 'Non-text message';

    console.log(`📩 Incoming message from ${from}:`, userMessage);

    try {
      // Check for ticket status request
      if (userMessage.toLowerCase().startsWith('track')) {
        const trackingId = userMessage.split(" ")[1]?.trim().toUpperCase();
        if (!trackingId) {
          await sendMessage(from, "⚠️ Please send a tracking number like: `track TKT-LSO6FHH6`");
          return res.status(200).send('Webhook processed');
        }

        const ticket = await checkTicketStatus(from, trackingId);
        if (ticket.error) {
          await sendMessage(from, `❌ ${ticket.error}`);
        } else {
          await sendMessage(from, 
            `📋 Ticket #${ticket.id}\n` +
            `Status: ${ticket.status}\n` +
            `Issue: ${ticket.issue}\n` +
            `Created: ${ticket.createdAt.toDate().toLocaleString()}`
          );
        }
        return res.status(200).send('Webhook processed');
      }

      // Handle reset command
      if (userMessage.toLowerCase().trim() === "reset") {
        await usersRef.doc(from).delete();
        await sendMessage(from, "✅ Session reset! Fresh start activated. How can I help?");
        return res.status(200).send('Webhook processed');
      }

      // Handle interactive messages
      if (messages.type === 'interactive') {
        if (messages.interactive.type === 'list_reply') {
          await sendMessage(from, `You selected: ${messages.interactive.list_reply.title}`);
        }
        if (messages.interactive.type === 'button_reply') {
          await sendMessage(from, `You clicked: ${messages.interactive.button_reply.title}`);
        }
        return res.status(200).send('Webhook processed');
      }

      // Get conversation history
      const userDoc = await usersRef.doc(from).get();
      const firstTime = !userDoc.exists || !userDoc.data().greeted;
      
      if (firstTime) {
        await usersRef.doc(from).set({ greeted: true }, { merge: true });
      }

      let previousLogs = [];
      const logsSnapshot = await usersRef.doc(from).collection("logs").orderBy("timestamp", "desc").limit(5).get();
      logsSnapshot.forEach(doc => previousLogs.unshift(doc.data()));

      const history = previousLogs.map(log => ({
        role: log.from,
        content: log.message
      }));

      // Generate AI response
      const aiResponse = await generateAIResponse(userMessage, history, firstTime);
      let aiMessage = aiResponse.trim();

      // Handle list responses
      if (aiMessage.includes("[LIST_VARS]")) {
        try {
          const listData = parseListResponse(aiMessage, from);
          await sendInteractiveList(from, listData);
          
          // Save to Firestore
          await saveConversation(from, userMessage, "Sent interactive options list");
          return res.status(200).send('Webhook processed');
        } catch (err) {
          console.error("❌ Failed to process list:", err);
          await sendMessage(from, "Sorry, I couldn't prepare the options. Please try again.");
          return res.status(200).send('Webhook processed');
        }
      }

      // Handle support ticket creation
      if (aiMessage.includes("Let me check with Fred!")) {
        const trackingId = await createSupportTicket(from, userMessage);
        aiMessage += `\n\nI've created a support ticket (ID: ${trackingId}). Track with: track ${trackingId}`;
      }

      // Save conversation and send response
      await saveConversation(from, userMessage, aiMessage);
      
      if (aiMessage.startsWith("[IMAGE]")) {
        await sendImage(from, aiMessage.replace("[IMAGE]", "").trim());
      } else if (aiMessage.startsWith("[TEMPLATE]")) {
        await sendTemplate(from, aiMessage.replace("[TEMPLATE]", "").trim());
      } else {
        await sendMessage(from, aiMessage);
      }

    } catch (err) {
      console.error("❌ Error:", err);
      await sendMessage(from, "Oops! Something went wrong. Please try again.");
    }
  }

  res.status(200).send('Webhook processed');
});

// AI Response Generation
async function generateAIResponse(userMessage, history, firstTime) {
  const sharedPrompt = `
You are Linda, Fred's WhatsApp assistant. Follow these rules:

1. For lists, use this exact format:
[LIST_VARS]
HEADER_TEXT: "Header"
BODY_TEXT: "Body text"
FOOTER_TEXT: "Footer"
BUTTON_TEXT: "Options"
SECTION_TITLE: "Section 1"
ROWS_ARRAY: [
  {"id": "opt1", "title": "Option 1"},
  {"id": "opt2", "title": "Option 2"}
]
[LIST_VARS_END]

2. Never return JSON arrays or objects directly
3. Keep responses concise`;

  const systemPrompt = firstTime 
    ? `Welcome message then help based on:\n${sharedPrompt}`
    : `Direct help:\n${sharedPrompt}`;

  const response = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: "mistralai/mistral-7b-instruct",
      messages: [
        { 
          role: "system", 
          content: systemPrompt 
        },
        ...history,
        { role: "user", content: userMessage }
      ],
      max_tokens: 1500,
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

// Helper functions
async function checkTicketStatus(from, trackingId) {
  try {
    const ticketDoc = await usersRef.doc(from)
      .collection('tickets')
      .doc(trackingId)
      .get();

    return ticketDoc.exists ? ticketDoc.data() : { error: `Ticket ${trackingId} not found` };
  } catch (error) {
    console.error("Error checking ticket:", error);
    return { error: "Failed to check ticket status" };
  }
}

function parseListResponse(aiMessage, from) {
  const listStart = aiMessage.indexOf("[LIST_VARS]");
  const listEnd = aiMessage.indexOf("[LIST_VARS_END]");
  const varsText = aiMessage.substring(listStart + 11, listEnd).trim();

  const lines = varsText.split('\n').map(l => l.trim()).filter(Boolean);
  const vars = { SECTIONS: [] };
  let currentSection = null;

  for (const line of lines) {
    const [key, ...valueParts] = line.split(':');
    const value = valueParts.join(':').trim().replace(/^"|"$/g, '');

    if (key === 'HEADER_TEXT') vars.HEADER_TEXT = value;
    else if (key === 'BODY_TEXT') vars.BODY_TEXT = value;
    else if (key === 'FOOTER_TEXT') vars.FOOTER_TEXT = value;
    else if (key === 'BUTTON_TEXT') vars.BUTTON_TEXT = value;
    else if (key === 'SECTION_TITLE') {
      if (currentSection) vars.SECTIONS.push(currentSection);
      currentSection = { title: value, rows: [] };
    }
    else if (key === 'ROWS_ARRAY') {
      const jsonStart = line.indexOf('[');
      const jsonArray = line.slice(jsonStart);
      currentSection.rows = JSON.parse(jsonArray);
    }
  }

  if (currentSection) vars.SECTIONS.push(currentSection);

  return {
    messaging_product: 'whatsapp',
    to: from,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: vars.HEADER_TEXT || '' },
      body: { text: vars.BODY_TEXT || '' },
      footer: { text: vars.FOOTER_TEXT || '' },
      action: {
        button: vars.BUTTON_TEXT || 'Options',
        sections: vars.SECTIONS
      }
    }
  };
}

async function saveConversation(from, userMessage, aiMessage) {
  const logRef = usersRef.doc(from).collection("logs");
  await logRef.add({ from: "user", message: userMessage, timestamp: new Date() });
  await logRef.add({ from: "assistant", message: aiMessage, timestamp: new Date() });
}

// Messaging functions
async function sendMessage(to, body, messageId = null) {
  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body }
  };

  if (messageId) {
    data.context = { message_id: messageId };
  }

  await axios({
    url: `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    method: 'post',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    data: JSON.stringify(data)
  });
  console.log("💬 Sent text to", to);
}

async function sendInteractiveList(to, listData) {
  await axios({
    url: `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    method: 'post',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    data: JSON.stringify(listData)
  });
  console.log("📋 Sent list to", to);
}

async function sendReplyButtons(to) {
  await axios({
    url: `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    method: 'post',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    data: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: 'Please select an option:' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'btn1', title: 'Option 1' } },
            { type: 'reply', reply: { id: 'btn2', title: 'Option 2' } }
          ]
        }
      }
    })
  });
  console.log("🔘 Sent buttons to", to);
}

async function sendImage(to, url, caption = "") {
  await axios({
    url: `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    method: 'post',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    data: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: url, caption }
    })
  });
  console.log("🖼️ Sent image to", to);
}

async function sendTemplate(to, templateName) {
  await axios({
    url: `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    method: 'post',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    data: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en' }
      }
    })
  });
  console.log("📤 Sent template:", templateName);
}

app.listen(3000, () => {
  console.log('🚀 Server running on port 3000');
  console.log("📞 PHONE ID:", process.env.WHATSAPP_PHONE_NUMBER_ID);
  console.log("🔐 TOKEN:", WHATSAPP_ACCESS_TOKEN?.slice(0, 6) + '...');
});
