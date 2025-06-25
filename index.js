require('dotenv').config();
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

// 🌍 ENV
const {
  WHATSAPP_ACCESS_TOKEN,
  WEBHOOK_VERIFY_TOKEN,
  PHONE_NUMBER_ID,
  OPENROUTER_API_KEY,
  EMAIL_USER,
  EMAIL_PASS,
  ALERT_EMAIL
} = process.env;

// 🔥 Firebase Init
const rawConfig = JSON.parse(process.env.FIREBASE_CONFIG);
rawConfig.private_key = rawConfig.private_key.replace(/\\n/g, '\n');
admin.initializeApp({ credential: admin.credential.cert(rawConfig) });
const db = admin.firestore();

// 📧 Email
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

// ✅ GET Root
app.get('/', (req, res) => res.send('✅ WhatsApp Bot running'));

// ✅ Webhook Verification
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode && token === WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ✅ Webhook Receiver
app.post('/webhook', async (req, res) => {
  const changes = req.body.entry?.[0]?.changes?.[0];
  const message = changes?.value?.messages?.[0];
  const profileName = message?.profile?.name;
  const from = message?.from;

  if (!message || !from) return res.sendStatus(200);

  const type = message.type;
  const messageId = message.id;
  let lastMessageText = null;

  if (type === 'text') {
    lastMessageText = message.text?.body;
  } else if (type === 'interactive') {
    const interactive = message.interactive;
    if (interactive?.type === 'button_reply') {
      lastMessageText = interactive.button_reply?.title || interactive.button_reply?.id;
    } else if (interactive?.type === 'list_reply') {
      lastMessageText = interactive.list_reply?.title || interactive.list_reply?.id;
    }
  }

  const updateData = {
    lastActive: Date.now(),
  };
  if (lastMessageText !== undefined) {
    updateData.lastMessage = lastMessageText.toLowerCase();
  }
  if (profileName !== undefined) {
    updateData.profileName = profileName;
  }

  await db.collection('users').doc(from).set(updateData, { merge: true });

  await db.collection('whatsapp_logs').add({
    from,
    type,
    message,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });

  if (type === 'text') {
    const text = lastMessageText.toLowerCase();
    if (text === 'hi') {
      await replyMessage(from, `Hi ${profileName || 'there'}! 🚀 Welcome to Fred's Inc, Official Meta Partner for WhatsApp. How can we help?`, messageId);
      await sendMainMenu(from);
    } else if (text === 'help') {
      await sendMessage(from, 'An agent will contact you shortly.');
      await sendEmailAlert(from, 'User requested help');
    } else {
      const aiReply = await getAIResponse(text, from);
      await sendMessage(from, aiReply);
    }
  }

  if (type === 'interactive') {
    const interactive = message.interactive;
    if (interactive.type === 'list_reply') {
      const userSelection = interactive.list_reply?.id;
      
      if (userSelection === 'demo') {
        await sendBusinessTypeList(from);
      } 
      else if (userSelection.startsWith('biz_')) {
        await db.collection('users').doc(from).update({ lastBusinessType: userSelection });
        await sendBusinessDemoFlow(from, userSelection);
      }
      else if (userSelection === 'buy_now') {
        await sendMessage(from, "🎉 Fantastic choice! Here's why Fred's Inc is perfect for you:");
        await sendBuyEncouragement(from);
        await sendFinalCTA(from);
      }
      else if (userSelection === 'confirm_buy') {
        await sendPurchaseOptions(from);
      }
      else if (userSelection === 'more_demo') {
        const userRef = await db.collection('users').doc(from).get();
        const lastBiz = userRef.data()?.lastBusinessType || 'biz_online_store';
        await sendExtendedDemo(from, lastBiz);
      }
      else {
        const aiReply = await getAIResponse(lastMessageText, from);
        await sendMessage(from, aiReply);
      }
    } else if (interactive.type === 'button_reply') {
      const replyId = interactive.button_reply.id;

      if (replyId === 'to_agent') {
        await sendMessage(from, 'Connecting you to a human agent. Please wait...');
        const agentSnapshot = await db.collection('agents')
          .where('active', '==', true)
          .orderBy('assignedCount')
          .limit(1)
          .get();

        if (agentSnapshot.empty) {
          await sendMessage(from, 'All agents are currently busy. Please wait a moment.');
          return;
        }

        const agentDoc = agentSnapshot.docs[0];
        const agentId = agentDoc.id;
        const agentData = agentDoc.data();

        await db.collection('users').doc(from).set({
          assignedAgent: agentId,
          agentName: agentData.name,
          status: 'awaiting_response',
          assignedAt: Date.now()
        }, { merge: true });

        await db.collection('agents').doc(agentId).update({
          assignedCount: admin.firestore.FieldValue.increment(1)
        });

        await sendEmailAlert(agentData.email || ALERT_EMAIL, `New user assigned: ${profileName || from}`);
        await sendMessage(from, `✅ You've been connected to ${agentData.name}. They'll respond shortly.`);
      } 
      else if (replyId === 'to_bot') {
        await sendMessage(from, 'Welcome back to Fred\'s Inc! Explore Performance Messaging:');
        await sendMainMenu(from);
      }
      else if (replyId === 'ai_guide') {
        await sendAISuggestions(from);
      }
    }
  }
  res.sendStatus(200);
});

// ✅ Follow-up every 1 min for inactive users
setInterval(async () => {
  const snapshot = await db.collection('users').get();
  const now = Date.now();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (now - data.lastActive > 5 * 60 * 1000 && !data.closed) {
      const from = doc.id;
      await sendMessage(from, `Hey ${data.profileName || ''}, we noticed you haven't replied. Let us know if you'd like to continue or restart later.`);
      await db.collection('users').doc(from).update({ closed: true });
    }
  }
}, 60 * 1000);

// ================== MESSAGE UTILITIES ================== //
async function sendMessage(to, body) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('❌ Send error:', err.response?.data || err.message);
  }
}

async function replyMessage(to, body, messageId) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      context: { message_id: messageId },
      type: 'text',
      text: { body }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('❌ Reply error:', err.response?.data || err.message);
  }
}

// ================== DEMO FLOW MENUS ================== //
async function sendMainMenu(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '📋 Fred\'s Inc - Official Meta Partner' },
        body: { text: 'Performance Messaging Solutions:' },
        footer: { text: '3.6x avg ROAS | 55% lower costs' },
        action: {
          button: 'Explore',
          sections: [
            {
              title: 'Core Features',
              rows: [
                { id: 'benefits', title: '🚀 Why WhatsApp?' },
                { id: 'demo', title: '🎯 Try Demo' }
              ]
            },
            {
              title: 'Get Started',
              rows: [
                { id: 'pricing', title: '💳 Pricing' },
                { id: 'support', title: '🛟 Support' }
              ]
            }
          ]
        }
      }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('❌ Main menu error:', err.response?.data || err.message);
  }
}

async function sendBusinessTypeList(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '🏢 Select Your Business' },
        body: { text: 'Experience tailored solutions for:' },
        footer: { text: 'Official Meta Partner' },
        action: {
          button: 'Choose',
          sections: [
            {
              title: 'Retail & Hospitality',
              rows: [
                { id: 'biz_online_store', title: '🛍️ Online Store' },
                { id: 'biz_offline_store', title: '🏬 Physical Store' },
                { id: 'biz_restaurant', title: '🍽️ Restaurant' },
                { id: 'biz_hotel', title: '🏨 Hotel' }
              ]
            },
            {
              title: 'Services & More',
              rows: [
                { id: 'biz_broker', title: '📈 Stock Broker' },
                { id: 'biz_logistics', title: '🚚 Logistics' },
                { id: 'biz_cyber', title: '💻 Cyber Cafe' },
                { id: 'biz_influencer', title: '🌟 Influencer' }
              ]
            }
          ]
        }
      }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('❌ Business list error:', err.response?.data || err.message);
  }
}

async function sendBusinessDemoFlow(to, businessType) {
  const bizFlows = {
    biz_online_store: {
      steps: [
        "1️⃣ Customer sees your Meta ad for trendy sneakers",
        "2️⃣ Clicks WhatsApp button → Lands in your automated flow",
        "3️⃣ AI assistant handles sizing questions",
        "4️⃣ WhatsApp Pay completes purchase in 2 taps",
        "5️⃣ Post-purchase tracking via WhatsApp"
      ],
      keywords: ["sneakers", "discount", "track order", "return", "help"],
      painPoints: [
        "❌ Abandoned carts on website?",
        "❌ High return rates from wrong sizes?",
        "❌ Customers can't reach support?"
      ]
    },
    biz_hotel: {
      steps: [
        "1️⃣ Guest sees Instagram story of your beachfront suites",
        "2️⃣ Clicks 'Book Now' → Opens WhatsApp chat",
        "3️⃣ Automated date selector checks availability",
        "4️⃣ Secure payment link sent in chat",
        "5️⃣ Pre-stay messages increase no-shows"
      ],
      keywords: ["availability", "pricing", "amenities", "cancel", "urgent"],
      painPoints: [
        "❌ Phone calls tying up staff?",
        "❌ No-shows from forgotten bookings?",
        "❌ Can't upsell amenities?"
      ]
    },
    biz_restaurant: {
      steps: [
        "1️⃣ Hungry customer sees Facebook ad",
        "2️⃣ Clicks 'Order Now' → WhatsApp chat opens",
        "3️⃣ AI takes order with allergen alerts",
        "4️⃣ Pay via WhatsApp or cash on delivery",
        "5️⃣ Loyalty points automatically tracked"
      ],
      keywords: ["menu", "delivery", "reservation", "specials", "allergies"],
      painPoints: [
        "❌ Phone orders during rush hour?",
        "❌ Missed upsell opportunities?",
        "❌ No customer database?"
      ]
    },
    biz_broker: {
      steps: [
        "1️⃣ Investor sees stock alert on Instagram",
        "2️⃣ Clicks 'Trade Now' → WhatsApp chat opens",
        "3️⃣ Secure verification via WhatsApp",
        "4️⃣ Place orders directly in chat",
        "5️⃣ Portfolio updates auto-sent daily"
      ],
      keywords: ["buy", "sell", "portfolio", "alert", "support"],
      painPoints: [
        "❌ Clients miss time-sensitive trades?",
        "❌ Can't scale personal service?",
        "❌ Compliance risks with SMS?"
      ]
    },
    biz_logistics: {
      steps: [
        "1️⃣ Shipper sees ad for instant quotes",
        "2️⃣ Clicks WhatsApp → AI requests details",
        "3️⃣ Real-time pricing calculated",
        "4️⃣ Booking confirmed in chat",
        "5️⃣ Live tracking updates via WhatsApp"
      ],
      keywords: ["quote", "track", "deliver", "urgent", "support"],
      painPoints: [
        "❌ Phone calls for simple queries?",
        "❌ Customers don't know shipment status?",
        "❌ Driver coordination headaches?"
      ]
    },
    biz_cyber: {
      steps: [
        "1️⃣ Gamer sees promo for hourly rates",
        "2️⃣ Clicks 'Book PC' → WhatsApp chat opens",
        "3️⃣ Checks PC availability in real-time",
        "4️⃣ Receives digital access pass",
        "5️⃣ Auto-extend session via WhatsApp"
      ],
      keywords: ["availability", "rates", "specs", "food", "help"],
      painPoints: [
        "❌ Empty seats during off-peak?",
        "❌ Cash handling issues?",
        "❌ No customer retention?"
      ]
    }
  };

  const flow = bizFlows[businessType] || bizFlows.biz_online_store;

  try {
    await sendMessage(to, `💡 ${flow.painPoints[Math.floor(Math.random() * flow.painPoints.length)]}`);
    
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: `🌟 ${businessType.replace('biz_', '').replace('_', ' ').toUpperCase()} FLOW` },
        body: { 
          text: `Here's how it works:\n\n${flow.steps.join('\n')}\n\nTry keywords: ${flow.keywords.slice(0, 3).join(', ')}` 
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'buy_now', title: '🚀 Get Started' } },
            { type: 'reply', reply: { id: 'more_demo', title: '🔍 See More' } }
          ]
        }
      }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('❌ Demo flow error:', err.response?.data || err.message);
  }
}

async function sendExtendedDemo(to, businessType) {
  const extendedDemos = {
    biz_online_store: [
      "🔄 RETURNS FLOW:",
      "1. Customer messages 'return'",
      "2. AI generates return label",
      "3. WhatsApp notifies when refund processes",
      "",
      "🎯 RECOMMENDATIONS:",
      "1. 'You might also like...' auto-sent",
      "2. Click-to-buy in WhatsApp",
      "3. Loyalty points tracked"
    ],
    biz_hotel: [
      "🛎️ CONCIERGE FLOW:",
      "1. Pre-stay: 'Need airport transfer?'",
      "2. During stay: 'Order room service?'",
      "3. Post-stay: 'Review your stay'",
      "",
      "📈 UPSELL FLOW:",
      "1. 'Upgrade to ocean view for 20% off?'",
      "2. 'Spa package available today'",
      "3. WhatsApp-exclusive offers"
    ]
  };

  const demo = extendedDemos[businessType] || extendedDemos.biz_online_store;
  
  await sendMessage(to, "🔍 Extended Demo:\n\n" + demo.join('\n'));
  await sendFinalCTA(to);
}

async function sendBuyEncouragement(to) {
  const stats = [
    "📈 3.6x higher conversions than web",
    "💬 85% faster response times",
    "🤖 24/7 AI assistant handles 80% queries",
    "🔒 Meta-verified security",
    "📊 Real-time dashboard with ROAS tracking"
  ];

  for (const stat of stats) {
    await sendMessage(to, stat);
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
}

async function sendFinalCTA(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { 
          text: "Ready to transform your business with Official Meta Partner solutions?" 
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'confirm_buy', title: '🛒 Buy Now' } },
            { type: 'reply', reply: { id: 'ai_guide', title: '🤖 AI Suggestions' } }
          ]
        }
      }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('❌ CTA error:', err.response?.data || err.message);
  }
}

async function sendPurchaseOptions(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '💰 Purchase Options' },
        body: { text: 'Select your package:' },
        footer: { text: 'All prices include Meta verification' },
        action: {
          button: 'Choose',
          sections: [
            {
              title: 'Starter Plans',
              rows: [
                { id: 'plan_starter', title: '🌱 Starter ($99/mo)' },
                { id: 'plan_pro', title: '🚀 Pro ($299/mo)' }
              ]
            },
            {
              title: 'Enterprise',
              rows: [
                { id: 'plan_enterprise', title: '🏢 Custom Solution' },
                { id: 'plan_contact', title: '📞 Schedule Call' }
              ]
            }
          ]
        }
      }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('❌ Purchase error:', err.response?.data || err.message);
  }
}

async function sendAISuggestions(to) {
  const userRef = await db.collection('users').doc(to).get();
  const lastBiz = userRef.data()?.lastBusinessType || 'general';
  
  const suggestions = {
    biz_online_store: [
      "Try: 'Show me summer collection'",
      "Try: 'Track order #12345'",
      "Try: 'Start return'",
      "Try: 'Size guide for sneakers'",
      "Tip: Use 'demo' to replay flow"
    ],
    biz_hotel: [
      "Try: 'Check May 15 availability'",
      "Try: 'Pool view upgrade cost'",
      "Try: 'Late checkout options'",
      "Try: 'Airport transfer info'",
      "Tip: Use 'help' for human agent"
    ]
  };

  const msgs = suggestions[lastBiz] || [
    "Try: 'demo' - Experience flow",
    "Try: 'pricing' - See plans",
    "Try: 'support' - Get help",
    "Keyword: 'buy' - Purchase now",
    "Keyword: 'agent' - Human help"
  ];

  await sendMessage(to, "🤖 AI Suggestions:\n\n" + msgs.join('\n'));
}

// ✅ AI Handler
async function getAIResponse(userText, userId) {
  try {
    const userRef = await db.collection('users').doc(userId).get();
    const lastBiz = userRef.data()?.lastBusinessType || 'general';
    const profileName = userRef.data()?.profileName || 'there';

    const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: "mistralai/mistral-7b-instruct",
      messages: [
        { 
          role: "system", 
          content: `You're Fred's Inc AI (Official Meta Partner). Context: ${lastBiz}. Guide users to:\
                    1. Recognize pain points\
                    2. Offer WhatsApp solutions\
                    3. Suggest next steps ('demo', 'buy', etc)\
                    Keep responses under 2 sentences. Use ${profileName}'s name if known.`
        },
        { role: "user", content: userText }
      ]
    }, {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    return res.data.choices?.[0]?.message?.content || "Try 'menu' for options.";
  } catch (err) {
    console.error('❌ AI error:', err.response?.data || err.message);
    return "🔧 System updating. Try 'demo' to continue.";
  }
}

async function sendEmailAlert(from, subjectText) {
  try {
    await transporter.sendMail({
      from: `"Fred's Inc Alerts" <${EMAIL_USER}>`,
      to: ALERT_EMAIL,
      subject: `🚨 Alert: ${subjectText}`,
      text: `User ${from} triggered: ${subjectText}`,
    });
  } catch (error) {
    console.error('❌ Email error:', error.message);
  }
}

// ✅ Create default agent
(async () => {
  const agentId = 'fred-jr';
  const agentRef = db.collection('agents').doc(agentId);
  const agentDoc = await agentRef.get();

  if (!agentDoc.exists) {
    await agentRef.set({
      name: 'Fred Jr',
      email: 'Juniorokovagng@gmail.com',
      active: true,
      assignedCount: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('✅ Default agent created');
  }
})();

// ✅ Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
