'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PIN_RE = /^\d{4,8}$/;

function hashPin(pin, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPin(pin, record) {
  if (!record || typeof pin !== 'string' || pin.length > 64) return false;
  const a = crypto.scryptSync(pin, record.salt, 32);
  const b = Buffer.from(record.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function randomPin(digits) {
  return String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');
}

function configFile(dataDir) {
  return path.join(dataDir, 'config.json');
}

function saveConfig(dataDir, config) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = configFile(dataDir);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Reads the PIN config. On the very first run it creates one with random PINs
// (or WORKER_PIN / ADMIN_PIN from the environment) and returns them once in `created`.
function loadConfig(dataDir) {
  const file = configFile(dataDir);
  if (fs.existsSync(file)) {
    return { config: JSON.parse(fs.readFileSync(file, 'utf8')), created: null };
  }
  const workerPin = process.env.WORKER_PIN || randomPin(4);
  let adminPin = process.env.ADMIN_PIN || randomPin(6);
  for (const [name, pin] of [['WORKER_PIN', workerPin], ['ADMIN_PIN', adminPin]]) {
    if (!PIN_RE.test(pin)) throw new Error(`${name} must be 4 to 8 digits`);
  }
  while (adminPin === workerPin) adminPin = randomPin(6);
  const config = { worker: hashPin(workerPin), admin: hashPin(adminPin) };
  saveConfig(dataDir, config);
  return { config, created: { workerPin, adminPin } };
}

module.exports = { PIN_RE, hashPin, verifyPin, loadConfig, saveConfig };
