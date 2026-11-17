'use strict';

// Run with: npm test   (or: node --test)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapyard-test-'));
process.env.WORKER_PIN = '1111';
process.env.ADMIN_PIN = '222222';
const { server } = require('../server');

let base;
test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data };
}

const login = async (pin) => (await call('POST', '/api/login', { body: { pin } })).data;
let worker, admin;

test('login gives the right role for each PIN', async () => {
  worker = await login('1111');
  admin = await login('222222');
  assert.equal(worker.role, 'worker');
  assert.equal(admin.role, 'admin');
});

test('requests without a session are rejected', async () => {
  assert.equal((await call('GET', '/api/catalog')).status, 401);
  assert.equal((await call('POST', '/api/intake', { body: {} })).status, 401);
});

test('worker catalog has materials only, no products or prices', async () => {
  const { status, data } = await call('GET', '/api/catalog', { token: worker.token });
  assert.equal(status, 200);
  assert.equal(data.materials.length, 11);
  assert.equal(data.products, undefined);
  const adminCat = (await call('GET', '/api/catalog', { token: admin.token })).data;
  assert.equal(adminCat.products.length, 10);
});

test('worker is blocked from every admin endpoint', async () => {
  for (const [method, url] of [
    ['GET', '/api/admin/stock'], ['GET', '/api/admin/dashboard'], ['GET', '/api/admin/logs'],
    ['GET', '/api/admin/settings'], ['GET', '/api/admin/next-docket'],
    ['POST', '/api/admin/dispatch'], ['POST', '/api/admin/process'], ['PUT', '/api/admin/settings'], ['POST', '/api/admin/pin'],
  ]) {
    assert.equal((await call(method, url, { token: worker.token, body: {} })).status, 403, `${method} ${url}`);
  }
});

test('intake: validation, price snapshot, worker never sees prices', async () => {
  const set = await call('PUT', '/api/admin/settings', {
    token: admin.token,
    body: { currency: '£', prices: { materials: { 'copper-wire': 5.5 }, products: { 'copper-granules': 7 } } },
  });
  assert.equal(set.status, 200);

  const bad = [
    { materialId: 'copper-wire', weightKg: 10, inspection: 'Pass' },                                   // no supplier
    { supplier: 'A', materialId: 'nope', weightKg: 10, inspection: 'Pass' },                          // bad material
    { supplier: 'A', materialId: 'copper-wire', weightKg: 0, inspection: 'Pass' },                    // zero weight
    { supplier: 'A', materialId: 'copper-wire', weightKg: 10, inspection: 'Maybe' },                  // bad inspection
    { supplier: 'A', materialId: 'copper-wire', weightKg: 10, inspection: 'Fail' },                   // fail needs a note
  ];
  for (const body of bad) assert.equal((await call('POST', '/api/intake', { token: worker.token, body })).status, 400);

  const ok = await call('POST', '/api/intake', {
    token: worker.token,
    body: { rid: 'rid-intake-0001', supplier: 'Acme Ltd', materialId: 'copper-wire', weightKg: '120,5', inspection: 'Pass', notes: 'clean' },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.entry.weightKg, 120.5);
  assert.match(ok.data.entry.batchId, /^B-\d{8}-001$/);
  assert.equal(ok.data.entry.pricePerKg, undefined);

  const recent = await call('GET', '/api/intake/recent', { token: worker.token });
  assert.equal(JSON.stringify(recent.data).includes('price'), false);

  const logs = (await call('GET', '/api/admin/logs', { token: admin.token })).data;
  assert.equal(logs.intake[0].value, 662.75);
});

test('a retried submit (same request id) is not recorded twice', async () => {
  const body = { rid: 'rid-intake-0001', supplier: 'Acme Ltd', materialId: 'copper-wire', weightKg: 120.5, inspection: 'Pass' };
  const again = await call('POST', '/api/intake', { token: worker.token, body });
  assert.equal(again.data.duplicate, true);
  const logs = (await call('GET', '/api/admin/logs', { token: admin.token })).data;
  assert.equal(logs.intake.length, 1);
});

test('failed inspections are logged but not added to stock', async () => {
  const r = await call('POST', '/api/intake', {
    token: worker.token,
    body: { supplier: 'Dodgy Co', materialId: 'brass', weightKg: 50, inspection: 'Fail', notes: 'contaminated' },
  });
  assert.equal(r.status, 201);
  const stock = (await call('GET', '/api/admin/stock', { token: admin.token })).data;
  assert.equal(stock.materials.find((m) => m.id === 'brass').kg, 0);
  assert.equal(stock.materials.find((m) => m.id === 'copper-wire').kg, 120.5);
});

test('processing converts raw stock into finished stock and checks limits', async () => {
  const p = (body) => call('POST', '/api/admin/process', { token: admin.token, body });
  assert.equal((await p({ materialId: 'copper-wire', inputKg: 500, productId: 'copper-granules', outputKg: 400 })).status, 409); // more than in stock
  assert.equal((await p({ materialId: 'copper-wire', inputKg: 100, productId: 'copper-granules', outputKg: 110 })).status, 400); // output > input
  assert.equal((await p({ materialId: 'copper-wire', inputKg: 100, productId: 'copper-granules', outputKg: 95 })).status, 201);
  const stock = (await call('GET', '/api/admin/stock', { token: admin.token })).data;
  assert.equal(stock.materials.find((m) => m.id === 'copper-wire').kg, 20.5);
  assert.equal(stock.products.find((x) => x.id === 'copper-granules').kg, 95);
});

test('dispatch removes stock, numbers dockets and refuses overselling', async () => {
  const d = (body) => call('POST', '/api/admin/dispatch', { token: admin.token, body });
  const docket = (await call('GET', '/api/admin/next-docket', { token: admin.token })).data.docketNo;
  assert.match(docket, /^WZ\/\d{4}\/0001$/);

  assert.equal((await d({ buyer: 'Smelter Ltd', productId: 'copper-granules', weightKg: 96 })).status, 409);
  assert.equal((await d({ productId: 'copper-granules', weightKg: 10 })).status, 400);

  const ok = await d({ buyer: 'Smelter Ltd', productId: 'copper-granules', weightKg: 40, destination: 'Sheffield' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.entry.docketNo, docket);
  assert.equal(ok.data.entry.value, 280);

  assert.equal((await d({ buyer: 'X', productId: 'copper-granules', weightKg: 5, docketNo: docket })).status, 409); // duplicate docket
  const stock = (await call('GET', '/api/admin/stock', { token: admin.token })).data;
  assert.equal(stock.products.find((x) => x.id === 'copper-granules').kg, 55);
});

test('dashboard totals match the records', async () => {
  const dash = (await call('GET', '/api/admin/dashboard', { token: admin.token })).data;
  assert.equal(dash.days.length, 7);
  assert.equal(dash.today.intakeKg, 120.5);
  assert.equal(dash.today.dispatchKg, 40);
  assert.equal(dash.today.rejected, 1);
  assert.equal(dash.totals.productKg, 55);
});

test('PIN change: needs the admin PIN, logs workers out, keeps PINs distinct', async () => {
  const change = (body) => call('POST', '/api/admin/pin', { token: admin.token, body });
  assert.equal((await change({ role: 'worker', newPin: '3333', adminPin: '999999' })).status, 403);
  assert.equal((await change({ role: 'worker', newPin: '222222', adminPin: '222222' })).status, 400); // same as admin
  assert.equal((await change({ role: 'worker', newPin: 'abcd', adminPin: '222222' })).status, 400);
  assert.equal((await change({ role: 'worker', newPin: '3333', adminPin: '222222' })).status, 200);
  assert.equal((await call('GET', '/api/session', { token: worker.token })).status, 401); // old worker session gone
  assert.equal((await login('1111')).error, 'Wrong PIN');
  worker = await login('3333');
  assert.equal(worker.role, 'worker');
});

test('static files are served, path traversal is not', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Scrap Yard Manager/);
  assert.equal((await fetch(`${base}/manifest.webmanifest`)).status, 200);
  assert.equal((await fetch(`${base}/%2e%2e/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/..%2fconfig.json`)).status, 404);
});

test('every accepted record is appended to events.jsonl (and nothing else)', () => {
  const lines = fs.readFileSync(path.join(process.env.DATA_DIR, 'events.jsonl'), 'utf8').trim().split('\n');
  // 2 intakes (one passed, one failed inspection), 1 processing, 1 dispatch; rejected and duplicate requests leave no trace
  assert.deepEqual(lines.map((l) => JSON.parse(l).type), ['intake', 'intake', 'processing', 'dispatch']);
});

test('repeated wrong PINs lock the address out (runs last)', async () => {
  let last;
  for (let i = 0; i < 5; i++) last = await call('POST', '/api/login', { body: { pin: '0000' } });
  assert.equal(last.status, 401);
  const locked = await call('POST', '/api/login', { body: { pin: '3333' } });
  assert.equal(locked.status, 429);
});
