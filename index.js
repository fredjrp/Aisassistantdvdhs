require('dotenv').config();
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const app = express();
const usersRef = require('./firebase'); // Your existing Firebase setup

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "your_custom_token";

app.use(express.json());

// Email transporter setup
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// AI Assistant Configuration
const AI_CONFIG = {
  name: "Linda",
  role: "IT Support and Shopping Assistant",
  restrictions: [
    "Only respond to IT-related queries",
    "For shopping, only provide links to products",
    "Politely decline all other requests"
  ],
  shoppingBaseUrl: process.env.SHOPPING_URL || "https://example.com/products"
};

// Default welcome template for Linda
const WELCOME_TEMPLATE = {
  name: "welcome_message",
  description: "Default welcome message from Linda",
  triggers: ["hello", "hi", "hey", "start"],
  content: {
    type: "interactive",
    header: {
      type: "text",
      text: `Hi! I'm ${AI_CONFIG.name} 👩‍💻`
    },
    body: {
      text: `I'm your ${AI_CONFIG.role}. How can I help you today?`
    },
    footer: {
      text: "I specialize in IT support and can share product links"
    },
    action: {
      button: "Menu Options",
      sections: [
        {
          title: "IT Support",
          rows: [
            {
              id: "it_support_option",
              title: "IT Help",
              description: "Get assistance with technology issues"
            },
            {
              id: "troubleshooting_option",
              title: "Troubleshooting",
              description: "Help solving technical problems"
            }
          ]
        },
        {
          title: "Shopping",
          rows: [
            {
              id: "laptops_option",
              title: "Laptops",
              description: "Browse our laptop collection"
            },
            {
              id: "accessories_option",
              title: "Accessories",
              description: "See tech accessories"
            }
          ]
        }
      ]
    }
  }
};

// Initialize templates collection on startup
async function initializeTemplates() {
  try {
    const templatesRef = usersRef.firestore.collection('whatsapp_templates');
    const welcomeTemplate = await templatesRef.doc('welcome_message').get();
    
    if (!welcomeTemplate.exists) {
      await templatesRef.doc('welcome_message').set(WELCOME_TEMPLATE);
      console.log('✅ Created default welcome template');
    }
  } catch (error) {
    console.error('❌ Error initializing templates:', error);
  }
}

// Routes
app.get('/', (req, res) => {
  res.send(`WhatsApp Business API with ${AI_CONFIG.name} AI Assistant`);
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const challenge = req.query['hub.challenge'];
  const token = req.query['hub.verify_token'];

  if (mode && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    console.warn('❌ Webhook verification failed');
    res.sendStatus(403);
  }
});

// Webhook handler with AI restrictions
app.post('/webhook', async (req, res) => {
  const { entry } = req.body;

  if (!entry || !entry[0]?.changes?.[0]?.value?.messages?.[0]) {
    return res.status(400).send('Invalid Request');
  }

  const message = entry[0].changes[0].value.messages[0];
  const from = message.from;
  const userMessage = message.type === 'text' ? message.text.body : '';
  const messageId = message.id;

  console.log(`📩 Message from ${from}: ${userMessage}`);

  try {
    // Check for first-time user
    const userDoc = await usersRef.doc(from).get();
    const firstTime = !userDoc.exists || !userDoc.data().greeted;

    // Send welcome template for first-time users
    if (firstTime) {
      const welcomeTemplate = await usersRef.firestore.collection('whatsapp_templates')
        .doc('welcome_message').get();
      
      if (welcomeTemplate.exists) {
        await usersRef.doc(from).set({ greeted: true }, { merge: true });
        await sendInteractiveMessage(from, welcomeTemplate.data().content);
        return res.status(200).send('OK');
      }
    }

    // Handle interactive messages
    if (message.type === 'interactive') {
      if (message.interactive.type === 'list_reply') {
        const selectedId = message.interactive.list_reply.id;
        
        // Handle IT support options
        if (selectedId.includes('it_')) {
          await replyMessage(from, "Please describe your IT issue and I'll do my best to help.", messageId);
          return res.status(200).send('OK');
        }
        
        // Handle shopping options
        if (selectedId.includes('_option')) {
          const productType = selectedId.split('_')[0];
          const shoppingLink = `${AI_CONFIG.shoppingBaseUrl}/${productType}`;
          await replyMessage(from, `You can browse our ${productType} here: ${shoppingLink}`, messageId);
          return res.status(200).send('OK');
        }
      }
    }

    // Process text messages with AI
    if (message.type === 'text') {
      const aiResponse = await generateAIResponse(userMessage);
      await replyMessage(from, aiResponse, messageId);
    }

  } catch (error) {
    console.error('Error handling message:', error);
    await replyMessage(from, "Oops! Something went wrong. Please try again.", messageId);
  }

  res.status(200).send('OK');
});

// AI Response Generator with restrictions
async function generateAIResponse(message) {
  // Check for shopping-related keywords
  const shoppingKeywords = ['buy', 'purchase', 'shop', 'product', 'laptop', 'accessory'];
  const isShoppingRequest = shoppingKeywords.some(keyword => 
    message.toLowerCase().includes(keyword)
  );

  if (isShoppingRequest) {
    const productType = extractProductType(message);
    if (productType) {
      return `You can browse our ${productType} collection here: ${AI_CONFIG.shoppingBaseUrl}/${productType}`;
    }
    return `Here's our main shopping page: ${AI_CONFIG.shoppingBaseUrl}`;
  }

  // Check if message is IT-related
  const itKeywords = ['computer', 'tech', 'it', 'software', 'hardware', 'install', 'error', 'problem', 'fix'];
  const isItRelated = itKeywords.some(keyword => 
    message.toLowerCase().includes(keyword)
  );

  if (!isItRelated) {
    return `I'm sorry, as ${AI_CONFIG.name} I can only assist with IT-related questions or provide shopping links. Is there something technical I can help you with?`;
  }

  // Generate IT support response
  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "mistralai/mistral-7b-instruct",
        messages: [{
          role: "system",
          content: `You are ${AI_CONFIG.name}, a professional IT support assistant. 
                  Only respond to IT-related questions. For all other requests, politely decline.
                  Keep responses concise and technical.`
        }, {
          role: "user",
          content: message
        }],
        max_tokens: 500,
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    
    return response.data.choices[0].message.content;
  } catch (error) {
    console.error('AI API error:', error);
    return "I'm having trouble processing your request. Please try again later.";
  }
}

function extractProductType(message) {
  const products = {
    'laptop': 'laptops',
    'computer': 'laptops',
    'accessory': 'accessories',
    'mouse': 'accessories',
    'keyboard': 'accessories',
    'monitor': 'accessories'
  };

  for (const [keyword, productType] of Object.entries(products)) {
    if (message.toLowerCase().includes(keyword)) {
      return productType;
    }
  }
  return null;
}

// Messaging functions
async function sendTextMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
  console.log("💬 Sent text to", to);
}

async function replyMessage(to, body, messageId) {
  await axios({
    url: `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    method: 'post',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    data: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        body
      },
      context: {
        message_id: messageId
      }
    })
  });
}

async function sendInteractiveMessage(to, interactiveContent) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: interactiveContent
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log("📋 Sent interactive message to", to);
    return response.data;
  } catch (error) {
    console.error("❌ Failed to send interactive message:", error.response?.data || error.message);
    throw error;
  }
}

// Initialize server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initializeTemplates();
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🤖 AI Assistant: ${AI_CONFIG.name}`);
  console.log("📞 PHONE ID:", process.env.WHATSAPP_PHONE_NUMBER_ID);
  console.log("🔐 TOKEN:", WHATSAPP_ACCESS_TOKEN?.slice(0, 6) + '...');
});
