require('dotenv').config();
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const app = express();
const usersRef = require('./firebase');

const VERIFY_TOKEN = "your_custom_token";

app.use(express.json());

// Email transporter setup
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
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
  
  // Save to Firebase
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

  // Send email
  await sendSupportEmail(from, userMessage, trackingId);

  return trackingId;
}

async function sendSupportEmail(from, userMessage, trackingId) {
  try {
    const info = await transporter.sendMail({
      from: `"Fred AI Support" <${process.env.EMAIL_USER}>`,
      to: process.env.SUPPORT_EMAIL || 'support@yourdomain.com',
      subject: `New Support Ticket: ${trackingId}`,
      text: `New support ticket created:\n\nFrom: ${from}\nIssue: ${userMessage}\nTracking ID: ${trackingId}\n\nPlease resolve this issue promptly.`,
      html: `
        <h1>New Support Ticket: ${trackingId}</h1>
        <p><strong>From:</strong> ${from}</p>
        <p><strong>Issue:</strong> ${userMessage}</p>
        <p><strong>Tracking ID:</strong> ${trackingId}</p>
        <p>Please resolve this issue promptly.</p>
      `
    });
    console.log("📧 Support email sent:", info.messageId);
  } catch (error) {
    console.error("❌ Failed to send support email:", error);
  }
}

async function checkTicketStatus(from, trackingId) {
  try {
    const ticketDoc = await usersRef.doc(from)
      .collection('tickets')
      .doc(trackingId)
      .get();

    if (!ticketDoc.exists) {
      return { error: `No ticket found with ID ${trackingId}` };
    }

    return ticketDoc.data();
  } catch (error) {
    console.error("Error checking ticket status:", error);
    return { error: "Failed to check ticket status" };
  }
}

// Strict WhatsApp interactive list template
const LIST_TEMPLATE = {
  "interactive": {
    "type": "list",
    "header": {
      "type": "text",
      "text": "$HEADER_TEXT$"
    },
    "body": {
      "text": "$BODY_TEXT$"
    },
    "footer": {
      "text": "$FOOTER_TEXT$"
    },
    "action": {
      "button": "$BUTTON_TEXT$",
      "sections": []
    }
  },
  "messaging_product": "whatsapp",
  "origin_graph_explorer": "1",
  "to": "$PHONE_NUMBER$",
  "transport": "cors",
  "type": "interactive"
};

function parseListVars(varsText) {
  const lines = varsText.split('\n').map(line => line.trim()).filter(Boolean);

  const vars = {
    HEADER_TEXT: '',
    BODY_TEXT: '',
    FOOTER_TEXT: '',
    BUTTON_TEXT: '',
    SECTIONS: []
  };

  let currentSection = null;

  for (let line of lines) {
    if (line.startsWith("HEADER_TEXT:")) {
      vars.HEADER_TEXT = line.replace("HEADER_TEXT:", "").trim().replace(/^"|"$/g, '');
    } else if (line.startsWith("BODY_TEXT:")) {
      vars.BODY_TEXT = line.replace("BODY_TEXT:", "").trim().replace(/^"|"$/g, '');
    } else if (line.startsWith("FOOTER_TEXT:")) {
      vars.FOOTER_TEXT = line.replace("FOOTER_TEXT:", "").trim().replace(/^"|"$/g, '');
    } else if (line.startsWith("BUTTON_TEXT:")) {
      vars.BUTTON_TEXT = line.replace("BUTTON_TEXT:", "").trim().replace(/^"|"$/g, '');
    } else if (line.startsWith("SECTION_TITLE:")) {
      if (currentSection) vars.SECTIONS.push(currentSection);
      currentSection = { title: line.replace("SECTION_TITLE:", "").trim().replace(/^"|"$/g, ''), rows: [] };
    } else if (line.startsWith("ROWS_ARRAY:")) {
      const arrayStart = line.indexOf('[');
      const jsonArray = line.slice(arrayStart);
      try {
        const parsedRows = JSON.parse(jsonArray);
        if (currentSection) currentSection.rows = parsedRows;
      } catch (e) {
        throw new Error("Invalid ROWS_ARRAY JSON");
      }
    }
  }

  if (currentSection) vars.SECTIONS.push(currentSection);
  return vars;
}

// Incoming message handler
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object && body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from;
    const userMessage = message.text?.body || "No text";

    console.log(`📩 Incoming message from ${from}:`, userMessage);

    try {
      // Check for ticket status request first
      if (userMessage.toLowerCase().startsWith('track')) {
        const parts = userMessage.split(" ");
        const trackingId = parts[1]?.trim().toUpperCase();

        if (!trackingId) {
          await sendText(from, "⚠️ Please send a tracking number like: `track TKT-LSO6FHH6`");
          return res.sendStatus(200);
        }

        const ticket = await checkTicketStatus(from, trackingId);
        if (ticket.error) {
          await sendText(from, `❌ ${ticket.error}`);
        } else {
          await sendText(from, 
            `📋 Ticket #${ticket.id}\n` +
            `Status: ${ticket.status}\n` +
            `Issue: ${ticket.issue}\n` +
            `Created: ${ticket.createdAt.toDate().toLocaleString()}`
          );
        }
        return res.sendStatus(200);
      }

      const userDoc = await usersRef.doc(from).get();
      const firstTime = !userDoc.exists || !userDoc.data().greeted;

      if (userMessage.toLowerCase().trim() === "reset") {
        await usersRef.doc(from).delete();
        await sendText(from, "✅ Session reset! Fresh start activated. How can I help?");
        return res.sendStatus(200);
      }

      if (firstTime) {
        await usersRef.doc(from).set({ greeted: true }, { merge: true });
      }

      // Retrieve last 5 logs
      let previousLogs = [];
      const logsSnapshot = await usersRef.doc(from).collection("logs").orderBy("timestamp", "desc").limit(5).get();
      logsSnapshot.forEach(doc => previousLogs.unshift(doc.data()));

      const history = previousLogs.map(log => ({
        role: log.from,
        content: log.message
      }));

      const sharedPrompt = `
You are Linda, Fred's witty WhatsApp assistant.

❗ STRICT FORMAT INSTRUCTIONS:
When asked to generate a list, **always respond using only** the template format below — surrounded with [LIST_VARS] and [LIST_VARS_END], as raw text. 

Absolutely do **not return JSON arrays or wrapped objects**.

Your format:
[LIST_VARS]
HEADER_TEXT: "..."
BODY_TEXT: "..."
FOOTER_TEXT: "..."
BUTTON_TEXT: "..."
SECTION_TITLE: "..."
ROWS_ARRAY: [
  { "id": "option1", "title": "Option 1", "description": "..." },
  { "id": "option2", "title": "Option 2", "description": "..." }
]
[LIST_VARS_END]

🚫 Do not return JSON arrays like this: [{...}, {...}]
🚫 Do not return explanations or comments.
✅ Do not wrap this in backticks or markdown.
✅ Always give plain text between [LIST_VARS] and [LIST_VARS_END].

Never explain. Never return multiple objects. Just raw, one block.
`;

      const systemPrompt = firstTime
        ? `Start with a quick friendly greeting (under 500 characters), then help based on the message.\n${sharedPrompt}`
        : `No greeting. Go straight to helping. Be concise, helpful, and witty.\n${sharedPrompt}`;

      const aiResponse = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: "mistralai/mistral-7b-instruct",
          messages: [
            { 
              role: "system", 
              content: `${systemPrompt}\n\nCurrent time: ${new Date().toLocaleTimeString()}. Never make up info. If unsure, say "Let me check with Fred!"`
            },
            ...history,
            { role: "user", content: userMessage }
          ],
          max_tokens: 3500,
          temperature: 0.7
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );

      let aiMessage = aiResponse.data.choices[0].message.content.trim();
      
      // Fail-safe for unexpected JSON arrays
      if (aiMessage.trim().startsWith('[')) {
        await sendText(from, "⚠️ AI returned unexpected format. Please try again or use a simpler prompt.");
        return res.sendStatus(200);
      }

      // Enforce character limit strictly
      if (aiMessage.length > 3500 && !aiMessage.includes("[LIST_VARS]")) {
        aiMessage = aiMessage.substring(0, 3497) + "...";
        console.log("⚠️ Trimmed long response to 3500 chars");
      }

      console.log("🤖 AI responded:", aiMessage);

      // Check if AI returned list variables
      if (aiMessage.includes("[LIST_VARS]")) {
        try {
          // Extract variables from the AI response
          const listStart = aiMessage.indexOf("[LIST_VARS]");
          const listEnd = aiMessage.indexOf("[LIST_VARS_END]");

          if (listStart === -1 || listEnd === -1) {
            throw new Error("Missing [LIST_VARS] block.");
          }

          const varsPart = aiMessage.substring(listStart + 11, listEnd).trim();
          const vars = parseListVars(varsPart);

          // Create the list data from template
          const listData = JSON.parse(JSON.stringify(LIST_TEMPLATE));
          
          // Replace placeholders with actual values
          listData.to = from;
          listData.interactive.header.text = vars.HEADER_TEXT || "";
          listData.interactive.body.text = vars.BODY_TEXT || "";
          listData.interactive.footer.text = vars.FOOTER_TEXT || "";
          listData.interactive.action.button = vars.BUTTON_TEXT || "Select";
          listData.interactive.action.sections = vars.SECTIONS;

          await sendInteractiveList(from, listData);
          console.log("📋 Sent interactive list with template");

          // Save to Firestore
          const logRef = usersRef.doc(from).collection("logs");
          await logRef.add({ from: "user", message: userMessage, timestamp: new Date() });
          await logRef.add({ from: "assistant", message: "Sent interactive options list", timestamp: new Date() });

          return res.sendStatus(200);
        } catch (err) {
          console.error("❌ Failed to process list variables:", err.message);
          await sendText(from, "Sorry, I couldn't prepare the options. Please try again.");
          return res.sendStatus(200);
        }
      }

      // Check if this is an unresolved issue
      if (aiMessage.includes("Let me check with Fred!")) {
        const trackingId = await createSupportTicket(from, userMessage);
        aiMessage += `\n\nI've created a support ticket for you (ID: ${trackingId}). Our team will contact you soon. You can check status by sending: track ${trackingId}`;
      }

      // Save to Firestore
      const logRef = usersRef.doc(from).collection("logs");
      await logRef.add({ from: "user", message: userMessage, timestamp: new Date() });
      await logRef.add({ from: "assistant", message: aiMessage, timestamp: new Date() });

      // Response handling
      if (aiMessage.startsWith("[IMAGE]")) {
        const imageUrl = aiMessage.replace("[IMAGE]", "").trim();
        await sendImage(from, imageUrl, "From Fred's Computers");
      } 
      else if (aiMessage.startsWith("[TEMPLATE]")) {
        const templateName = aiMessage.replace("[TEMPLATE]", "").trim();
        await sendTemplate(from, { template_name: templateName });
      }
      else {
        await sendText(from, aiMessage);
      }

    } catch (err) {
      console.error("❌ Error:", err.response?.data || err.message);
      await sendText(from, "Oops! My circuits glitched. Try again or contact Fred at +25470378935");
    }
  }

  res.sendStatus(200);
});

// =============== Messaging Helpers ================

async function sendText(to, message) {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(url, {
      messaging_product: "whatsapp",
      to,
      text: { body: message }
    }, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    console.log("💬 Sent text to", to);
  } catch (err) {
    console.error("❌ Failed to send text:", err.response?.data || err.message);
  }
}

async function sendImage(to, link, caption = "") {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(url, {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link, caption }
    }, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    console.log("🖼️ Sent image to", to);
  } catch (err) {
    console.error("❌ Failed to send image:", err.response?.data || err.message);
  }
}

async function sendTemplate(to, parsed) {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(url, {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: parsed.template_name,
        language: { code: "en" }
      }
    }, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    console.log("📤 Sent template:", parsed.template_name);
  } catch (err) {
    console.error("❌ Failed to send template:", err.response?.data || err.message);
  }
}

async function sendInteractiveList(to, listData) {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(url, listData, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    console.log("📋 Sent interactive list to", to);
  } catch (err) {
    console.error("❌ Failed to send interactive list:", err.response?.data || err.message);
  }
}

// =============== Server Start ================
app.listen(3000, () => {
  console.log('🚀 Server is running on http://localhost:3000');
  console.log("📞 PHONE ID:", process.env.WHATSAPP_PHONE_NUMBER_ID);
  console.log("🔐 WHATSAPP TOKEN:", process.env.WHATSAPP_ACCESS_TOKEN?.slice(0, 10) + '...');
  console.log("📧 Email Service:", process.env.EMAIL_SERVICE || 'gmail');
});
