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

      const systemPrompt = `You are Linda, Fred's smart and witty personal assistant at Fred's Computers. Keep responses concise (under 250 characters preferred, up to 500 max if needed).

SPECIAL RESPONSE FORMATS:
1. For WhatsApp templates, use this exact JSON structure:
{
  "type": "template",
  "template_name": "approved_template_name_from_whatsapp",
  "language_code": "en",
  "components": [
    {
      "type": "body",
      "parameters": [
        { "type": "text", "text": "value1" },
        { "type": "text", "text": "value2" }
      ]
    },
    {
      "type": "button",
      "sub_type": "quick_reply",
      "index": 0,
      "parameters": [
        { "type": "payload", "payload": "button1_payload" }
      ]
    }
  ]
}
Example: If user asks for a welcome message, respond with:
{
  "type": "template",
  "template_name": "welcome_message",
  "language_code": "en",
  "components": [
    {
      "type": "body",
      "parameters": [
        { "type": "text", "text": "Fred" }
      ]
    }
  ]
}

2. For multiple options, use:
{
  "type": "interactive_list",
  "header": "Header text",
  "body": "Main message",
  "footer": "Footer text (optional)",
  "sections": [
    {
      "title": "Section title",
      "rows": [
        {
          "id": "option1_id",
          "title": "Option 1",
          "description": "Description"
        }
      ]
    }
  ]
}

3. For locations, use:
{
  "type": "location",
  "longitude": 36.8219,
  "latitude": -1.2921,
  "name": "Location name",
  "address": "Address (optional)"
}

4. For images, include direct URL ending with .jpg/.png/.gif

OTHER INSTRUCTIONS:
- For tech support, be concise and helpful
- Mention Fred's store for products: https://www.kilimall.co.ke/store/100007946
- For complex issues, direct to Fred at +25470378935
- First-time users get a warm greeting
- Use templates only for pre-approved message types`;

      const aiResponse = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: "mistralai/mistral-7b-instruct",
          messages: [
            { role: "system", content: systemPrompt },
            ...history,
            { role: "user", content: userMessage }
          ],
          response_format: { type: "json_object" }
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
          await sendInteractiveList(from, parsed);
        } else if (parsed.type === "location") {
          await sendLocation(from, parsed);
        } else if (parsed.type === "template") {
          // Validate template structure before sending
          if (!parsed.template_name || !parsed.language_code) {
            console.warn("⚠️ Invalid template structure - missing required fields");
            await sendText(from, "Sorry, I had trouble formatting that response. Please try again.");
          } else {
            await sendTemplate(from, parsed);
          }
        } else {
          await sendText(from, aiMessage);
        }
      } else if (/\.(jpg|jpeg|png|gif)/.test(aiMessage)) {
        const imageUrl = aiMessage.match(/https?:\/\/[^\s]+/)[0];
        const caption = aiMessage.replace(imageUrl, "").trim();
        await sendImage(from, imageUrl, caption);
      } else {
        await sendText(from, aiMessage);
      }

    } catch (err) {
      if (err.response?.data) {
        console.error("❌ API Error:", err.response.data);
        await sendText(from, "Sorry, I encountered an error. Please try again later.");
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

async function sendTemplate(to, data) {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  
  // Fallback template if AI response is incomplete
  const templateData = {
    template_name: data.template_name || "welcome_message",
    language_code: data.language_code || "en",
    components: data.components || []
  };

  try {
    const response = await axios.post(url, {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateData.template_name,
        language: { code: templateData.language_code },
        components: templateData.components
      }
    }, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    console.log("📤 Sent template:", templateData.template_name);
  } catch (err) {
    console.error("❌ Failed to send template:", err.response?.data || err.message);
    // Fallback to text if template fails
    await sendText(to, "Here's what I wanted to share: " + JSON.stringify(data.components));
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
    // Fallback to text with options
    const optionsText = data.sections.map(section => 
      `${section.title}:\n${section.rows.map(row => `- ${row.title}: ${row.description}`).join('\n')}`
    ).join('\n\n');
    await sendText(to, `${data.body}\n\n${optionsText}`);
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
    await sendText(to, `Location: ${data.name}\nAddress: ${data.address || 'Not provided'}`);
  }
}

// =============== Server Start ================
app.listen(3000, () => {
  console.log('🚀 Server is running on http://localhost:3000');
  console.log("📞 PHONE ID:", process.env.WHATSAPP_PHONE_NUMBER_ID);
  console.log("🔐 WHATSAPP TOKEN:", process.env.WHATSAPP_ACCESS_TOKEN?.slice(0, 10) + '...');
});
