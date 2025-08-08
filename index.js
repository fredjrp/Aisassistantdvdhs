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
  GOOGLE_PRIVATE_KEY,
  PAYMENT_TILL_NUMBER
} = process.env;

const publicKey = process.env.PUBLIC_KEY?.replace(/\\n/g, '\n');

const rawConfig = JSON.parse(process.env.FIREBASE_CONFIG);
rawConfig.private_key = rawConfig.private_key.replace(/\\n/g, '\n');
admin.initializeApp({ credential: admin.credential.cert(rawConfig) });
const db = admin.firestore();

// Add this right after Firebase initialization (after admin.initializeApp)
async function initializeFirebaseCollections() {
  const requiredCollections = [
    'products',
    'complementary_products',
    'orders',
    'cases',
    'feedback',
    'agents',
    'whatsapp_logs',
    'users'
  ];

  const sampleProduct = {
    name: "Premium Power Bank 20,000mAh",
    description: "High-capacity portable charger with fast charging",
    price: 3500,
    images: ["https://example.com/powerbank.jpg"],
    specs: {
      capacity: "20000mAh",
      output: "5V/2.4A",
      input: "5V/2A",
      weight: "350g"
    },
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const sampleComplementary = {
    mainProduct: "sample_product_id",
    complementaryProduct: "sample_accessory_id",
    relationType: "accessory",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  try {
    console.log("Checking Firebase collections...");
    
    for (const collectionName of requiredCollections) {
      const collectionRef = db.collection(collectionName);
      const snapshot = await collectionRef.limit(1).get();
      
      if (snapshot.empty) {
        console.log(`Creating collection: ${collectionName}`);
        
        // Add sample document to create the collection
        if (collectionName === 'products') {
          await collectionRef.add(sampleProduct);
        } else if (collectionName === 'complementary_products') {
          // First ensure sample products exist
          const productRef = db.collection('products').doc('sample_product_id');
          await productRef.set(sampleProduct);
          
          const accessoryRef = db.collection('products').doc('sample_accessory_id');
          await accessoryRef.set({
            name: "Fast Charging Cable",
            description: "3-in-1 charging cable (Type-C, Micro-USB, Lightning)",
            price: 800,
            images: ["https://example.com/cable.jpg"],
            active: true,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          
          await collectionRef.add(sampleComplementary);
        } else {
          // Create empty collection with one dummy document
          await collectionRef.add({
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            placeholder: true
          });
        }
      }
    }
    
    console.log("Firebase collections verified");
  } catch (error) {
    console.error("Error initializing collections:", error);
  }
}

// Call this function right after admin.initializeApp
initializeFirebaseCollections().catch(console.error);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

const AGENT_RESPONSE_TIMEOUT = 5000;
const DEMO_DELAY = 2000;
const agentResponseTimers = new Map();
const TRIAL_DURATION_DAYS = 7;

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
      'Status': userData.status || '',
      'HouseNumber': userData.houseNumber || '',
      'CurrentProduct': userData.currentTrialProduct || '',
      'TrialStartDate': userData.trialStartDate || '',
      'PaymentStatus': userData.paymentStatus || '',
      'LoyaltyPoints': userData.loyaltyPoints || 0,
      'CaseNumber': userData.caseNumber || ''
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

async function getAIResponse(userText, userId, context = '') {
  const userRef = await db.collection('users').doc(userId).get();
  const userData = userRef.data() || {};
  
  const personality = {
    tone: "professional and helpful",
    traits: [
      "Keep responses under 200 characters",
      "Use bullet points when possible",
      "Focus on product benefits and features",
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
                     `Product: ${userData.currentTrialProduct || 'None'}\n` +
                     `Trial Day: ${getTrialDay(userData) || '0'}\n` +
                     `${context}`
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
    return "I'm having trouble responding. Please try again or visit our website for assistance.";
  }
}

function getTrialDay(userData) {
  if (!userData.trialStartDate) return 0;
  const startDate = userData.trialStartDate.toDate();
  const now = new Date();
  const diffTime = Math.abs(now - startDate);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

async function sendWelcomeMessage(to) {
  const interactiveData = {
    type: 'button',
    body: {
      text: "Welcome to Mountain View Electronics. Are you a Mountain View Estate resident?"
    },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'welcome_yes', title: 'Yes, I am a resident' } },
        { type: 'reply', reply: { id: 'welcome_no', title: 'No, I am not' } }
      ]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function sendProductCatalog(to) {
  try {
    const productsSnapshot = await db.collection('products').where('active', '==', true).get();
    const products = [];
    
    productsSnapshot.forEach(doc => {
      products.push({ id: doc.id, ...doc.data() });
    });

    if (products.length === 0) {
      await sendMessage(to, "Currently no products available. Please check back later.");
      return;
    }

    // For first product, send image with details
    const firstProduct = products[0];
    if (firstProduct.images && firstProduct.images.length > 0) {
      await sendImageMessage(to, firstProduct.images[0], 
        `${firstProduct.name}\n${firstProduct.description}\nPrice: KES ${firstProduct.price}`);
    }

    const remainingProducts = products.slice(1);
    if (remainingProducts.length > 0) {
      const sections = [{
        title: 'Available Products',
        rows: remainingProducts.map(product => ({
          id: `product_${product.id}`,
          title: product.name,
          description: `KES ${product.price}`
        }))
      }];

      const interactiveData = {
        type: 'list',
        header: { type: 'text', text: 'Our Products' },
        body: { text: 'Select a product to view details:' },
        action: {
          button: 'View Products',
          sections: sections
        }
      };

      await sendInteractiveMessage(to, interactiveData);
    }
  } catch (err) {
    console.error('Product catalog error:', err);
    await sendMessage(to, "Failed to load products. Please try again later.");
  }
}

async function sendProductDetails(to, productId) {
  try {
    const productDoc = await db.collection('products').doc(productId).get();
    if (!productDoc.exists) {
      await sendMessage(to, "Product not found.");
      return;
    }

    const product = productDoc.data();
    const userDoc = await db.collection('users').doc(to).get();
    const userData = userDoc.data() || {};

    if (product.images && product.images.length > 0) {
      await sendImageMessage(to, product.images[0], 
        `${product.name}\n${product.description}\nPrice: KES ${product.price}`);
    }

    if (userData.isEstateResident) {
      const interactiveData = {
        type: 'button',
        body: {
          text: `${product.name}\n\n${product.description}\n\nPrice: KES ${product.price}\n\nAs a Mountain View resident, you qualify for a 1-week free trial.`
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: `book_${productId}`, title: 'Book Free Trial' } },
            { type: 'reply', reply: { id: 'back_catalog', title: 'Back to Catalog' } }
          ]
        }
      };
      await sendInteractiveMessage(to, interactiveData);
    } else {
      const interactiveData = {
        type: 'button',
        body: {
          text: `${product.name}\n\n${product.description}\n\nPrice: KES ${product.price}\n\nPayment required upfront for non-residents.`
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: `buy_${productId}`, title: 'Purchase Now' } },
            { type: 'reply', reply: { id: 'back_catalog', title: 'Back to Catalog' } }
          ]
        }
      };
      await sendInteractiveMessage(to, interactiveData);
    }
  } catch (err) {
    console.error('Product details error:', err);
    await sendMessage(to, "Failed to load product details. Please try again later.");
  }
}

async function requestDeliveryDetails(to, productId, isTrial = true) {
  try {
    // First request house number for residents
    const userDoc = await db.collection('users').doc(to).get();
    const userData = userDoc.data() || {};

    if (userData.isEstateResident && !userData.houseNumber) {
      await sendMessage(to, "Please provide your Mountain View Estate house number (e.g., B42):");
      await db.collection('users').doc(to).update({
        onboarding: {
          stage: 'house_number',
          productId: productId,
          isTrial: isTrial
        }
      });
      return;
    }

    // Then request date
    await sendMessage(to, "Please enter your preferred delivery date (DD-MM-YYYY):");
    await db.collection('users').doc(to).update({
      onboarding: {
        stage: 'delivery_date',
        productId: productId,
        isTrial: isTrial
      }
    });
  } catch (err) {
    console.error('Delivery details error:', err);
    await sendMessage(to, "Failed to process delivery request. Please try again later.");
  }
}

async function requestDeliveryTime(to, productId, deliveryDate, isTrial) {
  try {
    const interactiveData = {
      type: 'button',
      body: {
        text: `Please select delivery time for ${deliveryDate}:`
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `time_morning_${productId}`, title: 'Morning (8am-12pm)' } },
          { type: 'reply', reply: { id: `time_afternoon_${productId}`, title: 'Afternoon (12pm-4pm)' } },
          { type: 'reply', reply: { id: `time_evening_${productId}`, title: 'Evening (4pm-8pm)' } }
        ]
      }
    };
    
    await sendInteractiveMessage(to, interactiveData);
    await db.collection('users').doc(to).update({
      onboarding: {
        stage: 'delivery_time',
        productId: productId,
        deliveryDate: deliveryDate,
        isTrial: isTrial
      }
    });
  } catch (err) {
    console.error('Delivery time error:', err);
    await sendMessage(to, "Failed to process delivery time. Please try again later.");
  }
}

async function confirmOrder(to, productId, deliveryDate, timeSlot, isTrial) {
  try {
    const productDoc = await db.collection('products').doc(productId).get();
    if (!productDoc.exists) {
      await sendMessage(to, "Product no longer available.");
      return;
    }

    const product = productDoc.data();
    const userDoc = await db.collection('users').doc(to).get();
    const userData = userDoc.data() || {};

    let message = `Order Summary:\n\n`;
    message += `Product: ${product.name}\n`;
    message += `Delivery Date: ${deliveryDate}\n`;
    message += `Time Slot: ${timeSlot}\n`;
    
    if (userData.houseNumber) {
      message += `House Number: ${userData.houseNumber}\n`;
    }

    if (isTrial) {
      message += `\nYou have a 1-week free trial period. Payment of KES ${product.price} will be requested after trial.`;
      
      const interactiveData = {
        type: 'button',
        body: {
          text: message
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: `confirm_trial_${productId}`, title: 'Confirm Trial' } },
            { type: 'reply', reply: { id: 'cancel_order', title: 'Cancel' } }
          ]
        }
      };
      
      await sendInteractiveMessage(to, interactiveData);
    } else {
      message += `\nTotal: KES ${product.price}\n\nPlease pay to Till Number ${PAYMENT_TILL_NUMBER} and send receipt.`;
      
      const interactiveData = {
        type: 'button',
        body: {
          text: message
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: `confirm_payment_${productId}`, title: 'I Have Paid' } },
            { type: 'reply', reply: { id: 'cancel_order', title: 'Cancel' } }
          ]
        }
      };
      
      await sendInteractiveMessage(to, interactiveData);
    }

    await db.collection('users').doc(to).update({
      onboarding: {
        stage: 'order_confirmation',
        productId: productId,
        deliveryDate: deliveryDate,
        timeSlot: timeSlot,
        isTrial: isTrial
      }
    });
  } catch (err) {
    console.error('Order confirmation error:', err);
    await sendMessage(to, "Failed to process order. Please try again later.");
  }
}

async function startTrialPeriod(to, productId, deliveryDate, timeSlot) {
  try {
    const trialEndDate = new Date();
    trialEndDate.setDate(trialEndDate.getDate() + TRIAL_DURATION_DAYS);

    await db.collection('users').doc(to).update({
      status: 'trial',
      currentTrialProduct: productId,
      trialStartDate: admin.firestore.FieldValue.serverTimestamp(),
      trialEndDate: admin.firestore.Timestamp.fromDate(trialEndDate),
      'onboarding.stage': 'trial_active'
    });

    await db.collection('orders').add({
      userId: to,
      productId: productId,
      deliveryDate: deliveryDate,
      deliverySlot: timeSlot,
      status: 'pending',
      isTrial: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await sendMessage(to, `Your 1-week trial for ${productId} starts upon delivery. We'll check in during your trial period.`);

    // Schedule check-ins
    scheduleTrialCheckins(to);
  } catch (err) {
    console.error('Trial start error:', err);
    await sendMessage(to, "Failed to start trial period. Please contact support.");
  }
}

async function scheduleTrialCheckins(userId) {
  const checkinIntervals = [
    { hours: 3 },    // 3 hours after delivery
    { hours: 24 },   // 1 day after
    { days: 3 },     // 3 days after
    { days: 5 },     // 5 days after
    { days: 7 }      // 7 days after (trial end)
  ];

  for (const interval of checkinIntervals) {
    const delay = interval.hours 
      ? interval.hours * 60 * 60 * 1000 
      : interval.days * 24 * 60 * 60 * 1000;

    setTimeout(async () => {
      const userDoc = await db.collection('users').doc(userId).get();
      const userData = userDoc.data() || {};

      if (userData.status === 'trial') {
        await sendTrialCheckin(userId, userData);
      }
    }, delay);
  }
}

async function sendTrialCheckin(userId, userData) {
  try {
    const productDoc = await db.collection('products').doc(userData.currentTrialProduct).get();
    const product = productDoc.data() || {};
    const trialDay = getTrialDay(userData);

    let message = '';
    if (trialDay === 0) {
      message = `How is your first impression of the ${product.name}?`;
    } else if (trialDay < TRIAL_DURATION_DAYS) {
      message = `Day ${trialDay} of your trial. How is the ${product.name} working for you?`;
    } else {
      message = `Your trial period has ended. Would you like to purchase the ${product.name}?`;
    }

    // Get product tips from AI
    const tipsContext = `Generate 1-2 short bullet points about using ${product.name} (${product.description}). Focus on helpful tips for day ${trialDay} of use.`;
    const productTips = await getAIResponse('', userId, tipsContext);

    // Get complementary products
    const compProducts = await getComplementaryProducts(userData.currentTrialProduct);

    let fullMessage = `${message}\n\n`;
    fullMessage += `Product Tips:\n${productTips}\n\n`;

    if (compProducts.length > 0) {
      fullMessage += `Recommended Accessories:\n`;
      compProducts.forEach(p => {
        fullMessage += `- ${p.name} (KES ${p.price})\n`;
      });
    }

    if (trialDay >= TRIAL_DURATION_DAYS) {
      const interactiveData = {
        type: 'button',
        body: {
          text: fullMessage
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'purchase_product', title: 'Purchase Now' } },
            { type: 'reply', reply: { id: 'return_product', title: 'Return Product' } }
          ]
        }
      };
      await sendInteractiveMessage(userId, interactiveData);
    } else {
      const interactiveData = {
        type: 'button',
        body: {
          text: fullMessage
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'checkin_good', title: 'Working Well' } },
            { type: 'reply', reply: { id: 'checkin_issues', title: 'Having Issues' } }
          ]
        }
      };
      await sendInteractiveMessage(userId, interactiveData);
    }
  } catch (err) {
    console.error('Trial checkin error:', err);
  }
}

async function getComplementaryProducts(mainProductId) {
  try {
    const compProducts = [];
    const compSnapshot = await db.collection('complementary_products')
      .where('mainProduct', '==', mainProductId)
      .limit(3)
      .get();

    for (const doc of compSnapshot.docs) {
      const productId = doc.data().complementaryProduct;
      const productDoc = await db.collection('products').doc(productId).get();
      if (productDoc.exists) {
        compProducts.push({ id: productId, ...productDoc.data() });
      }
    }

    return compProducts;
  } catch (err) {
    console.error('Complementary products error:', err);
    return [];
  }
}

async function requestPayment(to) {
  try {
    const userDoc = await db.collection('users').doc(to).get();
    const userData = userDoc.data() || {};
    const productDoc = await db.collection('products').doc(userData.currentTrialProduct).get();
    const product = productDoc.data() || {};

    let message = `Payment Request\n\n`;
    message += `Product: ${product.name}\n`;
    message += `Amount: KES ${product.price}\n\n`;
    message += `Please pay to Till Number ${PAYMENT_TILL_NUMBER}\n`;
    message += `Include your phone number as reference\n\n`;
    message += `Complete your purchase to continue enjoying your product.`;

    const interactiveData = {
      type: 'button',
      body: {
        text: message
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'payment_done', title: 'I Have Paid' } },
          { type: 'reply', reply: { id: 'payment_help', title: 'Need Help' } }
        ]
      }
    };

    await sendInteractiveMessage(to, interactiveData);
  } catch (err) {
    console.error('Payment request error:', err);
    await sendMessage(to, "Failed to process payment request. Please try again later.");
  }
}

async function verifyPayment(to, paymentDetails) {
  try {
    // In a real implementation, you would verify with your payment provider
    // For this example, we'll simulate verification
    
    await db.collection('users').doc(to).update({
      paymentStatus: 'completed',
      status: 'customer',
      loyaltyPoints: admin.firestore.FieldValue.increment(10)
    });

    const userDoc = await db.collection('users').doc(to).get();
    const userData = userDoc.data() || {};

    await db.collection('orders').where('userId', '==', to)
      .where('isTrial', '==', true)
      .where('status', '==', 'pending')
      .limit(1)
      .get()
      .then(async snapshot => {
        if (!snapshot.empty) {
          await snapshot.docs[0].ref.update({
            status: 'completed',
            paymentDate: admin.firestore.FieldValue.serverTimestamp(),
            amount: paymentDetails.amount
          });
        }
      });

    let message = `Payment Verified!\n\n`;
    message += `Thank you for your purchase.\n`;
    message += `You've earned 10 loyalty points.\n\n`;
    message += `Current points: ${userData.loyaltyPoints || 0}\n\n`;
    message += `Would you like to leave feedback for a 5% discount on your next purchase?`;

    const interactiveData = {
      type: 'button',
      body: {
        text: message
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'feedback_yes', title: 'Leave Feedback' } },
          { type: 'reply', reply: { id: 'feedback_later', title: 'Maybe Later' } }
        ]
      }
    };

    await sendInteractiveMessage(to, interactiveData);

    // Schedule follow-ups
    schedulePostPurchaseFollowups(to);
  } catch (err) {
    console.error('Payment verification error:', err);
    await sendMessage(to, "Failed to verify payment. Please contact support.");
  }
}

async function schedulePostPurchaseFollowups(userId) {
  const followupIntervals = [
    { days: 3 },    // 3 days after purchase
    { days: 7 },    // 1 week after
    { days: 30 }    // 1 month after
  ];

  for (const interval of followupIntervals) {
    const delay = interval.days * 24 * 60 * 60 * 1000;

    setTimeout(async () => {
      const userDoc = await db.collection('users').doc(userId).get();
      const userData = userDoc.data() || {};

      if (userData.status === 'customer') {
        await sendFollowupMessage(userId, userData, interval.days);
      }
    }, delay);
  }
}

async function sendFollowupMessage(userId, userData, daysSincePurchase) {
  try {
    let message = `Hello ${userData.name || ''},\n\n`;
    
    if (daysSincePurchase === 3) {
      message += `How is your new product working for you after 3 days of use?`;
    } else if (daysSincePurchase === 7) {
      message += `It's been a week since your purchase. Everything working well?`;
    } else {
      message += `It's been a month since your purchase. Would you like to check out our latest products?`;
    }

    const interactiveData = {
      type: 'button',
      body: {
        text: message
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'followup_ok', title: 'All Good' } },
          { type: 'reply', reply: { id: 'followup_issues', title: 'Having Issues' } },
          { type: 'reply', reply: { id: 'followup_products', title: 'See Products' } }
        ]
      }
    };

    await sendInteractiveMessage(userId, interactiveData);
  } catch (err) {
    console.error('Followup message error:', err);
  }
}

async function createCase(userId, issueType) {
  try {
    const caseNumber = `CASE-${Math.floor(1000 + Math.random() * 9000)}`;
    
    await db.collection('cases').add({
      caseNumber: caseNumber,
      userId: userId,
      issueType: issueType,
      status: 'open',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection('users').doc(userId).update({
      caseNumber: caseNumber
    });

    await sendMessage(userId, `Case created: ${caseNumber}\n\nAn agent will contact you shortly.`);

    // Assign to available agent
    assignCaseToAgent(caseNumber);
  } catch (err) {
    console.error('Case creation error:', err);
    await sendMessage(userId, "Failed to create case. Please try again later.");
  }
}

async function assignCaseToAgent(caseNumber) {
  // Implementation would depend on your agent assignment logic
  // This is a simplified version
  const agentsSnapshot = await db.collection('agents')
    .where('available', '==', true)
    .limit(1)
    .get();

  if (!agentsSnapshot.empty) {
    const agent = agentsSnapshot.docs[0];
    await agent.ref.update({ available: false });
    
    await db.collection('cases').where('caseNumber', '==', caseNumber)
      .limit(1)
      .get()
      .then(async snapshot => {
        if (!snapshot.empty) {
          await snapshot.docs[0].ref.update({
            assignedAgent: agent.id,
            status: 'in-progress'
          });
        }
      });
  }
}

async function updateDeliveryStatus(orderId, status) {
  try {
    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) return;

    await orderDoc.ref.update({ status: status });
    
    const userId = orderDoc.data().userId;
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) return;

    let message = '';
    switch (status) {
      case 'started':
        message = 'Your delivery is on the way.';
        break;
      case 'at_gate':
        message = 'Your delivery has arrived at the estate gate.';
        break;
      case 'delivered':
        message = 'Your delivery is complete. Enjoy your product!';
        break;
      default:
        return;
    }

    await sendMessage(userId, `Delivery Update: ${message}`);
  } catch (err) {
    console.error('Delivery status update error:', err);
  }
}

app.get('/', (req, res) => res.send('Mountain View Electronics WhatsApp Bot running'));

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
    const userData = userDoc.exists ? userDoc.data() : null;

    // Handle menu command
    if (message.text?.body?.toLowerCase().trim() === 'menu') {
      if (!userDoc.exists) {
        await sendWelcomeMessage(from);
      } else {
        await sendProductCatalog(from);
      }
      return res.sendStatus(200);
    }

    // Handle case check
    if (message.text?.body?.toLowerCase().includes('case')) {
      if (userData?.caseNumber) {
        const caseDoc = await db.collection('cases').where('caseNumber', '==', userData.caseNumber).limit(1).get();
        if (!caseDoc.empty) {
          const caseData = caseDoc.docs[0].data();
          await sendMessage(from, `Case ${caseData.caseNumber}\nStatus: ${caseData.status}\nAgent: ${caseData.assignedAgent || 'Not assigned'}`);
        } else {
          await sendMessage(from, "No active case found. Would you like to create one?");
        }
      } else {
        await sendMessage(from, "No active case found. Would you like to create one?");
      }
      return res.sendStatus(200);
    }

    // Handle onboarding flow
    if (!userDoc.exists) {
      await userRef.set({
        phone: from,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'new'
      });
      await sendWelcomeMessage(from);
      return res.sendStatus(200);
    }

    // Update last active timestamp
    await userRef.update({
      lastActive: admin.firestore.FieldValue.serverTimestamp()
    });

    // Extract message text
    let text = '';
    if (message.type === 'text') {
      text = message.text?.body || '';
    } else if (message.type === 'interactive') {
      if (message.interactive?.type === 'button_reply') {
        text = message.interactive.button_reply?.id || '';
      } else if (message.interactive?.type === 'list_reply') {
        text = message.interactive.list_reply?.id || '';
      }
    }

    // Handle onboarding stages
    if (userData.onboarding?.stage) {
      await handleOnboardingStage(from, text, userData.onboarding.stage, userRef, userData);
      return res.sendStatus(200);
    }

    // Handle product selection
    if (text.startsWith('product_')) {
      const productId = text.replace('product_', '');
      await sendProductDetails(from, productId);
      return res.sendStatus(200);
    }

    // Handle trial booking
    if (text.startsWith('book_')) {
      const productId = text.replace('book_', '');
      await requestDeliveryDetails(from, productId, true);
      return res.sendStatus(200);
    }

    // Handle direct purchase
    if (text.startsWith('buy_')) {
      const productId = text.replace('buy_', '');
      await requestDeliveryDetails(from, productId, false);
      return res.sendStatus(200);
    }

    // Handle back to catalog
    if (text === 'back_catalog') {
      await sendProductCatalog(from);
      return res.sendStatus(200);
    }

    // Handle payment confirmation
    if (text === 'payment_done') {
      const productDoc = await db.collection('products').doc(userData.currentTrialProduct).get();
      const product = productDoc.data() || {};
      
      await verifyPayment(from, {
        amount: product.price,
        method: 'M-Pesa'
      });
      return res.sendStatus(200);
    }

    // Handle feedback
    if (text === 'feedback_yes') {
      await sendMessage(from, "Please share your feedback about your purchase experience and product quality:");
      await userRef.update({ 'onboarding.stage': 'feedback' });
      return res.sendStatus(200);
    }

    // Handle case creation
    if (text === 'followup_issues' || text === 'checkin_issues') {
      await createCase(from, text === 'followup_issues' ? 'post_purchase_issue' : 'trial_issue');
      return res.sendStatus(200);
    }

    // Default AI response for customers
    if (userData.status === 'customer') {
      const aiResponse = await getAIResponse(text, from);
      await sendMessage(from, aiResponse, true);
      return res.sendStatus(200);
    }

    // Default response
    await sendMessage(from, "Sorry, I didn't understand that. Type MENU to see options.");
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

async function handleOnboardingStage(from, text, stage, userRef, userData) {
  const updateData = {};
  let nextStage = stage;

  try {
    switch (stage) {
      case 'welcome':
        if (text === 'welcome_yes') {
          updateData.isEstateResident = true;
          nextStage = 'product_catalog';
          await sendProductCatalog(from);
        } else if (text === 'welcome_no') {
          updateData.isEstateResident = false;
          nextStage = 'product_catalog';
          await sendProductCatalog(from);
        } else {
          await sendWelcomeMessage(from);
          return;
        }
        break;

      case 'house_number':
        if (text && text.match(/^[A-Za-z]?\d+$/)) {
          updateData.houseNumber = text.toUpperCase();
          const productId = userData.onboarding.productId;
          const isTrial = userData.onboarding.isTrial;
          nextStage = 'delivery_date';
          await sendMessage(from, "Please enter your preferred delivery date (DD-MM-YYYY):");
        } else {
          await sendMessage(from, "Invalid house number format. Please use format like B42 or 42.");
          return;
        }
        break;

      case 'delivery_date':
        if (text && text.match(/^\d{2}-\d{2}-\d{4}$/)) {
          const productId = userData.onboarding.productId;
          const isTrial = userData.onboarding.isTrial;
          nextStage = 'delivery_time';
          await requestDeliveryTime(from, productId, text, isTrial);
        } else {
          await sendMessage(from, "Invalid date format. Please use DD-MM-YYYY format.");
          return;
        }
        break;

      case 'delivery_time':
        if (text.startsWith('time_')) {
          const parts = text.split('_');
          const timeSlot = parts[1];
          const productId = parts[2];
          const deliveryDate = userData.onboarding.deliveryDate;
          const isTrial = userData.onboarding.isTrial;
          
          nextStage = 'order_confirmation';
          await confirmOrder(from, productId, deliveryDate, timeSlot, isTrial);
        } else {
          const productId = userData.onboarding.productId;
          const deliveryDate = userData.onboarding.deliveryDate;
          const isTrial = userData.onboarding.isTrial;
          await requestDeliveryTime(from, productId, deliveryDate, isTrial);
          return;
        }
        break;

      case 'order_confirmation':
        if (text.startsWith('confirm_trial_')) {
          const productId = text.replace('confirm_trial_', '');
          const deliveryDate = userData.onboarding.deliveryDate;
          const timeSlot = userData.onboarding.timeSlot;
          
          await startTrialPeriod(from, productId, deliveryDate, timeSlot);
          nextStage = 'trial_active';
        } else if (text.startsWith('confirm_payment_')) {
          const productId = text.replace('confirm_payment_', '');
          await requestPayment(from);
          nextStage = 'payment_pending';
        } else if (text === 'cancel_order') {
          nextStage = '';
          await sendMessage(from, "Order cancelled. Type MENU to browse products.");
        } else {
          const productId = userData.onboarding.productId;
          const deliveryDate = userData.onboarding.deliveryDate;
          const timeSlot = userData.onboarding.timeSlot;
          const isTrial = userData.onboarding.isTrial;
          await confirmOrder(from, productId, deliveryDate, timeSlot, isTrial);
          return;
        }
        break;

      case 'feedback':
        if (text && text.length > 10) {
          await db.collection('feedback').add({
            userId: from,
            feedback: text,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            discountEligible: true
          });
          
          await sendMessage(from, "Thank you for your feedback! You've earned a 5% discount on your next purchase.");
          nextStage = '';
        } else {
          await sendMessage(from, "Please provide more detailed feedback (at least 10 characters).");
          return;
        }
        break;

      default:
        await sendMessage(from, "Sorry, I didn't understand that. Type MENU to see options.");
        return;
    }

    if (nextStage) {
      updateData['onboarding.stage'] = nextStage;
    } else {
      updateData['onboarding'] = admin.firestore.FieldValue.delete();
    }
    
    await userRef.update(updateData);
    await updateGoogleSheet({
      ...userData,
      ...updateData,
      phone: from
    });

  } catch (err) {
    console.error('Onboarding error:', err);
    await sendMessage(from, "We encountered an error. Please try again or type MENU to restart.");
  }
}

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

