require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const qs = require('querystring');

const app = express();
app.use(express.json());

const corsOptions = {
  origin: ['https://fredjrp.github.io', 'http://localhost:3000'],
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
  JUMIA_CLIENT_ID = '66948ed6-996d-4ea7-9505-2cd9cdc18fb6',
  JUMIA_REFRESH_TOKEN,
  JUMIA_API_URL = 'https://vendor-api.jumia.com'
} = process.env;

// Token management
let accessToken = null;
let tokenExpiry = null;

// Validate environment variables
function validateEnvironment() {
  const requiredEnvVars = [
    'WHATSAPP_ACCESS_TOKEN',
    'WEBHOOK_VERIFY_TOKEN',
    'PHONE_NUMBER_ID',
    'JUMIA_REFRESH_TOKEN'
  ];
  
  const missing = requiredEnvVars.filter(envVar => !process.env[envVar]);
  
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

validateEnvironment();

// Get access token using refresh token
async function getAccessToken() {
  try {
    // If we have a valid token, return it
    if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
      return accessToken;
    }

    console.log('Refreshing Jumia access token...');
    
    const res = await axios.post(
      `${JUMIA_API_URL}/auth/realms/acl/protocol/openid-connect/token`,
      qs.stringify({
        grant_type: "refresh_token",
        client_id: JUMIA_CLIENT_ID,
        refresh_token: JUMIA_REFRESH_TOKEN
      }),
      {
        headers: { 
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json"
        }
      }
    );

    accessToken = res.data.access_token;
    // Set token expiry (with 60 second buffer)
    tokenExpiry = Date.now() + (res.data.expires_in * 1000) - 60000;
    
    console.log("✅ Jumia access token refreshed successfully");
    return accessToken;
  } catch (err) {
    console.error("❌ Error fetching access token:", err.response?.data || err.message);
    throw err;
  }
}

// Make authenticated request to Jumia API
async function makeJumiaRequest(endpoint, method = 'GET', params = {}) {
  try {
    const token = await getAccessToken();
    const url = `${JUMIA_API_URL}${endpoint}`;
    
    const config = {
      method,
      url,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      }
    };

    if (method === 'GET') {
      config.params = params;
    } else {
      config.data = params;
    }

    const response = await axios(config);
    return response.data;
  } catch (err) {
    console.error(`❌ Jumia API error (${endpoint}):`, err.response?.data || err.message);
    
    // If it's an authentication error, clear the token to force refresh
    if (err.response && err.response.status === 401) {
      accessToken = null;
      tokenExpiry = null;
    }
    
    throw err;
  }
}

// Fetch products from Jumia Vendor API
async function fetchJumiaProducts(limit = 10, offset = 0) {
  return makeJumiaRequest('/catalog/products', 'GET', { limit, offset });
}

// Fetch orders from Jumia Vendor API
async function fetchJumiaOrders(status = "pending") {
  return makeJumiaRequest('/orders', 'GET', { status });
}

// Get product details by ID
async function getProduct(productId) {
  return makeJumiaRequest(`/catalog/products/${productId}`);
}

// WhatsApp message functions
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
          caption: caption.substring(0, 1024)
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

// Format product for WhatsApp display
function formatProductForWhatsApp(product) {
  // Adjust this based on the actual Jumia API response structure
  return {
    name: product.name || product.Name || product.title || "Unnamed Product",
    price: product.price || product.Price || product.salePrice || "N/A",
    image: product.image || product.Image || product.mainImage || product.images?.[0] || "",
    id: product.id || product.productId || product.sku || "N/A",
    status: product.status || product.Status || "Unknown"
  };
}

// Send Jumia products to WhatsApp
async function sendJumiaProducts(to, limit = 5) {
  try {
    await sendMessage(to, "Fetching products from Jumia... ⏳");
    
    const productsData = await fetchJumiaProducts(limit);
    
    // Adjust based on actual API response structure
    const products = productsData.products || productsData.items || productsData.data || productsData || [];
    
    if (!products || products.length === 0) {
      await sendMessage(to, "No products found in your Jumia store.");
      return;
    }
    
    // Send the first product with image if available
    const firstProduct = formatProductForWhatsApp(products[0]);
    
    if (firstProduct.image) {
      await sendImage(
        to, 
        firstProduct.image, 
        `${firstProduct.name}\nPrice: KES ${firstProduct.price}\nID: ${firstProduct.id}`
      );
    } else {
      await sendMessage(
        to, 
        `${firstProduct.name}\nPrice: KES ${firstProduct.price}\nID: ${firstProduct.id}`
      );
    }
    
    // If there are more products, create an interactive list
    if (products.length > 1) {
      const interactiveData = {
        type: 'list',
        header: { 
          type: 'text', 
          text: 'Jumia Products' 
        },
        body: { 
          text: `Showing ${Math.min(products.length, limit)} products. Select one for details:` 
        },
        action: {
          button: 'Browse Products',
          sections: [{
            title: 'Your Products',
            rows: products.slice(1, 6).map((product, index) => {
              const formattedProduct = formatProductForWhatsApp(product);
              return {
                id: `product_${formattedProduct.id}`,
                title: formattedProduct.name.length > 24 
                  ? formattedProduct.name.substring(0, 21) + '...' 
                  : formattedProduct.name,
                description: `KES ${formattedProduct.price}`
              };
            })
          }]
        }
      };
      
      await sendInteractiveMessage(to, interactiveData);
    }
    
    await sendMessage(to, "Type 'more products' to see more or 'orders' to check your orders.");
    
  } catch (error) {
    console.error('Error sending Jumia products:', error);
    await sendMessage(to, "Sorry, I couldn't fetch products from Jumia at the moment. Please try again later.");
  }
}

// Send order information to WhatsApp
async function sendJumiaOrders(to, status = "pending") {
  try {
    await sendMessage(to, `Fetching ${status} orders from Jumia... ⏳`);
    
    const ordersData = await fetchJumiaOrders(status);
    
    // Adjust based on actual API response structure
    const orders = ordersData.orders || ordersData.items || ordersData.data || ordersData || [];
    
    if (!orders || orders.length === 0) {
      await sendMessage(to, `No ${status} orders found.`);
      return;
    }
    
    const statusDisplay = status.charAt(0).toUpperCase() + status.slice(1);
    await sendMessage(to, `You have ${orders.length} ${status} orders:`);
    
    // Show first 3 orders
    for (let i = 0; i < Math.min(orders.length, 3); i++) {
      const order = orders[i];
      // Adjust based on actual API response structure
      const orderId = order.orderId || order.id || "N/A";
      const orderDate = order.createdAt || order.date || order.orderDate || "Unknown date";
      const orderStatus = order.status || order.orderStatus || status;
      const customerName = order.customerName || order.customer?.name || "Unknown customer";
      
      await sendMessage(
        to,
        `Order #${orderId}\nCustomer: ${customerName}\nDate: ${orderDate}\nStatus: ${orderStatus}`
      );
    }
    
    if (orders.length > 3) {
      await sendMessage(to, `...and ${orders.length - 3} more ${status} orders.`);
    }
    
  } catch (error) {
    console.error('Error sending Jumia orders:', error);
    await sendMessage(to, "Sorry, I couldn't fetch orders from Jumia at the moment. Please try again later.");
  }
}

// Webhook endpoints
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

    if (message.type === 'text') {
      const text = message.text.body.toLowerCase().trim();
      
      // Handle greetings
      if (['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'].includes(text)) {
        await sendMessage(from, "Hello! Welcome to your Jumia Seller Assistant. Type 'products' to view your items or 'orders' to check orders.");
        return res.sendStatus(200);
      }
      
      // Handle product requests
      if (text === 'products' || text === 'items' || text === 'inventory') {
        await sendJumiaProducts(from);
        return res.sendStatus(200);
      }
      
      if (text === 'more products') {
        await sendJumiaProducts(from, 10);
        return res.sendStatus(200);
      }
      
      // Handle order requests
      if (text === 'orders' || text === 'order status') {
        await sendJumiaOrders(from);
        return res.sendStatus(200);
      }
      
      if (text.includes('pending orders')) {
        await sendJumiaOrders(from, "pending");
        return res.sendStatus(200);
      }
      
      if (text.includes('shipped orders') || text.includes('delivered orders')) {
        await sendJumiaOrders(from, "shipped");
        return res.sendStatus(200);
      }
      
      if (text.includes('cancelled orders')) {
        await sendJumiaOrders(from, "canceled");
        return res.sendStatus(200);
      }
      
      // Default response for other messages
      await sendMessage(from, "I'm your Jumia Seller Assistant. Type 'products' to view your items or 'orders' to check orders.");
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Test token refresh
    const token = await getAccessToken();
    
    res.status(200).json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      service: 'Jumia WhatsApp Seller Bot',
      jumiaApi: JUMIA_API_URL,
      tokenStatus: token ? 'Valid' : 'Invalid'
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// Test endpoint to check Jumia integration
app.get('/test-jumia', async (req, res) => {
  try {
    const products = await fetchJumiaProducts(2);
    res.json({
      success: true,
      message: 'Jumia API test successful',
      products: products || { data: [] }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test endpoint for orders
app.get('/test-orders', async (req, res) => {
  try {
    const orders = await fetchJumiaOrders("pending");
    res.json({
      success: true,
      message: 'Jumia Orders API test successful',
      orders: orders || { data: [] }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test token endpoint
app.get('/test-token', async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({
      success: true,
      message: 'Token refresh successful',
      token: token ? 'Received' : 'Not received'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Jumia WhatsApp Seller Bot running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
  console.log(`Jumia test endpoint available at http://localhost:${PORT}/test-jumia`);
  console.log(`Token test endpoint available at http://localhost:${PORT}/test-token`);
  console.log(`Jumia API URL: ${JUMIA_API_URL}`);
});
