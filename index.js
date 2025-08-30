// server.js — All-in-one backend for Jumia Seller + WhatsApp + Admin
// ---------------------------------------------------------------
// 1) READ THIS FIRST — REQUIRED ENV VARS
// PORT=10000
// ADMIN_PASSWORD=replace-me
// PUBLIC_ORIGIN=https://yourdomain.onrender.com
//
// JUMIA_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
// JUMIA_REFRESH_TOKEN=copy-from-vendor-center
// JUMIA_API_BASE=https://vendor-api.jumia.com
// JUMIA_FEE_PCT=10
// SHIPPING_COST_FLAT=0
//
// WHATSAPP_TOKEN=EAAG...
// PHONE_NUMBER_ID=123456789012345
// ADMIN_ALERT_PHONE=2547XXXXXXXX

const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const morgan = require('morgan');
const cron = require('node-cron');
const qs = require('querystring');

// --- ENV ---
const {
  PORT = 10000,
  ADMIN_PASSWORD,
  PUBLIC_ORIGIN,
  JUMIA_CLIENT_ID,
  JUMIA_REFRESH_TOKEN,
  JUMIA_API_BASE = 'https://vendor-api.jumia.com',
  JUMIA_FEE_PCT = '10',
  SHIPPING_COST_FLAT = '0',
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  ADMIN_ALERT_PHONE
} = process.env;

if (!ADMIN_PASSWORD) console.warn('⚠️ Set ADMIN_PASSWORD!');
if (!JUMIA_CLIENT_ID || !JUMIA_REFRESH_TOKEN) console.warn('⚠️ Set JUMIA_CLIENT_ID & JUMIA_REFRESH_TOKEN!');
if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) console.warn('⚠️ Set WHATSAPP_TOKEN & PHONE_NUMBER_ID!');

// --- APP ---
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));
app.use(cors(PUBLIC_ORIGIN ? { origin: PUBLIC_ORIGIN } : {}));

// --- DB (SQLite) ---
const DB_FILE = path.join(process.cwd(), 'data.db');
const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS products(
    id TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    price REAL,
    cost REAL DEFAULT 0,
    stock INTEGER DEFAULT 0,
    image_url TEXT,
    jumia_url TEXT,
    updated_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS orders(
    id TEXT PRIMARY KEY,
    product_id TEXT,
    quantity INTEGER,
    status TEXT,
    customer_name TEXT,
    customer_phone TEXT,
    total REAL,
    fees REAL,
    profit REAL,
    created_at TEXT,
    updated_at TEXT,
    shipment_due_date TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS settings(
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_products_updated ON products(updated_at)`);
});

const qRun = (sql, params=[]) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err){ if(err) reject(err); else resolve(this); });
});
const qGet = (sql, params=[]) => new Promise((resolve, reject) => {
  db.get(sql, params, (err,row)=>{ if(err) reject(err); else resolve(row); });
});
const qAll = (sql, params=[]) => new Promise((resolve, reject) => {
  db.all(sql, params, (err,rows)=>{ if(err) reject(err); else resolve(rows); });
});

// --- Helpers ---
const nowISO = () => new Date().toISOString();
const pct = parseFloat(JUMIA_FEE_PCT);
const shipFlat = parseFloat(SHIPPING_COST_FLAT);

// --- Auth middleware for admin ---
function requireAdmin(req,res,next){
  const key = req.get('x-admin-key');
  if(!key || key !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// --- Jumia OAuth (refresh token) ---
let cachedAccessToken = null;
let cachedExpTs = 0;
async function getJumiaAccessToken(){
  const now = Date.now()/1000;
  if (cachedAccessToken && now < cachedExpTs - 60) return cachedAccessToken;
  const url = `${JUMIA_API_BASE}/auth/realms/acl/protocol/openid-connect/token`;
  const body = qs.stringify({
    grant_type: 'refresh_token',
    client_id: JUMIA_CLIENT_ID,
    refresh_token: JUMIA_REFRESH_TOKEN
  });
  const { data } = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000
  });
  cachedAccessToken = data.access_token;
  cachedExpTs = Math.floor(Date.now()/1000) + (data.expires_in || 600);
  return cachedAccessToken;
}

// --- Jumia API service (adjust paths if needed) ---
async function jumiaGet(path, params={}){
  const token = await getJumiaAccessToken();
  const url = `${JUMIA_API_BASE}${path}`;
  const { data } = await axios.get(url, {
    params,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000
  });
  return data;
}

// GUESS endpoints (edit if your dashboard shows different):
// Products: /catalog/products
// Orders:   /orders

async function fetchJumiaProducts(limit=50){
  // TODO: if your API needs pagination, loop here
  const data = await jumiaGet('/catalog/products', { limit });
  // Normalize product shape; adjust keys if Jumia differs
  const list = Array.isArray(data?.products) ? data.products : (Array.isArray(data) ? data : []);
  return list.map(p => ({
    id: p.id || p.sku || p.productId,
    title: p.title || p.name,
    description: p.description || '',
    price: Number(p.price || p.salePrice || 0),
    stock: Number(p.stock || p.quantity || 0),
    image_url: extractImageUrl(p),
    jumia_url: p.url || p.productUrl || '',
    updated_at: nowISO()
  })).filter(x => x.id);
}

// Helper to extract image URL from various Jumia response formats
function extractImageUrl(product) {
  if (!product) return '';
  
  // Handle direct string
  if (typeof product.image === 'string') return product.image;
  
  // Handle object with url property
  if (typeof product.image === 'object' && product.image !== null) {
    if (product.image.url) return product.image.url;
    if (product.image.link) return product.image.link;
    if (product.image.primary) return product.image.primary;
    if (product.image.originalUrl) return product.image.originalUrl;
  }
  
  // Handle images array
  if (Array.isArray(product.images) && product.images.length > 0) {
    const firstImage = product.images[0];
    if (typeof firstImage === 'string') return firstImage;
    if (typeof firstImage === 'object' && firstImage !== null) {
      if (firstImage.url) return firstImage.url;
      if (firstImage.link) return firstImage.link;
      if (firstImage.primary) return firstImage.primary;
      if (firstImage.originalUrl) return firstImage.originalUrl;
    }
  }
  
  // Handle imageUrl field
  if (product.imageUrl) return product.imageUrl;
  
  return '';
}

async function fetchJumiaOrders(params = { status: 'pending', limit: 100 }){
  const data = await jumiaGet('/orders', params);
  const list = Array.isArray(data?.orders) ? data.orders : (Array.isArray(data) ? data : []);
  return list.map(o => {
    const product = Array.isArray(o.items) ? o.items[0] : null;
    const productId = product?.productId || product?.sku || o.productId;
    const qty = Number(product?.quantity || o.quantity || 1);
    const price = Number(product?.price || o.price || 0);
    const total = price * qty;
    const cost = Number(product?.cost || 0); // we'll override from our DB if present
    return {
      id: o.id || o.orderId,
      product_id: productId,
      quantity: qty,
      status: o.status || params.status || 'pending',
      customer_name: o.customer?.name || '',
      customer_phone: o.customer?.phone || '',
      price,
      total,
      cost,
      created_at: o.createdAt || nowISO(),
      updated_at: o.updatedAt || nowISO(),
      shipment_due_date: o.shipmentDueDate || null
    };
  }).filter(x => x.id && x.product_id);
}

// --- WhatsApp helpers ---
async function sendWhatsAppText(to, body){
  try{
    const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body }
    };
    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
  }catch(err){
    console.error('WA text error:', err.response?.data || err.message);
  }
}

async function sendWhatsAppImage(to, imageUrl, caption=''){
  try{
    // Ensure imageUrl is a string, not an object
    let actualImageUrl = imageUrl;
    if (typeof imageUrl === 'object' && imageUrl !== null) {
      if (imageUrl.url) actualImageUrl = imageUrl.url;
      else if (imageUrl.link) actualImageUrl = imageUrl.link;
      else if (imageUrl.originalUrl) actualImageUrl = imageUrl.originalUrl;
      else if (imageUrl.primary) actualImageUrl = imageUrl.primary;
    }
    
    const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image: { 
        link: actualImageUrl, // IMPORTANT: link is a plain string URL
        caption: caption.substring(0, 1024) 
      }
    };
    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
  }catch(err){
    console.error('WA image error:', err.response?.data || err.message);
  }
}

// --- Upsert helpers ---
async function upsertProducts(products){
  const stmt = `INSERT INTO products(id,title,description,price,cost,stock,image_url,jumia_url,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                  title=excluded.title,
                  description=excluded.description,
                  price=excluded.price,
                  stock=excluded.stock,
                  image_url=excluded.image_url,
                  jumia_url=excluded.jumia_url,
                  updated_at=excluded.updated_at`;
  for (const p of products){
    await qRun(stmt, [p.id,p.title,p.description,p.price,p.cost||0,p.stock,p.image_url,p.jumia_url,p.updated_at]);
  }
}

async function upsertOrders(orders){
  for (const o of orders){
    // fetch product cost from DB if present
    const prod = await qGet('SELECT cost, price, image_url, title, jumia_url FROM products WHERE id=?',[o.product_id]);
    const cost = prod?.cost ?? o.cost ?? 0;
    const unitPrice = prod?.price ?? o.price ?? 0;
    const total = unitPrice * o.quantity;
    const fees = total * (pct/100);
    const profit = total - fees - (cost * o.quantity) - shipFlat;
    
    await qRun(`INSERT INTO orders(id,product_id,quantity,status,customer_name,customer_phone,total,fees,profit,created_at,updated_at,shipment_due_date)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                  product_id=excluded.product_id,
                  quantity=excluded.quantity,
                  status=excluded.status,
                  customer_name=excluded.customer_name,
                  customer_phone=excluded.customer_phone,
                  total=excluded.total,
                  fees=excluded.fees,
                  profit=excluded.profit,
                  updated_at=excluded.updated_at,
                  shipment_due_date=excluded.shipment_due_date`,
      [o.id,o.product_id,o.quantity,o.status,o.customer_name,o.customer_phone,total,fees,profit,o.created_at,o.updated_at,o.shipment_due_date]);

    // Notify customer for new/pending orders (simple heuristic: created within last hour)
    const createdTs = Date.parse(o.created_at || nowISO());
    if (!isNaN(createdTs) && (Date.now() - createdTs) < 60*60*1000 && o.customer_phone){
      const caption = `${prod?.title || 'Your order'}\nOrder: ${o.id}\nQty: ${o.quantity}\nTotal: KES ${total.toFixed(2)}\nLink: ${prod?.jumia_url || ''}`;
      if (prod?.image_url) {
        await sendWhatsAppImage(o.customer_phone, prod.image_url, caption);
      } else {
        await sendWhatsAppText(o.customer_phone, caption);
      }
      
      // Also notify admin
      if (ADMIN_ALERT_PHONE) {
        await sendWhatsAppText(ADMIN_ALERT_PHONE, `🛒 New Order: ${o.id}\nProduct: ${prod?.title || o.product_id}\nCustomer: ${o.customer_name}\nTotal: KES ${total.toFixed(2)}`);
      }
    }
  }
}

// --- Public route (product gallery) ---
app.get('/', async (req,res)=>{
  const list = await qAll('SELECT * FROM products ORDER BY updated_at DESC LIMIT 200');
  const html = `
  <!doctype html><html><head><meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Products</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif;margin:0;background:#fafafa;color:#111}
    header{padding:16px 20px;background:#111;color:#fff}
    .grid{display:grid;gap:16px;padding:16px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
    .card{background:#fff;border:1px solid #eee;border-radius:12px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04)}
    .img{aspect-ratio:4/3;background:#f2f2f2;display:flex;align-items:center;justify-content:center;overflow:hidden}
    .img img{width:100%;height:100%;object-fit:cover}
    .p{padding:12px}
    .title{font-weight:600;margin:0 0 6px;font-size:15px;line-height:1.3}
    .desc{font-size:13px;color:#444;height:38px;overflow:hidden}
    .row{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
    .price{font-weight:700}
    .btn{display:inline-block;background:#111;color:#fff;text-decoration:none;padding:8px 10px;border-radius:8px;font-size:13px}
  </style>
  </head><body>
  <header><h1>Available Products</h1></header>
  <main>
    <div class="grid">
      ${list.map(p=>`
        <div class="card">
          <div class="img">
            ${p.image_url ? `<img src="${p.image_url}" alt="${(p.title||'product').replace(/"/g,'')}" />` : '<span>No image</span>'}
          </div>
          <div class="p">
            <div class="title">${p.title||''}</div>
            <div class="desc">${(p.description||'').slice(0,120)}</div>
            <div class="row">
              <div class="price">KES ${Number(p.price||0).toFixed(2)}</div>
              ${p.jumia_url ? `<a class="btn" href="${p.jumia_url}" target="_blank" rel="noopener">View</a>`:''}
            </div>
            <div class="row" style="margin-top:6px;color:#666;font-size:12px">Stock: ${p.stock||0}</div>
          </div>
        </div>
      `).join('')}
    </div>
  </main>
  </body></html>`;
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.send(html);
});

// --- Admin routes ---
app.post('/admin/sync/products', requireAdmin, async (req,res)=>{
  try{
    const limit = Number(req.body?.limit || 50);
    const products = await fetchJumiaProducts(limit);
    await upsertProducts(products);
    res.json({ ok:true, count: products.length });
  }catch(err){
    console.error('sync products error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Sync failed', detail: err.response?.data || err.message });
  }
});

app.get('/admin/orders', requireAdmin, async (req,res)=>{
  try{
    const { status='pending', from, to, limit=100 } = req.query;
    const fetched = await fetchJumiaOrders({ status, from, to, limit });
    await upsertOrders(fetched);
    const rows = await qAll('SELECT * FROM orders WHERE status=? ORDER BY created_at DESC',[status]);
    res.json({ ok:true, fetched: fetched.length, stored: rows.length, rows });
  }catch(err){
    console.error('orders fetch error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Orders fetch failed', detail: err.response?.data || err.message });
  }
});

app.post('/admin/product', requireAdmin, async (req,res)=>{
  const { id, title, description, price, cost, stock, image_url, jumia_url } = req.body||{};
  if(!id) return res.status(400).json({ error: 'id required' });
  try{
    const exists = await qGet('SELECT id FROM products WHERE id=?',[id]);
    if (exists){
      await qRun(`UPDATE products SET 
        title=COALESCE(?,title),
        description=COALESCE(?,description),
        price=COALESCE(?,price),
        cost=COALESCE(?,cost),
        stock=COALESCE(?,stock),
        image_url=COALESCE(?,image_url),
        jumia_url=COALESCE(?,jumia_url),
        updated_at=?
      WHERE id=?`,[title,description,price,cost,stock,image_url,jumia_url,nowISO(),id]);
    }else{
      await qRun(`INSERT INTO products(id,title,description,price,cost,stock,image_url,jumia_url,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,[id,title||'',description||'',price||0,cost||0,stock||0,image_url||'',jumia_url||'',nowISO()]);
    }
    res.json({ ok:true });
  }catch(err){
    console.error('product update error:', err.message);
    res.status(500).json({ error: 'Update failed', detail: err.message });
  }
});

app.post('/admin/order/mark-shipped', requireAdmin, async (req,res)=>{
  const { id, shipment_due_date } = req.body||{};
  if(!id) return res.status(400).json({ error: 'id required' });
  try{
    await qRun(`UPDATE orders SET status='shipped', updated_at=?, shipment_due_date=COALESCE(?,shipment_due_date) WHERE id=?`,
      [nowISO(), shipment_due_date || null, id]);
    res.json({ ok:true });
  }catch(err){
    console.error('mark shipped error:', err.message);
    res.status(500).json({ error: 'Update failed', detail: err.message });
  }
});

app.get('/admin/summary', requireAdmin, async (req,res)=>{
  try{
    const totals = await qGet(`SELECT 
      COALESCE(SUM(total),0) as revenue,
      COALESCE(SUM(fees),0) as fees,
      COALESCE(SUM(profit),0) as profit
      FROM orders`);
    const pending = await qGet(`SELECT COUNT(*) as c FROM orders WHERE status='pending'`);
    const toShip = await qGet(`SELECT COUNT(*) as c FROM orders WHERE status='pending_shipment'`);
    res.json({ ok:true, revenue: totals.revenue, fees: totals.fees, profit: totals.profit, pending: pending.c, toShip: toShip.c });
  }catch(err){
    res.status(500).json({ error: 'Summary failed', detail: err.message });
  }
});

// --- Cron: hourly reminders for upcoming shipments ---
cron.schedule('15 * * * *', async ()=>{
  try{
    const now = Date.now();
    const soon = now + 24*60*60*1000; // 24h
    const rows = await qAll(`SELECT id, customer_name, customer_phone, product_id, quantity, shipment_due_date 
                             FROM orders WHERE status='pending_shipment'`);
    const due = rows.filter(r => r.shipment_due_date && Date.parse(r.shipment_due_date) <= soon);
    if (due.length && ADMIN_ALERT_PHONE){
      const lines = await Promise.all(due.map(async d=>{
        const p = await qGet('SELECT title FROM products WHERE id=?',[d.product_id]);
        return `• ${d.id} · ${p?.title||d.product_id} · Qty ${d.quantity} · Due ${d.shipment_due_date}`;
      }));
      await sendWhatsAppText(ADMIN_ALERT_PHONE, `⏰ Shipment reminders (next 24h):\n${lines.join('\n')}`);
    }
  }catch(err){
    console.error('cron reminder error:', err.message);
  }
}, { timezone: 'Africa/Nairobi' });

// --- Start server ---
app.listen(PORT, ()=> {
  console.log(`✅ Server listening on :${PORT}`);
});
