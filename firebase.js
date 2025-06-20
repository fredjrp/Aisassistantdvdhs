const admin = require("firebase-admin");

const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

if (!serviceAccountBase64) {
  throw new Error("❌ FIREBASE_SERVICE_ACCOUNT_BASE64 is missing.");
}

const serviceAccount = JSON.parse(
  Buffer.from(serviceAccountBase64, "base64").toString("utf-8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const usersRef = db.collection("users");

module.exports = usersRef;
