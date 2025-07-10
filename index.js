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

// Public Key Endpoint
app.get('/public-key', (req, res) => {
  if (!publicKey) return res.status(404).send('No public key set');
  res.setHeader('Content-Type', 'text/plain');
  res.send(publicKey);
});

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

const MESSAGE_COOLDOWN = 5000;
const lastMessageTimestamps = new Map();

// Helper Functions
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
    console.error('❌ Failed to log message:', err);
  }
}

async function sendMessage(to, text, isAI = false) {
  try {
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

    lastMessageTimestamps.set(to, now);
    
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

async function sendInteractiveMessage(to, interactiveData) {
  try {
    const response = await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: interactiveData
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

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
      'UserType': userData.userType || '',
      'SchoolLevel': userData.schoolLevel || '',
      'BusinessIndustry': userData.businessIndustry || '',
      'Objective': userData.objective || '',
      'DemoRating': userData.demoRating || '',
      'BookedDemo': userData.bookedDemo || false,
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
    console.error('❌ Google Sheets error:', err.message);
  }
}

async function setOnboardingTimeout(userId, hours = 24) {
  const timeoutAt = new Date();
  timeoutAt.setHours(timeoutAt.getHours() + hours);
  
  await db.collection('users').doc(userId).update({
    'onboarding.timeoutAt': admin.firestore.Timestamp.fromDate(timeoutAt),
    'onboarding.closed': true
  });
}

// Onboarding Flow Functions
async function startOnboarding(userId) {
  await db.collection('users').doc(userId).set({
    phone: userId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    onboarding: {
      stage: 'welcome',
      closed: false,
      lastActive: admin.firestore.FieldValue.serverTimestamp()
    }
  }, { merge: true });
  await sendWelcomeMessage(userId);
}

async function sendWelcomeMessage(to) {
  const interactiveData = {
    type: 'button',
    body: {
      text: "👋 Hey there! Welcome to Fred's Official WhatsApp Automation Assistant 🌟\n\n" +
            "To provide you with the best experience, we'd like to collect some information. " +
            "Your data will only be used to personalize your experience and for demo booking purposes."
    },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'welcome_agree', title: 'Yes, I Agree' } },
        { type: 'reply', reply: { id: 'welcome_later', title: 'Remind Me Later' } }
      ]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function sendUserTypeSelection(to) {
  const interactiveData = {
    type: 'button',
    body: { text: "🔍 Are you a school or a business?" },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'userType_school', title: '🏫 School' } },
        { type: 'reply', reply: { id: 'userType_business', title: '🏪 Business' } }
      ]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

// SCHOOL FLOW FUNCTIONS
async function sendSchoolNameRequest(to) {
  await sendMessage(to, "🏫 Please share your school's full name:");
}

async function sendSchoolLevelSelection(to) {
  const interactiveData = {
    type: 'list',
    header: { type: 'text', text: '🎓 School Level' },
    body: { text: 'Which level best describes your school?' },
    action: {
      button: 'Select Level',
      sections: [{
        title: 'School Levels',
        rows: [
          { id: 'schoolLevel_primary', title: 'Primary' },
          { id: 'schoolLevel_secondary', title: 'Secondary' },
          { id: 'schoolLevel_college', title: 'College' },
          { id: 'schoolLevel_tvet', title: 'TVET' },
          { id: 'schoolLevel_university', title: 'University' }
        ]
      }]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function sendSchoolDemoOptions(to, userName) {
  await sendMessage(to, `Thanks, ${userName}! Since you're a school admin, let's show you how we help schools like yours...`);

  const interactiveData = {
    type: 'list',
    header: { type: 'text', text: '🎓 School Use Cases' },
    body: { text: 'Select a demo to see how we can help:' },
    action: {
      button: 'View Demos',
      sections: [{
        title: 'School Solutions',
        rows: [
          { id: 'demo_exam_timetable', title: 'Send Exam Timetable', description: 'Automated parent notifications' },
          { id: 'demo_parent_consent', title: 'Collect Parent Consent', description: 'For trips and activities' },
          { id: 'demo_report_cards', title: 'Send Report Cards', description: 'With feedback collection' }
        ]
      }]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

// BUSINESS FLOW FUNCTIONS
async function sendBusinessNameRequest(to) {
  await sendMessage(to, "🏢 Please share your business name:");
}

async function sendBusinessIndustrySelection(to) {
  const interactiveData = {
    type: 'list',
    header: { type: 'text', text: '🏢 Business Industry' },
    body: { text: 'Which industry best describes your business?' },
    action: {
      button: 'Select Industry',
      sections: [{
        title: 'Industries',
        rows: [
          { id: 'industry_retail', title: 'Retail' },
          { id: 'industry_service', title: 'Service' },
          { id: 'industry_hospitality', title: 'Hospitality' },
          { id: 'industry_freelance', title: 'Freelance' },
          { id: 'industry_other', title: 'Other' }
        ]
      }]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function sendBusinessObjectiveSelection(to) {
  const interactiveData = {
    type: 'button',
    body: { text: "What's your primary objective for using our services?" },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'objective_lead', title: 'Lead Capture' } },
        { type: 'reply', reply: { id: 'objective_support', title: 'Client Support' } },
        { type: 'reply', reply: { id: 'objective_both', title: 'Both' } }
      ]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function sendBusinessDemoOptions(to, userName, businessType) {
  await sendMessage(to, `Awesome, ${userName}! Based on your ${businessType} business, let me show you how Fred's Official helps you close more leads faster.`);

  const interactiveData = {
    type: 'list',
    header: { type: 'text', text: '🧲 Business Solutions' },
    body: { text: 'Select a demo to see how we can help:' },
    action: {
      button: 'View Demos',
      sections: [{
        title: 'Business Solutions',
        rows: [
          { id: 'demo_ad_leads', title: 'Capture WhatsApp Ad Leads', description: 'Automate lead collection' },
          { id: 'demo_autoresponder', title: 'Autoresponder Follow-Up', description: 'Instant responses 24/7' },
          { id: 'demo_crm_tagging', title: 'CRM Tagging + Broadcast', description: 'Organize and message clients' }
        ]
      }]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

// COMMON FLOW FUNCTIONS
async function sendDemoTestimonial(to, userType) {
  if (userType === 'School') {
    await sendMessage(to, "📣 'As a head teacher, I can now reach 300 parents instantly. It's a game-changer!' – Mr. Kamau, Greenhill Academy");
  } else {
    await sendMessage(to, "💬 'I run ads at night, and by morning 80 leads were already tagged and followed up.' – Faith, Salon Owner");
  }
}

async function sendRatingRequest(to) {
  const interactiveData = {
    type: 'button',
    body: { text: "⭐ How helpful was this demonstration?" },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'rating_1', title: '⭐ 1' } },
        { type: 'reply', reply: { id: 'rating_3', title: '⭐⭐⭐ 3' } },
        { type: 'reply', reply: { id: 'rating_5', title: '⭐⭐⭐⭐⭐ 5' } }
      ]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function sendDemoBookingCTA(to, userType) {
  const calendarLink = "https://calendly.com/fredsofficial/demo";
  if (userType === 'School') {
    await sendMessage(to, `📅 Book a Free Demo Call: ${calendarLink}`);
  } else {
    await sendMessage(to, `🚀 Schedule a Demo to Automate Your Sales: ${calendarLink}`);
  }
}

async function sendFinalReview(to, userData) {
  let summary = "📋 Here's what we've collected:\n\n";
  
  if (userData.userType === 'School') {
    summary += `Name: ${userData.name}\n`;
    summary += `Type: School\n`;
    summary += `School: ${userData.schoolName}\n`;
    summary += `Level: ${userData.schoolLevel}\n`;
  } else {
    summary += `Name: ${userData.name}\n`;
    summary += `Type: Business\n`;
    summary += `Industry: ${userData.businessIndustry}\n`;
    summary += `Objective: ${userData.objective}\n`;
  }
  
  if (userData.demoRating) {
    summary += `Demo Rating: ${'⭐'.repeat(userData.demoRating)}\n`;
  }
  
  summary += `\nWould you like to save and continue later or talk to a human agent?`;

  const interactiveData = {
    type: 'button',
    body: { text: summary },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'final_continue', title: 'Continue' } },
        { type: 'reply', reply: { id: 'final_agent', title: 'Talk to Agent' } }
      ]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function sendMenuOptions(to) {
  const interactiveData = {
    type: 'button',
    body: { text: "Would you like to resume where you left off or start over?" },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'menu_resume', title: 'Resume' } },
        { type: 'reply', reply: { id: 'menu_restart', title: 'Start Fresh' } },
        { type: 'reply', reply: { id: 'menu_agent', title: 'Talk to Agent' } }
      ]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

// Onboarding Flow Handler
async function handleOnboardingStage(from, text, stage, userRef, userData) {
  const updateData = {};
  let nextStage = stage;

  try {
    switch (stage) {
      case 'welcome':
        if (text === 'welcome_agree') {
          nextStage = 'user_type';
          await sendUserTypeSelection(from);
        } else if (text === 'welcome_later') {
          await setOnboardingTimeout(from);
          await sendMessage(from, "No problem! We'll remind you in 24 hours. Type 'menu' anytime to begin.");
          return;
        } else {
          await sendWelcomeMessage(from);
          return;
        }
        break;

      case 'user_type':
        if (text === 'userType_school') {
          updateData.userType = 'School';
          nextStage = 'name';
          await sendMessage(from, "Great! What's your full name?");
        } else if (text === 'userType_business') {
          updateData.userType = 'Business';
          nextStage = 'name';
          await sendMessage(from, "Great! What's your full name?");
        } else {
          await sendUserTypeSelection(from);
          return;
        }
        break;

      case 'name':
        if (text && text.length >= 2) {
          updateData.name = text;
          if (userData.userType === 'School') {
            nextStage = 'school_name';
            await sendSchoolNameRequest(from);
          } else {
            nextStage = 'business_industry';
            await sendBusinessIndustrySelection(from);
          }
        } else {
          await sendMessage(from, "❌ Please provide a valid name (at least 2 characters)");
          return;
        }
        break;

      case 'school_name':
        if (text && text.length >= 2) {
          updateData.schoolName = text;
          nextStage = 'school_level';
          await sendSchoolLevelSelection(from);
        } else {
          await sendMessage(from, "❌ Please provide a valid school name");
          return;
        }
        break;

      case 'school_level':
        if (text && text.startsWith('schoolLevel_')) {
          updateData.schoolLevel = text.replace('schoolLevel_', '');
          nextStage = 'school_demo';
          await sendSchoolDemoOptions(from, userData.name);
        } else {
          await sendSchoolLevelSelection(from);
          return;
        }
        break;

      case 'school_demo':
        if (text && text.startsWith('demo_')) {
          updateData.demoSelected = admin.firestore.FieldValue.arrayUnion(text);
          nextStage = 'demo_testimonial';
          await sendDemoTestimonial(from, 'School');
          await sendRatingRequest(from);
        } else {
          await sendSchoolDemoOptions(from, userData.name);
          return;
        }
        break;

      case 'business_industry':
        if (text && text.startsWith('industry_')) {
          updateData.businessIndustry = text.replace('industry_', '');
          nextStage = 'business_objective';
          await sendBusinessObjectiveSelection(from);
        } else {
          await sendBusinessIndustrySelection(from);
          return;
        }
        break;

      case 'business_objective':
        if (text && text.startsWith('objective_')) {
          updateData.objective = text.replace('objective_', '');
          nextStage = 'business_demo';
          await sendBusinessDemoOptions(from, userData.name, userData.businessIndustry);
        } else {
          await sendBusinessObjectiveSelection(from);
          return;
        }
        break;

      case 'business_demo':
        if (text && text.startsWith('demo_')) {
          updateData.demoSelected = admin.firestore.FieldValue.arrayUnion(text);
          nextStage = 'demo_testimonial';
          await sendDemoTestimonial(from, 'Business');
          await sendRatingRequest(from);
        } else {
          await sendBusinessDemoOptions(from, userData.name, userData.businessIndustry);
          return;
        }
        break;

      case 'demo_testimonial':
        if (text && text.startsWith('rating_')) {
          updateData.demoRating = parseInt(text.replace('rating_', ''));
          nextStage = 'demo_booking';
          await sendDemoBookingCTA(from, userData.userType);
          await new Promise(resolve => setTimeout(resolve, 1000));
          await sendFinalReview(from, {
            ...userData,
            demoRating: parseInt(text.replace('rating_', ''))
          });
        } else {
          await sendRatingRequest(from);
          return;
        }
        break;

      case 'demo_booking':
        if (text === 'final_continue') {
          updateData['onboarding.completed'] = true;
          updateData['onboarding.completedAt'] = admin.firestore.FieldValue.serverTimestamp();
          await sendMessage(from, "🎉 Thank you for completing the onboarding! Type 'menu' anytime to access these options again.");
        } else if (text === 'final_agent') {
          updateData.requiresAgent = true;
          await sendMessage(from, "We're connecting you to a human agent now. Please hold...");
        } else {
          await sendFinalReview(from, userData);
          return;
        }
        break;

      default:
        await sendMessage(from, "Sorry, I didn't understand that. Type 'menu' to see options.");
        return;
    }

    // Update user progress
    updateData['onboarding.stage'] = nextStage;
    updateData['onboarding.lastActive'] = admin.firestore.FieldValue.serverTimestamp();
    
    await userRef.update(updateData);
    await updateGoogleSheet({
      ...userData,
      ...updateData,
      phone: from
    });

  } catch (err) {
    console.error('Onboarding error:', err);
    await sendMessage(from, "⚠️ We encountered an error. Please try again or type 'menu' to restart.");
  }
}

// Routes
app.get('/', (req, res) => res.send('✅ WhatsApp Bot running'));

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

    const userRef = db.collection('users').doc(from);
    const userDoc = await userRef.get();
    const userData = userDoc.exists ? userDoc.data() : null;

    // Handle menu command
    if (message.text?.body?.toLowerCase().trim() === 'menu') {
      if (!userDoc.exists) {
        await startOnboarding(from);
      } else {
        await sendMenuOptions(from);
      }
      return res.sendStatus(200);
    }

    // Handle menu options
    if (message.interactive?.button_reply?.id === 'menu_resume') {
      if (userData?.onboarding?.stage) {
        await handleOnboardingStage(from, '', userData.onboarding.stage, userRef, userData);
      } else {
        await sendWelcomeMessage(from);
      }
      return res.sendStatus(200);
    }

    if (message.interactive?.button_reply?.id === 'menu_restart') {
      await startOnboarding(from);
      return res.sendStatus(200);
    }

    // Handle restart command
    if (['restart', 'start'].includes(message.text?.body?.toLowerCase().trim())) {
      await startOnboarding(from);
      return res.sendStatus(200);
    }

    // Check for timeout
    if (userData?.onboarding?.timeoutAt?.toDate() < new Date()) {
      await sendMessage(from, "⏰ Our conversation timed out. Type 'menu' to begin again.");
      await userRef.update({ 'onboarding.closed': true });
      return res.sendStatus(200);
    }

    // New user handling
    if (!userDoc.exists) {
      await startOnboarding(from);
      return res.sendStatus(200);
    }

    // Update last active time
    await userRef.update({
      'onboarding.lastActive': admin.firestore.FieldValue.serverTimestamp()
    });

    // Determine current stage
    const currentStage = userData.onboarding?.stage || 'welcome';
    let text = '';

    // Extract text from message
    if (message.type === 'text') {
      text = message.text?.body || '';
    } else if (message.type === 'interactive') {
      if (message.interactive?.type === 'button_reply') {
        text = message.interactive.button_reply?.id || '';
      } else if (message.interactive?.type === 'list_reply') {
        text = message.interactive.list_reply?.id || '';
      }
    }

    // Process the message
    await handleOnboardingStage(from, text, currentStage, userRef, userData);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
