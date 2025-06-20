const admin = require("firebase-admin");

const raw = JSON.parse(process.env.FIREBASE_CREDENTIALS_JSON);

// Fix private_key: convert \\n to actual newlines
raw.private_key = raw.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(raw),
});

const db = admin.firestore();
const usersRef = db.collection("users");

module.exports = usersRef;
