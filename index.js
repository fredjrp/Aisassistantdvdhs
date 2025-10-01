require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');

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
  OPENROUTER_API_KEY
} = process.env;

const rawConfig = JSON.parse(process.env.FIREBASE_CONFIG);
rawConfig.private_key = rawConfig.private_key.replace(/\\n/g, '\n');
admin.initializeApp({ credential: admin.credential.cert(rawConfig) });
const db = admin.firestore();

async function initializeCollections() {
  try {
    const collections = ['users', 'transactions', 'clients', 'products', 'exports', 'whatsapp_logs', 'conversations'];
    for (const col of collections) {
      const snapshot = await db.collection(col).limit(1).get();
      if (snapshot.empty) {
        if (col === 'products') {
          await db.collection(col).add({
            name: "Printing - Single Page",
            category: "printing",
            defaultCostPrice: 5,
            defaultUnitPrice: 20,
            source: "cybercafe",
            active: true,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        } else if (col === 'users') {
          await db.collection(col).add({
            phone: "+254700000000",
            name: "Admin User",
            role: "admin",
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

// AI Response Generator with Firebase context
async function generateAIResponse(prompt, phoneNumber, context = "") {
  try {
    // Get user data from Firebase
    const userDoc = await db.collection('users').doc(phoneNumber).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    
    // Get today's transactions
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    
    const transactionsSnapshot = await db.collection('transactions')
      .where('userNumber', '==', phoneNumber)
      .where('createdAt', '>=', startOfDay)
      .where('createdAt', '<=', endOfDay)
      .get();
    const todaysTransactions = transactionsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    // Get user's clients
    const clientsSnapshot = await db.collection('clients')
      .where('createdBy', '==', phoneNumber)
      .limit(10)
      .get();
    const clients = clientsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Build context from Firebase data
    const firebaseContext = `
      User Data:
      - Name: ${userData.name || 'Not provided'}
      - Role: ${userData.role || 'Not set'}
      
      Today's Activity:
      - Transactions: ${todaysTransactions.length}
      - Total Sales: KES ${todaysTransactions.reduce((sum, t) => sum + (t.totalAmount || 0), 0)}
      
      Your Clients:
      ${clients.length > 0 ? clients.map(c => `- ${c.name} (${c.phoneNumber})`).join('\n') : 'No clients yet'}
      
      Available Commands:
      - 'menu' - Show main menu
      - 'log sale' - Record a new sale
      - 'my sales' - View today's sales
      - 'clients' - Manage clients
      - 'report' - Generate reports (admin only)
      
      ${context}
    `;

    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: "openai/gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: `You are a helpful accounting assistant. Only use information from the provided context.
            Key commands: 'menu', 'log sale', 'my sales', 'clients', 'report'.
            ${firebaseContext}`
          },
          {
            role: "user",
            content: prompt
          }
        ],
        max_tokens: 150
      },
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('AI generation error:', error.response?.data || error.message);
    return "I'm having trouble understanding. Could you please rephrase that?";
  }
}

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
    
    // Log outgoing message
    await db.collection('whatsapp_logs').add({
      direction: 'outgoing',
      to: to,
      from: PHONE_NUMBER_ID,
      type: 'text',
      message: { text: { body: text } },
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
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
    
    // Log outgoing message
    await db.collection('whatsapp_logs').add({
      direction: 'outgoing',
      to: to,
      from: PHONE_NUMBER_ID,
      type: 'interactive',
      message: interactiveData,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return response.data;
  } catch (error) {
    console.error('Interactive message error:', error.response?.data || error.message);
    throw error;
  }
}

// Accounting Engine
class AccountingEngine {
  static calculateProfit(transactionData, productConfig = null) {
    const { quantity, unitPrice, totalAmount, costPrice } = transactionData;
    
    let actualCostPrice = costPrice;
    
    if (!actualCostPrice && productConfig && productConfig.defaultCostPrice) {
      actualCostPrice = productConfig.defaultCostPrice;
    }
    
    const revenue = totalAmount || (quantity * unitPrice);
    const cost = actualCostPrice ? (actualCostPrice * quantity) : 0;
    const profit = revenue - cost;
    
    return {
      revenue,
      cost,
      profit: Math.round(profit * 100) / 100,
      costPrice: actualCostPrice
    };
  }
  
  static calculateSavings(profit) {
    return Math.round((profit * 0.25) * 100) / 100;
  }
  
  static calculateTax(profit) {
    return Math.round((profit * 0.15) * 100) / 100;
  }
}

// User Session Management
const userSessions = new Map();

function getUserSession(phoneNumber) {
  if (!userSessions.has(phoneNumber)) {
    userSessions.set(phoneNumber, {
      currentFlow: null,
      transactionData: {},
      step: 0
    });
  }
  return userSessions.get(phoneNumber);
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

    // Store conversation context
    await db.collection('conversations').doc(from).set({
      lastMessage: message.type === 'text' ? message.text.body : message.type,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Log incoming message
    await db.collection('whatsapp_logs').add({
      direction: 'incoming',
      from: from,
      type: message.type,
      message: message,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    // Handle greetings
    if (message.type === 'text') {
      const text = message.text.body.toLowerCase().trim();
      
      if (['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'].includes(text)) {
        await handleGreeting(from);
        return res.sendStatus(200);
      }
      
      if (text === 'menu') {
        await sendMainMenu(from);
        return res.sendStatus(200);
      } else if (text === 'register') {
        await initiateRegistration(from);
        return res.sendStatus(200);
      } else if (text === 'my sales') {
        await showMySalesToday(from);
        return res.sendStatus(200);
      } else if (text === 'clients') {
        await showClientManagement(from);
        return res.sendStatus(200);
      } else if (text === 'report') {
        await generateDailyReport(from);
        return res.sendStatus(200);
      }

      // Handle registration text responses
      const userDoc = await db.collection('users').doc(from).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        if (userData.registrationStep === 'name') {
          await db.collection('users').doc(from).update({
            name: message.text.body,
            registrationStep: 'role'
          });
          await sendRoleSelection(from);
          return res.sendStatus(200);
        }
      }

      // Handle transaction flow text responses
      const session = getUserSession(from);
      if (session.currentFlow === 'log_sale') {
        await handleLogSaleText(from, message.text.body, session);
        return res.sendStatus(200);
      }

      // Handle general conversation with AI
      const aiResponse = await generateAIResponse(text, from);
      await sendMessage(from, aiResponse);
      return res.sendStatus(200);
    }

    if (message.type === 'interactive') {
      const interactiveType = message.interactive.type;
      let responseId = '';

      if (interactiveType === 'button_reply') {
        responseId = message.interactive.button_reply.id;
      } else if (interactiveType === 'list_reply') {
        responseId = message.interactive.list_reply.id;
      }

      console.log('Interactive response:', responseId);

      if (responseId === 'role_admin' || responseId === 'role_personnel') {
        await db.collection('users').doc(from).update({
          role: responseId.replace('role_', ''),
          registrationStep: 'complete',
          registrationCompleted: true
        });
        await sendMessage(from, "Registration complete! Type 'menu' to see accounting options.");
      } else if (responseId === 'menu_log_sale') {
        await startLogSaleFlow(from);
      } else if (responseId === 'menu_my_sales') {
        await showMySalesToday(from);
      } else if (responseId === 'menu_clients') {
        await showClientManagement(from);
      } else if (responseId === 'menu_report') {
        await generateDailyReport(from);
      } else if (responseId.startsWith('product_')) {
        const productId = responseId.replace('product_', '');
        await handleProductSelection(from, productId);
      } else if (responseId.startsWith('client_')) {
        const clientId = responseId.replace('client_', '');
        await handleClientSelection(from, clientId);
      } else if (responseId === 'client_new') {
        await handleNewClient(from);
      } else if (responseId.startsWith('payment_')) {
        const paymentMethod = responseId.replace('payment_', '');
        await handlePaymentMethod(from, paymentMethod);
      } else if (responseId === 'confirm_transaction') {
        await confirmTransaction(from);
      } else if (responseId === 'cancel_transaction') {
        await cancelTransaction(from);
      }

      return res.sendStatus(200);
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
      await sendMessage(to, `Hello ${userDoc.data().name}! Welcome back to Accounting System. Type 'menu' to see options.`);
    } else {
      await sendMessage(to, "Hello! Welcome to the Accounting System. To get started, please type 'register' to create your account.");
    }
  } catch (error) {
    console.error('Greeting error:', error);
    await sendMessage(to, "Hello! Welcome to the Accounting System.");
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

async function sendRoleSelection(to) {
  const interactiveData = {
    type: 'button',
    body: {
      text: "Please select your role:"
    },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'role_admin', title: '👑 Admin' } },
        { type: 'reply', reply: { id: 'role_personnel', title: '👤 Personnel' } }
      ]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function sendMainMenu(to) {
  try {
    const userDoc = await db.collection('users').doc(to).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    if (!userData.role) {
      await sendMessage(to, "Please complete registration first by typing 'register'");
      return;
    }

    // FIXED: Only show 3 buttons max (WhatsApp limit)
    let buttons = [
      { type: 'reply', reply: { id: 'menu_log_sale', title: '💰 Log Sale' } },
      { type: 'reply', reply: { id: 'menu_my_sales', title: '📈 My Sales' } },
      { type: 'reply', reply: { id: 'menu_clients', title: '👥 Clients' } }
    ];

    // Add admin-only option as separate menu
    if (userData.role === 'admin') {
      buttons = [
        { type: 'reply', reply: { id: 'menu_log_sale', title: '💰 Log Sale' } },
        { type: 'reply', reply: { id: 'menu_my_sales', title: '📈 My Sales' } },
        { type: 'reply', reply: { id: 'menu_report', title: '📊 Admin Report' } }
      ];
    }

    const interactiveData = {
      type: 'button',
      body: {
        text: `📊 Accounting Menu (${userData.role})\nSelect an action:`
      },
      action: {
        buttons: buttons
      }
    };

    await sendInteractiveMessage(to, interactiveData);
  } catch (error) {
    console.error('Main menu error:', error);
    await sendMessage(to, "Error loading menu. Please try again.");
  }
}

async function startLogSaleFlow(to) {
  try {
    const session = getUserSession(to);
    session.currentFlow = 'log_sale';
    session.step = 0;
    session.transactionData = {};
    
    await sendMessage(to, "💰 Log Sale\n\nEnter amount received or type 'price quantity' (e.g., '200 2'):");
  } catch (error) {
    console.error('Start log sale error:', error);
    await sendMessage(to, "Failed to start sale logging. Please try again.");
  }
}

async function handleLogSaleText(to, text, session) {
  try {
    switch (session.step) {
      case 0: // Parse amount/quantity
        if (text.includes(' ')) {
          const [unitPrice, quantity] = text.split(' ').map(Number);
          if (!isNaN(unitPrice) && !isNaN(quantity)) {
            session.transactionData.unitPrice = unitPrice;
            session.transactionData.quantity = quantity;
            session.transactionData.totalAmount = unitPrice * quantity;
          }
        } else {
          const amount = Number(text);
          if (!isNaN(amount)) {
            session.transactionData.totalAmount = amount;
            session.transactionData.quantity = 1;
            session.transactionData.unitPrice = amount;
          }
        }

        if (session.transactionData.unitPrice && session.transactionData.quantity) {
          await sendProductSelection(to);
          session.step = 1;
        } else {
          await sendMessage(to, '❌ Please enter valid numbers. Try "200 2" or just "200":');
        }
        break;

      case 2: // New client name
        session.transactionData.clientName = text;
        await sendMessage(to, '📱 Please enter client phone number:');
        session.step = 3;
        break;

      case 3: // New client phone
        session.transactionData.clientPhone = text;
        await sendPaymentMethodSelection(to);
        session.step = 4;
        break;

      case 4: // Notes
        session.transactionData.notes = text;
        await confirmTransactionDetails(to, session.transactionData);
        session.step = 5;
        break;
    }
  } catch (error) {
    console.error('Log sale text handling error:', error);
    await sendMessage(to, "Error processing your input. Please try again.");
    session.currentFlow = null;
  }
}

async function sendProductSelection(to) {
  try {
    const snapshot = await db.collection('products').where('active', '==', true).get();
    if (snapshot.empty) {
      await sendMessage(to, "No products available. Please contact admin.");
      return;
    }

    const products = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        title: data.name.length > 24 ? data.name.substring(0, 21) + '...' : data.name,
        description: `KES ${data.defaultUnitPrice}`,
        ...data
      };
    });

    const interactiveData = {
      type: 'list',
      header: { 
        type: 'text', 
        text: '🛍️ Select Product'
      },
      body: { 
        text: 'Choose a product:' 
      },
      action: {
        button: 'Browse Products',
        sections: [{
          title: 'Available Products',
          rows: products.map(product => ({
            id: `product_${product.id}`,
            title: product.title,
            description: product.description
          }))
        }]
      }
    };

    await sendInteractiveMessage(to, interactiveData);
  } catch (error) {
    console.error('Product selection error:', error);
    await sendMessage(to, "Error loading products. Please try again.");
  }
}

async function handleProductSelection(to, productId) {
  try {
    const session = getUserSession(to);
    session.transactionData.productOrService = productId;
    
    // Get product details for cost calculation
    const productDoc = await db.collection('products').doc(productId).get();
    if (productDoc.exists) {
      const product = productDoc.data();
      session.transactionData.source = product.source || 'cybercafe';
    }
    
    // Show client selection
    const clientsSnapshot = await db.collection('clients')
      .where('createdBy', '==', to)
      .limit(8)
      .get();
    const clients = clientsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    if (clients.length === 0) {
      await sendMessage(to, '👤 No existing clients found. Please enter client name:');
      session.step = 2;
    } else {
      const interactiveData = {
        type: 'list',
        header: { type: 'text', text: '👥 Select Client' },
        body: { text: 'Choose existing client or add new:' },
        action: {
          button: 'Select Client',
          sections: [{
            title: 'Existing Clients',
            rows: clients.map(client => ({
              id: `client_${client.id}`,
              title: client.name,
              description: client.phoneNumber
            })).concat([{
              id: 'client_new',
              title: '➕ New Client',
              description: 'Add new client'
            }])
          }]
        }
      };
      await sendInteractiveMessage(to, interactiveData);
    }
  } catch (error) {
    console.error('Product selection handling error:', error);
    await sendMessage(to, "Error processing product selection. Please try again.");
  }
}

async function handleClientSelection(to, clientId) {
  try {
    const session = getUserSession(to);
    
    if (clientId === 'new') {
      await sendMessage(to, '👤 Please enter client name:');
      session.step = 2;
    } else {
      const clientDoc = await db.collection('clients').doc(clientId).get();
      if (clientDoc.exists) {
        const client = clientDoc.data();
        session.transactionData.clientId = clientId;
        session.transactionData.clientName = client.name;
        session.transactionData.clientPhone = client.phoneNumber;
        await sendPaymentMethodSelection(to);
        session.step = 4;
      }
    }
  } catch (error) {
    console.error('Client selection error:', error);
    await sendMessage(to, "Error selecting client. Please try again.");
  }
}

async function handleNewClient(to) {
  try {
    const session = getUserSession(to);
    await sendMessage(to, '👤 Please enter client name:');
    session.step = 2;
  } catch (error) {
    console.error('New client error:', error);
    await sendMessage(to, "Error starting new client. Please try again.");
  }
}

async function sendPaymentMethodSelection(to) {
  const interactiveData = {
    type: 'button',
    body: { text: '💳 Select Payment Method:' },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'payment_cash', title: '💵 Cash' } },
        { type: 'reply', reply: { id: 'payment_mpesa', title: '📱 MPESA' } },
        { type: 'reply', reply: { id: 'payment_card', title: '💳 Card' } }
      ]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function handlePaymentMethod(to, paymentMethod) {
  try {
    const session = getUserSession(to);
    session.transactionData.paymentMethod = paymentMethod;
    await sendMessage(to, '📝 Any notes? (optional)');
    session.step = 4;
  } catch (error) {
    console.error('Payment method error:', error);
    await sendMessage(to, "Error setting payment method. Please try again.");
  }
}

async function confirmTransactionDetails(to, transactionData) {
  try {
    // Calculate financials
    const productDoc = await db.collection('products').doc(transactionData.productOrService).get();
    const productConfig = productDoc.exists ? productDoc.data() : null;
    
    const calculations = AccountingEngine.calculateProfit(transactionData, productConfig);
    const savings = AccountingEngine.calculateSavings(calculations.profit);
    const tax = AccountingEngine.calculateTax(calculations.profit);

    const confirmationText = `✅ Confirm Transaction:\n\n` +
      `📦 ${transactionData.quantity} x ${productConfig?.name || 'Product'}\n` +
      `💰 Amount: KES ${transactionData.totalAmount}\n` +
      `💵 Profit: KES ${calculations.profit}\n` +
      `🏦 Savings (25%): KES ${savings}\n` +
      `🏛️ Tax (15%): KES ${tax}\n` +
      `👤 Client: ${transactionData.clientName}\n` +
      `💳 Payment: ${transactionData.paymentMethod}\n` +
      `📝 Notes: ${transactionData.notes || 'None'}`;

    const interactiveData = {
      type: 'button',
      body: { text: confirmationText },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'confirm_transaction', title: '✅ Confirm' } },
          { type: 'reply', reply: { id: 'cancel_transaction', title: '❌ Cancel' } }
        ]
      }
    };

    await sendInteractiveMessage(to, interactiveData);
  } catch (error) {
    console.error('Transaction confirmation error:', error);
    await sendMessage(to, "Error confirming transaction. Please try again.");
  }
}

async function confirmTransaction(to) {
  try {
    const session = getUserSession(to);
    const transactionData = session.transactionData;
    
    if (!transactionData.productOrService || !transactionData.clientName) {
      await sendMessage(to, "❌ Missing transaction data. Please start over.");
      session.currentFlow = null;
      return;
    }
    
    // Get user data
    const userDoc = await db.collection('users').doc(to).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    
    // Get product config for calculations
    const productDoc = await db.collection('products').doc(transactionData.productOrService).get();
    const productConfig = productDoc.exists ? productDoc.data() : null;
    
    // Calculate financials
    const calculations = AccountingEngine.calculateProfit(transactionData, productConfig);
    const savings = AccountingEngine.calculateSavings(calculations.profit);
    const tax = AccountingEngine.calculateTax(calculations.profit);
    
    // Create transaction record
    const transactionId = `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const transaction = {
      transactionId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: to,
      userNumber: to,
      userName: userData.name || 'Unknown',
      productOrService: transactionData.productOrService,
      productName: productConfig?.name || 'Unknown Product',
      quantity: transactionData.quantity,
      unitPrice: transactionData.unitPrice,
      totalAmount: calculations.revenue,
      costPrice: calculations.costPrice,
      profit: calculations.profit,
      savings: savings,
      tax: tax,
      clientId: transactionData.clientId,
      clientName: transactionData.clientName,
      clientPhone: transactionData.clientPhone,
      paymentMethod: transactionData.paymentMethod,
      notes: transactionData.notes || '',
      source: transactionData.source || 'cybercafe',
      status: 'recorded'
    };
    
    await db.collection('transactions').doc(transactionId).set(transaction);
    
    // Create client if new
    if (!transactionData.clientId) {
      const clientId = `CLIENT_${Date.now()}`;
      await db.collection('clients').doc(clientId).set({
        clientId,
        name: transactionData.clientName,
        phoneNumber: transactionData.clientPhone,
        createdBy: to,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        totalTransactions: 1,
        lastTransaction: admin.firestore.FieldValue.serverTimestamp()
      });
    } else {
      // Update existing client
      await db.collection('clients').doc(transactionData.clientId).update({
        lastTransaction: admin.firestore.FieldValue.serverTimestamp(),
        totalTransactions: admin.firestore.FieldValue.increment(1)
      });
    }
    
    // Send confirmation
    const successMessage = `✅ Transaction Recorded!\n\n` +
      `📦 ${transaction.quantity} x ${transaction.productName}\n` +
      `💰 Amount: KES ${transaction.totalAmount}\n` +
      `💵 Profit: KES ${transaction.profit}\n` +
      `🏦 Savings: KES ${transaction.savings}\n` +
      `🏛️ Tax: KES ${transaction.tax}\n` +
      `👤 Client: ${transaction.clientName}\n` +
      `📋 Ref: ${transaction.transactionId}\n` +
      `⏰ Time: ${new Date().toLocaleString()}`;
    
    await sendMessage(to, successMessage);
    
    // Reset session
    session.currentFlow = null;
    session.step = 0;
    session.transactionData = {};
    
  } catch (error) {
    console.error('Transaction confirmation error:', error);
    await sendMessage(to, "❌ Failed to record transaction. Please try again.");
    
    // Reset session on error
    const session = getUserSession(to);
    session.currentFlow = null;
    session.step = 0;
    session.transactionData = {};
  }
}

async function cancelTransaction(to) {
  try {
    const session = getUserSession(to);
    session.currentFlow = null;
    session.step = 0;
    session.transactionData = {};
    
    await sendMessage(to, "❌ Transaction cancelled. Type 'menu' to see options.");
  } catch (error) {
    console.error('Transaction cancellation error:', error);
    await sendMessage(to, "Error cancelling transaction.");
  }
}

async function showMySalesToday(to) {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    
    const snapshot = await db.collection('transactions')
      .where('userNumber', '==', to)
      .where('createdAt', '>=', startOfDay)
      .where('createdAt', '<=', endOfDay)
      .get();
    
    const transactions = snapshot.docs.map(doc => doc.data());
    
    if (transactions.length === 0) {
      await sendMessage(to, "📊 No sales recorded today.");
      return;
    }
    
    const totals = transactions.reduce((acc, t) => {
      acc.revenue += t.totalAmount || 0;
      acc.profit += t.profit || 0;
      acc.savings += t.savings || 0;
      acc.tax += t.tax || 0;
      return acc;
    }, { revenue: 0, profit: 0, savings: 0, tax: 0 });
    
    const report = `📊 My Sales Today\n\n` +
      `💰 Total Revenue: KES ${totals.revenue.toFixed(2)}\n` +
      `💵 Total Profit: KES ${totals.profit.toFixed(2)}\n` +
      `🏦 Total Savings: KES ${totals.savings.toFixed(2)}\n` +
      `🏛️ Total Tax: KES ${totals.tax.toFixed(2)}\n` +
      `📈 Total Transactions: ${transactions.length}`;
    
    await sendMessage(to, report);
    
  } catch (error) {
    console.error('My sales error:', error);
    await sendMessage(to, "❌ Error retrieving your sales. Please try again.");
  }
}

async function showClientManagement(to) {
  try {
    const snapshot = await db.collection('clients')
      .where('createdBy', '==', to)
      .orderBy('lastTransaction', 'desc')
      .limit(10)
      .get();
    
    const clients = snapshot.docs.map(doc => doc.data());
    
    if (clients.length === 0) {
      await sendMessage(to, "👥 No clients found. Start by logging a sale!");
      return;
    }
    
    let clientList = "👥 Your Clients:\n\n";
    clients.forEach((client, index) => {
      clientList += `${index + 1}. ${client.name} (${client.phoneNumber})\n`;
      clientList += `   Transactions: ${client.totalTransactions || 0}\n\n`;
    });
    
    await sendMessage(to, clientList);
    
  } catch (error) {
    console.error('Client management error:', error);
    await sendMessage(to, "❌ Error loading clients. Please try again.");
  }
}

async function generateDailyReport(to) {
  try {
    const userDoc = await db.collection('users').doc(to).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    
    if (userData.role !== 'admin') {
      await sendMessage(to, "❌ This feature is for admins only.");
      return;
    }
    
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    
    const snapshot = await db.collection('transactions')
      .where('createdAt', '>=', startOfDay)
      .where('createdAt', '<=', endOfDay)
      .get();
    
    const transactions = snapshot.docs.map(doc => doc.data());
    
    if (transactions.length === 0) {
      await sendMessage(to, "📊 No transactions recorded today.");
      return;
    }
    
    const totals = transactions.reduce((acc, t) => {
      acc.revenue += t.totalAmount || 0;
      acc.profit += t.profit || 0;
      acc.savings += t.savings || 0;
      acc.tax += t.tax || 0;
      return acc;
    }, { revenue: 0, profit: 0, savings: 0, tax: 0 });
    
    // Group by user
    const userTotals = {};
    transactions.forEach(t => {
      if (!userTotals[t.userNumber]) {
        userTotals[t.userNumber] = { revenue: 0, transactions: 0, userName: t.userName };
      }
      userTotals[t.userNumber].revenue += t.totalAmount || 0;
      userTotals[t.userNumber].transactions += 1;
    });
    
    let report = `📊 Daily Admin Report\n\n` +
      `📅 Date: ${new Date().toLocaleDateString()}\n` +
      `💰 Total Revenue: KES ${totals.revenue.toFixed(2)}\n` +
      `💵 Total Profit: KES ${totals.profit.toFixed(2)}\n` +
      `🏦 Total Savings: KES ${totals.savings.toFixed(2)}\n` +
      `🏛️ Total Tax: KES ${totals.tax.toFixed(2)}\n` +
      `📈 Total Transactions: ${transactions.length}\n\n` +
      `👥 By User:\n`;
    
    Object.entries(userTotals).forEach(([userNumber, data]) => {
      report += `- ${data.userName}: KES ${data.revenue.toFixed(2)} (${data.transactions} txns)\n`;
    });
    
    await sendMessage(to, report);
    
  } catch (error) {
    console.error('Daily report error:', error);
    await sendMessage(to, "❌ Error generating report. Please try again.");
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Accounting System running on port ${PORT}`);
});
