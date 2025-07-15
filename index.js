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
  GOOGLE_PRIVATE_KEY
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

async function getAIResponse(userText, userId) {
  const userRef = await db.collection('users').doc(userId).get();
  const userData = userRef.data() || {};
  
  const personality = userData.userType === 'School' 
    ? {
        tone: "educational and concise",
        traits: [
          "Keep responses 100-300 characters",
          "Use bullet points when listing items",
          "Offer to continue via Fredsofficial.com if more detail needed",
          "Always conclude with clear next steps"
        ]
      }
    : {
        tone: "business-oriented and concise",
        traits: [
          "Keep responses 100-300 characters",
          "Focus on lead generation and sales",
          "Provide concrete business examples",
          "Emphasize automation and efficiency"
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
            content: `You are Fred's Official WhatsApp assistant. Be ${personality.tone}.\n` +
                     `${personality.traits.join('\n')}\n\n` +
                     `Current user context:\n` +
                     `Name: ${userData.name || 'Unknown'}\n` +
                     `Type: ${userData.userType || 'Unknown'}\n` +
                     `Business/School: ${userData.businessIndustry || userData.schoolLevel || 'Unknown'}`
          },
          { role: "user", content: userText }
        ],
        temperature: 0.7,
        max_tokens: 150
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
    console.error('❌ AI error:', err.response?.data || err.message);
    return "🔧 My circuits are a bit busy! Try asking again or visit Fredsofficial.com";
  }
}

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
      text: "👋 Welcome to Fred's Official WhatsApp Automation Assistant 🌟\n\n" +
            "To provide the best experience, we'll collect some information. " +
            "Your data will only be used to personalize your experience."
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
  await sendMessage(to, "📚 Here's how we help schools like yours:");
  
  const interactiveData = {
    type: 'list',
    header: { type: 'text', text: '🏫 School Automation Demo' },
    body: { 
      text: `${userName}, try these school communication tools:\n` +
            "Tap to experience a simulation" 
    },
    action: {
      button: 'View Demos',
      sections: [{
        title: 'School Tools',
        rows: [
          { id: 'demo_exam_alert', title: 'Exam Alert', description: 'Send to entire school' },
          { id: 'demo_report_card', title: 'Report Cards', description: 'With parent feedback' },
          { id: 'demo_event_reminder', title: 'Event Reminder', description: 'PTA meetings, etc' }
        ]
      }]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function runExamAlertDemo(to) {
  await sendMessage(to, "📝 Setting up exam alert simulation...");
  await new Promise(resolve => setTimeout(resolve, DEMO_DELAY));
  
  await sendInteractiveMessage(to, {
    type: 'button',
    body: { text: "Send exam timetable to:" },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'exam_all', title: 'All Parents (300)' } },
        { type: 'reply', reply: { id: 'exam_form4', title: 'Form 4 Only (45)' } }
      ]
    }
  });
}

async function completeExamAlertDemo(to, choice) {
  if (choice === 'exam_all') {
    await sendMessage(to, "⏳ Sending to 300 parents...");
    await new Promise(resolve => setTimeout(resolve, DEMO_DELAY));
    await sendMessage(to, 
      "✅ Sent successfully!\n\n" +
      "Sample message:\n" +
      "📅 FORM 1 EXAMS\n" +
      "Mon: Math (8-10am)\n" +
      "Tue: English (9-11am)\n" +
      "Full timetable: bit.ly/greenhill-exams");
  } else {
    await sendMessage(to, "⏳ Sending to Form 4 parents...");
    await new Promise(resolve => setTimeout(resolve, DEMO_DELAY));
    await sendMessage(to, 
      "✅ Sent to 45 parents!\n\n" +
      "Sample message:\n" +
      "📅 FORM 4 PRE-MOCKS\n" +
      "Wed: Chemistry (10am-12pm)\n" +
      "Thu: Physics (8-10am)");
  }
  
  await sendInteractiveMessage(to, {
    type: 'button',
    body: { text: "Would you like to test sending to another number?" },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'exam_test_number', title: 'Again' } },
        { type: 'reply', reply: { id: 'exam_done', title: 'Continue' } }
      ]
    }
  });
}

async function requestTestNumber(to, demoType) {
  await sendMessage(to, `Please enter the phone number to test ${demoType} (format: 0700123456):`);
}

async function confirmTestNumber(to, number, demoType) {
  await sendMessage(to, `⏳ Preparing to send ${demoType} demo to ${number}...`);
  await new Promise(resolve => setTimeout(resolve, DEMO_DELAY));
  
  if (demoType === 'exam alert') {
    await sendMessage(to, 
      `📤 Sent exam alert demo to ${number}:\n\n` +
      "Sample exam timetable attached\n" +
      "View full demo at Fredsofficial.com/demo");
  } else if (demoType === 'report card') {
    await sendMessage(to,
      `📤 Sent report card demo to ${number}:\n\n` +
      "📝 Term 3 Report Card\n" +
      "Math: A\nEnglish: B+\n" +
      "View full demo at Fredsofficial.com/demo");
  }
}

async function runReportCardDemo(to) {
  await sendMessage(to, "📊 Generating sample report card...");
  await new Promise(resolve => setTimeout(resolve, DEMO_DELAY));
  
  await sendMessage(to,
    "📝 STUDENT REPORT - TERM 3\n" +
    "Name: Maria Kamau\n" +
    "Class: Form 2 East\n\n" +
    "Math: A\n" +
    "English: B+\n" +
    "Science: A-\n" +
    "Comments: Excellent progress in STEM subjects");
  
  await sendInteractiveMessage(to, {
    type: 'button',
    body: { text: "Include parent feedback request?" },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'report_yes', title: 'Yes, Add Feedback' } },
        { type: 'reply', reply: { id: 'report_no', title: 'Send As Is' } }
      ]
    }
  });
}

async function completeReportCardDemo(to, includeFeedback) {
  if (includeFeedback === 'report_yes') {
    await sendMessage(to, "⏳ Adding feedback section...");
    await new Promise(resolve => setTimeout(resolve, DEMO_DELAY));
    await sendMessage(to,
      "✅ Report card ready with feedback request!\n\n" +
      "Sample message to parents:\n" +
      "Please reply with:\n" +
      "1 - Satisfied\n" +
      "2 - Needs improvement\n" +
      "3 - Request meeting");
  } else {
    await sendMessage(to, "⏳ Sending report card...");
    await new Promise(resolve => setTimeout(resolve, DEMO_DELAY));
    await sendMessage(to, "✅ Report card sent to parents!");
  }
  
  await sendInteractiveMessage(to, {
    type: 'button',
    body: { text: "Test sending to another number?" },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'report_test_number', title: 'Another' } },
        { type: 'reply', reply: { id: 'report_done', title: 'Continue' } }
      ]
    }
  });
}

async function runEventReminderDemo(to) {
  await sendMessage(to, "📅 Setting up event reminder...");
  await new Promise(resolve => setTimeout(resolve, DEMO_DELAY));
  
  await sendInteractiveMessage(to, {
    type: 'list',
    header: { type: 'text', text: '🏫 School Event Reminder' },
    body: { text: 'Select event type:' },
    action: {
      button: 'Select',
      sections: [{
        title: 'Event Types',
        rows: [
          { id: 'event_pta', title: 'PTA Meeting' },
          { id: 'event_sports', title: 'Sports Day' },
          { id: 'event_trip', title: 'School Trip' }
        ]
      }]
    }
  });
}

async function completeEventReminderDemo(to, eventType) {
  let eventName = '';
  if (eventType === 'event_pta') eventName = 'PTA Meeting';
  else if (eventType === 'event_sports') eventName = 'Sports Day';
  else eventName = 'School Trip';
  
  await sendMessage(to, `⏳ Creating ${eventName} reminder...`);
  await new Promise(resolve => setTimeout(resolve, DEMO_DELAY));
  
  await sendMessage(to,
    `✅ ${eventName} Reminder Ready!\n\n` +
    "Sample message:\n" +
    `📢 ${eventName} Alert\n` +
    `Date: ${new Date(Date.now() + 86400000 * 7).toLocaleDateString()}\n` +
    "Details: bit.ly/greenhill-events");
  
  await sendInteractiveMessage(to, {
    type: 'button',
    body: { text: "Test sending to another number?" },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'event_test_number', title: 'Another' } },
        { type: 'reply', reply: { id: 'event_done', title: 'Continue' } }
      ]
    }
  });
}

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
  await sendMessage(to, "🛍️ Here's our product catalog:");
  await sendMessage(to, "Image: [Mock product catalog image]");
  
  const interactiveData = {
    type: 'list',
    header: { type: 'text', text: '🧲 Business Solutions' },
    body: { 
      text: `${userName}, try these ${businessType} business tools:\n` +
            "Tap to experience a simulation" 
    },
    action: {
      button: 'View Demos',
      sections: [{
        title: 'Business Tools',
        rows: [
          { id: 'demo_ad_leads', title: 'Ad Lead Capture', description: 'From social media ads' },
          { id: 'demo_autoresponder', title: 'Autoresponder', description: 'Instant replies 24/7' },
          { id: 'demo_crm_tagging', title: 'CRM Tagging', description: 'Organize clients' }
        ]
      }]
    }
  };
  await sendInteractiveMessage(to, interactiveData);
}

async function runAdLeadDemo(to) {
  await sendMessage(to, "🔍 Simulating ad lead capture...");
  await new Promise(resolve => setTimeout(resolve, DEMO_DELAY));
  
  await sendInteractiveMessage(to, {
    type: 'button',
    body: { 
      text: "A customer clicked your Facebook ad:\n" +
            "'Learn About Premium Plan'" 
    },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'lead_capture', title: 'Capture Lead' } }
      ]
    }
  });
}

async function completeAdLeadDemo(to) {
  await sendMessage(to, "⏳ Creating lead in CRM...");
  await new Promise(resolve => setTimeout(resolve, DEMO_DELAY));
  
  await sendMessage(to,
    "✅ Lead Captured!\n" +
    "Name: John Doe\n" +
    "Interest: Premium Plan\n" +
    "Phone: +2547******");
  
  await new Promise(resolve => setTimeout(resolve, 1500));
  await sendMessage(to,
    "🤖 Auto-responder sequence started:\n\n" +
    "1. Instant reply sent:\n" +
    "'Thanks for your interest John! Here's our Premium Plan brochure: link.com'\n\n" +
    "2. Follow-up in 24h:\n" +
    "'Did you get a chance to review the Premium Plan details?'");
  
  await sendInteractiveMessage(to, {
    type: 'button',
    body: { text: "Test sending to another number?" },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'lead_test_number', title: 'Another' } },
        { type: 'reply', reply: { id: 'lead_done', title: 'Continue' } }
      ]
    }
  });
}

async function runAutoresponderDemo(to) {
  await sendMessage(to, "🤖 Setting up auto-responder...");
  await new Promise(resolve => setTimeout(resolve, DEMO_DELAY));
  
  await sendInteractiveMessage(to, {
    type: 'list',
    header: { type: 'text', text: '⏰ Auto-responder Triggers' },
    body: { text: 'Select when to respond automatically:' },
    action: {
      button: 'Select',
      sections: [{
        title: 'Triggers',
        rows: [
          { id: 'auto_keyword', title: 'Keyword Detection' },
          { id: 'auto_hours', title: 'After Hours' },
          { id: 'auto_all', title: 'All Messages' }
        ]
      }]
    }
  });
}

async function completeAutoresponderDemo(to, triggerType) {
  let triggerName = '';
  if (triggerType === 'auto_keyword') triggerName = 'keyword detection';
  else if (triggerType === 'auto_hours') triggerName = 'after hours';
  else triggerName = 'all messages';
  
  await sendMessage(to, `⏳ Configuring ${triggerName} responder...`);
  await new Promise(resolve => setTimeout(resolve, DEMO_DELAY));
  
  await sendMessage(to,
    `✅ ${triggerName.charAt(0).toUpperCase() + triggerName.slice(1)} responder active!\n\n` +
    "Sample triggered response:\n" +
    "Thanks for your message! Our team will respond within 24 hours. " +
    "For urgent inquiries, call 0700123456.");
  
  await sendInteractiveMessage(to, {
    type: 'button',
    body: { text: "Test sending to another number?" },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'auto_test_number', title: 'Another' } },
        { type: 'reply', reply: { id: 'auto_done', title: 'Continue' } }
      ]
    }
  });
}

async function runCRMTaggingDemo(to) {
  await sendMessage(to, "🏷️ Simulating CRM tagging...");
  await new Promise(resolve => setTimeout(resolve, DEMO_DELAY));
  
  await sendInteractiveMessage(to, {
    type: 'list',
    header: { type: 'text', text: '📌 Tag This Lead' },
    body: { text: 'New lead from website contact form:' },
    action: {
      button: 'Select Tags',
      sections: [{
        title: 'Tags',
        rows: [
          { id: 'tag_hot', title: '🔥 Hot Lead' },
          { id: 'tag_edu', title: '🎓 Education Sector' },
          { id: 'tag_follow', title: '🔄 Follow-up Tomorrow' }
        ]
      }]
    }
  });
}

async function completeCRMTaggingDemo(to) {
  await sendMessage(to, "⏳ Updating CRM records...");
  await new Promise(resolve => setTimeout(resolve, DEMO_DELAY));
  
  await sendMessage(to,
    "✅ Lead tagged successfully!\n\n" +
    "Tags applied:\n" +
    "• 🔥 Hot Lead\n" +
    "• 🎓 Education Sector\n" +
    "• 🔄 Follow-up Tomorrow");
  
  await sendInteractiveMessage(to, {
    type: 'button',
    body: { text: "Test sending to another number?" },
    action: {
      buttons: [
        { type: 'reply', reply: { id: 'crm_test_number', title: 'Another' } },
        { type: 'reply', reply: { id: 'crm_done', title: 'Continue' } }
      ]
    }
  });
}

async function sendDemoTestimonial(to, userType) {
  if (userType === 'School') {
    await sendMessage(to, 
      "📣 'As a head teacher, I can now reach 300 parents instantly. " +
      "It's a game-changer!' – Mr. Kamau, Greenhill Academy");
  } else {
    await sendMessage(to, 
      "💬 'I run ads at night, and by morning 80 leads were already " +
      "tagged and followed up.' – Faith, Salon Owner");
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
        if (text === 'demo_exam_alert') {
          await runExamAlertDemo(from);
          return;
        } else if (text === 'demo_report_card') {
          await runReportCardDemo(from);
          return;
        } else if (text === 'demo_event_reminder') {
          await runEventReminderDemo(from);
          return;
        } else if (text === 'exam_all' || text === 'exam_form4') {
          await completeExamAlertDemo(from, text);
          return;
        } else if (text === 'report_yes' || text === 'report_no') {
          await completeReportCardDemo(from, text);
          return;
        } else if (text.startsWith('event_')) {
          await completeEventReminderDemo(from, text);
          return;
        } else if (text === 'exam_test_number') {
          await requestTestNumber(from, 'exam alert');
          return;
        } else if (text === 'report_test_number') {
          await requestTestNumber(from, 'report card');
          return;
        } else if (text === 'event_test_number') {
          await requestTestNumber(from, 'event reminder');
          return;
        } else if (/^\d{10}$/.test(text)) {
          await confirmTestNumber(from, text, userData.demoType || 'demo');
          return;
        } else if (text.endsWith('_done')) {
          nextStage = 'demo_testimonial';
          await sendDemoTestimonial(from, userData.userType);
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
        if (text === 'demo_ad_leads') {
          await runAdLeadDemo(from);
          return;
        } else if (text === 'demo_autoresponder') {
          await runAutoresponderDemo(from);
          return;
        } else if (text === 'demo_crm_tagging') {
          await runCRMTaggingDemo(from);
          return;
        } else if (text === 'lead_capture') {
          await completeAdLeadDemo(from);
          return;
        } else if (text.startsWith('auto_')) {
          await completeAutoresponderDemo(from, text);
          return;
        } else if (text === 'lead_test_number') {
          await requestTestNumber(from, 'lead capture');
          return;
        } else if (text === 'auto_test_number') {
          await requestTestNumber(from, 'auto-responder');
          return;
        } else if (text === 'crm_test_number') {
          await requestTestNumber(from, 'CRM tagging');
          return;
        } else if (/^\d{10}$/.test(text)) {
          await confirmTestNumber(from, text, userData.demoType || 'demo');
          return;
        } else if (text.endsWith('_done')) {
          nextStage = 'demo_testimonial';
          await sendDemoTestimonial(from, userData.userType);
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
          updateData.agentRequestedAt = admin.firestore.FieldValue.serverTimestamp();
          await sendMessage(from, "We're connecting you to a human agent now. Please hold...");
          
          agentResponseTimers.set(from, setTimeout(async () => {
            const currentUserData = (await db.collection('users').doc(from).get()).data();
            if (currentUserData.requiresAgent && !currentUserData.assignedAgent) {
              await sendMessage(from, "Our agents are currently busy. Let me help you instead!");
              const aiResponse = await getAIResponse(text, from);
              await sendMessage(from, aiResponse);
              await db.collection('users').doc(from).update({
                aiEnabled: true,
                requiresAgent: false
              });
            }
          }, AGENT_RESPONSE_TIMEOUT));
        } else {
          await sendFinalReview(from, userData);
          return;
        }
        break;

      default:
        await sendMessage(from, "Sorry, I didn't understand that. Type 'menu' to see options.");
        return;
    }

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

app.get('/', (req, res) => res.send('✅ WhatsApp Bot running'));

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

    console.log('Webhook received:', message.type, 'from:', from);

    await logMessage('incoming', {
      from,
      type: message.type,
      message: message,
      userId: from
    });

    const userRef = db.collection('users').doc(from);
    const userDoc = await userRef.get();
    const userData = userDoc.exists ? userDoc.data() : null;

    if (message.text?.body?.toLowerCase().trim() === 'menu') {
      if (!userDoc.exists) {
        await startOnboarding(from);
      } else {
        await sendMenuOptions(from);
      }
      return res.sendStatus(200);
    }

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

    if (message.interactive?.button_reply?.id === 'menu_agent') {
      await userRef.update({
        requiresAgent: true,
        agentRequestedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await sendMessage(from, "We're connecting you to a human agent now. Please hold...");
      
      agentResponseTimers.set(from, setTimeout(async () => {
        const currentUserData = (await db.collection('users').doc(from).get()).data();
        if (currentUserData.requiresAgent && !currentUserData.assignedAgent) {
          await sendMessage(from, "Our agents are currently busy. Let me help you instead!");
          const aiResponse = await getAIResponse(message.text?.body || '', from);
          await sendMessage(from, aiResponse);
          await db.collection('users').doc(from).update({
            aiEnabled: true,
            requiresAgent: false
          });
        }
      }, AGENT_RESPONSE_TIMEOUT));
      
      return res.sendStatus(200);
    }

    if (['restart', 'start'].includes(message.text?.body?.toLowerCase().trim())) {
      await startOnboarding(from);
      return res.sendStatus(200);
    }

    if (userData?.onboarding?.timeoutAt?.toDate() < new Date()) {
      await sendMessage(from, "⏰ Our conversation timed out. Type 'menu' to begin again.");
      await userRef.update({ 'onboarding.closed': true });
      return res.sendStatus(200);
    }

    if (!userDoc.exists) {
      await startOnboarding(from);
      return res.sendStatus(200);
    }

    await userRef.update({
      'onboarding.lastActive': admin.firestore.FieldValue.serverTimestamp()
    });

    const currentStage = userData.onboarding?.stage || 'welcome';
    let text = '';

    if (message.type === 'text') {
      text = message.text?.body || '';
    } else if (message.type === 'interactive') {
      if (message.interactive?.type === 'button_reply') {
        text = message.interactive.button_reply?.id || '';
      } else if (message.interactive?.type === 'list_reply') {
        text = message.interactive.list_reply?.id || '';
      }
    }

    if (userData.onboarding?.completed || userData.aiEnabled) {
      if (!text.includes('agent') && !userData.requiresAgent && !userData.assignedAgent) {
        const aiResponse = await getAIResponse(text, from);
        await sendMessage(from, aiResponse, true);
        return res.sendStatus(200);
      }
    }

    await handleOnboardingStage(from, text, currentStage, userRef, userData);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`⏰ Last restart: ${new Date().toISOString()}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
