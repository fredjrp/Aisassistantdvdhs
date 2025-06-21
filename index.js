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
      // Test template bypass - remove in production
      if (userMessage.toLowerCase().trim() === "test template") {
        const testTemplate = {
          type: "template",
          template_name: "welcome_message", // Must match exactly in WhatsApp dashboard
          language_code: "en",
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: "Fred" }
              ]
            }
          ]
        };
        await sendTemplate(from, testTemplate);
        return res.sendStatus(200);
      }

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

      const systemPrompt = `You are Linda, Fred's assistant. Respond ONLY in valid JSON format using these structures:

1. For WhatsApp templates (MUST use exact structure):
{
  "type": "template",
  "template_name": "approved_template_name_from_whatsapp",
  "language_code": "en",
  "components": [
    {
      "type": "body",
      "parameters": [
        { "type": "text", "text": "value1" }
      ]
    }
  ]
}
⚠️ template_name MUST match exactly what's approved in WhatsApp dashboard
⚠️ ALWAYS include language_code and components

2. For interactive lists:
{
  "type": "interactive_list",
  "header": "Header text",
  "body": "Main message",
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

3. For locations:
{
  "type": "location",
  "longitude": 36.8219,
  "latitude": -1.2921,
  "name": "Location name"
}

⚠️ DO NOT respond in plain text. ALWAYS use JSON.
⚠️ For templates, ONLY use pre-approved template names.
⚠️ If unsure, respond with simple text inside JSON: {"type":"text","content":"message"}`;

      const aiResponse = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: "mistralai/mistral-7b-instruct", // Consider gpt-4-turbo for better JSON compliance
          messages: [
            { role: "system", content: systemPrompt },
            ...history,
            { 
              role: "user", 
              content: `${userMessage}\n\nRespond in strict JSON format using one of the specified structures.` 
            }
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
      console.log("🤖 Raw AI response:", aiMessage);

      // Save to Firestore
      const logRef = usersRef.doc(from).collection("logs");
      await logRef.add({ from: "user", message: userMessage, timestamp: new Date() });
      await logRef.add({ from: "assistant", message: aiMessage, timestamp: new Date() });

      // Parse and validate response
      let parsed;
      try {
        parsed = JSON.parse(aiMessage);
        console.log("🧪 Parsed AI message:", parsed);
      } catch (e) {
        console.warn("⚠️ Failed to parse AI response as JSON");
        await sendText(from, "Sorry, I encountered an error. Please try again.");
        return res.sendStatus(200);
      }

      // Handle different response types
      if (!parsed.type) {
        console.warn("⚠️ AI response missing 'type' field");
        await sendText(from, "Sorry, I had trouble formatting that response.");
        return res.sendStatus(200);
      }

      switch (parsed.type) {
        case "template":
          if (!parsed.template_name || !parsed.language_code || !parsed.components) {
            console.warn("⚠️ Invalid template structure - missing required fields");
            await sendText(from, "Sorry, I couldn't format that properly. Please try again.");
            break;
          }
          await sendTemplate(from, parsed);
          break;
        
        case "interactive_list":
          await sendInteractiveList(from, parsed);
          break;
        
        case "location":
          await sendLocation(from, parsed);
          break;
        
        case "text":
          await sendText(from, parsed.content || "No message content");
          break;
        
        default:
          console.warn("⚠️ Unknown response type:", parsed.type);
          await sendText(from, "Sorry, I couldn't process that request.");
      }

    } catch (err) {
      console.error("❌ Error processing message:", err);
      await sendText(from, "Sorry, I encountered an error. Please try again later.");
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

async function sendTemplate(to, data) {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  
  try {
    await axios.post(url, {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: data.template_name,
        language: { code: data.language_code },
        components: data.components
      }
    }, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    console.log("📤 Sent template:", data.template_name);
  } catch (err) {
    console.error("❌ Failed to send template:", err.response?.data || err.message);
    // Fallback to text with template details
    const bodyText = data.components.find(c => c.type === "body")?.parameters?.map(p => p.text).join(" ") || "";
    await sendText(to, `[Template: ${data.template_name}] ${bodyText}`);
  }
}

async function sendInteractiveList(to, data) {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(url, {
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
    await axios.post(url, {
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
