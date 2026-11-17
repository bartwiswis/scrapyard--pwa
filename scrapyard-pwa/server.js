'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MATERIALS, PRODUCTS, DEFAULT_PRODUCT } = require('./catalog');
const pins = require('./pins');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const SESSION_IDLE_MS = { worker: 12 * 3600e3, admin: 15 * 60e3 };
const MAX_BODY = 64 * 1024;
const MAX_WEIGHT_KG = 200000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- helpers

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const r2 = (n) => Math.round(n * 100) / 100;

function str(value, name, { required = false, max = 120 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${name} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be text`);
  const s = value.trim();
  if (!s && required) throw new HttpError(400, `${name} is required`);
  if (s.length > max) throw new HttpError(400, `${name} is too long (max ${max} characters)`);
  return s;
}

function weight(value, name) {
  const n = typeof value === 'string' ? Number(value.trim().replace(',', '.')) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    throw new HttpError(400, `${name} must be a number greater than 0`);
  }
  if (n > MAX_WEIGHT_KG) throw new HttpError(400, `${name} is too large (max ${MAX_WEIGHT_KG} kg)`);
  return r2(n);
}

function price(value, name) {
  const n = typeof value === 'string' ? Number(value.trim().replace(',', '.')) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e6) {
    throw new HttpError(400, `${name} must be a number between 0 and 1,000,000`);
  }
  return Math.round(n * 1000) / 1000;
}

function requestId(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !/^[\w-]{8,64}$/.test(value)) throw new HttpError(400, 'Invalid request id');
  return value;
}

const findMaterial = (id) => MATERIALS.find((m) => m.id === id);
const findProduct = (id) => PRODUCTS.find((p) => p.id === id);

// ---------------------------------------------------------------- storage
// Every intake / processing / dispatch record is one line in data/events.jsonl
// (append-only). State is rebuilt from that file on start-up.

const store = { intake: [], processing: [], dispatch: [] };
const seq = { intake: 0, processing: 0, dispatch: 0 };
const rids = new Set();
let settings = null;
let firstRun = null;
let lastBackupAt = 0;

const DEFAULT_SETTINGS = {
  company: { name: '', address: '' },
  currency: '',
  prices: { materials: {}, products: {} },
};

function loadEvents() {
  if (!fs.existsSync(EVENTS_FILE)) return;
  const text = fs.readFileSync(EVENTS_FILE, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const { type, ...rec } = JSON.parse(line);
      if (!store[type]) throw new Error('unknown record type');
      store[type].push(rec);
      seq[type] = Math.max(seq[type], rec.id);
      if (rec.rid) rids.add(`${type}:${rec.rid}`);
    } catch (e) {
      console.warn(`events.jsonl line ${i + 1} skipped: ${e.message}`);
    }
  });
  // A crash can leave a half-written last line; make sure the next append starts on a new line.
  if (text.length && !text.endsWith('\n')) fs.appendFileSync(EVENTS_FILE, '\n');
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return {
      company: { ...DEFAULT_SETTINGS.company, ...saved.company },
      currency: saved.currency || '',
      prices: {
        materials: { ...(saved.prices && saved.prices.materials) },
        products: { ...(saved.prices && saved.prices.products) },
      },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
}

function backup() {
  // At most one copy per hour, one file per day, last 60 days kept.
  if (Date.now() - lastBackupAt < 3600e3) return;
  lastBackupAt = Date.now();
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(EVENTS_FILE, path.join(BACKUP_DIR, `events-${localDate(new Date())}.jsonl`));
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('events-')).sort();
    files.slice(0, Math.max(0, files.length - 60)).forEach((f) => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  } catch (e) {
    console.warn('Backup failed:', e.message);
  }
}

function addEvent(type, rec) {
  rec.id = seq[type] + 1;
  fs.appendFileSync(EVENTS_FILE, JSON.stringify({ type, ...rec }) + '\n'); // throws on failure, nothing is kept in memory then
  seq[type] = rec.id;
  store[type].push(rec);
  if (rec.rid) rids.add(`${type}:${rec.rid}`);
  backup();
  return rec;
}

function duplicate(type, rid) {
  return rid && rids.has(`${type}:${rid}`) ? store[type].find((e) => e.rid === rid) : null;
}

function init() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  firstRun = pins.loadConfig(DATA_DIR).created;
  settings = loadSettings();
  loadEvents();
}

// ---------------------------------------------------------------- business logic

function computeStock() {
  const raw = Object.fromEntries(MATERIALS.map((m) => [m.id, 0]));
  const prod = Object.fromEntries(PRODUCTS.map((p) => [p.id, 0]));
  for (const e of store.intake) if (e.inspection === 'Pass') raw[e.materialId] += e.weightKg;
  for (const e of store.processing) {
    raw[e.materialId] -= e.inputKg;
    prod[e.productId] += e.outputKg;
  }
  for (const e of store.dispatch) prod[e.productId] -= e.weightKg;
  for (const k of Object.keys(raw)) raw[k] = r2(raw[k]);
  for (const k of Object.keys(prod)) prod[k] = r2(prod[k]);
  return { raw, prod };
}

function nextBatchId() {
  const now = new Date();
  const today = localDate(now);
  const n = store.intake.filter((e) => e.date === today).length + 1;
  return `B-${today.replace(/-/g, '')}-${String(n).padStart(3, '0')}`;
}

function nextDocket() {
  const year = new Date().getFullYear();
  let n = store.dispatch.filter((d) => d.date.startsWith(String(year))).length + 1;
  const used = new Set(store.dispatch.map((d) => d.docketNo.toLowerCase()));
  let no;
  do {
    no = `WZ/${year}/${String(n++).padStart(4, '0')}`;
  } while (used.has(no.toLowerCase()));
  return no;
}

// What the weighbridge worker may see about an intake record: no prices, no stock.
const workerView = (e) => ({
  id: e.id,
  ts: e.ts,
  supplier: e.supplier,
  material: e.material,
  weightKg: e.weightKg,
  inspection: e.inspection,
  batchId: e.batchId,
});

const withValue = (e, priceField = 'pricePerKg') => {
  const { rid, ...rest } = e;
  return { ...rest, value: e[priceField] != null ? r2((e.weightKg ?? e.outputKg) * e[priceField]) : null };
};

// ---------------------------------------------------------------- auth

const sessions = new Map();

function getSession(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  const now = Date.now();
  if (now - s.last > SESSION_IDLE_MS[s.role]) {
    sessions.delete(m[1]);
    return null;
  }
  s.last = now;
  return { ...s, token: m[1] };
}

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (now - s.last > SESSION_IDLE_MS[s.role]) sessions.delete(t);
}, 60e3).unref();

// Locks an address out after repeated wrong PINs (1 min after 5 tries, doubling, max 16 min).
const limiter = (() => {
  const attempts = new Map();
  return {
    blockedFor(ip) {
      const r = attempts.get(ip);
      if (!r || !r.until) return 0;
      return Math.max(0, Math.ceil((r.until - Date.now()) / 1000));
    },
    fail(ip) {
      const r = attempts.get(ip) || { count: 0, until: 0 };
      r.count += 1;
      if (r.count % 5 === 0) r.until = Date.now() + 60e3 * 2 ** Math.min(r.count / 5 - 1, 4);
      attempts.set(ip, r);
    },
    ok(ip) {
      attempts.delete(ip);
    },
  };
})();

function checkLocked(ip) {
  const wait = limiter.blockedFor(ip);
  if (wait > 0) throw new HttpError(429, `Too many wrong PIN attempts. Try again in ${wait} s.`);
}

// ---------------------------------------------------------------- API routes

const routes = [];
// role: null = public, 'worker' = worker or admin, 'admin' = admin only
const route = (method, pattern, role, handler) => routes.push({ method, pattern, role, handler });

route('POST', '/api/login', null, (ctx) => {
  checkLocked(ctx.ip);
  const pin = typeof ctx.body.pin === 'string' ? ctx.body.pin : '';
  const cfg = pins.loadConfig(DATA_DIR).config;
  const isAdmin = pins.verifyPin(pin, cfg.admin);
  const isWorker = pins.verifyPin(pin, cfg.worker);
  if (!isAdmin && !isWorker) {
    limiter.fail(ctx.ip);
    throw new HttpError(401, 'Wrong PIN');
  }
  limiter.ok(ctx.ip);
  const role = isAdmin ? 'admin' : 'worker';
  const token = crypto.randomBytes(24).toString('base64url');
  sessions.set(token, { role, last: Date.now() });
  return { token, role };
});

route('POST', '/api/logout', 'worker', (ctx) => {
  sessions.delete(ctx.session.token);
  return { ok: true };
});

route('GET', '/api/session', 'worker', (ctx) => ({ role: ctx.session.role }));

route('GET', '/api/catalog', 'worker', (ctx) => {
  const suppliers = [];
  for (let i = store.intake.length - 1; i >= 0 && suppliers.length < 50; i--) {
    const s = store.intake[i].supplier;
    if (!suppliers.includes(s)) suppliers.push(s);
  }
  const out = {
    materials: MATERIALS.map(({ id, name, color }) => ({ id, name, color })),
    suppliers,
  };
  if (ctx.session.role === 'admin') {
    out.products = PRODUCTS.map(({ id, name, color }) => ({ id, name, color }));
    out.defaultProduct = DEFAULT_PRODUCT;
  }
  return out;
});

route('GET', '/api/next-batch', 'worker', () => ({ batchId: nextBatchId() }));

route('GET', '/api/intake/recent', 'worker', () => {
  const today = localDate(new Date());
  const entries = store.intake.filter((e) => e.date === today).slice(-8).reverse().map(workerView);
  return { entries };
});

route('POST', '/api/intake', 'worker', (ctx) => {
  const b = ctx.body;
  const rid = requestId(b.rid);
  const dup = duplicate('intake', rid);
  if (dup) return { entry: workerView(dup), duplicate: true };

  const supplier = str(b.supplier, 'Supplier Name', { required: true, max: 100 });
  const material = findMaterial(b.materialId);
  if (!material) throw new HttpError(400, 'Unknown material');
  const weightKg = weight(b.weightKg, 'Weight');
  if (!['Pass', 'Fail'].includes(b.inspection)) throw new HttpError(400, 'Inspection Status must be Pass or Fail');
  const notes = str(b.notes, 'Notes', { max: 500 });
  if (b.inspection === 'Fail' && !notes) {
    throw new HttpError(400, 'Add a note explaining why the load failed inspection');
  }
  const batchId = str(b.batchId, 'Batch ID', { max: 40 }) || nextBatchId();

  const now = new Date();
  const entry = addEvent('intake', {
    ...(rid && { rid }),
    ts: now.toISOString(),
    date: localDate(now),
    supplier,
    materialId: material.id,
    material: material.name,
    weightKg,
    inspection: b.inspection,
    batchId,
    notes,
    by: ctx.session.role,
    pricePerKg: settings.prices.materials[material.id] ?? null,
  });
  ctx.status = 201;
  return { entry: workerView(entry) };
});

// ---- admin only

route('GET', '/api/admin/stock', 'admin', () => {
  const { raw, prod } = computeStock();
  return {
    materials: MATERIALS.map((m) => ({ id: m.id, name: m.name, color: m.color, kg: raw[m.id] })),
    products: PRODUCTS.map((p) => ({ id: p.id, name: p.name, color: p.color, kg: prod[p.id] })),
  };
});

route('GET', '/api/admin/dashboard', 'admin', (ctx) => {
  const asked = Number(ctx.url.searchParams.get('days'));
  const count = [7, 14, 30].includes(asked) ? asked : 7;
  const sums = {};
  const bucket = (date) => (sums[date] = sums[date] || { intakeKg: 0, dispatchKg: 0 });
  for (const e of store.intake) if (e.inspection === 'Pass') bucket(e.date).intakeKg += e.weightKg;
  for (const e of store.dispatch) bucket(e.date).dispatchKg += e.weightKg;

  const days = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = localDate(d);
    const s = sums[date] || { intakeKg: 0, dispatchKg: 0 };
    days.push({ date, intakeKg: r2(s.intakeKg), dispatchKg: r2(s.dispatchKg) });
  }
  const today = localDate(new Date());
  const { raw, prod } = computeStock();
  const sum = (o) => r2(Object.values(o).reduce((a, b) => a + b, 0));
  return {
    currency: settings.currency,
    days,
    today: {
      intakeKg: days[days.length - 1].intakeKg,
      dispatchKg: days[days.length - 1].dispatchKg,
      loads: store.intake.filter((e) => e.date === today).length,
      rejected: store.intake.filter((e) => e.date === today && e.inspection === 'Fail').length,
    },
    totals: { rawKg: sum(raw), productKg: sum(prod) },
  };
});

route('GET', '/api/admin/logs', 'admin', (ctx) => {
  const asked = parseInt(ctx.url.searchParams.get('limit'), 10);
  const limit = Math.min(Math.max(asked || 50, 1), 500);
  const last = (arr) => arr.slice(-limit).reverse();
  return {
    currency: settings.currency,
    intake: last(store.intake).map((e) => withValue(e)),
    dispatch: last(store.dispatch).map((e) => withValue(e)),
    processing: last(store.processing).map((e) => {
      const { rid, ...rest } = e;
      return { ...rest, lossKg: r2(e.inputKg - e.outputKg) };
    }),
  };
});

route('GET', '/api/admin/next-docket', 'admin', () => ({ docketNo: nextDocket() }));

route('POST', '/api/admin/process', 'admin', (ctx) => {
  const b = ctx.body;
  const rid = requestId(b.rid);
  const dup = duplicate('processing', rid);
  if (dup) return { entry: dup, duplicate: true };

  const material = findMaterial(b.materialId);
  if (!material) throw new HttpError(400, 'Unknown raw material');
  const product = findProduct(b.productId);
  if (!product) throw new HttpError(400, 'Unknown output product');
  const inputKg = weight(b.inputKg, 'Input weight');
  const outputKg = weight(b.outputKg, 'Output weight');
  if (outputKg > inputKg) throw new HttpError(400, 'Output weight cannot be higher than the input weight');
  const available = computeStock().raw[material.id];
  if (inputKg > available + 1e-6) {
    throw new HttpError(409, `Not enough ${material.name} in stock: only ${available} kg available`);
  }
  const now = new Date();
  const entry = addEvent('processing', {
    ...(rid && { rid }),
    ts: now.toISOString(),
    date: localDate(now),
    materialId: material.id,
    material: material.name,
    inputKg,
    productId: product.id,
    product: product.name,
    outputKg,
    notes: str(b.notes, 'Notes', { max: 500 }),
  });
  ctx.status = 201;
  return { entry };
});

route('POST', '/api/admin/dispatch', 'admin', (ctx) => {
  const b = ctx.body;
  const rid = requestId(b.rid);
  const dup = duplicate('dispatch', rid);
  if (dup) return { entry: withValue(dup), duplicate: true };

  const buyer = str(b.buyer, 'Recipient/Buyer', { required: true, max: 100 });
  const product = findProduct(b.productId);
  if (!product) throw new HttpError(400, 'Unknown product');
  const weightKg = weight(b.weightKg, 'Weight');
  const docketNo = str(b.docketNo, 'Dispatch Docket No.', { max: 40 }) || nextDocket();
  if (store.dispatch.some((d) => d.docketNo.toLowerCase() === docketNo.toLowerCase())) {
    throw new HttpError(409, `Dispatch Docket No. ${docketNo} is already used`);
  }
  const available = computeStock().prod[product.id];
  if (weightKg > available + 1e-6) {
    throw new HttpError(409, `Not enough ${product.name} in stock: only ${available} kg available`);
  }
  const now = new Date();
  const entry = addEvent('dispatch', {
    ...(rid && { rid }),
    ts: now.toISOString(),
    date: localDate(now),
    buyer,
    productId: product.id,
    product: product.name,
    weightKg,
    docketNo,
    destination: str(b.destination, 'Destination', { max: 150 }),
    notes: str(b.notes, 'Notes', { max: 500 }),
    pricePerKg: settings.prices.products[product.id] ?? null,
  });
  ctx.status = 201;
  return { entry: withValue(entry) };
});

route('GET', '/api/admin/settings', 'admin', () => settings);

route('PUT', '/api/admin/settings', 'admin', (ctx) => {
  const b = ctx.body;
  const next = structuredClone(settings);
  if (b.company && typeof b.company === 'object') {
    next.company.name = str(b.company.name, 'Company name', { max: 100 });
    next.company.address = str(b.company.address, 'Company address', { max: 300 });
  }
  if (b.currency !== undefined) next.currency = str(b.currency, 'Currency', { max: 8 });
  if (b.prices && typeof b.prices === 'object') {
    for (const [group, list] of [['materials', MATERIALS], ['products', PRODUCTS]]) {
      const src = b.prices[group];
      if (!src || typeof src !== 'object') continue;
      for (const item of list) {
        if (!Object.prototype.hasOwnProperty.call(src, item.id)) continue;
        const v = src[item.id];
        if (v === '' || v === null) delete next.prices[group][item.id];
        else next.prices[group][item.id] = price(v, `${item.name} price`);
      }
    }
  }
  settings = next;
  saveSettings();
  return settings;
});

route('POST', '/api/admin/pin', 'admin', (ctx) => {
  checkLocked(ctx.ip);
  const { role, newPin, adminPin } = ctx.body;
  if (!['worker', 'admin'].includes(role)) throw new HttpError(400, 'Choose which PIN to change');
  const cfg = pins.loadConfig(DATA_DIR).config;
  if (typeof adminPin !== 'string' || !pins.verifyPin(adminPin, cfg.admin)) {
    limiter.fail(ctx.ip);
    throw new HttpError(403, 'Your current admin PIN is wrong');
  }
  limiter.ok(ctx.ip);
  if (typeof newPin !== 'string' || !pins.PIN_RE.test(newPin)) throw new HttpError(400, 'The new PIN must be 4 to 8 digits');
  const other = role === 'admin' ? 'worker' : 'admin';
  if (pins.verifyPin(newPin, cfg[other])) throw new HttpError(400, 'Worker and admin PINs must be different');
  cfg[role] = pins.hashPin(newPin);
  pins.saveConfig(DATA_DIR, cfg);
  if (role === 'worker') {
    for (const [t, s] of sessions) if (s.role === 'worker') sessions.delete(t); // old PIN holders are logged out
  }
  return { ok: true };
});

// ---------------------------------------------------------------- HTTP plumbing

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const r = routes.find((x) => x.method === req.method && x.pattern === url.pathname);
  if (!r) throw new HttpError(404, 'Not found');
  let session = null;
  if (r.role) {
    session = getSession(req);
    if (!session) throw new HttpError(401, 'Please enter your PIN');
    if (r.role === 'admin' && session.role !== 'admin') throw new HttpError(403, 'Administrator access required');
  }
  const body = req.method === 'POST' || req.method === 'PUT' ? await readJson(req) : {};
  const ctx = { req, url, body, session, ip: req.socket.remoteAddress || 'unknown', status: 200 };
  const data = await r.handler(ctx);
  sendJson(res, ctx.status, data);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (p.includes('\0')) {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (p === '/') p = '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + p);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function requestListener(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong on the server' });
    });
  } else {
    serveStatic(req, res, url);
  }
}

// Optional HTTPS: put cert.pem and key.pem into ./certs (see README) to enable it.
function createServer() {
  const certDir = path.join(__dirname, 'certs');
  const certFile = process.env.TLS_CERT || path.join(certDir, 'cert.pem');
  const keyFile = process.env.TLS_KEY || path.join(certDir, 'key.pem');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return { server: https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, requestListener), secure: true };
  }
  return { server: http.createServer(requestListener), secure: false };
}

init();
const { server, secure } = createServer();

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const scheme = secure ? 'https' : 'http';
    console.log('\nScrap Yard Manager is running');
    console.log(`  This computer:   ${scheme}://localhost:${PORT}`);
    for (const ip of lanAddresses()) console.log(`  On the network:  ${scheme}://${ip}:${PORT}   <- open this on phones and tablets`);
    if (firstRun) {
      console.log('\nFirst start - PINs generated (shown only once, change them in Settings):');
      console.log(`  Weighbridge worker PIN: ${firstRun.workerPin}`);
      console.log(`  Admin PIN:              ${firstRun.adminPin}`);
    }
    console.log(`\nData folder: ${DATA_DIR}\n`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}

module.exports = { server };
