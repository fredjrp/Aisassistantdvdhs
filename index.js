require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

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
  JUMIA_API_TOKEN,
  JUMIA_PARTNER_ID
} = process.env;

// Validate environment variables
function validateEnvironment() {
  const requiredEnvVars = [
    'WHATSAPP_ACCESS_TOKEN',
    'WEBHOOK_VERIFY_TOKEN',
    'PHONE_NUMBER_ID',
    'JUMIA_API_TOKEN'
  ];
  
  const missing = requiredEnvVars.filter(envVar => !process.env[envVar]);
  
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

validateEnvironment();

// Jumia API integration
async function fetchJumiaProducts(category = '', limit = 10) {
  try {
    // Note: This is a placeholder URL - you'll need to replace it with the actual Jumia API endpoint
     const apiUrl = `https://vendorcenter.jumia.com/api/catalog/products?limit=${limit}${category ? `&category=${category}` : ''}`;   
    
    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${JUMIA_API_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Partner-ID': JUMIA_PARTNER_ID || '' // If Jumia requires a partner ID
      }
    });
    
    return response.data;
  } catch (error) {
    console.error('Jumia API error:', error.response?.data || error.message);
    throw new Error('Failed to fetch products from Jumia');
  }
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

// Send Jumia products to WhatsApp
async function sendJumiaProducts(to, category = '') {
  try {
    await sendMessage(to, "Fetching products from Jumia... ⏳");
    
    const products = await fetchJumiaProducts(category, 5);
    
    if (!products || products.length === 0) {
      await sendMessage(to, "No products found in this category.");
      return;
    }
    
    // Send the first product with image
    const firstProduct = products[0];
    if (firstProduct.image) {
      await sendImage(
        to, 
        firstProduct.image, 
        `${firstProduct.name}\nPrice: ${firstProduct.price}\nRating: ${firstProduct.rating || 'N/A'}`
      );
    } else {
      await sendMessage(
        to, 
        `${firstProduct.name}\nPrice: ${firstProduct.price}\nRating: ${firstProduct.rating || 'N/A'}`
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
          text: 'Select a product to see details:' 
        },
        action: {
          button: 'Browse Products',
          sections: [{
            title: 'Available Products',
            rows: products.slice(1).map((product, index) => ({
              id: `product_${index}`,
              title: product.name.length > 24 ? product.name.substring(0, 21) + '...' : product.name,
              description: `KES ${product.price}`
            }))
          }]
        }
      };
      
      await sendInteractiveMessage(to, interactiveData);
    }
    
    await sendMessage(to, "Type 'more' to see more products or specify a category like 'electronics', 'fashion', etc.");
    
  } catch (error) {
    console.error('Error sending Jumia products:', error);
    await sendMessage(to, "Sorry, I couldn't fetch products from Jumia at the moment. Please try again later.");
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
        await sendMessage(from, "Hello! Welcome to Jumia Shopping Assistant. Type 'products' to browse items or specify a category like 'electronics'.");
        return res.sendStatus(200);
      }
      
      // Handle product requests
      if (text === 'products' || text === 'menu') {
        await sendJumiaProducts(from);
        return res.sendStatus(200);
      }
      
      if (text === 'more') {
        await sendJumiaProducts(from);
        return res.sendStatus(200);
      }
      
      // Handle category-specific requests
      const categories = ['electronics', 'fashion', 'home', 'sports', 'beauty', 'books'];
      const requestedCategory = categories.find(category => text.includes(category));
      
      if (requestedCategory) {
        await sendJumiaProducts(from, requestedCategory);
        return res.sendStatus(200);
      }
      
      // Default response for other messages
      await sendMessage(from, "I'm your Jumia shopping assistant. Type 'products' to browse items or specify a category like 'electronics', 'fashion', etc.");
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'Jumia WhatsApp Bot'
  });
});

// Test endpoint to check Jumia integration
app.get('/test-jumia', async (req, res) => {
  try {
    const products = await fetchJumiaProducts('', 2);
    res.json({
      success: true,
      products: products || [{ name: 'Test Product', price: 1000, image: 'https://example.com/image.jpg' }]
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
  console.log(`Jumia WhatsApp bot running on port ${PORT}`);
});

