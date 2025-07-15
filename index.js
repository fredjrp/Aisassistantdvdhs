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
  SLACK_WEBHOOK_URL
} = process.env;

const publicKey = process.env.PUBLIC_KEY?.replace(/\\n/g, '\n');

const rawConfig = JSON.parse(process.env.FIREBASE_CONFIG);
rawConfig.private_key = rawConfig.private_key.replace(/\\n/g, '\n');
admin.initializeApp({ credential: admin.credential.cert(rawConfig) });
const db = admin.firestore();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

const AGENT_RESPONSE_TIMEOUT = 5000;
const DEMO_DELAY = 2000;
const agentResponseTimers = new Map();

async function sendSlackAlert(message) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await axios.post(SLACK_WEBHOOK_URL, { text: message });
  } catch (err) {
    console.error('Slack alert failed:', err.message);
  }
}

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

async function sendOTPEmail(email) {
  const otp = Math.floor(1000 + Math.random() * 9000);
  const mailOptions = {
    from: `"Linda" <${EMAIL_USER}>`,
    to: email,
    subject: 'Your Linda Verification Code',
    text: `Your verification code is: ${otp}\n\nEnter this code in WhatsApp to continue. The code expires in 5 minutes.`,
    html: `<p>Your verification code is: <strong>${otp}</strong></p><p>Enter this code in WhatsApp to continue. The code expires in 5 minutes.</p>`
  };

  try {
    await transporter.sendMail(mailOptions);
    await db.collection('authCodes').doc(email).set({
      code: otp.toString(),
      expiresAt: new Date(Date.now() + 300000)
    });
  } catch (err) {
    console.error('Failed to send OTP email:', err);
    throw err;
  }
}

async function updateAffiliateEarnings(referralId, amount) {
  if (!referralId) return;
  try {
    const commission = amount * 0.15;
    await db.collection('affiliates').doc(referralId).update({
      earnings: admin.firestore.FieldValue.increment(commission),
      lastCommission: admin.firestore.FieldValue.serverTimestamp()
    });
    await sendSlackAlert(`💸 New commission for affiliate ${referralId}: KES ${commission}\nTotal earnings: KES ${(await db.collection('affiliates').doc(referralId).get()).data().earnings}`);
  } catch (err) {
    console.error('Failed to update affiliate earnings:', err);
  }
}

async function getAIResponse(userText, userId) {
  const userRef = await db.collection('users').doc(userId).get();
  const userData = userRef.data() || {};
  
  const personality = userData.businessType === 'Chama' 
    ? {
        tone: "friendly but professional",
        traits: [
          "Focus on ROI tracking and member contributions",
          "Provide Chama-specific examples",
          "Keep responses under 200 characters",
          "Use simple language"
        ]
      }
    : {
        tone: "professional and helpful",
        traits: [
          "Focus on business automation",
          "Provide concrete examples",
          "Keep responses under 200 characters",
          "Use professional language"
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
            content: `You are Linda's WhatsApp assistant. Be ${personality.tone}.\n` +
                     `${personality.traits.join('\n')}\n\n` +
                     `User context:\n` +
                     `Type: ${userData.businessType || 'Unknown'}\n` +
                     `Name: ${userData.name || 'Unknown'}\n` +
                     `Status: ${userData.status || 'unverified'}`
          },
          { role: "user", content: userText }
        ],
        temperature: 0.7,
        max_tokens: 200
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
    return "I'm having trouble responding right now. Please try again later or visit our website for help.";
  }
}

async function handleNewUser(from, email, referralId, businessType) {
  const userRef = db.collection('users').doc(email);
  const userData = {
    phone: from,
    email,
    businessType,
    status: 'unverified',
    referralId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    onboardingStage: 'emailSent'
  };

  await userRef.set(userData, { merge: true });
  await sendOTPEmail(email);
  await sendMessage(from, "We've sent a verification code to your email. Please reply with that code to continue.");
  
  await sendSlackAlert(`🎯 New lead from ${referralId ? `affiliate ${referralId}` : 'organic'}:\nEmail: ${email}\nPhone: ${from}\nType: ${businessType}`);
}

async function verifyOTP(email, code, phone) {
  const otpDoc = await db.collection('authCodes').doc(email).get();
  if (!otpDoc.exists) return false;

  const otpData = otpDoc.data();
  if (otpData.code !== code || otpData.expiresAt.toDate() < new Date()) {
    return false;
  }

  await db.collection('users').doc(email).update({
    status: 'verified',
    onboardingStage: 'verified',
    lastVerified: admin.firestore.FieldValue.serverTimestamp()
  });

  await db.collection('authCodes').doc(email).delete();

  const userData = (await db.collection('users').doc(email).get()).data();
  const welcomeMessage = userData.businessType === 'Chama' 
    ? "Welcome to Linda! Let's automate your Chama communications. Would you like to:\n1. Set up payment reminders\n2. Track member contributions\n3. Calculate ROI"
    : "Welcome to Linda! Let's automate your business WhatsApp. Would you like to:\n1. Set up customer replies\n2. Create payment reminders\n3. Import contacts";

  await sendMessage(phone, welcomeMessage);
  return true;
}

app.get('/', (req, res) => res.send('✅ Linda WhatsApp Bot running'));

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

    await logMessage('incoming', {
      from,
      type: message.type,
      message: message,
      userId: from
    });

    if (message.text?.body?.toLowerCase().includes('register')) {
      const email = message.text.body.match(/\S+@\S+\.\S+/)?.toString();
      if (!email) {
        await sendMessage(from, "Please reply with your email to register, like: register my@email.com");
        return res.sendStatus(200);
      }

      const referralId = message.text.body.match(/ref:\S+/)?.toString()?.replace('ref:', '');
      const businessType = message.text.body.match(/type:(retail|service|NGO|Chama)/)?.[1] || 'retail';
      
      await handleNewUser(from, email, referralId, businessType);
      return res.sendStatus(200);
    }

    if (message.text?.body?.match(/^\d{4}$/)) {
      const emailDoc = await db.collection('users').where('phone', '==', from).limit(1).get();
      if (emailDoc.empty) {
        await sendMessage(from, "Please start by sending 'register your@email.com'");
        return res.sendStatus(200);
      }

      const email = emailDoc.docs[0].id;
      const verified = await verifyOTP(email, message.text.body, from);
      if (!verified) {
        await sendMessage(from, "Invalid or expired code. Please request a new one.");
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    const userDoc = await db.collection('users').where('phone', '==', from).limit(1).get();
    if (userDoc.empty) {
      await sendMessage(from, "Welcome to Linda! To get started, please send: register your@email.com");
      return res.sendStatus(200);
    }

    const userData = userDoc.docs[0].data();
    if (userData.status !== 'verified') {
      await sendMessage(from, "Please verify your email first. Check your inbox for the code.");
      return res.sendStatus(200);
    }

    const aiResponse = await getAIResponse(message.text?.body || '', from);
    await sendMessage(from, aiResponse, true);

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
