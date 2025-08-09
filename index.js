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

async function initializeCollections() {
  try {
    const collections = ['products', 'users', 'orders', 'whatsapp_logs', 'complementary_items', 'trials'];
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
        } else if (col === 'complementary_items') {
          await db.collection(col).add({
            name: "Wireless Earphones",
            description: "Bluetooth 5.0",
            product_id: "powerbank123",
            image: "https://example.com/earphones.jpg",
            active: true
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

async function sendImage(to, imageUrl, caption = '') {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
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
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Image sending error:', error.response?.data || error.message);
    throw error;
  }
}

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

    // Send first product with image
    const firstProduct = products[0];
    if (firstProduct.images && firstProduct.images.length > 0) {
      await sendImage(to, firstProduct.images[0], `${firstProduct.name}\nKES ${firstProduct.price}`);
    } else {
      await sendMessage(to, `${firstProduct.name}\n${firstProduct.description}\nKES ${firstProduct.price}`);
    }

    // Send remaining products as list
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

    // Handle greetings
    if (message.type === 'text') {
      const text = message.text.body.toLowerCase().trim();
      
      if (['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'].includes(text)) {
        await handleGreeting(from);
        return res.sendStatus(200);
      }
      
      if (text === 'menu') {
        await sendWelcomeMessage(from);
        return res.sendStatus(200);
      } else if (text === 'register') {
        await initiateRegistration(from);
        return res.sendStatus(200);
      } else if (text === 'status') {
        await checkOrderStatus(from);
        return res.sendStatus(200);
      } else if (text === 'points') {
        await checkLoyaltyPoints(from);
        return res.sendStatus(200);
      }

      // Handle registration text responses
      const userDoc = await db.collection('users').doc(from).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        if (userData.registrationStep === 'name') {
          await db.collection('users').doc(from).update({
            name: message.text.body,
            registrationStep: 'estate_number'
          });
          await sendMessage(from, "Thank you. Now please send your estate house number (e.g., Acacia 39):");
          return res.sendStatus(200);
        } else if (userData.registrationStep === 'estate_number') {
          await db.collection('users').doc(from).update({
            estateNumber: message.text.body,
            registrationStep: 'complete',
            registrationCompleted: true
          });
          await sendMessage(from, "Registration complete! Type 'menu' to browse products.");
          return res.sendStatus(200);
        }
      }
    }

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
        
        const userDoc = await db.collection('users').doc(from).get();
        if (!userDoc.exists || !userDoc.data().name) {
          await initiateRegistration(from);
        } else {
          await sendProductCatalog(from);
        }
      } else if (responseId.startsWith('product_')) {
        const productId = responseId.replace('product_', '');
        await sendProductDetails(from, productId);
      } else if (responseId.startsWith('more_images_')) {
        const productId = responseId.replace('more_images_', '');
        await sendAdditionalImages(from, productId);
      } else if (responseId.startsWith('buy_')) {
        const productId = responseId.replace('buy_', '');
        await initiatePurchase(from, productId);
      } else if (responseId.startsWith('trial_')) {
        const productId = responseId.replace('trial_', '');
        await initiateTrial(from, productId);
      } else if (responseId.startsWith('confirm_purchase_')) {
        const orderId = responseId.replace('confirm_purchase_', '');
        await confirmPurchase(from, orderId);
      } else if (responseId.startsWith('payment_')) {
        const parts = responseId.split('_');
        const orderId = parts[2];
        const action = parts[1];
        
        if (action === 'paid') {
          await db.collection('orders').doc(orderId).update({
            paymentConfirmed: true,
            paymentDate: admin.firestore.FieldValue.serverTimestamp()
          });
          await sendMessage(from, "Thank you for confirming your payment! We'll process your order shortly.");
        } else if (action === 'later') {
          await sendMessage(from, "No problem! Please confirm your payment when you've made it by typing 'status' later.");
        }
      } else if (responseId === 'back_to_catalog') {
        await sendProductCatalog(from);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

async function handleGreeting(to) {
  try {
    const userDoc = await db.collection('users').doc(to).get();
    if (userDoc.exists && userDoc.data().name) {
      await sendMessage(to, `Hello ${userDoc.data().name}! Welcome back to Froy. How can we assist you today?`);
    } else {
      await sendMessage(to, "Hello! Welcome to Froy. To get started, please type 'register' to create your account.");
    }
  } catch (error) {
    console.error('Greeting error:', error);
    await sendMessage(to, "Hello! Welcome to Froy.");
  }
}

async function initiateRegistration(to) {
  try {
    await sendMessage(to, "Let's get you registered. Please reply with your full name:");
    
    await db.collection('users').doc(to).set({
      registrationStep: 'name',
      phone: to,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (error) {
    console.error('Registration initiation error:', error);
    await sendMessage(to, "Registration failed. Please try again later.");
  }
}

async function sendWelcomeMessage(to) {
  try {
    const userDoc = await db.collection('users').doc(to).get();
    
    if (userDoc.exists && userDoc.data().registrationCompleted) {
      await sendProductCatalog(to);
      return;
    }

    const interactiveData = {
      type: 'button',
      body: {
        text: "Welcome to Froy, partnering with Mountain View Electronics!\nAre you a Mountain View Estate resident?"
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
    await sendMessage(to, "Welcome! How can we assist you today?");
  }
}

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

    // Send product image if available
    if (product.images && product.images.length > 0) {
      await sendImage(to, product.images[0], `${product.name}\n${product.description}\nPrice: KES ${product.price}`);
    } else {
      await sendMessage(to, `${product.name}\n${product.description}\nPrice: KES ${product.price}`);
    }

    if (isResident) {
      await sendMessage(to, "As a resident, you qualify for a 7-day free trial of this product!");
    }

    const interactiveData = {
      type: 'button',
      body: { text: "What would you like to do?" },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `more_images_${productId}`, title: 'See More Images' } },
          isResident ? 
            { type: 'reply', reply: { id: `trial_${productId}`, title: 'Start Free Trial' } } :
            { type: 'reply', reply: { id: `buy_${productId}`, title: 'Purchase Now' } }
          ]
      }
    };

    await sendInteractiveMessage(to, interactiveData);
  } catch (error) {
    console.error('Product details error:', error);
    await sendMessage(to, "Couldn't load product details. Please try again.");
  }
}

async function sendAdditionalImages(to, productId) {
  try {
    const doc = await db.collection('products').doc(productId).get();
    if (!doc.exists || !doc.data().images || doc.data().images.length <= 1) {
      await sendMessage(to, "No additional images available for this product.");
      return;
    }

    const images = doc.data().images.slice(1);
    for (const imageUrl of images) {
      await sendImage(to, imageUrl);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const interactiveData = {
      type: 'button',
      body: { text: "Would you like to see a video of this product in action?" },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `video_${productId}`, title: 'Yes, Show Video' } },
          { type: 'reply', reply: { id: `back_to_product_${productId}`, title: 'No, Go Back' } }
        ]
      }
    };

    await sendInteractiveMessage(to, interactiveData);
  } catch (error) {
    console.error('Additional images error:', error);
    await sendMessage(to, "Failed to load additional images. Please try again.");
  }
}

async function initiatePurchase(to, productId) {
  try {
    const productDoc = await db.collection('products').doc(productId).get();
    if (!productDoc.exists) {
      await sendMessage(to, "Product not available for purchase.");
      return;
    }

    const product = productDoc.data();
    const userDoc = await db.collection('users').doc(to).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    const orderRef = await db.collection('orders').add({
      productId: productId,
      productName: product.name,
      price: product.price,
      customerPhone: to,
      customerName: userData.name || '',
      estateNumber: userData.estateNumber || '',
      status: 'pending_payment',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      paymentConfirmed: false,
      deliveryStatus: 'pending',
      isTrial: false
    });

    const interactiveData = {
      type: 'button',
      body: { 
        text: `Purchase ${product.name} for KES ${product.price}\n\nPay to: 123456\nTill Number: 54321\nName: Froy\n\nOnce paid, please confirm below:`
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `payment_paid_${orderRef.id}`, title: 'I Have Paid' } },
          { type: 'reply', reply: { id: `payment_later_${orderRef.id}`, title: 'I will Pay Later' } },
          { type: 'reply', reply: { id: 'cancel_purchase', title: 'Cancel' } }
        ]
      }
    };

    await sendInteractiveMessage(to, interactiveData);
  } catch (error) {
    console.error('Purchase initiation error:', error);
    await sendMessage(to, "Failed to initiate purchase. Please try again.");
  }
}

async function initiateTrial(to, productId) {
  try {
    const productDoc = await db.collection('products').doc(productId).get();
    if (!productDoc.exists) {
      await sendMessage(to, "Product not available for trial.");
      return;
    }

    const product = productDoc.data();
    const userDoc = await db.collection('users').doc(to).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    // Check if user already has an active trial
    const activeTrial = await db.collection('trials')
      .where('customerPhone', '==', to)
      .where('status', '==', 'active')
      .get();

    if (!activeTrial.empty) {
      await sendMessage(to, "You already have an active trial. Please complete that before starting a new one.");
      return;
    }

    const trialRef = await db.collection('trials').add({
      productId: productId,
      productName: product.name,
      customerPhone: to,
      customerName: userData.name || '',
      estateNumber: userData.estateNumber || '',
      status: 'pending',
      startDate: admin.firestore.FieldValue.serverTimestamp(),
      endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection('orders').add({
      productId: productId,
      productName: product.name,
      price: 0,
      customerPhone: to,
      customerName: userData.name || '',
      estateNumber: userData.estateNumber || '',
      status: 'trial_started',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      paymentConfirmed: true,
      deliveryStatus: 'pending',
      isTrial: true,
      trialId: trialRef.id
    });

    await sendMessage(to, `Your 7-day free trial for ${product.name} has been started! We'll contact you for delivery details.`);
    
    // Send product education
    await sendProductEducation(to, productId);
  } catch (error) {
    console.error('Trial initiation error:', error);
    await sendMessage(to, "Failed to start trial. Please try again.");
  }
}

async function sendProductEducation(to, productId) {
  try {
    // In a real implementation, you would use the OPENROUTER_API_KEY to get AI-generated content
    // For this example, we'll use static content
    const educationPoints = [
      "• Charge fully before first use",
      "• Avoid extreme temperatures",
      "• Use included cable for fastest charging",
      "• LED indicators show remaining power",
      "• Compatible with most USB devices"
    ];
    
    await sendMessage(to, `Product Tips for Best Experience:\n\n${educationPoints.join('\n')}`);
  } catch (error) {
    console.error('Product education error:', error);
  }
}

async function confirmPurchase(to, orderId) {
  try {
    await db.collection('orders').doc(orderId).update({
      paymentConfirmed: true,
      paymentDate: admin.firestore.FieldValue.serverTimestamp(),
      status: 'payment_received'
    });

    await sendMessage(to, "Thank you for your payment! We'll process your order shortly. You'll receive updates on your delivery status.");
    
    const orderDoc = await db.collection('orders').doc(orderId).get();
    const productDoc = await db.collection('products').doc(orderDoc.data().productId).get();
    
    if (productDoc.exists) {
      const complementaryItems = await db.collection('complementary_items')
        .where('product_id', '==', orderDoc.data().productId)
        .where('active', '==', true)
        .get();
      
      if (!complementaryItems.empty) {
        await sendMessage(to, "Recommended complementary items:");
        
        for (const item of complementaryItems.docs) {
          const itemData = item.data();
          if (itemData.image) {
            await sendImage(to, itemData.image, `${itemData.name}\n${itemData.description}`);
          } else {
            await sendMessage(to, `${itemData.name}\n${itemData.description}`);
          }
        }
      }
    }

    await updateLoyaltyPoints(to, 10, 'purchase');
  } catch (error) {
    console.error('Purchase confirmation error:', error);
    await sendMessage(to, "Failed to confirm your payment. Please contact support.");
  }
}

async function updateLoyaltyPoints(to, points, reason) {
  try {
    const userRef = db.collection('users').doc(to);
    await userRef.update({
      loyaltyPoints: admin.firestore.FieldValue.increment(points),
      lastActivity: admin.firestore.FieldValue.serverTimestamp()
    });

    await db.collection('loyalty_logs').add({
      userPhone: to,
      points: points,
      reason: reason,
      date: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error('Loyalty points update error:', error);
  }
}

async function checkLoyaltyPoints(to) {
  try {
    const userDoc = await db.collection('users').doc(to).get();
    if (!userDoc.exists) {
      await sendMessage(to, "You're not registered yet. Type 'register' to get started.");
      return;
    }

    const points = userDoc.data().loyaltyPoints || 0;
    await sendMessage(to, `You have ${points} loyalty points. Earn 10 points for each purchase and 5 points for referrals!`);
  } catch (error) {
    console.error('Loyalty points check error:', error);
    await sendMessage(to, "Failed to check your loyalty points. Please try again later.");
  }
}

async function checkOrderStatus(to) {
  try {
    const orders = await db.collection('orders')
      .where('customerPhone', '==', to)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (orders.empty) {
      await sendMessage(to, "No orders found for your account.");
      return;
    }

    const order = orders.docs[0].data();
    let statusMessage = `Order: ${order.productName}\nStatus: ${order.status}`;
    
    if (order.isTrial) {
      statusMessage += "\nType: Free Trial";
      if (order.status === 'trial_started') {
        const trialDoc = await db.collection('trials').doc(order.trialId).get();
        if (trialDoc.exists) {
          const trialData = trialDoc.data();
          const endDate = trialData.endDate.toDate();
          statusMessage += `\nTrial ends: ${endDate.toLocaleDateString()}`;
        }
      }
    }
    
    await sendMessage(to, statusMessage);
  } catch (error) {
    console.error('Order status check error:', error);
    await sendMessage(to, "Failed to check your order status. Please try again later.");
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
