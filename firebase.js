const admin = require("firebase-admin");

// Load credentials from environment variable
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const usersRef = db.collection("users");

module.exports = usersRef;
