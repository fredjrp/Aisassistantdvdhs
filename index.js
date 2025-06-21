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
For anything too complex, direct users to contact Fred at +25470378935 or juniorokovagng@gmail.com. Keep the tone friendly and professional. Be quick, smart, and to the point. Use maximum 2 emojis per message.`
        : `You're Linda, Fred's assistant. Keep helping with tech and computer-related issues. Be concise (under 250 characters preferred, up to 500 max if necessary).
Mention Fred's online store if users ask about products — Hats, Canon Cameras, and Beanies: https://www.kilimall.co.ke/store/100007946?source=SellerApp&referCode=100007946. Save user interests for future suggestions.
If anything is beyond your scope, tell the user to reach out to Fred at +25470378935 or juniorokovagng@gmail.com. Avoid greetings and repeat info. Be sharp, polite, and helpful. Use maximum 2 emojis per message.`;

      // Check if AI should respond with an interactive list
      const shouldSendInteractiveList = userMessage.toLowerCase().includes('hiking') || 
                                      userMessage.toLowerCase().includes('trip') ||
                                      userMessage.toLowerCase().includes('travel');

      if (shouldSendInteractiveList) {
        // Get AI response for the header and body
        const aiResponse = await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            model: "mistralai/mistral-7b-instruct",
            messages: [
              { role: "system", content: `Generate a short header (max 3 words) and body text (1 sentence) for a travel options list based on: "${userMessage}". Use max 2 emojis total. Respond ONLY in this JSON format: {"header":"Header text","body":"Body text"}` },
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

        let listConfig;
        try {
          listConfig = JSON.parse(aiMessage);
        } catch (e) {
          listConfig = {
            header: "Travel Options",
            body: "Here are some great travel options for you!"
          };
        }

        // Send the interactive list with AI-generated header/body
        await sendInteractiveList(from, {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: from,
          type: "interactive",
          interactive: {
            type: "list",
            header: {
              type: "text",
              text: listConfig.header || "🌍 Trip Planner"
            },
            body: {
              text: listConfig.body || "Hello! Ready to explore? Select a trip package below."
            },
            footer: {
              text: "Powered by WanderNow ✈️"
            },
            action: {
              button: "Choose a Package",
              sections: [
                {
                  title: "🌅 Popular Getaways",
                  rows: [
                    {
                      id: "coast_trip",
                      title: "Mombasa Beach Escape",
                      description: "3 Days, 2 Nights | All-inclusive | Starts at KES 15,000"
                    },
                    {
                      id: "naivasha_trip",
                      title: "Naivasha Nature Retreat",
                      description: "2 Days, 1 Night | Boat ride included | From KES 8,500"
                    }
                  ]
                },
                {
                  title: "🚌 Upcoming Group Trips",
                  rows: [
                    {
                      id: "mtkenya_hike",
                      title: "Mt. Kenya Hiking Tour",
                      description: "4 Days | Group adventure | From KES 22,000"
                    },
                    {
                      id: "arusha_safari",
                      title: "Arusha Safari (TZ)",
                      description: "5 Days | Cross-border | KES 35,000 all in"
                    }
                  ]
                }
              ]
            }
          }
        });

        // Save to Firestore
        const logRef = usersRef.doc(from).collection("logs");
        await logRef.add({ from: "user", message: userMessage, timestamp: new Date() });
        await logRef.add({ 
          from: "assistant", 
          message: `Sent interactive list: ${listConfig.header} - ${listConfig.body}`,
          timestamp: new Date() 
        });
        
        return res.sendStatus(200);
      }

      // Regular text response
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

async function sendInteractiveList(to, listData) {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const response = await axios.post(url, listData, {
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
});
