require('dotenv').config(); // Load environment variables

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// Environment variables
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Home route
app.get('/', (req, res) => {
  res.send('✅ WhatsApp Webhook is live');
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

// Webhook message receiver
app.post('/webhook', async (req, res) => {
  const { entry } = req.body;

  if (!entry || !entry[0]?.changes) return res.sendStatus(400);

  const change = entry[0].changes[0];
  const message = change.value?.messages?.[0];
  const status = change.value?.statuses?.[0];

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
      if (message.interactive.type === 'list_reply') {
        await sendMessage(from, `✅ You selected: ${message.interactive.list_reply.title}`);
      } else if (message.interactive.type === 'button_reply') {
        await sendMessage(from, `✅ You clicked: ${message.interactive.button_reply.title}`);
      }
    }

    console.log("📩 Message Received:", JSON.stringify(message, null, 2));
  }

  res.sendStatus(200);
});

// Plain text message
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
    console.error('❌ Error sending message:', error?.response?.data || error.message);
  }
}

// Reply message to a specific message ID
async function replyMessage(to, body, messageId) {
  try {
    await axios.post(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
      context: { message_id: messageId }
    }, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('❌ Error sending reply:', error?.response?.data || error.message);
  }
}

// Interactive list message
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
          text: 'List Menu'
        },
        body: {
          text: 'Choose one of the options below:'
        },
        footer: {
          text: 'Fred\'s Assistant'
        },
        action: {
          button: 'Open Menu',
          sections: [
            {
              title: 'Services',
              rows: [
                {
                  id: 'first_option',
                  title: 'First Option',
                  description: 'This is the first choice'
                },
                {
                  id: 'second_option',
                  title: 'Second Option',
                  description: 'This is the second choice'
                }
              ]
            },
            {
              title: 'Support',
              rows: [
                {
                  id: 'help',
                  title: 'Contact Support'
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
    console.error('❌ Error sending list:', error?.response?.data || error.message);
  }
}

// Interactive button message
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
          text: 'Quick Actions'
        },
        body: {
          text: 'Choose one of the actions below'
        },
        footer: {
          text: 'Fred\'s Assistant'
        },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: 'first_button',
                title: 'First Button'
              }
            },
            {
              type: 'reply',
              reply: {
                id: 'second_button',
                title: 'Second Button'
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
    console.error('❌ Error sending buttons:', error?.response?.data || error.message);
  }
}

// Start server on Render-compatible port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
