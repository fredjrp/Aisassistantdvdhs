const admin = require("firebase-admin");

const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
const serviceAccountJSON = Buffer.from(serviceAccountBase64, 'base64').toString('utf8');
const serviceAccount = JSON.parse(serviceAccountJSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const usersRef = db.collection("users");

module.exports = usersRef;
