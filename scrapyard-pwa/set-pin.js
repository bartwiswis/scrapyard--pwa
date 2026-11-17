'use strict';

// Usage: node set-pin.js worker 1234
//        node set-pin.js admin 654321
// Takes effect immediately, no server restart needed.

const path = require('node:path');
const pins = require('./pins');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const [role, pin] = process.argv.slice(2);

if (!['worker', 'admin'].includes(role) || !pin) {
  console.error('Usage: node set-pin.js <worker|admin> <PIN, 4-8 digits>');
  process.exit(1);
}
if (!pins.PIN_RE.test(pin)) {
  console.error('The PIN must be 4 to 8 digits.');
  process.exit(1);
}

const { config } = pins.loadConfig(DATA_DIR);
const other = role === 'admin' ? 'worker' : 'admin';
if (pins.verifyPin(pin, config[other])) {
  console.error(`That PIN is already used by the ${other}. Worker and admin PINs must differ.`);
  process.exit(1);
}
config[role] = pins.hashPin(pin);
pins.saveConfig(DATA_DIR, config);
console.log(`The ${role} PIN has been updated.`);
