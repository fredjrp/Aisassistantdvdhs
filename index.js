require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { GoogleSpreadsheet } = require('google-spreadsheet');

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
  ALERT_EMAIL,
  GOOGLE_SHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  PUBLIC_KEY,
  GOOGLE_PRIVATE_KEY
} = process.env;

const publicKey = process.env.PUBLIC_KEY?.replace(/\\n/g, '\n');

const rawConfig = JSON.parse(process.env.FIREBASE_CONFIG);
rawConfig.private_key = rawConfig.private_key.replace(/\\n/g, '\n');
admin.initializeApp({ credential: admin.credential.cert(rawConfig) });
const db = admin.firestore();

// Initialize required collections
async function initializeCollections() {
  const collections = [
    'whatsapp_logs',
    'users',
    'products',
    'orders',
    'deliveries',
    'cases',
    'loyalty_points',
    'product_education',
    'complementary_products'
  ];

  for (const collectionName of collections) {
    try {
      const collectionRef = db.collection(collectionName);
      const snapshot = await collectionRef.limit(1).get();
      if (snapshot.empty) {
        // Create collection with a dummy document if it doesn't exist
        await collectionRef.doc('init').set({ initialized: true });
        console.log(`Created collection: ${collectionName}`);
      }
    } catch (err) {
      console.error(`Error initializing collection ${collectionName}:`, err);
    }
  }

  // Initialize default products if none exist
  const productsRef = db.collection('products');
  const productsSnapshot = await productsRef.limit(1).get();
  if (productsSnapshot.empty) {
    const defaultProducts = [
      {
        name: "Premium Power Bank 10000mAh",
        description: "High capacity portable charger",
        price: 2500,
        trial_days: 7,
        images: ["powerbank_front.jpg", "powerbank_back.jpg"],
        category: "power_banks",
        stock: 100,
        created_at: admin.firestore.FieldValue.serverTimestamp()
      },
      {
        name: "Wireless Earbuds",
        description: "Bluetooth 5.0 with charging case",
        price: 3500,
        trial_days: 7,
        images: ["earbuds_front.jpg", "earbuds_back.jpg"],
        category: "audio",
        stock: 50,
        created_at: admin.firestore.FieldValue.serverTimestamp()
      }
    ];

    for (const product of defaultProducts) {
      await productsRef.add(product);
    }
    console.log("Added default products");
  }
}

initializeCollections().catch(console.error);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

const AGENT_RESPONSE_TIMEOUT = 5000;
const DEMO_DELAY = 2000;
const agentResponseTimers = new Map();

async function logMessage(direction, messageData) {
  try {
    const logData = {
      ...messageData,
      direction,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      aiGenerated: direction === 'outgoing' && messageData.ai || false
    };

    Object.keys(logData).forEach(key => {
      if (logData[key] === undefined) {
        delete logData[key];
      }
    });

    await db.collection('whatsapp_logs').add(logData);
  } catch (err) {
    console.error('Failed to log message:', err);
  }
}

async function sendMessage(to, text, isAI = false) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    await logMessage('outgoing', {
      to,
      from: PHONE_NUMBER_ID,
      type: 'text',
      message: { text: { body: text } },
      messageId: response.data.messages?.[0]?.id,
      ai: isAI
    });

    return response;
  } catch (err) {
    console.error('Send message error:', err.response?.data || err.message);
    throw err;
  }
}

async function sendInteractiveMessage(to, interactiveData) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: interactiveData
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    await logMessage('outgoing', {
      to,
      from: PHONE_NUMBER_ID,
      type: 'interactive',
      message: interactiveData,
      messageId: response.data.messages?.[0]?.id
    });

    return response;
  } catch (err) {
    console.error('Interactive message error:', err.response?.data || err.message);
    throw err;
  }
}

async function sendImageMessage(to, imageUrl, caption = '') {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: {
          link: imageUrl,
          caption: caption
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    await logMessage('outgoing', {
      to,
      from: PHONE_NUMBER_ID,
      type: 'image',
      message: { image: { link: imageUrl, caption: caption } },
      messageId: response.data.messages?.[0]?.id
    });

    return response;
  } catch (err) {
    console.error('Image message error:', err.response?.data || err.message);
    throw err;
  }
}

async function updateGoogleSheet(userData) {
  try {
    if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
      console.log('Google Sheets credentials missing - skipping update');
      return;
    }

    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID);
    await doc.useServiceAccountAuth({
      client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    });

    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    
    const rows = await sheet.getRows();
    const existingRow = rows.find(row => row['Phone'] === userData.phone);

    const record = {
      'Timestamp': new Date().toISOString(),
      'Phone': userData.phone,
      'Name': userData.name || '',
      'Address': userData.address || '',
      'UserType': userData.userType || '',
      'LoyaltyPoints': userData.loyaltyPoints || 0,
      'LastOrderDate': userData.lastOrderDate || '',
      'Status': userData.status || 'active',
      'LastActive': new Date().toISOString()
    };

    if (existingRow) {
      Object.keys(record).forEach(key => {
        existingRow[key] = record[key];
      });
      await existingRow.save();
    } else {
      await sheet.addRow(record);
    }
  } catch (err) {
    console.error('Google Sheets error:', err.message);
  }
}

async function getAIResponse(userText, userId) {
  const userRef = await db.collection('users').doc(userId).get();
  const userData = userRef.data() || {};
  
  const personality = {
    tone: "professional and helpful",
    traits: [
      "Keep responses under 200 characters",
      "Use bullet points when appropriate",
      "Focus on product benefits",
      "Provide clear next steps"
    ]
  };

  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: "mistralai/mistral-7b-instruct",
        messages: [
          { 
            role: "system", 
            content: `You are Mountain View Electronics WhatsApp assistant. Be ${personality.tone}.\n` +
                     `${personality.traits.join('\n')}\n\n` +
                     `Current user context:\n` +
                     `Name: ${userData.name || 'Customer'}\n` +
                     `Status: ${userData.status || 'New'}\n` +
                     `Loyalty Points: ${userData.loyaltyPoints || 0}`
          },
          { role: "user", content: userText }
        ],
        temperature: 0.7,
        max_tokens: 150
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    let response = res.data.choices?.[0]?.message?.content || "I didn't understand that. Could you rephrase?";
    await logMessage('outgoing', {
      to: userId,
      from: PHONE_NUMBER_ID,
      type: 'text',
      message: { text: { body: response } },
      originalMessage: userText,
      ai: true
    });

    return response;
  } catch (err) {
    console.error('AI error:', err.response?.data || err.message);
    return "I'm currently having trouble processing your request. Please try again later or visit our website for assistance.";
  }
}

async function registerNewUser(userId) {
  await db.collection('users').doc(userId).set({
    phone: userId,
    status: 'new',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    lastActive: admin.firestore.FieldValue.serverTimestamp(),
    loyaltyPoints: 0,
    address: '',
    userType: 'potential',
    trialProducts: [],
    orders: [],
    cases: []
  }, { merge: true });
}

async function sendWelcomeMessage(to) {
  const interactiveData = {
    type: 'button',
    body: {
      text: "Welcome to Mountain View Electronics. We offer premium power banks and electronic devices with a free trial option for Mountain View Estate residents."
    },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'welcome_continue', title: 'Continue' } },
        { type: 'reply', reply: { id: 'welcome_help', title: 'Need Help' } }
      ]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function sendProductCatalog(to) {
  const productsSnapshot = await db.collection('products').limit(5).get();
  if (productsSnapshot.empty) {
    await sendMessage(to, "Our products are currently being updated. Please check back later.");
    return;
  }

  await sendMessage(to, "Here are our featured products:");

  for (const doc of productsSnapshot.docs) {
    const product = doc.data();
    if (product.images && product.images.length > 0) {
      await sendImageMessage(to, product.images[0], `${product.name}\nPrice: KES ${product.price}\n${product.description}`);
    } else {
      await sendMessage(to, `${product.name}\nPrice: KES ${product.price}\n${product.description}`);
    }
  }

  const interactiveData = {
    type: 'button',
    body: {
      text: "Would you like to proceed with any of these products?"
    },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'catalog_yes', title: 'Yes, Proceed' } },
        { type: 'reply', reply: { id: 'catalog_no', title: 'Browse More' } }
      ]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function requestAddress(to) {
  const interactiveData = {
    type: 'button',
    body: {
      text: "Are you a Mountain View Estate resident?"
    },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'address_yes', title: 'Yes, I am' } },
        { type: 'reply', reply: { id: 'address_no', title: 'No, Outside' } }
      ]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function requestHouseNumber(to) {
  await sendMessage(to, "Please provide your house number in Mountain View Estate:");
}

async function requestFullAddress(to) {
  await sendMessage(to, "Please provide your full delivery address:");
}

async function requestDeliveryDate(to) {
  const interactiveData = {
    type: 'button',
    body: {
      text: "When would you like your delivery?"
    },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'delivery_today', title: 'Today' } },
        { type: 'reply', reply: { id: 'delivery_tomorrow', title: 'Tomorrow' } },
        { type: 'reply', reply: { id: 'delivery_custom', title: 'Specific Date' } }
      ]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function requestDeliveryTime(to) {
  const interactiveData = {
    type: 'button',
    body: {
      text: "Select preferred delivery time:"
    },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'time_morning', title: 'Morning (8am-12pm)' } },
        { type: 'reply', reply: { id: 'time_afternoon', title: 'Afternoon (12pm-5pm)' } },
        { type: 'reply', reply: { id: 'time_evening', title: 'Evening (5pm-8pm)' } }
      ]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function confirmOrder(to, productId, userData) {
  const productRef = await db.collection('products').doc(productId).get();
  if (!productRef.exists) {
    await sendMessage(to, "The selected product is no longer available. Please choose another product.");
    return;
  }

  const product = productRef.data();
  const isEstateResident = userData.address.includes('Mountain View Estate');
  const requiresPayment = !isEstateResident || userData.status === 'returning';

  if (requiresPayment) {
    const interactiveData = {
      type: 'button',
      body: {
        text: `Confirm order for ${product.name} at KES ${product.price}? Payment is required upfront.`
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'order_confirm_pay', title: 'Confirm & Pay' } },
          { type: 'reply', reply: { id: 'order_cancel', title: 'Cancel' } }
        ]
      }
    };
    await sendInteractiveMessage(to, interactiveData);
  } else {
    const interactiveData = {
      type: 'button',
      body: {
        text: `Confirm order for ${product.name} with 7-day free trial?`
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'order_confirm_trial', title: 'Confirm Trial' } },
          { type: 'reply', reply: { id: 'order_cancel', title: 'Cancel' } }
        ]
      }
    };
    await sendInteractiveMessage(to, interactiveData);
  }
}

async function createOrder(userId, productId, deliveryDetails, isTrial) {
  const orderRef = db.collection('orders').doc();
  const productRef = await db.collection('products').doc(productId).get();
  const product = productRef.data();

  const orderData = {
    orderId: orderRef.id,
    userId: userId,
    productId: productId,
    productName: product.name,
    price: product.price,
    status: isTrial ? 'trial_started' : 'paid',
    deliveryDetails: deliveryDetails,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    trialEndDate: isTrial ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null,
    paymentStatus: isTrial ? 'not_required' : 'pending'
  };

  await orderRef.set(orderData);
  return orderRef.id;
}

async function sendPaymentInstructions(to, orderId, amount) {
  const interactiveData = {
    type: 'button',
    body: {
      text: `Please pay KES ${amount} to Till Number 123456. Once paid, click below to confirm.`
    },
    action: {
      buttons: [
        { type: 'reply', reply: { id: `payment_confirm_${orderId}`, title: 'I Have Paid' } },
        { type: 'reply', reply: { id: 'payment_help', title: 'Need Help' } }
      ]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function sendTrialStartedMessage(to, productName, trialEndDate) {
  const endDate = trialEndDate.toLocaleDateString();
  await sendMessage(to, `Your trial for ${productName} has started. You have until ${endDate} to test the product before purchase.`);
  
  // Schedule follow-up messages
  scheduleTrialFollowUps(to, trialEndDate);
}

async function scheduleTrialFollowUps(to, trialEndDate) {
  // Schedule messages at 3h, 24h, 3 days, and 1 day before trial ends
  const followUps = [
    { delay: 3 * 60 * 60 * 1000, message: "How is your trial product working so far? Any questions?" },
    { delay: 24 * 60 * 60 * 1000, message: "We hope you're enjoying your trial product. Let us know if you need any assistance." },
    { delay: 3 * 24 * 60 * 60 * 1000, message: "Halfway through your trial period. How is the product meeting your needs?" },
    { delay: 6 * 24 * 60 * 60 * 1000, message: "Your trial ends tomorrow. Would you like to proceed with the purchase?" }
  ];

  for (const followUp of followUps) {
    setTimeout(async () => {
      const userRef = await db.collection('users').doc(to).get();
      if (userRef.exists) {
        const interactiveData = {
          type: 'button',
          body: {
            text: followUp.message
          },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'feedback_positive', title: 'Going Well' } },
              { type: 'reply', reply: { id: 'feedback_issues', title: 'Having Issues' } }
            ]
          }
        };
        await sendInteractiveMessage(to, interactiveData);
      }
    }, followUp.delay);
  }
}

async function sendOrderConfirmation(to, orderId) {
  const orderRef = await db.collection('orders').doc(orderId).get();
  if (!orderRef.exists) {
    await sendMessage(to, "We couldn't find your order details. Please contact support.");
    return;
  }

  const order = orderRef.data();
  await sendMessage(to, `Thank you for your order! Your ${order.productName} will be delivered as scheduled.`);

  // Update user status
  await db.collection('users').doc(to).update({
    status: 'customer',
    lastOrderDate: admin.firestore.FieldValue.serverTimestamp()
  });

  // Schedule post-delivery check-in
  setTimeout(async () => {
    const interactiveData = {
      type: 'button',
      body: {
        text: "How was your delivery experience?"
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'delivery_good', title: 'Good' } },
          { type: 'reply', reply: { id: 'delivery_issues', title: 'Had Issues' } }
        ]
      }
    };
    await sendInteractiveMessage(to, interactiveData);
  }, 24 * 60 * 60 * 1000); // 24 hours after confirmation
}

async function handleNewUserFlow(from, text, userRef, userData) {
  const updateData = {};
  let nextStage = userData.onboarding?.stage || 'welcome';

  try {
    switch (nextStage) {
      case 'welcome':
        if (text === 'welcome_continue') {
          nextStage = 'product_selection';
          await sendProductCatalog(from);
        } else if (text === 'welcome_help') {
          await sendMessage(from, "What can we help you with today?");
          return;
        } else {
          await sendWelcomeMessage(from);
          return;
        }
        break;

      case 'product_selection':
        if (text === 'catalog_yes') {
          nextStage = 'address';
          await requestAddress(from);
        } else if (text === 'catalog_no') {
          await sendProductCatalog(from);
          return;
        } else {
          await sendProductCatalog(from);
          return;
        }
        break;

      case 'address':
        if (text === 'address_yes') {
          nextStage = 'house_number';
          await requestHouseNumber(from);
        } else if (text === 'address_no') {
          nextStage = 'full_address';
          await requestFullAddress(from);
        } else {
          await requestAddress(from);
          return;
        }
        break;

      case 'house_number':
        if (text && text.length > 0) {
          updateData.address = `Mountain View Estate, House ${text}`;
          nextStage = 'delivery_date';
          await requestDeliveryDate(from);
        } else {
          await requestHouseNumber(from);
          return;
        }
        break;

      case 'full_address':
        if (text && text.length > 10) {
          updateData.address = text;
          nextStage = 'delivery_date';
          await requestDeliveryDate(from);
        } else {
          await sendMessage(from, "Please provide a complete address including street and town.");
          return;
        }
        break;

      case 'delivery_date':
        if (text === 'delivery_today' || text === 'delivery_tomorrow') {
          nextStage = 'delivery_time';
          await requestDeliveryTime(from);
        } else if (text === 'delivery_custom') {
          await sendMessage(from, "Please enter your preferred delivery date (DD/MM/YYYY):");
          return;
        } else if (text.match(/^\d{2}\/\d{2}\/\d{4}$/)) {
          nextStage = 'delivery_time';
          await requestDeliveryTime(from);
        } else {
          await requestDeliveryDate(from);
          return;
        }
        break;

      case 'delivery_time':
        if (text === 'time_morning' || text === 'time_afternoon' || text === 'time_evening') {
          nextStage = 'order_confirmation';
          // For demo purposes, we're using a sample product
          await confirmOrder(from, 'sample_product_id', userData);
        } else {
          await requestDeliveryTime(from);
          return;
        }
        break;

      case 'order_confirmation':
        if (text === 'order_confirm_trial') {
          // Create trial order
          const orderId = await createOrder(from, 'sample_product_id', userData.address, true);
          await sendTrialStartedMessage(from, "Premium Power Bank", new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
          nextStage = 'completed';
        } else if (text === 'order_confirm_pay') {
          // Create paid order
          const orderId = await createOrder(from, 'sample_product_id', userData.address, false);
          await sendPaymentInstructions(from, orderId, 2500);
          nextStage = 'payment_pending';
        } else if (text === 'order_cancel') {
          await sendMessage(from, "Order cancelled. Let us know if you'd like to browse other products.");
          nextStage = 'product_selection';
          await sendProductCatalog(from);
          return;
        } else {
          await confirmOrder(from, 'sample_product_id', userData);
          return;
        }
        break;

      case 'payment_pending':
        if (text.startsWith('payment_confirm_')) {
          const orderId = text.split('_')[2];
          await db.collection('orders').doc(orderId).update({
            paymentStatus: 'confirmed',
            paidAt: admin.firestore.FieldValue.serverTimestamp()
          });
          await sendOrderConfirmation(from, orderId);
          nextStage = 'completed';
        } else if (text === 'payment_help') {
          await sendMessage(from, "Please call 0700123456 for payment assistance.");
          return;
        } else {
          // For demo, we'll assume any other message is payment confirmation
          await sendMessage(from, "Please use the payment confirmation button to verify your payment.");
          return;
        }
        break;

      case 'completed':
        await sendMessage(from, "Thank you for your business! If you need anything else, just let us know.");
        break;

      default:
        await sendWelcomeMessage(from);
        return;
    }

    updateData['onboarding.stage'] = nextStage;
    updateData['onboarding.lastActive'] = admin.firestore.FieldValue.serverTimestamp();
    
    await userRef.update(updateData);
    await updateGoogleSheet({
      ...userData,
      ...updateData,
      phone: from
    });

  } catch (err) {
    console.error('Onboarding error:', err);
    await sendMessage(from, "We encountered an error. Please try again or contact support.");
  }
}

app.get('/', (req, res) => res.send('WhatsApp Bot running'));

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode && token === WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  try {
    const changes = req.body.entry?.[0]?.changes?.[0];
    const message = changes?.value?.messages?.[0];
    const from = message?.from;

    if (!message || !from) return res.sendStatus(200);

    console.log('Webhook received:', message.type, 'from:', from);

    await logMessage('incoming', {
      from,
      type: message.type,
      message: message,
      userId: from
    });

    const userRef = db.collection('users').doc(from);
    const userDoc = await userRef.get();
    let userData = userDoc.exists ? userDoc.data() : null;

    // Handle new user registration
    if (!userDoc.exists) {
      await registerNewUser(from);
      await sendWelcomeMessage(from);
      return res.sendStatus(200);
    }

    // Update last active timestamp
    await userRef.update({
      lastActive: admin.firestore.FieldValue.serverTimestamp()
    });

    // Get message text
    let text = '';
    if (message.type === 'text') {
      text = message.text?.body?.toLowerCase() || '';
    } else if (message.type === 'interactive') {
      if (message.interactive?.type === 'button_reply') {
        text = message.interactive.button_reply?.id || '';
      } else if (message.interactive?.type === 'list_reply') {
        text = message.interactive.list_reply?.id || '';
      }
    }

    // Check for greetings to start conversation
    if (!userData.onboarding?.stage && ['hi', 'hello', 'hey'].includes(text)) {
      await sendWelcomeMessage(from);
      return res.sendStatus(200);
    }

    // Handle existing user flow
    if (userData.onboarding?.stage) {
      await handleNewUserFlow(from, text, userRef, userData);
      return res.sendStatus(200);
    }

    // Handle returning customer requests
    const aiResponse = await getAIResponse(text, from);
    await sendMessage(from, aiResponse, true);

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Last restart: ${new Date().toISOString()}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
