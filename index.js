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
You're Linda, Fred's witty and helpful tech assistant. Limit replies to 500 characters. Use a warm, concise, and slightly humorous tone. Max 2 emojis.

Fred's products: Hats, Canon Cameras, Beanies — link: kilimall.co.ke/store/100007946.
For other items: say "I'll tell Fred!".
For complex issues: say "Let me connect you with Fred at +25470378935.".
`;

      const systemPrompt = firstTime
        ? `Start with a short greeting (under 500 chars), then help based on the user's input.${sharedPrompt}`
        : `Do not greet. Go straight to the point with your reply.${sharedPrompt}`;

      // Check if user asked about hiking
      if (userMessage.toLowerCase().includes('hiking')) {
        if (firstTime) {
          await sendText(from, "Hi! I'm Linda 👋 Fred's assistant. I see you're into hiking! Let me show some options...");
        }
        
        await sendInteractiveList(from, {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: from,
          type: "interactive",
          interactive: {
            type: "list",
            header: {
              type: "text",
              text: "🌄 Adventure Packages"
            },
            body: {
              text: "Ready for adventure? Choose a package below:"
            },
            footer: {
              text: "Book early for best rates!"
            },
            action: {
              button: "View Trips",
              sections: [
                {
                  title: "Popular Trips",
                  rows: [
                    {
                      id: "coast_trip",
                      title: "Mombasa Beach Escape",
                      description: "3D/2N | All-inclusive | KES 15,000"
                    },
                    {
                      id: "naivasha_trip",
                      title: "Naivasha Retreat",
                      description: "2D/1N | Boat ride | KES 8,500"
                    }
                  ]
                },
                {
                  title: "Group Adventures",
                  rows: [
                    {
                      id: "mtkenya_hike",
                      title: "Mt. Kenya Hike",
                      description: "4 Days | Group tour | KES 22,000"
                    },
                    {
                      id: "arusha_safari",
                      title: "Arusha Safari",
                      description: "5 Days | Tanzania | KES 35,000"
                    }
                  ]
                }
              ]
            }
          }
        });
        
        const logRef = usersRef.doc(from).collection("logs");
        await logRef.add({ from: "user", message: userMessage, timestamp: new Date() });
        await logRef.add({ from: "assistant", message: "Sent hiking options", timestamp: new Date() });
        
        return res.sendStatus(200);
      }

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
          max_tokens: 100,
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
      
      // Enforce character limit strictly
      if (aiMessage.length > 250) {
        aiMessage = aiMessage.substring(0, 247) + "...";
        console.log("⚠️ Trimmed long response to 250 chars");
      }

      console.log("🤖 AI responded:", aiMessage);

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
