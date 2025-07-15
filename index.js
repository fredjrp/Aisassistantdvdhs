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
  EMAIL_PASS,
  SLACK_WEBHOOK_URL
} = process.env;

const rawConfig = JSON.parse(process.env.FIREBASE_CONFIG);
rawConfig.private_key = rawConfig.private_key.replace(/\\n/g, '\n');
admin.initializeApp({ credential: admin.credential.cert(rawConfig) });
const db = admin.firestore();

const collections = {
  users: 'linda_users',
  authCodes: 'linda_auth_codes',
  affiliates: 'linda_affiliates',
  logs: 'linda_whatsapp_logs',
  payments: 'linda_payments'
};

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

async function initializeCollections() {
  const batch = db.batch();
  const collectionRefs = Object.values(collections).map(col => db.collection(col).doc('init'));
  collectionRefs.forEach(ref => batch.set(ref, { initialized: true }));
  await batch.commit().catch(() => {});
}
initializeCollections();

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
    await db.collection(collections.logs).add({
      ...messageData,
      direction,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
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
        }
      }
    );
    
    await logMessage('outgoing', {
      to,
      from: PHONE_NUMBER_ID,
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

async function sendOTPEmail(email, phone) {
  const otp = Math.floor(1000 + Math.random() * 9000);
  await db.collection(collections.authCodes).doc(email).set({
    code: otp.toString(),
    phone,
    expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 300000))
  });

  await transporter.sendMail({
    from: `"Linda" <${EMAIL_USER}>`,
    to: email,
    subject: 'Your Linda Verification Code',
    text: `Your verification code is: ${otp}\n\nReply with this code in WhatsApp to continue.`
  });
}

async function handleRegistration(phone, email, referralId, businessType) {
  await db.collection(collections.users).doc(email).set({
    phone,
    email,
    businessType,
    status: 'unverified',
    referralId,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await sendOTPEmail(email, phone);
  await sendMessage(phone, "We've sent a verification code to your email. Please reply with that code to continue.");

  await sendSlackAlert(`🎯 New ${businessType} lead from ${referralId || 'organic'}:\nEmail: ${email}\nPhone: ${phone}`);
}

async function verifyOTP(email, code, phone) {
  const otpDoc = await db.collection(collections.authCodes).doc(email).get();
  if (!otpDoc.exists) return false;

  const otpData = otpDoc.data();
  if (otpData.code !== code || otpData.expiresAt.toDate() < new Date()) {
    return false;
  }

  await db.collection(collections.users).doc(email).update({
    status: 'verified',
    verifiedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  await db.collection(collections.authCodes).doc(email).delete();

  const userData = (await db.collection(collections.users).doc(email).get()).data();
  let welcomeMessage = "Welcome to Linda! Your WhatsApp automation is ready.\n\n";

  if (userData.businessType === 'Chama') {
    welcomeMessage += "For your Chama, I can help with:\n- ROI calculations\n- Member tracking\n- Meeting reminders\n\nReply 'ROI' to start.";
  } else {
    welcomeMessage += "For your business, I can help with:\n- Customer replies\n- Payment reminders\n- Contact management\n\nReply 'HELP' for options.";
  }

  await sendMessage(phone, welcomeMessage);
  return true;
}

async function trackPayment(email, amount) {
  const userDoc = await db.collection(collections.users).doc(email).get();
  if (!userDoc.exists) return;

  const userData = userDoc.data();
  await db.collection(collections.payments).add({
    email,
    amount,
    referralId: userData.referralId,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });

  if (userData.referralId) {
    const commission = amount * 0.15;
    await db.collection(collections.affiliates).doc(userData.referralId).set({
      earnings: admin.firestore.FieldValue.increment(commission),
      lastCommission: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await sendSlackAlert(`💰 New payment: KES ${amount} from ${email}\nAffiliate ${userData.referralId} earned KES ${commission}`);
  }
}

app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode && token === WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = message?.from;
    if (!message || !from) return res.sendStatus(200);

    await logMessage('incoming', { from, message });

    if (message.text?.body?.toLowerCase().startsWith('register')) {
      const email = message.text.body.match(/\S+@\S+\.\S+/)?.[0];
      const referralId = message.text.body.match(/ref:\S+/)?.[0]?.replace('ref:', '');
      const businessType = message.text.body.match(/type:(retail|service|ngo|chama)/i)?.[1]?.toLowerCase() || 'retail';
      
      if (!email) {
        await sendMessage(from, "Please include your email: register your@email.com");
        return res.sendStatus(200);
      }

      await handleRegistration(from, email, referralId, businessType);
      return res.sendStatus(200);
    }

    if (message.text?.body?.match(/^\d{4}$/)) {
      const emailQuery = await db.collection(collections.authCodes)
        .where('phone', '==', from)
        .limit(1)
        .get();

      if (emailQuery.empty) {
        await sendMessage(from, "Please start by sending 'register your@email.com'");
        return res.sendStatus(200);
      }

      const email = emailQuery.docs[0].id;
      const verified = await verifyOTP(email, message.text.body, from);
      await sendMessage(from, verified ? "✅ Verification successful!" : "❌ Invalid code. Please try again.");
      return res.sendStatus(200);
    }

    const userQuery = await db.collection(collections.users)
      .where('phone', '==', from)
      .limit(1)
      .get();

    if (userQuery.empty) {
      await sendMessage(from, "Please register first by sending: register your@email.com");
      return res.sendStatus(200);
    }

    const userData = userQuery.docs[0].data();
    if (userData.status !== 'verified') {
      await sendMessage(from, "Please verify your email first. Check your inbox for the code.");
      return res.sendStatus(200);
    }

    const response = await getAIResponse(message.text?.body || '', from, userData);
    await sendMessage(from, response, true);

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

async function getAIResponse(text, phone, userData) {
  const prompt = userData.businessType === 'chama' ? 
    `Respond as Linda to a Chama member. Focus on ROI tracking and group management. Keep it under 200 characters. User context: ${JSON.stringify(userData)}` :
    `Respond as Linda to a business owner. Focus on automation and customer service. Keep it professional. User context: ${JSON.stringify(userData)}`;

  try {
    const res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: "mistralai/mistral-7b-instruct",
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: text }
        ],
        max_tokens: 200
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return res.data.choices?.[0]?.message?.content || "I didn't understand that. Could you rephrase?";
  } catch (err) {
    console.error('AI error:', err.message);
    return "I'm having trouble responding right now. Please try again later.";
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Linda WhatsApp bot running on port ${PORT}`));
