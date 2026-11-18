'use strict';

(() => {
  const $app = document.getElementById('app');
  const state = { token: null, role: null, view: null };
  let currency = '';
  let viewToken = 0;
  let loginKeyHandler = null;

  // ------------------------------------------------------------ helpers

  // Builds DOM nodes with textContent only (never innerHTML), so user-entered text can't inject markup.
  const h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };

  const svg = (tag, attrs, ...kids) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const kid of kids.flat(Infinity)) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };

  const nf = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
  const kg = (n) => `${nf.format(n)} kg`;
  const dt = (iso) => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const num = (v) => Number(String(v).trim().replace(',', '.'));
  const money = (v) => (v == null ? '—' : `${currency}${currency ? ' ' : ''}${v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const uid = () => {
    const a = new Uint8Array(12);
    crypto.getRandomValues(a); // works on plain http, unlike crypto.randomUUID()
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };

  let toastTimer;
  function toast(msg, kind = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, 3500);
  }

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'Cannot reach the server. Check the Wi-Fi connection and try again.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (res.status === 401 && state.token) {
      logout('Session expired. Please enter your PIN again.');
      throw new ApiError(401, 'Session expired');
    }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  const field = (label, input, hint) =>
    h('label', { class: 'field' }, h('span', { class: 'label' }, label), input, hint && h('span', { class: 'hint' }, hint));

  const withUnit = (input, unit = 'kg') => h('div', { class: 'input-unit' }, input, h('span', { class: 'unit' }, unit));

  function table(headers, rows, numericCols = []) {
    if (!rows.length) return h('div', { class: 'table-wrap' }, h('p', { class: 'empty-note' }, 'No entries yet.'));
    return h('div', { class: 'table-wrap' },
      h('table', { class: 'data' },
        h('thead', null, h('tr', null, headers.map((t, i) => h('th', { class: numericCols.includes(i) ? 'num' : '' }, t)))),
        h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: numericCols.includes(i) ? 'num' : '' }, c)))))));
  }

  function confirmDialog({ title, lines, confirmText }) {
    return new Promise((resolve) => {
      const done = (v) => { wrap.remove(); resolve(v); };
      const wrap = h('div', { class: 'modal-wrap' },
        h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('h2', null, title),
          h('ul', null, lines.map((l) => h('li', null, l))),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'Cancel'),
            h('button', { class: 'btn primary', type: 'button', onclick: () => done(true) }, confirmText))));
      document.body.append(wrap);
    });
  }

  // ------------------------------------------------------------ login

  function showLogin(message) {
    state.token = null;
    state.role = null;
    ls.del('sy_token');
    document.body.classList.remove('printing-wz');
    document.querySelectorAll('.modal-wrap, .sheet-wrap').forEach((n) => n.remove());
    if (loginKeyHandler) document.removeEventListener('keydown', loginKeyHandler);

    let pin = '';
    let busy = false;
    const dots = h('div', { class: 'pin-dots', 'aria-label': 'PIN entry' });
    const msg = h('p', { class: 'login-msg', role: 'alert' }, message || '');
    const paint = () => dots.replaceChildren(...Array.from({ length: Math.max(4, pin.length) }, (_, i) => h('span', { class: `dot${i < pin.length ? ' on' : ''}` })));
    const press = (d) => { if (pin.length < 8) { pin += d; msg.textContent = ''; paint(); } };
    const back = () => { pin = pin.slice(0, -1); paint(); };
    const submit = () => {
      if (pin === '1234') {
        state.token = 'offline-token';
        ls.set('sy_token', 'offline-token');
        renderShell();
    } else {
        showLogin('Błędny PIN');
    }
       
    };
    loginKeyHandler = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') back();
      else if (e.key === 'Enter') submit();
    };
    document.addEventListener('keydown', loginKeyHandler);

    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => h('button', { class: 'key', type: 'button', onclick: () => press(d) }, d));
    keys.push(
      h('button', { class: 'key del', type: 'button', 'aria-label': 'Delete', onclick: back }, '⌫'),
      h('button', { class: 'key', type: 'button', onclick: () => press('0') }, '0'),
      h('button', { class: 'key ok', type: 'button', onclick: submit }, 'OK'));

    $app.className = '';
    $app.replaceChildren(h('div', { class: 'login' },
      h('img', { src: 'icons/icon-192.png', alt: '', width: 84, height: 84 }),
      h('h1', null, 'Scrap Yard Manager'),
      h('p', { class: 'muted' }, 'Enter your PIN'),
      dots, msg,
      h('div', { class: 'keypad' }, keys)));
    paint();
  }

  function logout(message) {
    const t = state.token;
    if (t && !message) fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${t}` } }).catch(() => {});
    showLogin(message);
  }

  // ------------------------------------------------------------ shell & routing

  const ADMIN_TABS = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'intake', label: 'Intake' },
    { id: 'process', label: 'Process' },
    { id: 'dispatch', label: 'Dispatch' },
    { id: 'logs', label: 'Logs' },
    { id: 'settings', label: 'Settings' },
  ];

  function start() {
    state.view = state.role === 'admin' ? 'dashboard' : 'intake';
    renderShell();
  }

  function renderShell() {
    const admin = state.role === 'admin';
    $app.className = admin ? 'has-nav' : '';
    const top = h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, h('img', { src: 'icons/icon-192.png', alt: '', width: 28, height: 28 }), h('span', null, 'Scrap Yard')),
      h('span', { class: 'chip' }, admin ? 'Admin' : 'Weighbridge'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => logout() }, 'Log out'));
    const nav = admin && h('nav', { class: 'bottomnav' },
      ADMIN_TABS.map((t) => h('button', { class: `navbtn${t.id === state.view ? ' active' : ''}`, type: 'button', 'data-view': t.id, onclick: () => go(t.id) }, t.label)));
    $app.replaceChildren(...[top, h('main', { class: 'main', id: 'main' }), nav].filter(Boolean));
    loadView();
  }

  function go(view) {
    state.view = view;
    document.querySelectorAll('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    loadView();
  }

  const VIEWS = {
    dashboard: dashboardView,
    intake: intakeView,
    process: processView,
    dispatch: dispatchView,
    logs: logsView,
    settings: settingsView,
  };

  async function loadView() {
    const main = document.getElementById('main');
    const mine = ++viewToken;
    main.replaceChildren(h('p', { class: 'muted center' }, 'Loading…'));
    try {
      const node = await VIEWS[state.view]();
      if (mine !== viewToken) return;
      main.replaceChildren(node);
      window.scrollTo(0, 0);
    } catch (e) {
      if (e.status === 401 || mine !== viewToken) return;
      main.replaceChildren(h('div', { class: 'card error-card stack' },
        h('p', null, e.message),
        h('button', { class: 'btn', type: 'button', onclick: loadView }, 'Try again')));
    }
  }

  // ------------------------------------------------------------ Module A: intake

  async function intakeView() {
    const [cat, recent] = await Promise.all([api('/catalog'), api('/intake/recent')]);
    const root = h('div', { class: 'stack' });
    let recentList = recent.entries;

    const recentTable = () => h('div', null,
      h('h2', { class: 'section-title' }, 'Today’s latest intake'),
      table(['Time', 'Supplier', 'Material', 'Weight', 'Inspection'],
        recentList.map((e) => [dt(e.ts).slice(-5), e.supplier, e.material, kg(e.weightKg), h('span', { class: `badge ${e.inspection.toLowerCase()}` }, e.inspection)]), [3]));

    const tiles = () => root.replaceChildren(
      h('div', null, h('h1', null, 'Material Inventory Intake'), h('p', { class: 'muted' }, 'Tap the material being delivered.')),
      h('div', { class: 'tiles' }, cat.materials.map((m) =>
        h('button', { class: 'tile', type: 'button', style: { '--c': m.color }, onclick: () => formScreen(m) }, h('span', null, m.name)))),
      recentTable());

    const formScreen = (m) => {
      root.replaceChildren(intakeForm(m, cat, {
        onBack: tiles,
        onDone: async (entry) => {
          try { recentList = (await api('/intake/recent')).entries; } catch { /* keep old list */ }
          successScreen(entry);
        },
      }));
      window.scrollTo(0, 0);
    };

    const successScreen = (e) => {
      root.replaceChildren(h('div', { class: 'card success' },
        h('div', { class: 'big-check', 'aria-hidden': 'true' }, '✓'),
        h('h2', null, 'Intake recorded'),
        h('table', { class: 'kv' },
          h('tbody', null,
            [['Supplier', e.supplier], ['Material', e.material], ['Weight', kg(e.weightKg)], ['Inspection', e.inspection], ['Batch ID', e.batchId]]
              .map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v))))),
        h('button', { class: 'btn primary big', type: 'button', onclick: tiles }, 'New intake')));
      window.scrollTo(0, 0);
    };

    tiles();
    return root;
  }

  function intakeForm(material, cat, { onBack, onDone }) {
    const rid = uid(); // lets the server ignore an accidental double submit
    let inspection = 'Pass';

    const supplier = h('input', { type: 'text', maxLength: 100, autocomplete: 'off', autocapitalize: 'words', list: 'suppliers' });
    const datalist = h('datalist', { id: 'suppliers' }, cat.suppliers.map((n) => h('option', { value: n })));
    const weightInput = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.0' });
    const batch = h('input', { type: 'text', maxLength: 40, autocomplete: 'off' });
    const notes = h('textarea', { rows: 3, maxLength: 500 });
    const err = h('p', { class: 'form-error', role: 'alert' });

    api('/next-batch').then((r) => { if (!batch.value) batch.value = r.batchId; }).catch(() => {});

    const passBtn = h('button', { type: 'button', class: 'seg pass active', 'aria-pressed': 'true', onclick: () => setInspection('Pass') }, 'Pass');
    const failBtn = h('button', { type: 'button', class: 'seg fail', 'aria-pressed': 'false', onclick: () => setInspection('Fail') }, 'Fail');
    function setInspection(v) {
      inspection = v;
      passBtn.classList.toggle('active', v === 'Pass');
      failBtn.classList.toggle('active', v === 'Fail');
      passBtn.setAttribute('aria-pressed', String(v === 'Pass'));
      failBtn.setAttribute('aria-pressed', String(v === 'Fail'));
    }

    const submitBtn = h('button', { type: 'submit', class: 'btn primary big' }, 'Submit Inventory Intake');
    const problem = (text, el) => { err.textContent = text; el.focus(); };

    const form = h('form', {
      class: 'card form',
      novalidate: true,
      onsubmit: async (ev) => {
        ev.preventDefault();
        err.textContent = '';
        const w = num(weightInput.value);
        if (!supplier.value.trim()) return problem('Enter the supplier name.', supplier);
        if (!(w > 0)) return problem('Enter the weight in kg.', weightInput);
        if (inspection === 'Fail' && !notes.value.trim()) return problem('Add a note explaining why the load failed.', notes);
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting…';
        try {
          const r = await api('/intake', { method: 'POST', body: { rid, supplier: supplier.value, materialId: material.id, weightKg: w, inspection, batchId: batch.value, notes: notes.value } });
          onDone(r.entry);
        } catch (e) {
          err.textContent = e.message;
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit Inventory Intake';
        }
      },
    },
      h('h2', null, 'Material Inventory Intake'),
      field('Supplier Name', supplier),
      datalist,
      field('Material Type', h('input', { type: 'text', readOnly: true, value: material.name, tabIndex: -1 })),
      field('Weight (kg)', withUnit(weightInput), 'Type the weight shown on the scale.'),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Inspection Status'), h('div', { class: 'segs', role: 'group', 'aria-label': 'Inspection Status' }, passBtn, failBtn)),
      field('Batch ID', batch),
      field('Notes', notes),
      err,
      submitBtn);

    return h('div', { class: 'stack' },
      h('button', { class: 'btn small back', type: 'button', onclick: onBack }, '← Back to materials'),
      h('div', { class: 'tile', style: { '--c': material.color, 'min-height': '0' } }, h('span', null, material.name)),
      form);
  }

  // ------------------------------------------------------------ Processing (raw -> finished)

  async function processView() {
    const [stock, cat] = await Promise.all([api('/admin/stock'), api('/catalog')]);
    const available = stock.materials.filter((m) => m.kg > 0);
    const head = h('div', null, h('h1', null, 'Process Material'),
      h('p', { class: 'muted' }, 'Turn raw material from the yard into finished product that can be dispatched.'));
    if (!available.length) {
      return h('div', { class: 'stack' }, head, h('div', { class: 'card' }, h('p', { class: 'muted' }, 'There is no raw material in stock. Record an intake first.')));
    }

    const rid = uid();
    const rawSel = h('select', null, available.map((m) => h('option', { value: m.id }, `${m.name} — ${kg(m.kg)} in stock`)));
    const prodSel = h('select', null, cat.products.map((p) => h('option', { value: p.id }, p.name)));
    const inInput = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.0' });
    const outInput = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.0' });
    const notes = h('textarea', { rows: 2, maxLength: 500 });
    const loss = h('p', { class: 'hint' }, '');
    const err = h('p', { class: 'form-error', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn primary big' }, 'Record Processing');
    const stockOf = () => (stock.materials.find((m) => m.id === rawSel.value) || { kg: 0 }).kg;

    const syncProduct = () => { prodSel.value = cat.defaultProduct[rawSel.value] || prodSel.value; };
    const syncLoss = () => {
      const i = num(inInput.value);
      const o = num(outInput.value);
      loss.textContent = i > 0 && o >= 0 && outInput.value.trim() ? `Loss: ${kg(Math.max(0, i - o))} (${nf.format(Math.max(0, ((i - o) / i) * 100))}%)` : '';
    };
    rawSel.addEventListener('change', syncProduct);
    inInput.addEventListener('input', syncLoss);
    outInput.addEventListener('input', syncLoss);
    syncProduct();

    const form = h('form', {
      class: 'card form',
      novalidate: true,
      onsubmit: async (ev) => {
        ev.preventDefault();
        err.textContent = '';
        const i = num(inInput.value);
        const o = num(outInput.value);
        if (!(i > 0)) return (err.textContent = 'Enter the input weight.');
        if (i > stockOf() + 1e-6) return (err.textContent = `Only ${kg(stockOf())} of this material is in stock.`);
        if (!(o > 0)) return (err.textContent = 'Enter the output weight.');
        if (o > i) return (err.textContent = 'Output weight cannot be higher than the input weight.');
        submit.disabled = true;
        submit.textContent = 'Saving…';
        try {
          await api('/admin/process', { method: 'POST', body: { rid, materialId: rawSel.value, inputKg: i, productId: prodSel.value, outputKg: o, notes: notes.value } });
          toast('Processing recorded', 'good');
          loadView();
        } catch (e) {
          err.textContent = e.message;
          submit.disabled = false;
          submit.textContent = 'Record Processing';
        }
      },
    },
      field('Raw Material', rawSel),
      field('Input Weight (kg)', withUnit(inInput)),
      h('button', { class: 'btn small back', type: 'button', onclick: () => { inInput.value = String(stockOf()); syncLoss(); } }, 'Use all stock'),
      field('Output Product', prodSel),
      field('Output Weight (kg)', withUnit(outInput)),
      loss,
      field('Notes', notes),
      err,
      submit);
    return h('div', { class: 'stack' }, head, form);
  }

  // ------------------------------------------------------------ Module B: dispatch

  async function dispatchView() {
    const [stock, cat] = await Promise.all([api('/admin/stock'), api('/catalog')]);
    const root = h('div', { class: 'stack' });
    let stockMap = Object.fromEntries(stock.products.map((p) => [p.id, p.kg]));

    const tiles = () => root.replaceChildren(
      h('div', null, h('h1', null, 'Material Inventory Output'), h('p', { class: 'muted' }, 'Tap the finished product leaving the yard.')),
      h('div', { class: 'tiles' }, cat.products.map((p) => {
        const q = stockMap[p.id] || 0;
        return h('button', { class: 'tile', type: 'button', style: { '--c': p.color }, disabled: q <= 0, onclick: () => formScreen(p) },
          h('span', null, p.name), h('span', { class: 'tile-sub' }, q > 0 ? `${kg(q)} in stock` : 'No stock'));
      })));

    const refresh = async () => {
      try { stockMap = Object.fromEntries((await api('/admin/stock')).products.map((p) => [p.id, p.kg])); } catch { /* keep old */ }
    };

    const formScreen = async (p) => {
      let docket = '';
      try { docket = (await api('/admin/next-docket')).docketNo; } catch { /* admin can type one */ }
      root.replaceChildren(dispatchForm(p, stockMap[p.id] || 0, docket, {
        onBack: tiles,
        onDone: async (entry) => { await refresh(); successScreen(entry); },
      }));
      window.scrollTo(0, 0);
    };

    const successScreen = (e) => {
      root.replaceChildren(h('div', { class: 'card success' },
        h('div', { class: 'big-check', 'aria-hidden': 'true' }, '✓'),
        h('h2', null, 'Dispatch confirmed'),
        h('table', { class: 'kv' }, h('tbody', null,
          [['Docket No.', e.docketNo], ['Recipient', e.buyer], ['Product', e.product], ['Weight', kg(e.weightKg)], ['Destination', e.destination || '—']]
            .map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v))))),
        h('button', { class: 'btn primary big', type: 'button', onclick: () => showWz(e) }, 'Print dispatch note (WZ)'),
        h('button', { class: 'btn big', type: 'button', onclick: tiles }, 'New dispatch')));
      window.scrollTo(0, 0);
    };

    tiles();
    return root;
  }

  function dispatchForm(product, available, docketNo, { onBack, onDone }) {
    const rid = uid();
    const buyer = h('input', { type: 'text', maxLength: 100, autocomplete: 'off', autocapitalize: 'words' });
    const weightInput = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.0' });
    const docket = h('input', { type: 'text', maxLength: 40, autocomplete: 'off', value: docketNo });
    const destination = h('input', { type: 'text', maxLength: 150, autocomplete: 'off', autocapitalize: 'words' });
    const notes = h('textarea', { rows: 3, maxLength: 500 });
    const err = h('p', { class: 'form-error', role: 'alert' });
    const submitBtn = h('button', { type: 'submit', class: 'btn primary big' }, 'Confirm Inventory Dispatch');

    const form = h('form', {
      class: 'card form',
      novalidate: true,
      onsubmit: async (ev) => {
        ev.preventDefault();
        err.textContent = '';
        const w = num(weightInput.value);
        if (!buyer.value.trim()) return (err.textContent = 'Enter the recipient / buyer.');
        if (!(w > 0)) return (err.textContent = 'Enter the weight in kg.');
        if (w > available + 1e-6) return (err.textContent = `Only ${kg(available)} of ${product.name} is in stock.`);
        const ok = await confirmDialog({
          title: 'Confirm dispatch',
          lines: [`${kg(w)} of ${product.name}`, `To: ${buyer.value.trim()}`, `Docket: ${docket.value.trim() || '(automatic)'}`, 'This removes the goods from stock.'],
          confirmText: 'Dispatch now',
        });
        if (!ok) return;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving…';
        try {
          const r = await api('/admin/dispatch', { method: 'POST', body: { rid, buyer: buyer.value, productId: product.id, weightKg: w, docketNo: docket.value, destination: destination.value, notes: notes.value } });
          onDone(r.entry);
        } catch (e) {
          err.textContent = e.message;
          submitBtn.disabled = false;
          submitBtn.textContent = 'Confirm Inventory Dispatch';
        }
      },
    },
      h('h2', null, 'Material Inventory Output'),
      field('Recipient/Buyer', buyer),
      field('Product Type', h('input', { type: 'text', readOnly: true, value: product.name, tabIndex: -1 })),
      field('Weight (kg)', withUnit(weightInput), `Available: ${kg(available)}`),
      h('button', { class: 'btn small back', type: 'button', onclick: () => { weightInput.value = String(available); } }, 'Dispatch all available'),
      field('Dispatch Docket No.', docket),
      field('Destination', destination),
      field('Notes', notes),
      err,
      submitBtn);

    return h('div', { class: 'stack' },
      h('button', { class: 'btn small back', type: 'button', onclick: onBack }, '← Back to products'),
      h('div', { class: 'tile', style: { '--c': product.color, 'min-height': '0' } }, h('span', null, product.name)),
      form);
  }

  async function showWz(d) {
    let company = { name: '', address: '' };
    try { company = (await api('/admin/settings')).company; } catch { /* print without header */ }
    const close = () => { wrap.remove(); document.body.classList.remove('printing-wz'); };
    const row = (k, v) => h('tr', null, h('th', null, k), h('td', null, v || '—'));
    const wrap = h('div', { class: 'sheet-wrap' },
      h('div', { class: 'sheet-actions no-print' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => window.print() }, 'Print / Save as PDF'),
        h('button', { class: 'btn', type: 'button', onclick: close }, 'Close')),
      h('article', { class: 'wz' },
        h('div', { class: 'company' }, company.name || 'Scrap Yard'),
        company.address && h('div', { class: 'addr' }, company.address),
        h('h1', null, 'DISPATCH NOTE (WZ)'),
        h('table', null, h('tbody', null,
          row('Docket No.', d.docketNo),
          row('Date / time', new Date(d.ts).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })),
          row('Recipient/Buyer', d.buyer),
          row('Destination', d.destination),
          row('Product', d.product),
          row('Weight', kg(d.weightKg)),
          row('Notes', d.notes))),
        h('div', { class: 'signs' }, h('div', { class: 'sign' }, 'Issued by (name, signature)'), h('div', { class: 'sign' }, 'Received by (name, signature)'))));
    document.body.append(wrap);
    document.body.classList.add('printing-wz');
  }

  // ------------------------------------------------------------ Logs

  async function logsView() {
    const logs = await api('/admin/logs?limit=100');
    currency = logs.currency || '';
    let tab = 'intake';
    const box = h('div');

    const builders = {
      intake: () => table(['Time', 'Supplier', 'Material', 'Weight', 'Inspection', 'Batch ID', `Value`, 'Notes'],
        logs.intake.map((e) => [dt(e.ts), e.supplier, e.material, kg(e.weightKg), h('span', { class: `badge ${e.inspection.toLowerCase()}` }, e.inspection), e.batchId, money(e.value), h('span', { class: 'wrap' }, e.notes || '—')]), [3, 6]),
      dispatch: () => table(['Time', 'Docket No.', 'Recipient', 'Product', 'Weight', 'Destination', 'Value', ''],
        logs.dispatch.map((e) => [dt(e.ts), e.docketNo, e.buyer, e.product, kg(e.weightKg), e.destination || '—', money(e.value),
          h('button', { class: 'btn small', type: 'button', onclick: () => showWz(e) }, 'WZ')]), [4, 6]),
      processing: () => table(['Time', 'Raw material', 'Input', 'Product', 'Output', 'Loss'],
        logs.processing.map((e) => [dt(e.ts), e.material, kg(e.inputKg), e.product, kg(e.outputKg), `${kg(e.lossKg)} (${nf.format((e.lossKg / e.inputKg) * 100)}%)`]), [2, 4, 5]),
    };

    const tabBtns = {};
    const draw = () => {
      for (const [k, b] of Object.entries(tabBtns)) b.classList.toggle('active', k === tab);
      box.replaceChildren(builders[tab]());
    };
    const tabsEl = h('div', { class: 'tabs', role: 'tablist' },
      [['intake', 'Intake'], ['dispatch', 'Dispatch'], ['processing', 'Processing']].map(([k, label]) => {
        tabBtns[k] = h('button', { class: 'btn', type: 'button', onclick: () => { tab = k; draw(); } }, label);
        return tabBtns[k];
      }));
    draw();
    return h('div', null, h('h1', null, 'Logs'), h('p', { class: 'muted' }, 'Latest 100 entries of each type.'), tabsEl, box);
  }

  // ------------------------------------------------------------ Dashboard

  function niceMax(v) {
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }

  function barChart(days) {
    const W = 640, H = 280, m = { l: 58, r: 8, t: 14, b: 38 };
    const max = niceMax(Math.max(1, ...days.flatMap((d) => [d.intakeKg, d.dispatchKg])));
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const gw = iw / days.length;
    const bw = Math.min(26, gw / 3);
    const short = (v) => (v >= 1000 ? `${v / 1000}k` : String(v));
    const el = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Intake versus dispatch per day, last ${days.length} days` });
    for (let i = 0; i <= 4; i++) {
      const y = m.t + ih - (i / 4) * ih;
      el.append(svg('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: y, y2: y }), svg('text', { x: m.l - 8, y: y + 6, 'text-anchor': 'end' }, short((max * i) / 4)));
    }
    days.forEach((d, i) => {
      const cx = m.l + gw * (i + 0.5);
      const bar = (cls, x, v, label) => {
        const hh = (v / max) * ih;
        el.append(svg('rect', { class: cls, x, y: m.t + ih - hh, width: bw, height: Math.max(hh, v > 0 ? 1 : 0), rx: 3 }, svg('title', null, `${label}: ${kg(v)}`)));
      };
      const when = new Date(`${d.date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
      bar('bar-in', cx - bw - 1, d.intakeKg, `${when} intake`);
      bar('bar-out', cx + 1, d.dispatchKg, `${when} dispatch`);
      el.append(svg('text', { x: cx, y: H - 12, 'text-anchor': 'middle' }, when));
    });
    return el;
  }

  const statCard = (k, v, s) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), s && h('div', { class: 's' }, s));

  function stockCard(title, items) {
    const max = Math.max(1, ...items.map((i) => i.kg));
    return h('div', { class: 'card' }, h('h2', null, title),
      items.map((i) => h('div', { class: 'stock-row' },
        h('div', { class: 'line' }, h('span', null, i.name), h('b', null, kg(i.kg))),
        h('div', { class: 'meter' }, h('span', { style: { '--w': `${(i.kg / max) * 100}%`, '--c': i.color } })))));
  }

  async function dashboardView() {
    const [d, st] = await Promise.all([api('/admin/dashboard?days=7'), api('/admin/stock')]);
    currency = d.currency || '';
    return h('div', { class: 'stack' },
      h('h1', null, 'Dashboard'),
      h('div', { class: 'stats' },
        statCard('Intake today', kg(d.today.intakeKg), `${d.today.loads} load${d.today.loads === 1 ? '' : 's'}${d.today.rejected ? `, ${d.today.rejected} rejected` : ''}`),
        statCard('Dispatched today', kg(d.today.dispatchKg)),
        statCard('Raw material in yard', kg(d.totals.rawKg)),
        statCard('Finished goods', kg(d.totals.productKg))),
      h('div', { class: 'card' }, h('h2', null, 'Intake vs dispatch — last 7 days'), barChart(d.days),
        h('div', { class: 'legend' }, h('span', null, h('i', { class: 'in' }), 'Intake (accepted)'), h('span', null, h('i', { class: 'out' }), 'Dispatch'))),
      h('div', { class: 'two-col' }, stockCard('Raw material in stock', st.materials), stockCard('Finished goods in stock', st.products)));
  }

  // ------------------------------------------------------------ Settings

  async function settingsView() {
    const [st, cat] = await Promise.all([api('/admin/settings'), api('/catalog')]);
    currency = st.currency || '';
    const priceInputs = {};
    const priceRows = (group, items) => items.map((it) => {
      const input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '—', value: st.prices[group][it.id] ?? '' });
      priceInputs[`${group}:${it.id}`] = input;
      return h('label', { class: 'price-row' }, h('span', null, it.name), input);
    });
    const company = h('input', { type: 'text', maxLength: 100, value: st.company.name });
    const address = h('textarea', { rows: 3, maxLength: 300, value: st.company.address });
    const cur = h('input', { type: 'text', maxLength: 8, value: st.currency, placeholder: 'e.g. £, €, PLN' });
    const saveErr = h('p', { class: 'form-error', role: 'alert' });

    const saveForm = h('form', {
      class: 'card form',
      novalidate: true,
      onsubmit: async (ev) => {
        ev.preventDefault();
        saveErr.textContent = '';
        const prices = { materials: {}, products: {} };
        for (const [key, input] of Object.entries(priceInputs)) {
          const [group, id] = key.split(':');
          const raw = input.value.trim();
          if (raw === '') { prices[group][id] = null; continue; }
          const n = num(raw);
          if (!Number.isFinite(n) || n < 0) return (saveErr.textContent = 'Prices must be numbers (0 or more).');
          prices[group][id] = n;
        }
        try {
          const saved = await api('/admin/settings', { method: 'PUT', body: { company: { name: company.value, address: address.value }, currency: cur.value, prices } });
          currency = saved.currency || '';
          toast('Settings saved', 'good');
        } catch (e) {
          saveErr.textContent = e.message;
        }
      },
    },
      h('h2', null, 'Company details (printed on the WZ)'),
      field('Company name', company),
      field('Address', address),
      field('Currency symbol', cur),
      h('h2', null, 'Buying prices per kg'),
      h('p', { class: 'hint' }, 'Only the admin sees prices. Each intake keeps the price that was valid when it was recorded.'),
      priceRows('materials', cat.materials),
      h('h2', null, 'Selling prices per kg'),
      priceRows('products', cat.products),
      saveErr,
      h('button', { type: 'submit', class: 'btn primary big' }, 'Save settings'));

    const roleSel = h('select', null, h('option', { value: 'worker' }, 'Weighbridge worker PIN'), h('option', { value: 'admin' }, 'Admin PIN'));
    const newPin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxLength: 8, placeholder: '4–8 digits' });
    const newPin2 = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxLength: 8 });
    const curPin = h('input', { type: 'password', inputmode: 'numeric', autocomplete: 'current-password', maxLength: 8 });
    const pinErr = h('p', { class: 'form-error', role: 'alert' });
    const pinForm = h('form', {
      class: 'card form',
      novalidate: true,
      onsubmit: async (ev) => {
        ev.preventDefault();
        pinErr.textContent = '';
        if (newPin.value !== newPin2.value) return (pinErr.textContent = 'The two new PINs do not match.');
        try {
          await api('/admin/pin', { method: 'POST', body: { role: roleSel.value, newPin: newPin.value, adminPin: curPin.value } });
          newPin.value = newPin2.value = curPin.value = '';
          toast('PIN changed', 'good');
        } catch (e) {
          pinErr.textContent = e.message;
        }
      },
    },
      h('h2', null, 'Change a PIN'),
      field('Which PIN', roleSel),
      field('New PIN', newPin),
      field('Repeat new PIN', newPin2),
      field('Your current admin PIN', curPin),
      pinErr,
      h('button', { type: 'submit', class: 'btn big' }, 'Change PIN'));

    return h('div', { class: 'stack' }, h('h1', null, 'Settings'), saveForm, pinForm);
  }

  // ------------------------------------------------------------ boot

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  const saved = ls.get('sy_token');
  if (!saved) {
    showLogin();
  } else {
    state.token = saved;
    api('/session')
      .then((r) => { state.role = r.role; start(); })
      .catch((e) => { if (e.status !== 401) showLogin(e.message); });
  }
})();
