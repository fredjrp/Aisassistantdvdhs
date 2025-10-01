require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

const app = express();
app.use(express.json());

const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

const {
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_WEBHOOK_SECRET,
  WEBHOOK_VERIFY_TOKEN,
  PHONE_NUMBER_ID,
  FIREBASE_PROJECT_ID,
  FIREBASE_PRIVATE_KEY,
  FIREBASE_CLIENT_EMAIL,
  DEFAULT_CURRENCY = 'KES',
  BUSINESS_NAME = 'Cyber Cafe & Dropshipping',
  OPENROUTER_API_KEY,
  EXPORT_EXPIRY_DAYS = '7'
} = process.env;

// Firebase Initialization
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID || "key-id",
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID || "client-id",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL || `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.FIREBASE_CLIENT_EMAIL?.replace('@', '%40')}`,
  universe_domain: "googleapis.com"
};

// Validate required fields
if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
  console.error('❌ Missing required Firebase environment variables');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Core Accounting Engine
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

// Transaction Validator
class TransactionValidator {
  static validateTransaction(data) {
    const errors = [];
    
    if (!data.quantity || data.quantity < 1) errors.push("Quantity must be at least 1");
    if (!data.unitPrice || data.unitPrice <= 0) errors.push("Unit price must be positive");
    if (!data.paymentMethod) errors.push("Payment method is required");
    if (!data.productOrService) errors.push("Product/service is required");
    if (!data.clientName) errors.push("Client name is required");
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }
  
  static validateProfit(profitData) {
    if (profitData.profit < 0) {
      return {
        warning: true,
        message: "⚠️ This transaction shows negative profit. Please confirm if this is correct."
      };
    }
    return { warning: false };
  }
}

// Excel Export Service
class ExcelExportService {
  async generateTransactionReport(transactions, filters = {}) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Transactions');
    
    worksheet.columns = [
      { header: 'Transaction ID', key: 'transactionId', width: 20 },
      { header: 'Timestamp', key: 'timestamp', width: 20 },
      { header: 'User Name', key: 'userName', width: 15 },
      { header: 'Product/Service', key: 'productOrService', width: 20 },
      { header: 'Quantity', key: 'quantity', width: 10 },
      { header: 'Unit Price', key: 'unitPrice', width: 12 },
      { header: 'Total Amount', key: 'totalAmount', width: 12 },
      { header: 'Cost Price', key: 'costPrice', width: 12 },
      { header: 'Profit', key: 'profit', width: 12 },
      { header: 'Savings (25%)', key: 'savings25', width: 15 },
      { header: 'Tax (15%)', key: 'tax15', width: 12 },
      { header: 'Payment Method', key: 'paymentMethod', width: 15 },
      { header: 'Client Name', key: 'clientName', width: 15 },
      { header: 'Client Phone', key: 'clientPhone', width: 15 },
      { header: 'Notes', key: 'notes', width: 20 },
      { header: 'Source', key: 'source', width: 12 },
      { header: 'Status', key: 'status', width: 12 }
    ];
    
    transactions.forEach(transaction => {
      const savings = AccountingEngine.calculateSavings(transaction.profit);
      const tax = AccountingEngine.calculateTax(transaction.profit);
      
      worksheet.addRow({
        transactionId: transaction.transactionId,
        timestamp: transaction.createdAt.toDate().toISOString(),
        userName: transaction.userName,
        productOrService: transaction.productOrService,
        quantity: transaction.quantity,
        unitPrice: transaction.unitPrice,
        totalAmount: transaction.totalAmount,
        costPrice: transaction.costPrice,
        profit: transaction.profit,
        savings25: savings,
        tax15: tax,
        paymentMethod: transaction.paymentMethod,
        clientName: transaction.clientName,
        clientPhone: transaction.clientPhone,
        notes: transaction.notes,
        source: transaction.source,
        status: transaction.status
      });
    });
    
    return workbook;
  }
  
  async uploadToStorage(workbook, exportId) {
    const buffer = await workbook.xlsx.writeBuffer();
    const filePath = `exports/${exportId}.xlsx`;
    
    const file = bucket.file(filePath);
    await file.save(buffer, {
      metadata: {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }
    });
    
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000
    });
    
    return url;
  }
}

// Edit Request System
class EditRequestSystem {
  static async createEditRequest(transactionId, userId, changes, reason) {
    const transactionRef = db.collection('transactions').doc(transactionId);
    const transactionDoc = await transactionRef.get();
    
    if (!transactionDoc.exists) {
      throw new Error("Transaction not found");
    }
    
    const transaction = transactionDoc.data();
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    if (transaction.createdBy !== userId && transaction.createdAt.toDate() < fiveMinutesAgo) {
      throw new Error("Edit window expired. Request admin approval.");
    }
    
    const editRequest = {
      requestedBy: userId,
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
      reason,
      changes,
      status: 'pending'
    };
    
    await transactionRef.update({
      status: 'edit_requested',
      editRequests: admin.firestore.FieldValue.arrayUnion(editRequest)
    });
    
    return editRequest;
  }
}

// AI Assistant
class AIAssistant {
  static generateConfirmationMessage(transactionData, calculations) {
    return `✅ Transaction Recorded:\n\n` +
      `📦 ${transactionData.quantity} x ${transactionData.productOrService}\n` +
      `💰 Amount: ${DEFAULT_CURRENCY} ${transactionData.totalAmount}\n` +
      `💵 Profit: ${DEFAULT_CURRENCY} ${calculations.profit}\n` +
      `🏦 Savings (25%): ${DEFAULT_CURRENCY} ${calculations.savings}\n` +
      `🏛️ Tax (15%): ${DEFAULT_CURRENCY} ${calculations.tax}\n` +
      `👤 Client: ${transactionData.clientName} ${transactionData.clientPhone}\n` +
      `📋 Ref: ${transactionData.transactionId}\n` +
      `⏰ Time: ${new Date().toLocaleString()}`;
  }
  
  static async handleNaturalLanguageQuery(userMessage, userRole) {
    if (userRole !== 'admin') {
      return "Natural language queries are available for admins only.";
    }
    
    const intents = {
      'photocopy sales': { product: 'photocopy', period: 'week' },
      'printing this week': { product: 'printing', period: 'week' },
      'today revenue': { metric: 'revenue', period: 'today' }
    };
    
    const matchedIntent = Object.keys(intents).find(intent => 
      userMessage.toLowerCase().includes(intent)
    );
    
    if (matchedIntent) {
      return await generateQuickReport(intents[matchedIntent]);
    }
    
    return "I can help with sales reports. Try: 'photocopy sales' or 'today revenue'";
  }
}

// Utility Functions
async function logMessage(direction, messageData) {
  try {
    const logData = {
      ...messageData,
      direction,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };

    Object.keys(logData).forEach(key => {
      if (logData[key] === undefined) {
        delete logData[key];
      }
    });

    await db.collection('whatsapp_logs').add(logData);
  } catch (err) {
    console.error('❌ Failed to log message:', err);
  }
}

async function sendMessage(to, text) {
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
      messageId: response.data.messages?.[0]?.id
    });

    return response;
  } catch (err) {
    console.error('❌ Send message error:', err.response?.data || err.message);
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
    console.error('❌ Interactive message error:', err.response?.data || err.message);
    throw err;
  }
}

async function getUserRole(phoneNumber) {
  try {
    const userDoc = await db.collection('users').doc(phoneNumber).get();
    if (userDoc.exists) {
      return userDoc.data().role;
    }
    return null;
  } catch (error) {
    console.error('Error getting user role:', error);
    return null;
  }
}

// WhatsApp Message Flows
async function sendMainMenu(to, userRole) {
  if (userRole === 'admin') {
    const interactiveData = {
      type: 'button',
      body: { text: "👑 Admin Menu - Select Action:" },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'todays_report', title: '📊 Today\'s Report' } },
          { type: 'reply', reply: { id: 'custom_report', title: '📅 Custom Report' } },
          { type: 'reply', reply: { id: 'download_excel', title: '📥 Export Excel' } },
          { type: 'reply', reply: { id: 'manage_products', title: '🛍️ Products' } }
        ]
      }
    };
    await sendInteractiveMessage(to, interactiveData);
  } else {
    const interactiveData = {
      type: 'button',
      body: { text: "📊 Accounting Menu - Select Action:" },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'log_sale', title: '💰 Log Sale' } },
          { type: 'reply', reply: { id: 'list_clients', title: '👥 Clients' } },
          { type: 'reply', reply: { id: 'my_sales_today', title: '📈 My Sales' } },
          { type: 'reply', reply: { id: 'help', title: '❓ Help' } }
        ]
      }
    };
    await sendInteractiveMessage(to, interactiveData);
  }
}

async function sendProductSelection(to) {
  const interactiveData = {
    type: 'list',
    header: { type: 'text', text: '🛍️ Select Product/Service' },
    body: { text: 'Choose from available products:' },
    action: {
      button: 'View Products',
      sections: [{
        title: 'Cyber Cafe Services',
        rows: [
          { id: 'printing_single', title: 'Printing - Single', description: `${DEFAULT_CURRENCY} 20` },
          { id: 'printing_double', title: 'Printing - Double', description: `${DEFAULT_CURRENCY} 35` },
          { id: 'photocopy', title: 'Photocopy', description: `${DEFAULT_CURRENCY} 10` },
          { id: 'internet_hour', title: 'Internet - 1 Hour', description: `${DEFAULT_CURRENCY} 100` }
        ]
      }, {
        title: 'Dropshipping Items', 
        rows: [
          { id: 'powerbank', title: 'Power Bank', description: `${DEFAULT_CURRENCY} 1500` },
          { id: 'phone_case', title: 'Phone Case', description: `${DEFAULT_CURRENCY} 800` }
        ]
      }]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
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

async function sendClientSelection(to, clients) {
  if (clients.length === 0) {
    await sendMessage(to, '👤 No existing clients found. Please type the client name:');
    return;
  }

  const interactiveData = {
    type: 'list',
    header: { type: 'text', text: '👥 Select Client' },
    body: { text: 'Choose existing client or select "New Client":' },
    action: {
      button: 'Select Client',
      sections: [{
        title: 'Existing Clients',
        rows: clients.slice(0, 8).map(client => ({
          id: `client_${client.clientId}`,
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

// Transaction Management
async function createTransaction(transactionData) {
  try {
    const transactionId = `TXN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Get product config
    const productDoc = await db.collection('config/products').doc(transactionData.productOrService).get();
    const productConfig = productDoc.exists ? productDoc.data() : null;
    
    // Calculate financials
    const calculations = AccountingEngine.calculateProfit(transactionData, productConfig);
    const savings = AccountingEngine.calculateSavings(calculations.profit);
    const tax = AccountingEngine.calculateTax(calculations.profit);
    
    // Get user data
    const userDoc = await db.collection('users').doc(transactionData.userNumber).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    
    const transaction = {
      transactionId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: transactionData.userNumber,
      userNumber: transactionData.userNumber,
      userName: userData.name || 'Unknown',
      productOrService: transactionData.productOrService,
      quantity: transactionData.quantity,
      unitPrice: transactionData.unitPrice,
      totalAmount: calculations.revenue,
      costPrice: calculations.costPrice,
      profit: calculations.profit,
      expenses: transactionData.expenses || [],
      clientId: transactionData.clientId,
      clientName: transactionData.clientName,
      clientPhone: transactionData.clientPhone,
      paymentMethod: transactionData.paymentMethod,
      notes: transactionData.notes || '',
      source: transactionData.source || 'cybercafe',
      status: 'recorded'
    };
    
    await db.collection('transactions').doc(transactionId).set(transaction);
    
    // Update client if exists, otherwise create
    if (transactionData.clientId) {
      await db.collection('clients').doc(transactionData.clientId).update({
        lastTransaction: admin.firestore.FieldValue.serverTimestamp(),
        totalTransactions: admin.firestore.FieldValue.increment(1)
      });
    } else {
      const clientId = `CLIENT_${Date.now()}`;
      await db.collection('clients').doc(clientId).set({
        clientId,
        name: transactionData.clientName,
        phoneNumber: transactionData.clientPhone,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        totalTransactions: 1,
        lastTransaction: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    
    return {
      transaction,
      calculations: {
        ...calculations,
        savings,
        tax
      }
    };
  } catch (error) {
    console.error('Error creating transaction:', error);
    throw error;
  }
}

// Report Generation
async function generateTodaysReport(userNumber) {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    
    let transactionsQuery = db.collection('transactions')
      .where('createdAt', '>=', startOfDay)
      .where('createdAt', '<=', endOfDay);
    
    const userRole = await getUserRole(userNumber);
    if (userRole !== 'admin') {
      transactionsQuery = transactionsQuery.where('userNumber', '==', userNumber);
    }
    
    const snapshot = await transactionsQuery.get();
    const transactions = snapshot.docs.map(doc => doc.data());
    
    const totals = transactions.reduce((acc, transaction) => {
      acc.revenue += transaction.totalAmount;
      acc.profit += transaction.profit;
      acc.savings += AccountingEngine.calculateSavings(transaction.profit);
      acc.tax += AccountingEngine.calculateTax(transaction.profit);
      return acc;
    }, { revenue: 0, profit: 0, savings: 0, tax: 0 });
    
    return {
      summary: `📊 Today's Report (${new Date().toLocaleDateString()})\n\n` +
               `💰 Total Revenue: ${DEFAULT_CURRENCY} ${totals.revenue.toFixed(2)}\n` +
               `💵 Total Profit: ${DEFAULT_CURRENCY} ${totals.profit.toFixed(2)}\n` +
               `🏦 Total Savings: ${DEFAULT_CURRENCY} ${totals.savings.toFixed(2)}\n` +
               `🏛️ Total Tax: ${DEFAULT_CURRENCY} ${totals.tax.toFixed(2)}\n` +
               `📈 Total Transactions: ${transactions.length}`,
      transactions,
      totals
    };
  } catch (error) {
    console.error('Error generating report:', error);
    throw error;
  }
}

async function initiateExport(userNumber, filters = {}) {
  try {
    const exportId = `EXP_${Date.now()}`;
    
    await db.collection('exports').doc(exportId).set({
      exportId,
      requestedBy: userNumber,
      type: filters.type || 'custom',
      query: filters,
      status: 'processing',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });
    
    // Process export in background
    processExport(exportId, filters);
    
    return exportId;
  } catch (error) {
    console.error('Error initiating export:', error);
    throw error;
  }
}

async function processExport(exportId, filters) {
  try {
    let transactionsQuery = db.collection('transactions');
    
    if (filters.dateFrom && filters.dateTo) {
      const startDate = new Date(filters.dateFrom);
      const endDate = new Date(filters.dateTo);
      endDate.setHours(23, 59, 59, 999);
      
      transactionsQuery = transactionsQuery
        .where('createdAt', '>=', startDate)
        .where('createdAt', '<=', endDate);
    }
    
    if (filters.userId) {
      transactionsQuery = transactionsQuery.where('userNumber', '==', filters.userId);
    }
    
    if (filters.product) {
      transactionsQuery = transactionsQuery.where('productOrService', '==', filters.product);
    }
    
    const snapshot = await transactionsQuery.get();
    const transactions = snapshot.docs.map(doc => doc.data());
    
    const exportService = new ExcelExportService();
    const workbook = await exportService.generateTransactionReport(transactions, filters);
    const fileUrl = await exportService.uploadToStorage(workbook, exportId);
    
    await db.collection('exports').doc(exportId).update({
      status: 'completed',
      fileUrl,
      completedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    // Notify user
    const exportDoc = await db.collection('exports').doc(exportId).get();
    const exportData = exportDoc.data();
    
    await sendMessage(exportData.requestedBy, 
      `✅ Your export is ready!\n\n` +
      `📊 Type: ${exportData.type}\n` +
      `📈 Records: ${transactions.length}\n` +
      `🔗 Download: ${fileUrl}\n\n` +
      `This link expires in 7 days.`
    );
    
  } catch (error) {
    console.error('Error processing export:', error);
    await db.collection('exports').doc(exportId).update({
      status: 'failed',
      error: error.message
    });
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

// Webhook Handlers
app.get('/', (req, res) => res.send(`✅ ${BUSINESS_NAME} WhatsApp Accounting Bot Running`));

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    business: BUSINESS_NAME
  });
});

app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode && token === WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

function validateWebhookSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  
  if (!signature) {
    return res.status(401).json({ error: 'Missing signature' });
  }
  
  const expectedSignature = crypto
    .createHmac('sha256', WHATSAPP_WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');
    
  if (signature !== `sha256=${expectedSignature}`) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  next();
}

app.post('/webhook', validateWebhookSignature, async (req, res) => {
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

    const userRole = await getUserRole(from);
    const session = getUserSession(from);

    // Handle menu command
    if (message.text?.body?.toLowerCase().trim() === 'menu') {
      await sendMainMenu(from, userRole);
      return res.sendStatus(200);
    }

    // Handle interactive messages
    let userInput = '';
    if (message.type === 'text') {
      userInput = message.text.body;
    } else if (message.type === 'interactive') {
      if (message.interactive.type === 'button_reply') {
        userInput = message.interactive.button_reply.id;
      } else if (message.interactive.type === 'list_reply') {
        userInput = message.interactive.list_reply.id;
      }
    }

    // Handle main menu options
    if (['log_sale', 'todays_report', 'custom_report', 'download_excel', 'my_sales_today'].includes(userInput)) {
      session.currentFlow = userInput;
      session.step = 0;
      session.transactionData = {};
    }

    // Process based on current flow
    switch (session.currentFlow) {
      case 'log_sale':
        await handleLogSaleFlow(from, userInput, session);
        break;
      case 'todays_report':
        await handleTodaysReport(from, userRole);
        session.currentFlow = null;
        break;
      case 'my_sales_today':
        await handleMySalesToday(from);
        session.currentFlow = null;
        break;
      case 'download_excel':
        await handleDownloadExcel(from);
        session.currentFlow = null;
        break;
      default:
        if (userRole === 'admin') {
          await sendMainMenu(from, 'admin');
        } else {
          await sendMainMenu(from, 'personnel');
        }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// Flow Handlers
async function handleLogSaleFlow(from, userInput, session) {
  try {
    switch (session.step) {
      case 0: // Start - get amount or price quantity
        await sendMessage(from, '💰 Log Sale - Enter amount received or type "price quantity" (e.g., "200 2"):');
        session.step = 1;
        break;

      case 1: // Parse amount/quantity
        if (userInput.includes(' ')) {
          const [unitPrice, quantity] = userInput.split(' ').map(Number);
          if (!isNaN(unitPrice) && !isNaN(quantity)) {
            session.transactionData.unitPrice = unitPrice;
            session.transactionData.quantity = quantity;
            session.transactionData.totalAmount = unitPrice * quantity;
          }
        } else {
          const amount = Number(userInput);
          if (!isNaN(amount)) {
            session.transactionData.totalAmount = amount;
            session.transactionData.quantity = 1;
            session.transactionData.unitPrice = amount;
          }
        }

        if (session.transactionData.unitPrice && session.transactionData.quantity) {
          await sendProductSelection(from);
          session.step = 2;
        } else {
          await sendMessage(from, '❌ Please enter valid numbers. Try "200 2" or just "200":');
        }
        break;

      case 2: // Product selection
        if (userInput.startsWith('printing_') || userInput === 'photocopy' || userInput === 'internet_hour' || 
            userInput === 'powerbank' || userInput === 'phone_case') {
          session.transactionData.productOrService = userInput;
          session.transactionData.source = userInput === 'powerbank' || userInput === 'phone_case' ? 'dropship' : 'cybercafe';
          
          // Get existing clients
          const clientsSnapshot = await db.collection('clients').limit(10).get();
          const clients = clientsSnapshot.docs.map(doc => doc.data());
          
          await sendClientSelection(from, clients);
          session.step = 3;
        } else {
          await sendProductSelection(from);
        }
        break;

      case 3: // Client selection
        if (userInput === 'client_new') {
          await sendMessage(from, '👤 Please enter client name:');
          session.step = 4;
        } else if (userInput.startsWith('client_')) {
          const clientId = userInput.replace('client_', '');
          const clientDoc = await db.collection('clients').doc(clientId).get();
          if (clientDoc.exists) {
            const client = clientDoc.data();
            session.transactionData.clientId = clientId;
            session.transactionData.clientName = client.name;
            session.transactionData.clientPhone = client.phoneNumber;
            await sendPaymentMethodSelection(from);
            session.step = 5;
          }
        }
        break;

      case 4: // New client name
        session.transactionData.clientName = userInput;
        await sendMessage(from, '📱 Please enter client phone number:');
        session.step = 6;
        break;

      case 5: // Payment method
        if (userInput.startsWith('payment_')) {
          session.transactionData.paymentMethod = userInput.replace('payment_', '');
          await sendMessage(from, '📝 Any notes? (optional)');
          session.step = 7;
        }
        break;

      case 6: // New client phone
        session.transactionData.clientPhone = userInput;
        await sendPaymentMethodSelection(from);
        session.step = 5;
        break;

      case 7: // Notes and confirmation
        if (userInput !== 'payment_cash' && userInput !== 'payment_mpesa' && userInput !== 'payment_card') {
          session.transactionData.notes = userInput;
        }

        // Validate transaction
        const validation = TransactionValidator.validateTransaction(session.transactionData);
        if (!validation.isValid) {
          await sendMessage(from, `❌ Validation errors:\n${validation.errors.join('\n')}`);
          session.currentFlow = null;
          return;
        }

        // Create transaction
        session.transactionData.userNumber = from;
        const result = await createTransaction(session.transactionData);
        
        // Check for profit warning
        const profitWarning = TransactionValidator.validateProfit(result.calculations);
        if (profitWarning.warning) {
          await sendMessage(from, profitWarning.message);
        }

        // Send confirmation
        const confirmationMessage = AIAssistant.generateConfirmationMessage(
          result.transaction, 
          result.calculations
        );
        await sendMessage(from, confirmationMessage);

        // Reset flow
        session.currentFlow = null;
        session.step = 0;
        session.transactionData = {};
        break;
    }
  } catch (error) {
    console.error('Log sale flow error:', error);
    await sendMessage(from, '❌ An error occurred. Please try again or type "menu" to restart.');
    session.currentFlow = null;
  }
}

async function handleTodaysReport(from, userRole) {
  try {
    const report = await generateTodaysReport(from);
    await sendMessage(from, report.summary);
    
    if (userRole === 'admin') {
      const interactiveData = {
        type: 'button',
        body: { text: '📊 Report Actions:' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'download_excel', title: '📥 Export Excel' } },
            { type: 'reply', reply: { id: 'show_breakdown', title: '📈 Show Breakdown' } }
          ]
        }
      };
      await sendInteractiveMessage(from, interactiveData);
    }
  } catch (error) {
    console.error('Report error:', error);
    await sendMessage(from, '❌ Error generating report. Please try again.');
  }
}

async function handleMySalesToday(from) {
  try {
    const report = await generateTodaysReport(from);
    await sendMessage(from, report.summary);
  } catch (error) {
    console.error('My sales error:', error);
    await sendMessage(from, '❌ Error retrieving your sales. Please try again.');
  }
}

async function handleDownloadExcel(from) {
  try {
    const exportId = await initiateExport(from, { type: 'daily' });
    await sendMessage(from, '⏳ Generating Excel export... You will receive a download link when ready.');
  } catch (error) {
    console.error('Export error:', error);
    await sendMessage(from, '❌ Error creating export. Please try again.');
  }
}

// API Endpoints
app.post('/api/transactions', async (req, res) => {
  try {
    const transactionData = req.body;
    const result = await createTransaction(transactionData);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/transactions', async (req, res) => {
  try {
    const { dateFrom, dateTo, userId, product } = req.query;
    let query = db.collection('transactions');

    if (dateFrom && dateTo) {
      const startDate = new Date(dateFrom);
      const endDate = new Date(dateTo);
      endDate.setHours(23, 59, 59, 999);
      query = query.where('createdAt', '>=', startDate).where('createdAt', '<=', endDate);
    }

    if (userId) {
      query = query.where('userNumber', '==', userId);
    }

    if (product) {
      query = query.where('productOrService', '==', product);
    }

    const snapshot = await query.get();
    const transactions = snapshot.docs.map(doc => doc.data());
    
    res.json({ success: true, data: transactions });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/transactions/:id/edit-request', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, changes, reason } = req.body;
    
    const editRequest = await EditRequestSystem.createEditRequest(id, userId, changes, reason);
    res.json({ success: true, data: editRequest });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/export', async (req, res) => {
  try {
    const { filters } = req.body;
    const exportId = await initiateExport(req.user.phoneNumber, filters);
    res.json({ success: true, exportId });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/export/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const exportDoc = await db.collection('exports').doc(id).get();
    
    if (!exportDoc.exists) {
      return res.status(404).json({ success: false, error: 'Export not found' });
    }
    
    res.json({ success: true, data: exportDoc.data() });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ${BUSINESS_NAME} Accounting Bot running on port ${PORT}`);
  console.log(`💰 Default Currency: ${DEFAULT_CURRENCY}`);
  console.log(`⏰ Started: ${new Date().toISOString()}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

