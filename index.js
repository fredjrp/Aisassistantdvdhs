require('dotenv').config();

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Load environment variables
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

if (!WHATSAPP_ACCESS_TOKEN || !PHONE_NUMBER_ID || !WEBHOOK_VERIFY_TOKEN) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

// Home route
app.get('/', (req, res) => {
  res.send('✅ WhatsApp Webhook is running');
});

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Webhook event handler
app.post('/webhook', async (req, res) => {
  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const message = changes?.value?.messages?.[0];
  const status = changes?.value?.statuses?.[0];

  if (status) {
    console.log(`📦 Message Status: ${status.status}, ID: ${status.id}`);
  }

  if (message) {
    const from = message.from;
    const type = message.type;

    if (type === 'text') {
      const text = message.text.body.toLowerCase();

      if (text === 'hello') await replyMessage(from, 'Hello. How are you?', message.id);
      else if (text === 'list') await sendList(from);
      else if (text === 'buttons') await sendReplyButtons(from);
    }

    if (type === 'interactive') {
      const interactive = message.interactive;
      if (interactive.type === 'list_reply') {
        await sendMessage(from, `✅ You selected: ${interactive.list_reply.title}`);
      } else if (interactive.type === 'button_reply') {
        await sendMessage(from, `✅ You clicked: ${interactive.button_reply.title}`);
      }
    }

    console.log("📩 Message Received:", JSON.stringify(message, null, 2));
  }

  res.sendStatus(200);
});

// Text message
async function sendMessage(to, body) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('❌ Error sending message:', error.response?.data || error.message);
  }
}

// Reply to a message ID
async function replyMessage(to, body, messageId) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      context: { message_id: messageId },
      type: 'text',
      text: { body }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('❌ Error sending reply:', error.response?.data || error.message);
  }
}

// Send interactive list
async function sendList(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: {
          type: 'text',
          text: '📋 Menu'
        },
        body: {
          text: 'Choose an option from the list:'
        },
        footer: {
          text: 'Powered by Fred'
        },
        action: {
          button: 'Open Menu',
          sections: [
            {
              title: 'Main Options',
              rows: [
                {
                  id: 'opt1',
                  title: 'First Option',
                  description: 'This is the first option'
                },
                {
                  id: 'opt2',
                  title: 'Second Option',
                  description: 'This is the second option'
                }
              ]
            },
            {
              title: 'Other',
              rows: [
                {
                  id: 'help',
                  title: 'Help & Support'
                }
              ]
            }
          ]
        }
      }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('❌ Error sending list:', error.response?.data || error.message);
  }
}

// Send interactive buttons
async function sendReplyButtons(to) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: {
          type: 'text',
          text: '⚡ Quick Action'
        },
        body: {
          text: 'Click a button below:'
        },
        footer: {
          text: 'Fred\'s Assistant'
        },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: 'btn1',
                title: 'Option A'
              }
            },
            {
              type: 'reply',
              reply: {
                id: 'btn2',
                title: 'Option B'
              }
            }
          ]
        }
      }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('❌ Error sending buttons:', error.response?.data || error.message);
  }
}

// Render/production compatible port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
