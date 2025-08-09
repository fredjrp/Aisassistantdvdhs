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
  EMAIL_PASS
} = process.env;

const rawConfig = JSON.parse(process.env.FIREBASE_CONFIG);
rawConfig.private_key = rawConfig.private_key.replace(/\\n/g, '\n');
admin.initializeApp({ credential: admin.credential.cert(rawConfig) });
const db = admin.firestore();

// Initialize collections with proper error handling
async function initializeCollections() {
  try {
    const collections = ['products', 'users', 'orders', 'whatsapp_logs'];
    for (const col of collections) {
      const snapshot = await db.collection(col).limit(1).get();
      if (snapshot.empty) {
        if (col === 'products') {
          await db.collection(col).add({
            name: "Premium Power Bank",
            description: "20000mAh Fast Charging",
            price: 3500,
            images: ["https://example.com/powerbank.jpg"],
            active: true,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        } else {
          await db.collection(col).add({ initialized: true });
        }
        console.log(`Created collection ${col}`);
      }
    }
  } catch (error) {
    console.error("Initialization error:", error);
  }
}

initializeCollections();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

// WhatsApp message functions with improved error handling
async function sendMessage(to, text) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Message sending error:', error.response?.data || error.message);
    throw error;
  }
}

async function sendInteractiveMessage(to, interactiveData) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'interactive',
        interactive: interactiveData
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Interactive message error:', error.response?.data || error.message);
    throw error;
  }
}

// Product catalog with proper error handling
async function sendProductCatalog(to) {
  try {
    const snapshot = await db.collection('products').where('active', '==', true).get();
    if (snapshot.empty) {
      await sendMessage(to, "No products available at the moment.");
      return;
    }

    const products = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.name.length > 24 ? data.name.substring(0, 21) + '...' : data.name,
        description: `KES ${data.price}`,
        ...data
      };
    });

    // Send first product details
    const firstProduct = products[0];
    await sendMessage(to, 
      `${firstProduct.title}\n${firstProduct.description}\n${firstProduct.details || ''}`
    );

    // Prepare interactive list for remaining products
    if (products.length > 1) {
      const interactiveData = {
        type: 'list',
        header: { 
          type: 'text', 
          text: 'Our Products'
        },
        body: { 
          text: 'Select a product:' 
        },
        action: {
          button: 'Browse',
          sections: [{
            title: 'Products',
            rows: products.slice(1).map(product => ({
              id: `product_${product.id}`,
              title: product.title,
              description: product.description
            }))
          }]
        }
      };

      await sendInteractiveMessage(to, interactiveData);
    }
  } catch (error) {
    console.error('Catalog error:', error);
    await sendMessage(to, "We're having technical difficulties. Please try again later.");
  }
}

// Webhook handlers
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    const from = message?.from;

    if (!message || !from) {
      return res.sendStatus(200);
    }

    console.log('Received message:', message.type, 'from:', from);

    // Handle text messages
    if (message.type === 'text') {
      const text = message.text.body.toLowerCase().trim();
      
      if (text === 'menu') {
        await sendWelcomeMessage(from);
        return res.sendStatus(200);
      }
    }

    // Handle interactive messages
    if (message.type === 'interactive') {
      const interactiveType = message.interactive.type;
      let responseId = '';

      if (interactiveType === 'button_reply') {
        responseId = message.interactive.button_reply.id;
      } else if (interactiveType === 'list_reply') {
        responseId = message.interactive.list_reply.id;
      }

      if (responseId === 'welcome_yes' || responseId === 'welcome_no') {
        await db.collection('users').doc(from).set({
          isEstateResident: responseId === 'welcome_yes',
          phone: from,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        await sendProductCatalog(from);
      } else if (responseId.startsWith('product_')) {
        const productId = responseId.replace('product_', '');
        await sendProductDetails(from, productId);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

// Welcome message with working buttons
async function sendWelcomeMessage(to) {
  try {
    const interactiveData = {
      type: 'button',
      body: {
        text: "Welcome to Mountain View Electronics!\nAre you a Mountain View Estate resident?"
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'welcome_yes', title: 'Yes' } },
          { type: 'reply', reply: { id: 'welcome_no', title: 'No' } }
        ]
      }
    };
    await sendInteractiveMessage(to, interactiveData);
  } catch (error) {
    console.error('Welcome message error:', error);
    await sendMessage(to, "Welcome! Please type 'menu' to see options.");
  }
}

// Product details function
async function sendProductDetails(to, productId) {
  try {
    const doc = await db.collection('products').doc(productId).get();
    if (!doc.exists) {
      await sendMessage(to, "Product not found.");
      return;
    }

    const product = doc.data();
    const userDoc = await db.collection('users').doc(to).get();
    const isResident = userDoc.exists ? userDoc.data().isEstateResident : false;

    let message = `${product.name}\n${product.description}\nPrice: KES ${product.price}`;
    if (isResident) {
      message += "\n\nAs a resident, you qualify for a free trial!";
    }

    const interactiveData = {
      type: 'button',
      body: { text: message },
      action: {
        buttons: isResident ? [
          { type: 'reply', reply: { id: `trial_${productId}`, title: 'Start Free Trial' } },
          { type: 'reply', reply: { id: 'back_to_catalog', title: 'Back to Catalog' } }
        ] : [
          { type: 'reply', reply: { id: `buy_${productId}`, title: 'Purchase Now' } },
          { type: 'reply', reply: { id: 'back_to_catalog', title: 'Back to Catalog' } }
        ]
      }
    };

    await sendInteractiveMessage(to, interactiveData);
  } catch (error) {
    console.error('Product details error:', error);
    await sendMessage(to, "Couldn't load product details. Please try again.");
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
