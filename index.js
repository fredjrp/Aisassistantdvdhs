require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// Environment variables
const {
  LOYVERSE_API_TOKEN,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  BUSINESS_PHONE,
  PORT = 3000
} = process.env;

// File path for storing last processed receipt
const LAST_RECEIPT_FILE = path.join(__dirname, 'lastReceipt.json');

// Loyverse API configuration
const LOYVERSE_BASE_URL = 'https://api.loyverse.com/v1.0';
const LOYVERSE_HEADERS = {
  'Authorization': `Bearer ${LOYVERSE_API_TOKEN}`,
  'Content-Type': 'application/json'
};

// WhatsApp API configuration
const WHATSAPP_BASE_URL = `https://graph.facebook.com/v17.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
const WHATSAPP_HEADERS = {
  'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
  'Content-Type': 'application/json'
};

/**
 * Load last processed receipt from file
 */
async function loadLastReceipt() {
  try {
    const data = await fs.readFile(LAST_RECEIPT_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // File doesn't exist or is invalid, return null
    return null;
  }
}

/**
 * Save last processed receipt to file
 */
async function saveLastReceipt(receipt) {
  try {
    await fs.writeFile(LAST_RECEIPT_FILE, JSON.stringify(receipt, null, 2));
    console.log('✅ Last receipt saved:', receipt.id);
  } catch (error) {
    console.error('❌ Error saving last receipt:', error.message);
  }
}

/**
 * Fetch recent receipts from Loyverse API
 */
async function fetchRecentReceipts() {
  try {
    // Get receipts from last 5 minutes to ensure we catch new ones
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    
    const response = await axios.get(
      `${LOYVERSE_BASE_URL}/receipts?limit=10&sort_by=created_at&order=DESC&created_at_min=${fiveMinutesAgo}`,
      { headers: LOYVERSE_HEADERS }
    );
    
    return response.data.receipts || [];
  } catch (error) {
    console.error('❌ Error fetching Loyverse receipts:', error.response?.data || error.message);
    return [];
  }
}

/**
 * Extract customer phone from receipt
 */
function extractCustomerPhone(receipt) {
  // Loyverse customer data might be in different fields
  const customer = receipt.customer;
  
  if (!customer) return null;
  
  // Try different possible phone fields
  const phone = customer.phone || customer.contact_phone || customer.mobile;
  
  if (!phone) return null;
  
  // Format phone number for WhatsApp (ensure international format)
  let formattedPhone = phone.toString().replace(/\D/g, '');
  
  // If starts with 0, assume Kenya and convert to 254
  if (formattedPhone.startsWith('0')) {
    formattedPhone = '254' + formattedPhone.substring(1);
  }
  
  // If starts with 7 and no country code, assume Kenya
  if (formattedPhone.startsWith('7') && formattedPhone.length === 9) {
    formattedPhone = '254' + formattedPhone;
  }
  
  // Ensure it's a valid WhatsApp number format
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
    receipt_id: receipt.receipt_number || receipt.id
  };
}

/**
 * Send WhatsApp message using interactive buttons
 */
async function sendWhatsAppMessage(phoneNumber, receiptData) {
  try {
    const messagePayload = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
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
    
    const response = await axios.post(WHATSAPP_BASE_URL, messagePayload, {
      headers: WHATSAPP_HEADERS
    });
    
    console.log('✅ WhatsApp message sent to:', phoneNumber);
    console.log('📱 Message ID:', response.data.messages?.[0]?.id);
    
    return true;
  } catch (error) {
    console.error('❌ Error sending WhatsApp message:', error.response?.data || error.message);
    return false;
  }
}

/**
 * Send simple text message (fallback)
 */
async function sendSimpleMessage(phoneNumber, text) {
  try {
    const messagePayload = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'text',
      text: { body: text }
    };
    
    await axios.post(WHATSAPP_BASE_URL, messagePayload, {
      headers: WHATSAPP_HEADERS
    });
    
    console.log('✅ Simple message sent to:', phoneNumber);
    return true;
  } catch (error) {
    console.error('❌ Error sending simple message:', error.response?.data || error.message);
    return false;
  }
}

/**
 * Main function to check for new receipts and send notifications
 */
async function checkForNewSales() {
  console.log('🔄 Checking for new Loyverse sales...');
  
  try {
    // Load last processed receipt
    const lastReceipt = await loadLastReceipt();
    const lastReceiptId = lastReceipt?.id;
    
    // Fetch recent receipts
    const receipts = await fetchRecentReceipts();
    
    if (receipts.length === 0) {
      console.log('📭 No recent receipts found');
      return;
    }
    
    // Sort by creation date (newest first)
    receipts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    let newReceiptsFound = 0;
    
    // Process receipts from newest to oldest
    for (const receipt of receipts) {
      // Stop if we reach the last processed receipt
      if (receipt.id === lastReceiptId) {
        break;
      }
      
      console.log('🆕 New receipt found:', receipt.id);
      newReceiptsFound++;
      
      // Determine recipient phone number
      const customerPhone = extractCustomerPhone(receipt);
      const recipientPhone = customerPhone || BUSINESS_PHONE;
      
      if (!recipientPhone) {
        console.log('⚠️ No recipient phone found for receipt:', receipt.id);
        continue;
      }
      
      // Format receipt data
      const receiptData = formatReceiptData(receipt);
      
      // Send WhatsApp message
      const messageSent = await sendWhatsAppMessage(recipientPhone, receiptData);
      
      if (messageSent) {
        console.log(`📨 Notification sent to: ${recipientPhone} (${customerPhone ? 'Customer' : 'Business'})`);
        
        // Log the activity
        console.log('🧾 Receipt Details:', {
          id: receipt.id,
          amount: receiptData.amount,
          customer: receiptData.customer_name,
          items: receiptData.item_name
        });
      }
      
      // Small delay between messages to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Update last processed receipt if we found new ones
    if (newReceiptsFound > 0 && receipts.length > 0) {
      await saveLastReceipt(receipts[0]);
      console.log(`🎉 Processed ${newReceiptsFound} new receipt(s)`);
    } else {
      console.log('✅ No new receipts to process');
    }
    
  } catch (error) {
    console.error('❌ Error in sales check:', error.message);
  }
}

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
    
    const success = await sendWhatsAppMessage(BUSINESS_PHONE, testReceiptData);
    
    if (success) {
      res.json({ 
        success: true, 
        message: 'Test WhatsApp message sent successfully',
        to: BUSINESS_PHONE
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
    endpoints: {
      '/': 'Health check',
      '/test': 'Send test WhatsApp message',
      '/check-sales': 'Manually trigger sales check'
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

/**
 * Endpoint to view last processed receipt
 */
app.get('/last-receipt', async (req, res) => {
  try {
    const lastReceipt = await loadLastReceipt();
    res.json({ 
      success: true, 
      lastReceipt: lastReceipt 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: 'Failed to load last receipt',
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
    // Create last receipt file if it doesn't exist
    try {
      await fs.access(LAST_RECEIPT_FILE);
    } catch {
      await saveLastReceipt({ id: null, timestamp: new Date().toISOString() });
    }
    
    // Start server
    app.listen(PORT, () => {
      console.log('🚀 Loyverse-WhatsApp Bot Started Successfully');
      console.log('📊 Server running on port:', PORT);
      console.log('⏰ Sales check scheduled: Every minute');
      console.log('🔧 Endpoints:');
      console.log('   GET  / - Health check');
      console.log('   GET  /test - Send test message');
      console.log('   POST /check-sales - Manual sales check');
      console.log('   GET  /last-receipt - View last processed receipt');
      
      // Run initial check
      setTimeout(() => {
        checkForNewSales();
      }, 2000);
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
