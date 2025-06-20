require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();

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

    try {
      const systemPrompt = `You are a WhatsApp assistant for Fred's Computers. Be natural and helpful. If needed, suggest a WhatsApp template using JSON format. Avoid repeating greetings.`;

      const aiResponse = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: "mistralai/mistral-7b-instruct",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage }
          ]
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

      // Parse for template
      let parsed = null;
      try {
        const maybeJSON = JSON.parse(aiMessage);
        if (maybeJSON?.action === "send_template") parsed = maybeJSON;
      } catch {
        parsed = null;
      }

      const sendUrl = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
      const headers = {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      };

      if (parsed?.template_name) {
        await axios.post(
          sendUrl,
          {
            messaging_product: "whatsapp",
            to: from,
            type: "template",
            template: {
              name: parsed.template_name,
              language: { code: parsed.language_code || "en" },
              ...(parsed.components && { components: parsed.components })
            }
          },
          { headers }
        );
        console.log("📤 Sent WhatsApp template:", parsed.template_name);
      } else {
        const containsImage = aiMessage.includes("http") && /\.(jpg|jpeg|png|gif)/.test(aiMessage);
        const containsLink = aiMessage.includes("http");

        if (containsImage) {
          const imageUrl = aiMessage.match(/https?:\/\/[^\s]+/)[0];
          const caption = aiMessage.replace(imageUrl, "").trim();
          await axios.post(
            sendUrl,
            {
              messaging_product: "whatsapp",
              to: from,
              type: "image",
              image: {
                link: imageUrl,
                caption: caption || "📸 Here's what you need"
              }
            },
            { headers }
          );
          console.log("🖼️ Sent image with caption");
        } else {
          await axios.post(
            sendUrl,
            {
              messaging_product: "whatsapp",
              to: from,
              text: { body: aiMessage }
            },
            { headers }
          );
          console.log("💬 Sent text reply");
        }
      }
    } catch (err) {
      console.error("❌ Error:", err.response?.data || err.message);
    }
  }

  res.sendStatus(200);
});

app.listen(3000, () => console.log('🚀 Server is running on http://localhost:3000'));
