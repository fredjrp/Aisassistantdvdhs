require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
const usersRef = require('./firebase');

const VERIFY_TOKEN = "your_custom_token";

// CORS configuration for Render
const corsOptions = {
  origin: function (origin, callback) {
    // Allow all in development
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    
    // Allowed production domains
    const allowedDomains = [
      'https://your-dashboard.onrender.com',
      'https://your-custom-domain.com'
    ];
    
    if (allowedDomains.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());

// [Keep all your existing routes and handlers exactly as they were...]

// =============== Server Start ================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log("📞 PHONE ID:", process.env.WHATSAPP_PHONE_NUMBER_ID);
  console.log("🔐 WHATSAPP TOKEN:", process.env.WHATSAPP_ACCESS_TOKEN?.slice(0, 10) + '...');
  console.log("🌐 CORS configured for:", corsOptions.origin);
});
