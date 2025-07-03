require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

const corsOptions = {
  origin: 'https://fredjrp.github.io',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

const {
  WHATSAPP_ACCESS_TOKEN,
  WEBHOOK_VERIFY_TOKEN,
  PHONE_NUMBER_ID,
  OPENROUTER_API_KEY,
  EMAIL_USER,
  EMAIL_PASS,
  ALERT_EMAIL
} = process.env;

const rawConfig = JSON.parse(process.env.FIREBASE_CONFIG);
rawConfig.private_key = rawConfig.private_key.replace(/\\n/g, '\n');
admin.initializeApp({ credential: admin.credential.cert(rawConfig) });
const db = admin.firestore();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

app.get('/', (req, res) => res.send('✅ WhatsApp Bot running'));

app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode && token === WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  const changes = req.body.entry?.[0]?.changes?.[0];
  const message = changes?.value?.messages?.[0];
  const profileName = message?.profile?.name;
  const from = message?.from;

  const userDoc = await db.collection('users').doc(from).get();
  if (userDoc.exists && userDoc.data().aiEnabled === false) {
    return res.sendStatus(200);
  }

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

  async function sendMessage(to, text) {
    try {
      await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text }
      }, {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
    } catch (err) {
      console.error('❌ Send message error:', err.response?.data || err.message);
    }
  }

  async function sendContactCard(to) {
    try {
      await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
        messaging_product: 'whatsapp',
        to,
        type: 'contacts',
        contacts: [
          {
            name: {
              formatted_name: "Fred Junior",
              first_name: "Fred",
              last_name: "Junior"
            },
            org: {
              company: "Fred's Computers",
              department: "Support",
              title: "Founder & Automation Expert"
            },
            phones: [
              {
                phone: "+254703738935",
                type: "mobile",
                wa_id: "254703738935"
              }
            ],
            emails: [
              {
                email: "juniorokovagng@gmail.com",
                type: "work"
              }
            ],
            urls: [
              {
                url: "https://fredscomputers.co.ke",
                type: "work"
              }
            ]
          }
        ]
      }, {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
    } catch (err) {
      console.error("❌ Contact send error:", err.response?.data || err.message);
    }
  }

  async function sendDocument(to, document) {
    const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      to: to,
      type: "document",
      document: {
        link: document.link,
        filename: document.filename
      }
    };

    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
  }

  async function replyMessage(to, text, messageId) {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      context: { message_id: messageId },
      type: 'text',
      text: { body: text }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  }

  if (type === 'text') {
    const text = lastMessageText.toLowerCase();
    if (text.includes('hi') || text.includes('hello') || text.includes('hey')) {
      await replyMessage(from, `Hi ${profileName || 'there'}! 🚀 Welcome to Fred's Inc, Official Meta Partner for WhatsApp. How can we help?`, messageId);
      await sendMainMenu(from);
    } else if (text.includes('help') || text.includes('support') || text.includes('assist')) {
      await replyMessage(from, 'An agent will contact you shortly.');
      await sendEmailAlert(from, 'User requested help');
    } else if (text.includes('menu') || text.includes('options') || text.includes('start')) {
      await sendMainMenu(from);
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

      if (userSelection === 'benefits') {
        await sendPlanDetails(from, 'starter');
      }
      else if (userSelection.startsWith('biz_')) {
        await db.collection('users').doc(from).update({ lastBusinessType: userSelection });
        await sendBusinessDemoFlow(from, userSelection);
      }
      else if (userSelection === 'buy_now') {
        await sendMessage(from, "🎉 Fantastic choice! Here's why Fred's Inc is perfect for you:");
        await sendBuyEncouragement(from);
        await sendFinalCTA(from);
        await sendDocument(from, {
          link: "https://github.com/fredjrp/investus/blob/fred/junior/Fred%20Official%20WhatsApp%20Automation%20Document.pdf",
          filename: "Fred Official WhatsApp Automation Document.pdf"
        });
      }
      else if (userSelection === 'pricing') {
        await sendPurchaseOptions(from);
      }
      else if (userSelection === 'support') {
        await sendMessage(from, "Please describe your issue and an agent will contact you shortly.");
        await sendEmailAlert(from, "User requested support");
        await sendContactCard(from);
      }
      else if (userSelection === 'confirm_buy') {
        await sendPaymentMethods(from);
      }
      else if (userSelection === 'more_demo') {
        const userRef = await db.collection('users').doc(from).get();
        const lastBiz = userRef.data()?.lastBusinessType || 'biz_online_store';
        await sendExtendedDemo(from, lastBiz);
      }
      else if (userSelection === 'plan_starter') {
        await sendPlanDetails(from, 'starter');
      }
      else if (userSelection === 'plan_pro') {
        await sendPlanDetails(from, 'pro');
      }
      else if (userSelection === 'plan_enterprise') {
        await sendEnterpriseContactForm(from);
      }
      else if (userSelection === 'plan_contact') {
        await sendContactScheduler(from);
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
      else if (replyId === 'buy_now') {
        await sendMessage(from, "🎉 Fantastic choice! Here's why Fred's Inc is perfect for you:");
        await sendBuyEncouragement(from);
        await sendFinalCTA(from);
      }
      else if (replyId === 'more_demo') {
        const userRef = await db.collection('users').doc(from).get();
        const lastBiz = userRef.data()?.lastBusinessType || 'biz_online_store';
        await sendExtendedDemo(from, lastBiz);
      }
      else if (replyId === 'confirm_buy') {
        await sendPaymentMethods(from);
      }
    }
  }
  res.sendStatus(200);
});

async function sendPlanSelector(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: "📦 Choose your ideal WhatsApp Automation Plan:"
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'plan_starter', title: '🌱 Starter' } },
            { type: 'reply', reply: { id: 'plan_pro', title: '🚀 Pro' } },
            { type: 'reply', reply: { id: 'plan_enterprise', title: '🏢 Enterprise' } }
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
    console.error('❌ Plan selector error:', err.response?.data || err.message);
  }
}

async function sendPlanDetails(to, planType) {
  const plans = {
    starter: {
      name: "🌱 Starter Plan",
      price: "Ksh950/month",
      features: [
        "✔️ WhatsApp Business API setup",
        "✔️ Basic automation flows",
        "✔️ 500 conversations/month",
        "✔️ Email support (24h response)",
        "✔️ Meta verification included"
      ],
      cta: "Perfect for new businesses!"
    },
    pro: {
      name: "🚀 Pro Plan",
      price: "Ksh9,999/month",
      features: [
        "✔️ Everything in Starter PLUS",
        "✔️ Advanced AI automation",
        "✔️ 5,000 conversations/month",
        "✔️ Priority phone/chat support",
        "✔️ Performance analytics dashboard",
        "✔️ CRM integration"
      ],
      cta: "Best for scaling businesses!"
    },
    enterprise: {
      name: "🏢 Enterprise Plan",
      price: "Custom Pricing",
      features: [
        "✔️ Everything in Pro PLUS",
        "✔️ Unlimited conversations",
        "✔️ Dedicated account manager",
        "✔️ Onboarding & team training",
        "✔️ SLA-backed uptime",
        "✔️ Multi-agent live chat support"
      ],
      cta: "Ideal for large or complex teams!"
    }
  };

  const plan = plans[planType] || plans.starter;

  try {
    await sendMessage(to, `✨ ${plan.name} (${plan.price})\n\n${plan.features.join('\n')}\n\n${plan.cta}`);
    
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { 
          text: `Ready to activate your ${plan.name}?` 
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'confirm_buy', title: 'Join Now' } },
            { type: 'reply', reply: { id: 'to_agent', title: 'Talk to Sales' } },
            { type: 'reply', reply: { id: 'more_info', title: 'Request PDF Info' } }
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
    console.error('❌ Plan details error:', err.response?.data || err.message);
  }
}

async function sendPaymentMethods(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '💳 Payment Options' },
        body: { text: 'Choose your preferred payment method:' },
        footer: { text: 'Instant activation after payment' },
        action: {
          button: 'Select',
          sections: [
            {
              title: 'Digital Payments',
              rows: [
                { id: 'pay_mpesa', title: 'M-Pesa', description: 'Pay via Lipa Na M-Pesa' },
                { id: 'pay_card', title: 'Credit/Debit Card', description: 'Visa, Mastercard, etc' },
                { id: 'pay_paypal', title: 'PayPal', description: 'Use your PayPal balance' }
              ]
            },
            {
              title: 'Other Options',
              rows: [
                { id: 'pay_bank', title: 'Bank Transfer', description: 'Direct to our account' },
                { id: 'pay_crypto', title: 'Crypto', description: 'BTC, ETH, or USDT' },
                { id: 'pay_other', title: 'Other Method', description: 'Request alternative payment' }
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
    console.error('❌ Payment methods error:', err.response?.data || err.message);
  }
}

async function sendEnterpriseContactForm(to) {
  try {
    await sendMessage(to, `📋 Let's customize your enterprise solution!\n\nPlease provide:\n1. Your business name\n2. Estimated monthly message volume\n3. Any special requirements\n\nOr type 'cancel' to return.`);
    
    await db.collection('users').doc(to).update({
      awaitingEnterpriseDetails: true,
      enterpriseRequestAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.error('❌ Enterprise form error:', err.response?.data || err.message);
  }
}

async function sendContactScheduler(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { 
          text: "📅 Let's schedule your consultation!\n\nPick an option below or suggest your preferred time." 
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'schedule_am', title: 'Morning (9AM-12PM)' } },
            { type: 'reply', reply: { id: 'schedule_pm', title: 'Afternoon (1PM-5PM)' } },
            { type: 'reply', reply: { id: 'schedule_custom', title: 'Suggest Time' } }
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
    console.error('❌ Scheduler error:', err.response?.data || err.message);
  }
}

async function getAIResponse(userText, userId) {
  try {
    const userRef = await db.collection('users').doc(userId).get();
    const userData = userRef.data() || {};
    const lastBiz = userData.lastBusinessType || 'general';
    const profileName = userData.profileName || 'friend';

    if (userData.awaitingEnterpriseDetails) {
      await db.collection('enterprise_requests').add({
        user: userId,
        details: userText,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      
      await db.collection('users').doc(userId).update({
        awaitingEnterpriseDetails: false
      });
      
      return `Thank you, ${profileName}! Our enterprise team will contact you within 1 business day with a custom proposal. Meanwhile, explore our features with 'demo' or ask me anything!`;
    }

    const personalityTraits = [
      "You're Fred's Inc AI (Official Meta Partner) - charming, witty, and persuasive",
      "Use emojis tastefully to enhance communication",
      "Address users by name when known",
      "When unsure, suggest trying 'demo' or 'pricing'",
      "For objections, highlight 3.6x ROAS and Meta partnership"
    ];

    const businessContexts = {
      biz_online_store: "eCommerce store looking to boost sales",
      biz_hotel: "hotel aiming to streamline bookings",
      biz_restaurant: "restaurant wanting faster orders",
      biz_broker: "stock broker needing client alerts",
      biz_logistics: "logistics company optimizing deliveries",
      biz_cyber: "cyber cafe automating services"
    };

    const context = businessContexts[lastBiz] || "business exploring WhatsApp solutions";

    const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: "mistralai/mistral-7b-instruct",
      messages: [
        { 
          role: "system", 
          content: `${personalityTraits.join('\n')}\n\nCurrent context: Helping ${profileName} with their ${context}. Key goals:\n1. Identify pain points\n2. Offer tailored solutions\n3. Guide to relevant menus ('demo', 'pricing')\n4. Close with clear CTAs\n\nKeep responses conversational yet professional under 3 sentences.` 
        },
        { role: "user", content: userText }
      ],
      temperature: 0.7
    }, {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    let response = res.data.choices?.[0]?.message?.content || "Try 'menu' for options.";
    
    if (response.length < 100 && !response.includes('menu') && !response.includes('demo')) {
      const suggestions = {
        biz_online_store: "\n\nTry 'demo' to see our eCommerce flows or 'pricing' for plans!",
        biz_hotel: "\n\nWant to see booking automation? Just say 'demo'!",
        general: "\n\nExplore options with 'menu' or ask me anything!"
      };
      response += suggestions[lastBiz] || suggestions.general;
    }

    return response;
  } catch (err) {
    console.error('❌ AI error:', err.response?.data || err.message);
    return "🔧 My circuits are a bit busy! Try 'menu' to continue or 'help' for support.";
  }
}

async function sendMainMenu(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '📋 Fred\'s Inc - Official Meta Partner' },
        body: { text: 'Boost your business with our AI-powered WhatsApp solutions. Select a service below to learn more.' },
        footer: { text: '📊 3.6x Avg ROAS • 55% Lower Ad Costs • 24/7 Support' },
        action: {
          button: 'Explore Menu',
          sections: [
            {
              title: '🚀 Core Features',
              rows: [
                {
                  id: 'benefits',
                  title: 'Why WhatsApp?',
                  description: 'Discover the advantages of WhatsApp for your business'
                },
                {
                  id: 'demo',
                  title: 'Try Demo',
                  description: 'Experience an interactive sample journey'
                },
                {
                  id: 'case_studies',
                  title: 'Success Stories',
                  description: 'See how businesses like yours succeeded'
                }
              ]
            },
            {
              title: '🛠️ Get Started',
              rows: [
                {
                  id: 'pricing',
                  title: 'Pricing Plans',
                  description: 'Flexible packages to suit every business size'
                },
                {
                  id: 'support',
                  title: 'Talk to Support',
                  description: 'Need help? Reach a real human agent now'
                },
                {
                  id: 'onboarding',
                  title: 'Quick Start Guide',
                  description: 'Get running in minutes'
                }
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
        header: { type: 'text', text: '🏢 Select Your Business Type' },
        body: { text: 'Choose a category to explore solutions made for you.' },
        footer: { text: 'Official Meta Partner • Trusted & Verified' },
        action: {
          button: 'Choose a Category',
          sections: [
            {
              title: '🛍️ Retail & E-commerce',
              rows: [
                {
                  id: 'biz_online_store',
                  title: 'Online Store',
                  description: 'E-commerce automation & customer support'
                },
                {
                  id: 'biz_offline_store',
                  title: 'Physical Store',
                  description: 'POS, payments & inventory tools'
                },
                {
                  id: 'biz_fashion',
                  title: 'Fashion Boutique',
                  description: 'Virtual try-ons & styling'
                }
              ]
            },
            {
              title: '🍽️ Food & Hospitality',
              rows: [
                {
                  id: 'biz_restaurant',
                  title: 'Restaurant',
                  description: 'Manage menus, orders & delivery'
                },
                {
                  id: 'biz_hotel',
                  title: 'Hotel',
                  description: 'Booking systems & concierge'
                },
                {
                  id: 'biz_catering',
                  title: 'Catering',
                  description: 'Event bookings & menus'
                }
              ]
            },
            {
              title: '💼 Professional Services',
              rows: [
                {
                  id: 'biz_broker',
                  title: 'Stock Broker',
                  description: 'Client alerts & CRM'
                },
                {
                  id: 'biz_logistics',
                  title: 'Logistics',
                  description: 'Track orders & drivers'
                },
                {
                  id: 'biz_consulting',
                  title: 'Consulting',
                  description: 'Appointment scheduling'
                }
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
        header: { type: 'text', text: ` ${businessType.replace('biz_', '').replace('_', ' ').toUpperCase()} FLOW` },
        body: { 
          text: `Here's how it works:\n\n${flow.steps.join('\n')}\n\nTry keywords: ${flow.keywords.slice(0, 3).join(', ')}` 
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'buy_now', title: 'Get Started' } },
            { type: 'reply', reply: { id: 'more_demo', title: 'See More' } }
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
    "3.6x higher conversions than web",
    "85% faster response times",
    "24/7 AI assistant handles 80% queries",
    "Meta-verified security",
    "Real-time dashboard with ROAS tracking"
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
            { type: 'reply', reply: { id: 'confirm_buy', title: 'Join Now' } },
            { type: 'reply', reply: { id: 'ai_guide', title: 'Linda Suggestions' } }
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
        body: { text: 'Select your preferred package below:' },
        footer: { text: 'All prices include Meta verification' },
        action: {
          button: 'Choose',
          sections: [
            {
              title: 'Starter Plans',
              rows: [
                { id: 'plan_basic', title: '🟢 Basic ($49/mo)', description: 'For individuals and small teams' },
                { id: 'plan_starter', title: '🌱 Starter ($99/mo)', description: 'For growing businesses' },
                { id: 'plan_pro', title: '🚀 Pro ($299/mo)', description: 'Advanced features for scaling' }
              ]
            },
            {
              title: 'Enterprise & Add-ons',
              rows: [
                { id: 'plan_premium', title: '💎 Premium Support ($499/mo)', description: 'Priority access and support' },
                { id: 'plan_enterprise', title: '🏢 Custom Solution', description: 'Tailored for large businesses' },
                { id: 'plan_contact', title: '📞 Schedule Call', description: 'Talk to our team directly' }
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

  await sendMessage(to, "My Suggestions:\n\n" + msgs.join('\n'));
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

app.post('/agent-webhook', async (req, res) => {
  const { action, phoneNumber, agentId } = req.body;
  
  try {
    const userRef = db.collection('users').doc(phoneNumber);
    
    if (action === 'assign') {
      await userRef.set({
        assignedAgent: agentId,
        status: 'assigned',
        aiEnabled: false,
        assignedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      
      await sendMessage(phoneNumber, `You've been connected to agent ${agentId}. They'll respond shortly.`);
      
    } else if (action === 'toggle_ai') {
      const userDoc = await userRef.get();
      const currentAIStatus = userDoc.data()?.aiEnabled ?? true;
      
      await userRef.update({
        aiEnabled: !currentAIStatus,
        status: !currentAIStatus ? 'ai' : 'assigned'
      });
      
      const statusMessage = !currentAIStatus ? 
        "AI assistant is now handling this conversation" :
        "Agent is now handling this conversation";
        
      await sendMessage(phoneNumber, statusMessage);
    }
    
    res.sendStatus(200);
  } catch (err) {
    console.error('Agent webhook error:', err);
    res.status(500).send(err.message);
  }
});

app.post('/send-message', async (req, res) => {
  const { to, type, text } = req.body;

  if (!to || !text) return res.status(400).json({ error: 'Missing "to" or "text"' });

  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: type || 'text',
      text: { body: text }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    // Optional: save outgoing message to Firestore logs
    await db.collection('whatsapp_logs').add({
      to,
      type,
      message: { text: { body: text } },
      direction: 'outgoing',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, message: 'Message sent' });
  } catch (err) {
    console.error('❌ Send-message API error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
