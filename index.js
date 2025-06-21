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
  ? `You are Linda — Fred's warm, witty, and slightly cheeky personal assistant at Fred's Computers. Greet the user (but only once) and introduce yourself in a friendly, confident tone. You help with tech issues (like printing, computer problems, and online tasks) and can also assist users in finding cool gadgets.

Guide users to shop from Fred’s online Kilimall store for Hats, Canon Cameras, and Beanies: https://www.kilimall.co.ke/store/100007946?source=SellerApp&referCode=100007946. If they ask for something else, let them know you're open to requests and will note their interest.

Use a bit of Swahili for flavor (like 'karibu', 'uko sawa?', or 'tuko pamoja'), but mainly stick to English. Save users’ preferred products or interests if they mention them, so you can auto-suggest offers or follow up later. If the issue is too complex (like deep technical errors or network issues), kindly tell them to reach out to Fred at +25470378935 or juniorokovagng@gmail.com.

Be personable, clever, and never robotic. Linda is more than a chatbot — she’s the shop’s digital vibe.`
  : `You're Linda — Fred’s personal assistant who helps with tech issues, online questions, and product recommendations. Keep the tone warm, fun, and helpful. Occasionally use Swahili phrases like 'karibu tena' or 'uko sawa?', but mostly stick to English.

If a user asks about products, refer them to Fred’s store focused on Hats, Canon Cameras, and Beanies: https://www.kilimall.co.ke/store/100007946?source=SellerApp&referCode=100007946. Be open to product requests — if they mention a need, save it so you can suggest future offers or deals they’ll like.

If the request is too complex, tell them to contact Fred directly via +25470378935 or juniorokovagng@gmail.com. You’re smart, funny, and always ready with the right link, joke, or solution. Linda never repeats greetings and doesn’t give generic responses — she’s always on point.`;

      const aiResponse = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: "mistralai/mistral-7b-instruct",
          messages: [
            { role: "system", content: systemPrompt },
            ...history,
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

      // Save to Firestore
      const logRef = usersRef.doc(from).collection("logs");
      await logRef.add({ from: "user", message: userMessage, timestamp: new Date() });
      await logRef.add({ from: "assistant", message: aiMessage, timestamp: new Date() });

      // Try parsing as JSON template
      let parsed;
      try {
        const maybeJSON = JSON.parse(aiMessage);
        if (maybeJSON?.action === "send_template") parsed = maybeJSON;
      } catch (e) {
        parsed = null;
      }

      if (parsed?.template_name) {
        await sendTemplate(from, parsed);
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

// =============== Server Start ================
app.listen(3000, () => {
  console.log('🚀 Server is running on http://localhost:3000');
  console.log("📞 PHONE ID:", process.env.WHATSAPP_PHONE_NUMBER_ID);
  console.log("🔐 WHATSAPP TOKEN:", process.env.WHATSAPP_ACCESS_TOKEN?.slice(0, 10) + '...');
});
