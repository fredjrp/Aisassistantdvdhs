require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const session = require('express-session');

const app = express();
app.use(express.json());

// Session configuration for OAuth
app.use(session({
  secret: process.env.SESSION_SECRET || 'loyverse-whatsapp-bot-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Environment variables
const {
  APP_ID,
  APP_SECRET,
  REDIRECT_URI,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  FALLBACK_BUSINESS_PHONE,
  PORT = 3000
} = process.env;

// File paths for data storage
const TOKEN_FILE = path.join(__dirname, 'loyverse_tokens.json');
const LAST_RECEIPT_FILE = path.join(__dirname, 'lastReceipt.json');
const SALES_DATA_FILE = path.join(__dirname, 'salesData.json');
const RATINGS_FILE = path.join(__dirname, 'customerRatings.json');

// Loyverse OAuth configuration
const LOYVERSE_AUTH_URL = 'https://developer.loyverse.com/oauth/authorize';
const LOYVERSE_TOKEN_URL = 'https://developer.loyverse.com/oauth/token';
const LOYVERSE_API_BASE_URL = 'https://api.loyverse.com/v1.0';

// WhatsApp API configuration
const WHATSAPP_BASE_URL = `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
const WHATSAPP_HEADERS = {
  'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
  'Content-Type': 'application/json'
};

// Admin commands
const ADMIN_COMMANDS = {
  REPORT_TODAY: 'report today',
  REPORT_WEEK: 'report week',
  REPORT_MONTH: 'report month',
  REPORT_YESTERDAY: 'report yesterday',
  TOP_ITEMS: 'top items',
  CUSTOMER_RATINGS: 'ratings',
  HELP: 'help',
  STATUS: 'status'
};

/**
 * Load OAuth tokens from file
 */
async function loadTokens() {
  try {
    const data = await fs.readFile(TOKEN_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

/**
 * Save OAuth tokens to file
 */
async function saveTokens(tokens) {
  try {
    await fs.writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    console.log('✅ OAuth tokens saved');
    return true;
  } catch (error) {
    console.error('❌ Error saving tokens:', error.message);
    return false;
  }
}

/**
 * Check if tokens are valid and refresh if needed
 */
async function getValidAccessToken() {
  const tokens = await loadTokens();
  
  if (!tokens) {
    throw new Error('No OAuth tokens found. Please authenticate first.');
  }
  
  // Check if token is expired (with 5 minute buffer)
  const isExpired = Date.now() >= (tokens.created_at + tokens.expires_in * 1000 - 300000);
  
  if (isExpired) {
    console.log('🔄 Access token expired, refreshing...');
    return await refreshAccessToken(tokens.refresh_token);
  }
  
  return tokens.access_token;
}

/**
 * Refresh access token using refresh token
 */
async function refreshAccessToken(refreshToken) {
  try {
    const response = await axios.post(LOYVERSE_TOKEN_URL, null, {
      params: {
        client_id: APP_ID,
        client_secret: APP_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    const newTokens = {
      ...response.data,
      created_at: Date.now()
    };
    
    await saveTokens(newTokens);
    console.log('✅ Access token refreshed');
    return newTokens.access_token;
  } catch (error) {
    console.error('❌ Error refreshing token:', error.response?.data || error.message);
    throw new Error('Failed to refresh access token. Please re-authenticate.');
  }
}

/**
 * Make authenticated request to Loyverse API
 */
async function makeLoyverseRequest(endpoint, params = {}) {
  try {
    const accessToken = await getValidAccessToken();
    
    const response = await axios.get(`${LOYVERSE_API_BASE_URL}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      params: params
    });
    
    return response.data;
  } catch (error) {
    console.error('❌ Loyverse API error:', error.response?.data || error.message);
    
    // If unauthorized, trigger re-authentication
    if (error.response?.status === 401) {
      throw new Error('Authentication required. Please re-authenticate with Loyverse.');
    }
    
    throw error;
  }
}

/**
 * Load data from JSON file
 */
async function loadJSONFile(filePath, defaultData = null) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return defaultData;
  }
}

/**
 * Save data to JSON file
 */
async function saveJSONFile(filePath, data) {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (error) {
    console.error('❌ Error saving file:', error.message);
    return false;
  }
}

/**
 * Load last processed receipt
 */
async function loadLastReceipt() {
  return await loadJSONFile(LAST_RECEIPT_FILE, null);
}

/**
 * Save last processed receipt
 */
async function saveLastReceipt(receipt) {
  return await saveJSONFile(LAST_RECEIPT_FILE, receipt);
}

/**
 * Load sales data
 */
async function loadSalesData() {
  return await loadJSONFile(SALES_DATA_FILE, { sales: [], dailyTotals: {} });
}

/**
 * Save sales data
 */
async function saveSalesData(data) {
  return await saveJSONFile(SALES_DATA_FILE, data);
}

/**
 * Load customer ratings
 */
async function loadCustomerRatings() {
  return await loadJSONFile(RATINGS_FILE, { ratings: [], average: 0, total: 0 });
}

/**
 * Save customer rating
 */
async function saveCustomerRating(ratingData) {
  const ratings = await loadCustomerRatings();
  ratings.ratings.push(ratingData);
  ratings.total = ratings.ratings.length;
  ratings.average = ratings.ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.total;
  
  return await saveJSONFile(RATINGS_FILE, ratings);
}

/**
 * Fetch recent receipts from Loyverse API
 */
async function fetchRecentReceipts() {
  try {
    // Get receipts from last 5 minutes to ensure we catch new ones
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    
    const data = await makeLoyverseRequest('/receipts', {
      limit: 10,
      sort_by: 'created_at',
      order: 'DESC',
      created_at_min: fiveMinutesAgo
    });
    
    return data.receipts || [];
  } catch (error) {
    console.error('❌ Error fetching Loyverse receipts:', error.message);
    return [];
  }
}

/**
 * Fetch receipts for a specific time period
 */
async function fetchReceiptsByPeriod(startDate, endDate) {
  try {
    const data = await makeLoyverseRequest('/receipts', {
      limit: 50,
      sort_by: 'created_at',
      order: 'DESC',
      created_at_min: startDate,
      created_at_max: endDate
    });
    
    return data.receipts || [];
  } catch (error) {
    console.error('❌ Error fetching period receipts:', error.message);
    return [];
  }
}

/**
 * Extract customer phone from receipt
 */
function extractCustomerPhone(receipt) {
  const customer = receipt.customer;
  if (!customer) return null;
  
  const phone = customer.phone || customer.contact_phone || customer.mobile;
  if (!phone) return null;
  
  let formattedPhone = phone.toString().replace(/\D/g, '');
  
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '254' + formattedPhone.substring(1);
  }
  
  if (formattedPhone.startsWith('7') && formattedPhone.length === 9) {
    formattedPhone = '254' + formattedPhone;
  }
  
  if (formattedPhone.length >= 10 && formattedPhone.length <= 15) {
    return formattedPhone;
  }
  
  return null;
}

/**
 * Format receipt data for WhatsApp message
 */
function formatReceiptData(receipt) {
  const items = receipt.line_items || [];
  const itemNames = items.map(item => item.item_name || 'Unknown Item').join(', ');
  const totalAmount = receipt.total_money ? (receipt.total_money.amount / 100).toFixed(2) : '0.00';
  const currency = receipt.total_money?.currency || 'KES';
  const customerName = receipt.customer?.name || 'Walk-in Customer';
  const timestamp = new Date(receipt.created_at).toLocaleString();
  
  return {
    item_name: itemNames.length > 50 ? itemNames.substring(0, 47) + '...' : itemNames,
    amount: `${currency} ${totalAmount}`,
    customer_name: customerName,
    timestamp: timestamp,
    receipt_id: receipt.receipt_number || receipt.id,
    original_receipt: receipt
  };
}

/**
 * Store sales data for reporting
 */
async function storeSalesData(receipt) {
  const salesData = await loadSalesData();
  const saleDate = new Date(receipt.created_at).toISOString().split('T')[0];
  
  // Add to sales array
  salesData.sales.push({
    id: receipt.id,
    date: saleDate,
    amount: receipt.total_money ? receipt.total_money.amount / 100 : 0,
    currency: receipt.total_money?.currency || 'KES',
    items: receipt.line_items || [],
    customer: receipt.customer?.name || 'Walk-in Customer'
  });
  
  // Update daily totals
  if (!salesData.dailyTotals[saleDate]) {
    salesData.dailyTotals[saleDate] = {
      total: 0,
      count: 0,
      items: {}
    };
  }
  
  salesData.dailyTotals[saleDate].total += receipt.total_money ? receipt.total_money.amount / 100 : 0;
  salesData.dailyTotals[saleDate].count += 1;
  
  // Update item counts
  receipt.line_items?.forEach(item => {
    const itemName = item.item_name || 'Unknown Item';
    if (!salesData.dailyTotals[saleDate].items[itemName]) {
      salesData.dailyTotals[saleDate].items[itemName] = 0;
    }
    salesData.dailyTotals[saleDate].items[itemName] += item.quantity || 1;
  });
  
  // Keep only last 1000 sales to prevent file from growing too large
  if (salesData.sales.length > 1000) {
    salesData.sales = salesData.sales.slice(-500);
  }
  
  await saveSalesData(salesData);
}

/**
 * Generate sales report for a specific period
 */
async function generateSalesReport(period) {
  const salesData = await loadSalesData();
  const now = new Date();
  let startDate, endDate, periodName;
  
  switch (period) {
    case 'today':
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      periodName = 'Today';
      break;
    case 'yesterday':
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      periodName = 'Yesterday';
      break;
    case 'week':
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      periodName = 'Last 7 Days';
      break;
    case 'month':
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
      endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      periodName = 'Last 30 Days';
      break;
    default:
      return 'Invalid period specified';
  }
  
  const periodSales = salesData.sales.filter(sale => {
    const saleDate = new Date(sale.date);
    return saleDate >= startDate && saleDate < endDate;
  });
  
  const totalSales = periodSales.reduce((sum, sale) => sum + sale.amount, 0);
  const totalTransactions = periodSales.length;
  const averageSale = totalTransactions > 0 ? totalSales / totalTransactions : 0;
  
  // Get top items
  const itemCounts = {};
  periodSales.forEach(sale => {
    sale.items.forEach(item => {
      const itemName = item.item_name || 'Unknown Item';
      itemCounts[itemName] = (itemCounts[itemName] || 0) + (item.quantity || 1);
    });
  });
  
  const topItems = Object.entries(itemCounts)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5)
    .map(([name, count]) => `${name} (${count})`)
    .join(', ');
  
  return `📊 ${periodName} Sales Report\n\n` +
         `💰 Total Sales: ${salesData.sales[0]?.currency || 'KES'} ${totalSales.toFixed(2)}\n` +
         `🧾 Transactions: ${totalTransactions}\n` +
         `📈 Average Sale: ${salesData.sales[0]?.currency || 'KES'} ${averageSale.toFixed(2)}\n` +
         `🏆 Top Items: ${topItems || 'No data'}\n` +
         `⏰ Generated: ${new Date().toLocaleString()}`;
}

/**
 * Get top selling items report
 */
async function getTopItemsReport() {
  const salesData = await loadSalesData();
  const itemCounts = {};
  
  salesData.sales.forEach(sale => {
    sale.items.forEach(item => {
      const itemName = item.item_name || 'Unknown Item';
      itemCounts[itemName] = (itemCounts[itemName] || 0) + (item.quantity || 1);
    });
  });
  
  const topItems = Object.entries(itemCounts)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 10);
  
  let report = `🏆 Top 10 Selling Items\n\n`;
  topItems.forEach(([name, count], index) => {
    report += `${index + 1}. ${name}: ${count} sold\n`;
  });
  
  report += `\n⏰ Generated: ${new Date().toLocaleString()}`;
  return report;
}

/**
 * Get customer ratings report
 */
async function getRatingsReport() {
  const ratingsData = await loadCustomerRatings();
  
  if (ratingsData.total === 0) {
    return `⭐ Customer Ratings\n\nNo ratings received yet.\n\nEncourage customers to rate their experience!`;
  }
  
  const ratingCounts = {5: 0, 4: 0, 3: 0, 2: 0, 1: 0};
  ratingsData.ratings.forEach(rating => {
    ratingCounts[rating.rating]++;
  });
  
  return `⭐ Customer Ratings Report\n\n` +
         `📊 Average Rating: ${ratingsData.average.toFixed(1)}/5 ⭐\n` +
         `👥 Total Ratings: ${ratingsData.total}\n\n` +
         `⭐ 5 Stars: ${ratingCounts[5]}\n` +
         `⭐ 4 Stars: ${ratingCounts[4]}\n` +
         `⭐ 3 Stars: ${ratingCounts[3]}\n` +
         `⭐ 2 Stars: ${ratingCounts[2]}\n` +
         `⭐ 1 Star: ${ratingCounts[1]}\n\n` +
         `⏰ Generated: ${new Date().toLocaleString()}`;
}

/**
 * Get system status report
 */
async function getSystemStatus() {
  const tokens = await loadTokens();
  const salesData = await loadSalesData();
  const ratingsData = await loadCustomerRatings();
  
  const isAuthenticated = tokens && Date.now() < (tokens.created_at + tokens.expires_in * 1000 - 300000);
  const totalSales = salesData.sales.length;
  const totalRatings = ratingsData.total;
  
  return `🤖 System Status Report\n\n` +
         `🔐 Authentication: ${isAuthenticated ? '✅ Connected' : '❌ Not Connected'}\n` +
         `📊 Total Sales Tracked: ${totalSales}\n` +
         `⭐ Customer Ratings: ${totalRatings}\n` +
         `📈 Average Rating: ${ratingsData.average.toFixed(1)}/5\n` +
         `🔄 Last Check: ${new Date().toLocaleString()}\n\n` +
         `Use 'help' to see all available commands.`;
}

/**
 * Send WhatsApp message using interactive buttons
 */
async function sendWhatsAppMessage(phoneNumber, messageData) {
  try {
    const messagePayload = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      ...messageData
    };
    
    const response = await axios.post(WHATSAPP_BASE_URL, messagePayload, {
      headers: WHATSAPP_HEADERS
    });
    
    console.log('✅ WhatsApp message sent to:', phoneNumber);
    return { success: true, messageId: response.data.messages?.[0]?.id };
  } catch (error) {
    console.error('❌ Error sending WhatsApp message:', error.response?.data || error.message);
    return { success: false, error: error.response?.data || error.message };
  }
}

/**
 * Send interactive receipt notification
 */
async function sendReceiptNotification(phoneNumber, receiptData) {
  const messagePayload = {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: `💰 New Sale Recorded!\n\nItem: ${receiptData.item_name}\nAmount: ${receiptData.amount}\nCustomer: ${receiptData.customer_name}\nTime: ${receiptData.timestamp}\nReceipt: ${receiptData.receipt_id}\n\nWould you like to view the full receipt?`
      },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: {
              id: 'view_receipt',
              title: 'View Receipt'
            }
          },
          {
            type: 'reply',
            reply: {
              id: 'thank_you',
              title: 'Send Thank You'
            }
          }
        ]
      }
    }
  };
  
  return await sendWhatsAppMessage(phoneNumber, messagePayload);
}

/**
 * Send thank you response with rating request
 */
async function sendThankYouResponse(phoneNumber, customerName) {
  const encouragingMessages = [
    `Thank you ${customerName}! 🙏 Your support means the world to us! We're thrilled to serve you and look forward to your next visit! 🌟`,
    `We appreciate you, ${customerName}! 💫 Your loyalty inspires us to keep delivering excellence. Can't wait to serve you again! 🚀`,
    `Thank you for your business, ${customerName}! 🌈 You're amazing and we're grateful for the opportunity to serve someone as wonderful as you! ✨`,
    `You're awesome, ${customerName}! 🌟 Thank you for choosing us! We're committed to making every experience special for valued customers like you! 💝`,
    `Heartfelt thanks ${customerName}! 🙌 Your support fuels our passion! We're already looking forward to your next visit! 🌠`
  ];
  
  const randomMessage = encouragingMessages[Math.floor(Math.random() * encouragingMessages.length)];
  
  const messagePayload = {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: `${randomMessage}\n\nHow would you rate your experience with us today?`
      },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: {
              id: 'rate_5',
              title: '⭐ 5 Stars'
            }
          },
          {
            type: 'reply',
            reply: {
              id: 'rate_4',
              title: '⭐ 4 Stars'
            }
          },
          {
            type: 'reply',
            reply: {
              id: 'rate_3',
              title: '⭐ 3 Stars'
            }
          }
        ]
      }
    }
  };
  
  return await sendWhatsAppMessage(phoneNumber, messagePayload);
}

/**
 * Send rating confirmation
 */
async function sendRatingConfirmation(phoneNumber, rating) {
  const thankYouMessages = {
    5: `🎉 Wow! 5 Stars! Thank you for the perfect rating! You made our day! 🌟 We'll keep striving to exceed your expectations!`,
    4: `😊 Thank you for the 4-star rating! We're glad you had a great experience and we'll work to make it even better next time! ✨`,
    3: `🙏 Thanks for the 3-star rating and your valuable feedback! We're constantly improving and appreciate you helping us grow! 🌱`
  };
  
  const message = thankYouMessages[rating] || `Thank you for your ${rating}-star rating! We appreciate your feedback!`;
  
  const messagePayload = {
    type: 'text',
    text: { body: message }
  };
  
  return await sendWhatsAppMessage(phoneNumber, messagePayload);
}

/**
 * Send admin help menu
 */
async function sendAdminHelp(phoneNumber) {
  const messagePayload = {
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: '📊 Admin Reports Menu' },
      body: { text: 'Select a report type or use text commands:' },
      footer: { text: 'Available commands: report today/week/month/yesterday, top items, ratings, status, help' },
      action: {
        button: 'View Reports',
        sections: [
          {
            title: '📈 Sales Reports',
            rows: [
              { id: 'report_today', title: 'Today\'s Report', description: 'Sales data for today' },
              { id: 'report_week', title: 'Weekly Report', description: 'Last 7 days sales' },
              { id: 'report_month', title: 'Monthly Report', description: 'Last 30 days sales' }
            ]
          },
          {
            title: '📊 Analytics',
            rows: [
              { id: 'top_items', title: 'Top Selling Items', description: 'Most popular products' },
              { id: 'ratings_report', title: 'Customer Ratings', description: 'Service feedback ratings' },
              { id: 'system_status', title: 'System Status', description: 'Bot status and connection' }
            ]
          }
        ]
      }
    }
  };
  
  return await sendWhatsAppMessage(phoneNumber, messagePayload);
}

/**
 * Handle admin commands
 */
async function handleAdminCommand(phoneNumber, messageText) {
  const command = messageText.toLowerCase().trim();
  
  try {
    let report;
    
    switch (command) {
      case ADMIN_COMMANDS.REPORT_TODAY:
        report = await generateSalesReport('today');
        break;
      case ADMIN_COMMANDS.REPORT_WEEK:
        report = await generateSalesReport('week');
        break;
      case ADMIN_COMMANDS.REPORT_MONTH:
        report = await generateSalesReport('month');
        break;
      case ADMIN_COMMANDS.REPORT_YESTERDAY:
        report = await generateSalesReport('yesterday');
        break;
      case ADMIN_COMMANDS.TOP_ITEMS:
        report = await getTopItemsReport();
        break;
      case ADMIN_COMMANDS.CUSTOMER_RATINGS:
        report = await getRatingsReport();
        break;
      case ADMIN_COMMANDS.STATUS:
        report = await getSystemStatus();
        break;
      case ADMIN_COMMANDS.HELP:
        await sendAdminHelp(phoneNumber);
        return;
      default:
        // Send help menu for unknown commands
        await sendAdminHelp(phoneNumber);
        return;
    }
    
    // Send the report as a text message
    await sendWhatsAppMessage(phoneNumber, {
      type: 'text',
      text: { body: report }
    });
    
  } catch (error) {
    console.error('❌ Error handling admin command:', error);
    await sendWhatsAppMessage(phoneNumber, {
      type: 'text',
      text: { body: '❌ Error generating report. Please try again.' }
    });
  }
}

/**
 * Check if number is admin
 */
function isAdminNumber(phoneNumber) {
  return phoneNumber === FALLBACK_BUSINESS_PHONE;
}

/**
 * Main function to check for new receipts and send notifications
 */
async function checkForNewSales() {
  console.log('🔄 Checking for new Loyverse sales...');
  
  try {
    // Check if we have valid authentication
    await getValidAccessToken();
    
    const lastReceipt = await loadLastReceipt();
    const lastReceiptId = lastReceipt?.id;
    
    const receipts = await fetchRecentReceipts();
    
    if (receipts.length === 0) {
      console.log('📭 No recent receipts found');
      return;
    }
    
    receipts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    let newReceiptsFound = 0;
    
    for (const receipt of receipts) {
      if (receipt.id === lastReceiptId) {
        break;
      }
      
      console.log('🆕 New receipt found:', receipt.id);
      newReceiptsFound++;
      
      // Store sales data for reporting
      await storeSalesData(receipt);
      
      const customerPhone = extractCustomerPhone(receipt);
      const recipientPhone = customerPhone || FALLBACK_BUSINESS_PHONE;
      
      if (!recipientPhone) {
        console.log('⚠️ No recipient phone found for receipt:', receipt.id);
        continue;
      }
      
      const receiptData = formatReceiptData(receipt);
      await sendReceiptNotification(recipientPhone, receiptData);
      
      console.log(`📨 Notification sent to: ${recipientPhone} (${customerPhone ? 'Customer' : 'Business'})`);
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    if (newReceiptsFound > 0 && receipts.length > 0) {
      await saveLastReceipt(receipts[0]);
      console.log(`🎉 Processed ${newReceiptsFound} new receipt(s)`);
    } else {
      console.log('✅ No new receipts to process');
    }
    
  } catch (error) {
    console.error('❌ Error in sales check:', error.message);
    
    // If authentication error, send alert to admin
    if (error.message.includes('Authentication required') || error.message.includes('No OAuth tokens')) {
      await sendWhatsAppMessage(FALLBACK_BUSINESS_PHONE, {
        type: 'text',
        text: { body: `🔐 Authentication Alert:\n\n${error.message}\n\nPlease visit your bot URL to re-authenticate with Loyverse.` }
      });
    }
  }
}

/**
 * OAuth Routes
 */

// Initiate OAuth flow
app.get('/auth', (req, res) => {
  const authUrl = `${LOYVERSE_AUTH_URL}?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=read:receipts`;
  res.redirect(authUrl);
});

// OAuth callback handler
app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  
  if (error) {
    return res.status(400).send(`OAuth Error: ${error}`);
  }
  
  if (!code) {
    return res.status(400).send('No authorization code received');
  }
  
  try {
    // Exchange authorization code for access token
    const response = await axios.post(LOYVERSE_TOKEN_URL, null, {
      params: {
        client_id: APP_ID,
        client_secret: APP_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    const tokens = {
      ...response.data,
      created_at: Date.now()
    };
    
    await saveTokens(tokens);
    
    // Send success notification to admin
    await sendWhatsAppMessage(FALLBACK_BUSINESS_PHONE, {
      type: 'text',
      text: { body: '✅ Successfully connected to Loyverse!\n\nYour sales notifications are now active. You will receive WhatsApp messages for new sales.' }
    });
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Loyverse Connection Successful</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
          .success { color: #22c55e; font-size: 24px; }
          .message { margin: 20px 0; }
        </style>
      </head>
      <body>
        <div class="success">✅ Connection Successful!</div>
        <div class="message">Your Loyverse account has been successfully connected.</div>
        <div>You can now close this window and return to WhatsApp.</div>
      </body>
      </html>
    `);
    
  } catch (error) {
    console.error('❌ OAuth callback error:', error.response?.data || error.message);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Connection Failed</title>
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
          .error { color: #ef4444; font-size: 24px; }
        </style>
      </head>
      <body>
        <div class="error">❌ Connection Failed</div>
        <div>Please try again or contact support.</div>
      </body>
      </html>
    `);
  }
});

/**
 * Webhook endpoint for WhatsApp messages
 */
app.post('/webhook', async (req, res) => {
  try {
    const { entry } = req.body;
    
    if (!entry || !entry[0]?.changes?.[0]?.value?.messages?.[0]) {
      return res.sendStatus(200);
    }
    
    const message = entry[0].changes[0].value.messages[0];
    const from = message.from;
    const type = message.type;
    
    console.log('📱 Incoming WhatsApp message from:', from);
    
    // Handle interactive messages (button replies)
    if (type === 'interactive') {
      const interactive = message.interactive;
      const buttonId = interactive.button_reply?.id;
      
      console.log('🔘 Button pressed:', buttonId);
      
      if (buttonId === 'thank_you') {
        // Send thank you message with rating request
        await sendThankYouResponse(from, 'valued customer');
      } else if (buttonId.startsWith('rate_')) {
        // Handle rating
        const rating = parseInt(buttonId.split('_')[1]);
        await saveCustomerRating({
          phone: from,
          rating: rating,
          timestamp: new Date().toISOString()
        });
        await sendRatingConfirmation(from, rating);
      } else if (buttonId === 'view_receipt') {
        // Send receipt details
        await sendWhatsAppMessage(from, {
          type: 'text',
          text: { body: '📄 Full receipt details are available in your Loyverse dashboard. Thank you for your business! 🛍️' }
        });
      } else if (buttonId.startsWith('report_')) {
        // Handle admin report buttons
        const reportType = buttonId.replace('report_', '');
        const report = await generateSalesReport(reportType);
        await sendWhatsAppMessage(from, {
          type: 'text',
          text: { body: report }
        });
      } else if (buttonId === 'top_items') {
        const report = await getTopItemsReport();
        await sendWhatsAppMessage(from, {
          type: 'text',
          text: { body: report }
        });
      } else if (buttonId === 'ratings_report') {
        const report = await getRatingsReport();
        await sendWhatsAppMessage(from, {
          type: 'text',
          text: { body: report }
        });
      } else if (buttonId === 'system_status') {
        const report = await getSystemStatus();
        await sendWhatsAppMessage(from, {
          type: 'text',
          text: { body: report }
        });
      }
    }
    
    // Handle text messages from admin
    if (type === 'text' && isAdminNumber(from)) {
      const messageText = message.text.body;
      await handleAdminCommand(from, messageText);
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.sendStatus(500);
  }
});

/**
 * Test endpoint to manually trigger a WhatsApp message
 */
app.get('/test', async (req, res) => {
  try {
    const testReceiptData = {
      item_name: 'Test Product 1, Test Product 2',
      amount: 'KES 1500.00',
      customer_name: 'Test Customer',
      timestamp: new Date().toLocaleString(),
      receipt_id: 'TEST-001'
    };
    
    const success = await sendReceiptNotification(FALLBACK_BUSINESS_PHONE, testReceiptData);
    
    if (success.success) {
      res.json({ 
        success: true, 
        message: 'Test WhatsApp message sent successfully',
        to: FALLBACK_BUSINESS_PHONE
      });
    } else {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to send test message' 
      });
    }
  } catch (error) {
    console.error('❌ Test endpoint error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'Test failed', 
      error: error.message 
    });
  }
});

/**
 * Health check endpoint
 */
app.get('/', (req, res) => {
  res.json({
    status: '✅ Loyverse-WhatsApp Bot Running',
    timestamp: new Date().toISOString(),
    authentication: {
      required: true,
      endpoint: '/auth',
      callback: '/callback'
    },
    features: [
      'OAuth 2.0 authentication',
      'Automatic sales notifications',
      'Admin reports (today, week, month, yesterday)',
      'Top items analytics',
      'Customer rating system',
      'Interactive WhatsApp messages'
    ],
    endpoints: {
      'GET /': 'Health check',
      'GET /auth': 'Start OAuth flow',
      'GET /callback': 'OAuth callback',
      'GET /test': 'Send test WhatsApp message',
      'POST /webhook': 'WhatsApp webhook',
      'POST /check-sales': 'Manual sales check'
    }
  });
});

/**
 * Manual trigger for sales check
 */
app.post('/check-sales', async (req, res) => {
  try {
    await checkForNewSales();
    res.json({ 
      success: true, 
      message: 'Sales check completed manually' 
    });
  } catch (error) {
    console.error('❌ Manual check error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'Manual check failed', 
      error: error.message 
    });
  }
});

// Start scheduled job to check for new sales every minute
cron.schedule('* * * * *', () => {
  console.log('⏰ Running scheduled sales check...');
  checkForNewSales();
});

// Initialize and start the server
async function initialize() {
  try {
    // Initialize data files
    await loadLastReceipt() || await saveLastReceipt({ id: null, timestamp: new Date().toISOString() });
    await loadSalesData() || await saveSalesData({ sales: [], dailyTotals: {} });
    await loadCustomerRatings() || await saveJSONFile(RATINGS_FILE, { ratings: [], average: 0, total: 0 });
    
    // Start server
    app.listen(PORT, () => {
      console.log('🚀 Enhanced Loyverse-WhatsApp Bot Started');
      console.log('📊 Server running on port:', PORT);
      console.log('👑 Admin phone:', FALLBACK_BUSINESS_PHONE);
      console.log('🔐 OAuth Required: Visit /auth to authenticate');
      console.log('⏰ Features: OAuth + Sales notifications + Admin reports + Customer ratings');
      
      // Check authentication status
      loadTokens().then(tokens => {
        if (tokens) {
          console.log('✅ Loyverse tokens found');
        } else {
          console.log('⚠️ No Loyverse tokens - authentication required');
        }
      });
    });
  } catch (error) {
    console.error('❌ Failed to initialize server:', error.message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Shutting down gracefully...');
  process.exit(0);
});

// Start the application
initialize();
