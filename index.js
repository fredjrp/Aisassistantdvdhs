require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
const usersRef = require('./firebase');

const VERIFY_TOKEN = "your_custom_token";

app.use(express.json());

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

// Incoming message handler
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (
    body.object &&
    body.entry &&
    body.entry[0].changes &&
    body.entry[0].changes[0].value.messages
  ) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from;
    const userMessage = message.text?.body || "No text";

    console.log(`📩 Incoming message from ${from}:`, userMessage);

    try {
      const userDoc = await usersRef.doc(from).get();
      const firstTime = !userDoc.exists || !userDoc.data().greeted;

      if (userMessage.toLowerCase().trim() === "reset") {
        await usersRef.doc(from).delete();
        await sendText(from, "✅ Your session has been reset. You can start fresh now.");
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

      const systemPrompt = firstTime
        ? `You are Linda, Fred's smart and witty personal assistant at Fred's Computers. Greet the user warmly (only once) and assist with tech issues like printing, browsing, or general computer help. Keep responses concise — aim for under 250 characters unless more detail is needed (max 500).
Let users know they can shop for Hats, Canon Cameras, and Beanies from Fred's online store: https://www.kilimall.co.ke/store/100007946?source=SellerApp&referCode=100007946. If they ask for different products, take note and say you'll share it with Fred.
For anything too complex, direct users to contact Fred at +25470378935 or juniorokovagng@gmail.com. Keep the tone friendly and professional. Be quick, smart, and to the point.

SPECIAL FORMATS:
1. If you need to present multiple options (like product choices or service packages), respond with JSON in this format:
{
  "type": "interactive_list",
  "header": "Header text",
  "body": "Main message text",
  "footer": "Footer text (optional)",
  "sections": [
    {
      "title": "Section 1 title",
      "rows": [
        {
          "id": "unique_id_1",
          "title": "Option 1",
          "description": "Description of option 1"
        },
        {
          "id": "unique_id_2",
          "title": "Option 2",
          "description": "Description of option 2"
        }
      ]
    }
  ]
}

2. If you need to share a location, respond with JSON in this format:
{
  "type": "location",
  "longitude": 36.821946,
  "latitude": -1.292066,
  "name": "Location name",
  "address": "Physical address (optional)"
}

Otherwise, respond with normal text.`
        : `You're Linda, Fred's assistant. Keep helping with tech and computer-related issues. Be concise (under 250 characters preferred, up to 500 max if necessary).
Mention Fred's online store if users ask about products — Hats, Canon Cameras, and Beanies: https://www.kilimall.co.ke/store/100007946?source=SellerApp&referCode=100007946. Save user interests for future suggestions.
If anything is beyond your scope, tell the user to reach out to Fred at +25470378935 or juniorokovagng@gmail.com. Avoid greetings and repeat info. Be sharp, polite, and helpful.

SPECIAL FORMATS:
1. For multiple options, use JSON with "type": "interactive_list" format.
2. For locations, use JSON with "type": "location".
Otherwise use normal text.`;

      const aiResponse = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: "mistralai/mistral-7b-instruct",
          messages: [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content: userMessage }
          ],
          response_format: { type: "json_object" } // Encourage JSON responses when needed
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );

      const aiMessage = aiResponse.data.choices[0].message.content.trim();
      console.log("🤖 AI responded:", aiMessage);

      // Save to Firestore
      const logRef = usersRef.doc(from).collection("logs");
      await logRef.add({ from: "user", message: userMessage, timestamp: new Date() });
      await logRef.add({ from: "assistant", message: aiMessage, timestamp: new Date() });

      // Try parsing as JSON
      let parsed;
      try {
        parsed = JSON.parse(aiMessage);
      } catch (e) {
        parsed = null;
      }

      if (parsed) {
        if (parsed.type === "interactive_list") {
          // Handle interactive list message
          await sendInteractiveList(from, parsed);
        } else if (parsed.type === "location") {
          // Handle location message
          await sendLocation(from, parsed);
        } else if (parsed?.template_name) {
          // Handle template message (existing functionality)
          await sendTemplate(from, parsed);
        } else {
          // Fallback to text if JSON doesn't match expected formats
          await sendText(from, aiMessage);
        }
      } else if (/\.(jpg|jpeg|png|gif)/.test(aiMessage)) {
        // Handle image message (existing functionality)
        const imageUrl = aiMessage.match(/https?:\/\/[^\s]+/)[0];
        const caption = aiMessage.replace(imageUrl, "").trim();
        await sendImage(from, imageUrl, caption);
      } else {
        // Default to text message
        await sendText(from, aiMessage);
      }

    } catch (err) {
      if (err.response?.data) {
        console.error("❌ API Error:", err.response.data);
      } else {
        console.error("❌ Internal Error:", err.message);
      }
    }
  }

  res.sendStatus(200);
});

// =============== Messaging Helpers ================

async function sendText(to, message) {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const response = await axios.post(url, {
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
    const response = await axios.post(url, {
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
    const response = await axios.post(url, {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: parsed.template_name,
        language: { code: parsed.language_code || "en" },
        ...(parsed.components && { components: parsed.components })
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

async function sendInteractiveList(to, data) {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const response = await axios.post(url, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: {
          type: "text",
          text: data.header || "Options"
        },
        body: {
          text: data.body || "Please select an option:"
        },
        ...(data.footer && { footer: { text: data.footer } }),
        action: {
          button: data.button || "Choose Option",
          sections: data.sections.map(section => ({
            title: section.title,
            rows: section.rows.map(row => ({
              id: row.id,
              title: row.title,
              description: row.description || ""
            }))
          }))
        }
      }
    }, {
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

async function sendLocation(to, data) {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const response = await axios.post(url, {
      messaging_product: "whatsapp",
      to,
      type: "location",
      location: {
        longitude: data.longitude,
        latitude: data.latitude,
        name: data.name,
        ...(data.address && { address: data.address })
      }
    }, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    console.log("📍 Sent location to", to);
  } catch (err) {
    console.error("❌ Failed to send location:", err.response?.data || err.message);
  }
}

// =============== Server Start ================
app.listen(3000, () => {
  console.log('🚀 Server is running on http://localhost:3000');
  console.log("📞 PHONE ID:", process.env.WHATSAPP_PHONE_NUMBER_ID);
  console.log("🔐 WHATSAPP TOKEN:", process.env.WHATSAPP_ACCESS_TOKEN?.slice(0, 10) + '...');
});
