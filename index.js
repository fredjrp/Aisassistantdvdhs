require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const app = express();
app.use(express.json());

// CORS Configuration
const corsOptions = {
  origin: 'https://fredjrp.github.io',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Environment Variables
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
  GOOGLE_PRIVATE_KEY
} = process.env;

const publicKey = process.env.PUBLIC_KEY?.replace(/\\n/g, '\n');

// ✅ Endpoint to expose public key
app.get('/public-key', (req, res) => {
  if (!publicKey) return res.status(404).send('No public key set');
  res.setHeader('Content-Type', 'text/plain');
  res.send(publicKey);
});

// ✅ Function to upload key to Meta Graph API
async function uploadPublicKeyToMeta() {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/public_key`,
      { public_key: publicKey },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('✅ Public key uploaded to Meta:', response.data);
  } catch (err) {
    console.error('❌ Failed to upload public key:', err.response?.data || err.message);
  }
}

// Firebase Initialization
const rawConfig = JSON.parse(process.env.FIREBASE_CONFIG);
rawConfig.private_key = rawConfig.private_key.replace(/\\n/g, '\n');
admin.initializeApp({ credential: admin.credential.cert(rawConfig) });
const db = admin.firestore();

// Nodemailer Setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

const MESSAGE_COOLDOWN = 5000; // 5 seconds between messages to the same user
const lastMessageTimestamps = new Map();

// AI Personalities Configuration for Freds Official WhatsApp Automation
const aiPersonalities = {
  onboarding: {
    tone: "professional yet welcoming",
    traits: [
      "Specializes in WhatsApp automation setup",
      "Guides users through Freds Official's service options",
      "Highlights time-saving benefits of automation",
      "Uses clear, step-by-step instructions",
      "Incorporates social proof and case studies"
    ],
    businessValue: "Converts curious users into automation clients"
  },
  automationConsultant: {
    tone: "knowledgeable and solution-oriented", 
    traits: [
      "Diagnoses business workflow pain points",
      "Recommends specific WhatsApp automation solutions",
      "Provides ROI estimates for automation",
      "Shares success stories from similar businesses",
      "Offers tiered service packages (Basic/Pro/Enterprise)"
    ],
    businessValue: "Upsells premium automation services"
  },
  technicalSetup: {
    tone: "precise and reassuring",
    traits: [
      "Guides through technical integration steps",
      "Simplifies API and platform connections",
      "Provides troubleshooting for common issues",
      "Offers screenshots or video tutorials when helpful",
      "Confirms successful setup completion"
    ],
    businessValue: "Reduces setup friction and support tickets"
  },
  conversionExpert: {
    tone: "persuasive but not pushy",
    traits: [
      "Identifies upsell opportunities naturally",
      "Times service recommendations appropriately",
      "Highlights limited-time offers strategically",
      "Uses social proof from happy clients",
      "Provides clear CTA to purchase/upgrade"
    ],
    businessValue: "Increases conversion rates and LTV"
  }
};

// Helper Functions
// Add this helper function for logging messages
async function logMessage(direction, messageData) {
  try {
    const logData = {
      ...messageData,
      direction, // 'incoming' or 'outgoing'
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      aiGenerated: direction === 'outgoing' && messageData.ai || false
    };

    // Clean undefined fields
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
async function sendMessage(to, text, isAI = false) {
  try {
    // Check cooldown
    const now = Date.now();
    const lastSent = lastMessageTimestamps.get(to);
    
    if (lastSent && (now - lastSent) < MESSAGE_COOLDOWN) {
      console.log(`⚠️ Message to ${to} skipped due to cooldown`);
      return null;
    }

    const response = await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    // Update last message timestamp
    lastMessageTimestamps.set(to, now);
    
    // Rest of your existing logging code...
    await logMessage('outgoing', {
      to,
      from: PHONE_NUMBER_ID,
      type: 'text',
      message: { text: { body: text } },
      messageId: response.data.messages?.[0]?.id,
    });

    return response;
  } catch (err) {
    console.error('❌ Send message error:', err.response?.data || err.message);
    throw err;
  }
}

async function sendOnboardingMessage(to, stage, userData = {}) {
  const templates = {
    permission: {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: "Welcome to Fred's Official WhatsApp Automation!\n\nMay we collect some information to serve you better?" },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'onboard_yes', title: 'Yes, proceed' } },
            { type: 'reply', reply: { id: 'onboard_later', title: 'Remind me later' } }
          ]
        }
      }
    },
    name: {
      type: 'text',
      text: { body: "What's your full name?" }
    },
    phone: {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: "Please share an alternative phone number for backup (optional):" },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'phone_skip', title: 'Skip' } }
          ]
        }
      }
    },
    gender: {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: "Please select your gender:" },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'gender_male', title: 'Male' } },
            { type: 'reply', reply: { id: 'gender_female', title: 'Female' } },
            { type: 'reply', reply: { id: 'gender_other', title: 'Other' } }
          ]
        }
      }
    },
    business: {
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '🏢 Business Type' },
        body: { text: 'Which category best describes your business?' },
        action: {
          button: 'Select',
          sections: [{
            title: 'Business Categories',
            rows: [
              { id: 'biz_retail', title: 'Retail', description: 'Physical or online store' },
              { id: 'biz_service', title: 'Service', description: 'Professional services' },
              { id: 'biz_hospitality', title: 'Hospitality', description: 'Hotels, restaurants' },
              { id: 'biz_other', title: 'Other', description: 'Not listed above' }
            ]
          }]
        }
      }
    },
    objective: {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: "What's your primary objective for using our services?" },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'obj_specific', title: 'Specific Goal' } },
            { type: 'reply', reply: { id: 'obj_adventure', title: 'Explore' } }
          ]
        }
      }
    },
    discovery: {
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '📢 Discovery Source' },
        body: { text: 'How did you hear about us?' },
        action: {
          button: 'Select',
          sections: [{
            title: 'Discovery Channels',
            rows: [
              { id: 'src_social', title: 'Social Media', description: 'Facebook, Instagram, etc' },
              { id: 'src_referral', title: 'Referral', description: 'From a friend/colleague' },
              { id: 'src_ads', title: 'Advertisement', description: 'Online or offline ads' },
              { id: 'src_other', title: 'Other', description: 'Another way' }
            ]
          }]
        }
      }
    },
    review: {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { 
          text: `Please review your information:\n\n` +
                `Name: ${userData.name?.value || 'Not provided'}\n` +
                `Alt Phone: ${userData.altPhone?.value || 'Not provided'}\n` +
                `Gender: ${userData.gender?.value || 'Not provided'}\n` +
                `Business: ${userData.businessType?.value || 'Not provided'}\n` +
                `Objective: ${userData.objective?.value || 'Not provided'}\n` +
                `Found us via: ${userData.discoverySource?.value || 'Not provided'}\n\n` +
                `Is everything correct?` 
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'review_yes', title: 'All Correct' } },
            { type: 'reply', reply: { id: 'review_edit', title: 'Edit Info' } }
          ]
        }
      }
    }
  };

  try {
    const template = templates[stage];
    if (!template) throw new Error(`Invalid stage: ${stage}`);
    
    const response = await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      ...template
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

        // Log interactive messages
    if (template.type === 'interactive') {
      await logMessage('outgoing', {
        to,
        from: PHONE_NUMBER_ID,
        type: 'interactive',
        message: template.interactive,
        stage: stage,
        messageId: response.data.messages?.[0]?.id
      });
    }
    return response;
  } catch (err) {
    console.error(`❌ Onboarding message error (stage ${stage}):`, err.response?.data || err.message);
    throw err;
  }
}

async function updateGoogleSheet(userData) {
  try {
    if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
      console.log('⚠️ Google Sheets credentials missing - skipping update');
      return;
    }

    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID);
    await doc.useServiceAccountAuth({
      client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    });

    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    
    const rows = await sheet.getRows();
    const existingRow = rows.find(row => row['Phone'] === userData.phone);

    const record = {
      'Timestamp': new Date().toISOString(),
      'Phone': userData.phone,
      'Name': userData.name || '',
      'AltPhone': userData.altPhone || '',
      'Gender': userData.gender || '',
      'BusinessType': userData.businessType || '',
      'Objective': userData.objective || '',
      'DiscoverySource': userData.discoverySource || '',
      'Stage': userData.onboarding?.stage || '',
      'LastActive': new Date().toISOString()
    };

    if (existingRow) {
      Object.keys(record).forEach(key => {
        existingRow[key] = record[key];
      });
      await existingRow.save();
    } else {
      await sheet.addRow(record);
    }
  } catch (err) {
    console.error('❌ Google Sheets error - proceeding without update:', err.message);
    // Continue execution even if Sheets fails
  }
}

async function setOnboardingTimeout(userId, hours = 24) {
  const timeoutAt = new Date();
  timeoutAt.setHours(timeoutAt.getHours() + hours);
  
  await db.collection('users').doc(userId).update({
    'onboarding.timeoutAt': admin.firestore.Timestamp.fromDate(timeoutAt)
  });
}

async function sendEditOptions(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: '✏️ Edit Information' },
        body: { text: 'Which information would you like to update?' },
        action: {
          button: 'Select Field',
          sections: [{
            title: 'Editable Fields',
            rows: [
              { id: 'edit_name', title: 'Full Name' },
              { id: 'edit_phone', title: 'Phone Number' },
              { id: 'edit_gender', title: 'Gender' },
              { id: 'edit_business', title: 'Business Type' },
              { id: 'edit_objective', title: 'Objective' },
              { id: 'edit_discovery', title: 'Discovery Source' }
            ]
          }]
        }
      }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    console.error('Edit options error:', err.response?.data || err.message);
    throw err;
  }
}

async function handleOnboardingStage(from, text, stage, userRef, userData) {
  const updateData = {};
  let nextStage = stage;

  switch (stage) {
    case 'permission':
      if (text === 'onboard_yes') {
        nextStage = 'name';
      } else if (text === 'onboard_later') {
        await setOnboardingTimeout(from);
        await sendMessage(from, "We'll remind you in 24 hours. Type 'start' anytime to begin.");
        return;
      } else {
        await sendOnboardingMessage(from, 'permission');
        return;
      }
      break;

    case 'name':
      if (text && text.length >= 2) {
        updateData['onboarding.name'] = {
          value: text,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        nextStage = 'phone';
      } else {
        await sendMessage(from, "❌ Please provide a valid name (at least 2 characters)");
        await sendOnboardingMessage(from, 'name');
        return;
      }
      break;

    case 'phone':
      if (text === 'phone_skip') {
        updateData['onboarding.altPhone'] = {
          value: null,
          skipped: true,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        nextStage = 'gender';
      } else if (/^\+\d{10,15}$/.test(text)) {
        updateData['onboarding.altPhone'] = {
          value: text,
          skipped: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        nextStage = 'gender';
      } else {
        await sendMessage(from, "❌ Please provide a valid phone number (e.g. +254712345678) or skip");
        await sendOnboardingMessage(from, 'phone');
        return;
      }
      break;

    case 'gender':
      if (['gender_male', 'gender_female', 'gender_other'].includes(text)) {
        updateData['onboarding.gender'] = {
          value: text.replace('gender_', ''),
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        nextStage = 'business';
      } else {
        await sendMessage(from, "⚠️ Please select from the options provided");
        await sendOnboardingMessage(from, 'gender');
        return;
      }
      break;

    case 'business':
      if (text && text.startsWith('biz_')) {
        updateData['onboarding.businessType'] = {
          value: text,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        nextStage = 'objective';
      } else {
        await sendMessage(from, "⚠️ Please select a business type from the list");
        await sendOnboardingMessage(from, 'business');
        return;
      }
      break;

    case 'objective':
      if (['obj_specific', 'obj_adventure'].includes(text)) {
        updateData['onboarding.objective'] = {
          type: text.replace('obj_', ''),
          value: null, // Will be filled in next step
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        nextStage = 'discovery';
      } else {
        await sendMessage(from, "⚠️ Please select an objective");
        await sendOnboardingMessage(from, 'objective');
        return;
      }
      break;

    case 'discovery':
      if (text && text.startsWith('src_')) {
        updateData['onboarding.discoverySource'] = {
          value: text,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        nextStage = 'review';
      } else {
        await sendMessage(from, "⚠️ Please select how you found us");
        await sendOnboardingMessage(from, 'discovery');
        return;
      }
      break;

    case 'review':
      if (text === 'review_yes') {
        updateData['onboarding.completed'] = true;
        updateData['onboarding.completedAt'] = admin.firestore.FieldValue.serverTimestamp();
        
        const userSnapshot = await userRef.get();
        const completedUser = userSnapshot.data();
        
        await sendMessage(from, `🎉 Thank you for completing onboarding, ${completedUser.onboarding.name.value}!`);
        await sendMessage(from, `Here's what we'll do next:\n\n1. Connect you with the right solutions\n2. Provide personalized recommendations\n3. Get you started with our services`);
        await sendMessage(from, `Explore our services at Fredsofficial.com`);
        
        await updateGoogleSheet({
          ...completedUser,
          phone: from
        });
      } else if (text === 'review_edit') {
        nextStage = 'edit_select';
        await sendEditOptions(from);
      } else {
        await sendOnboardingMessage(from, 'review', userData.onboarding);
        return;
      }
      break;

    case 'edit_select':
      if (text.startsWith('edit_')) {
        const field = text.replace('edit_', '');
        updateData['onboarding.stage'] = `edit_${field}`;
        await sendMessage(from, `Please enter your new ${field.replace('_', ' ')}:`);
      } else {
        await sendEditOptions(from);
        return;
      }
      break;

    default:
      if (stage.startsWith('edit_')) {
        const field = stage.replace('edit_', '');
        updateData[`onboarding.${field}`] = {
          value: text,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        nextStage = 'review';
        await sendOnboardingMessage(from, 'review', {
          ...userData.onboarding,
          [field]: text
        });
        return;
      }
      break;
  }

  if (nextStage !== stage) {
    updateData['onboarding.stage'] = nextStage;
  }

  if (Object.keys(updateData).length > 0) {
    await userRef.update(updateData);
  }

  if (nextStage !== stage && !nextStage.startsWith('edit_') && nextStage !== 'review') {
    await sendOnboardingMessage(from, nextStage);
  }
}

// Inactivity Checker
setInterval(async () => {
  try {
    const now = new Date();
    const inactiveThreshold = new Date(now.getTime() - 5 * 60 * 1000);
    
    const snapshot = await db.collection('users')
      .where('onboarding.closed', '==', false)
      .where('onboarding.lastActive', '<', inactiveThreshold)
      .where('onboarding.followupSent', '==', false)
      .get();

    for (const doc of snapshot.docs) {
      const user = doc.data();
      
      // Skip if we've already sent a followup
      if (user.onboarding.followupSent) continue;
      
      // Skip if in cooldown period
      if (lastMessageTimestamps.has(doc.id)) {
        const lastMessageTime = lastMessageTimestamps.get(doc.id);
        if (now - lastMessageTime < MESSAGE_COOLDOWN) continue;
      }

      await sendMessage(doc.id, "⌛ We noticed you haven't responded. Would you like to continue where you left off?");
      await db.collection('users').doc(doc.id).update({
        'onboarding.followupSent': true,
        'onboarding.lastActive': admin.firestore.FieldValue.serverTimestamp()
      });
    }
  } catch (err) {
    console.error('Inactivity checker error:', err);
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// Routes
app.get('/', (req, res) => res.send('✅ WhatsApp Bot running'));

app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode && token === WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  const changes = req.body.entry?.[0]?.changes?.[0];
  const message = changes?.value?.messages?.[0];
  const from = message?.from;

  if (!message || !from) return res.sendStatus(200);

  // Log incoming message
  await logMessage('incoming', {
    from,
    type: message.type,
    message: message,
    userId: from
  });

  const userRef = db.collection('users').doc(from);
  const userDoc = await userRef.get();
  const userData = userDoc.exists ? userDoc.data() : null;

  // Handle restart command
if (['restart', 'start'].includes(message.text?.body?.toLowerCase().trim())) {
  await userRef.set({
    phone: from,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    onboarding: {
      stage: 'permission',
      closed: false,
      lastActive: admin.firestore.FieldValue.serverTimestamp()
    }
  }, { merge: true });
  
  await sendMessage(from, "🔄 Restarting your onboarding process...");
  await sendOnboardingMessage(from, 'permission');
  return res.sendStatus(200);
}

  // Rest of your existing webhook logic...
  if (userData?.onboarding?.timeoutAt?.toDate() < new Date()) {
    await sendMessage(from, "⏰ Our conversation timed out. Type 'restart' to begin again.");
    await userRef.update({ 'onboarding.closed': true });
    return res.sendStatus(200);
  }

  if (!userDoc.exists) {
    await userRef.set({
      phone: from,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      onboarding: {
        stage: 'permission',
        closed: false,
        lastActive: admin.firestore.FieldValue.serverTimestamp()
      }
    });
    await sendOnboardingMessage(from, 'permission');
    return res.sendStatus(200);
  }

  await userRef.update({
    'onboarding.lastActive': admin.firestore.FieldValue.serverTimestamp()
  });

  const currentStage = userData.onboarding?.stage;
  const type = message.type;
  let text = '';

  if (type === 'text') {
    text = message.text?.body?.toLowerCase() || '';
  } else if (type === 'interactive') {
    const interactive = message.interactive;
    if (interactive?.type === 'button_reply') {
      text = interactive.button_reply?.id || '';
    } else if (interactive?.type === 'list_reply') {
      text = interactive.list_reply?.id || '';
    }
  }

  if (currentStage && !userData.onboarding.completed) {
    try {
      await handleOnboardingStage(from, text, currentStage, userRef, userData);
      return res.sendStatus(200);
    } catch (err) {
      console.error('Onboarding error:', err);
      await sendMessage(from, "⚠️ We encountered an error. Please try again.");
      return res.sendStatus(500);
    }
  }

  // Handle regular messages for completed onboarding
  if (userData.onboarding?.completed) {
    const aiResponse = await getAIResponse(text, from);
    await sendMessage(from, aiResponse);
  }

  res.sendStatus(200);
});

async function getAIResponse(userText, userId) {
  const userRef = await db.collection('users').doc(userId).get();
  const userData = userRef.data() || {};
  
  if (userData.onboarding?.pendingReview) {
    return "Would you like to edit any information before we proceed?";
  }

  const personality = userData.onboarding?.objective?.type === 'adventure' 
    ? aiPersonalities.adventure 
    : aiPersonalities.regular;

  try {
    const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: "mistralai/mistral-7b-instruct",
      messages: [
        { 
          role: "system", 
          content: `${personality.traits.join('\n')}\n\nCurrent user context:\n` +
                   `Name: ${userData.onboarding?.name?.value || 'Unknown'}\n` +
                   `Business: ${userData.onboarding?.businessType?.value || 'Unknown'}\n` +
                   `Objective: ${userData.onboarding?.objective?.type || 'Unknown'}`
        },
        { role: "user", content: userText }
      ],
      temperature: 0.7
    }, {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    let response = res.data.choices?.[0]?.message?.content || "I didn't understand that. Could you rephrase?";
    
    if (response.length < 100 && !response.includes('website')) {
      response += `\n\nLearn more at Fredsofficial.com`;
    }

    // Log the AI response
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
    console.error('❌ AI error:', err.response?.data || err.message);
    return "🔧 My circuits are a bit busy! Try asking again or visit Fredsofficial.com";
  }
}
app.post('/agent-webhook', async (req, res) => {
  const { action, phoneNumber, agentId } = req.body;
  
  try {
    const userRef = db.collection('users').doc(phoneNumber);
    
    if (action === 'assign') {
      await userRef.update({
        assignedAgent: agentId,
        status: 'assigned',
        aiEnabled: false,
        assignedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      await sendMessage(phoneNumber, `You've been connected to agent ${agentId}. They'll respond shortly.`);
      
    } else if (action === 'toggle_ai') {
      const userDoc = await userRef.get();
      const currentAIStatus = userDoc.data()?.aiEnabled ?? true;
      
      await userRef.update({
        aiEnabled: !currentAIStatus,
        status: !currentAIStatus ? 'ai' : 'assigned'
      });
      
      const statusMessage = !currentAIStatus ? 
        "AI assistant is now handling this conversation" :
        "Agent is now handling this conversation";
        
      await sendMessage(phoneNumber, statusMessage);
    }
    
    res.sendStatus(200);
  } catch (err) {
    console.error('Agent webhook error:', err);
    res.status(500).send(err.message);
  }
});

app.post('/send-message', async (req, res) => {
  const { to, type, text, image, location, interactive } = req.body;

  if (!to || !type) {
    return res.status(400).json({ error: 'Missing "to" or "type"' });
  }

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type
  };

  if (type === 'text') {
    if (!text) return res.status(400).json({ error: 'Missing "text" for text message' });
    payload.text = { body: text };
  } else if (type === 'image') {
    if (!image?.link) return res.status(400).json({ error: 'Missing "image.link"' });
    payload.image = {
      link: image.link,
      caption: image.caption || ''
    };
  } else if (type === 'location') {
    if (!location?.latitude || !location?.longitude) {
      return res.status(400).json({ error: 'Missing location "latitude" and "longitude"' });
    }
    payload.location = {
      latitude: location.latitude,
      longitude: location.longitude,
      name: location.name || '',
      address: location.address || ''
    };
  } else if (type === 'interactive') {
    if (!interactive?.type) {
      return res.status(400).json({ error: 'Missing interactive type' });
    }
    payload.interactive = interactive;
  } else {
    return res.status(400).json({ error: `Unsupported message type: ${type}` });
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // Enhanced logging
    await logMessage('outgoing', {
      to,
      from: PHONE_NUMBER_ID,
      type,
      message: payload,
      messageId: response.data.messages?.[0]?.id,
      direction: 'outgoing',
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json({ success: true, messageId: response.data.messages?.[0]?.id });
  } catch (err) {
    console.error('❌ Error sending message:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to send message', details: err.response?.data || err.message });
  }
});

async function startServer() {
  await uploadPublicKeyToMeta(); // 👈 This runs once on startup

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

startServer();
