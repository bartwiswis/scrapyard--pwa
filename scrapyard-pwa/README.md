# Scrap Yard Manager (PWA)

Local-network web app for scrap metal intake, processing and dispatch. English UI, touch-first, built for tablets and phones.
No dependencies: you only need **Node.js 18 or newer** (no `npm install`).

## Run it

```bash
node server.js          # or: npm start
```

On the first start the server prints the **worker PIN** and the **admin PIN** (generated randomly, shown only once) and the address to open:

```
On the network:  http://192.168.1.20:3000   <- open this on phones and tablets
```

Phones and tablets must be on the same Wi-Fi as the computer running the server. If a phone cannot connect, allow Node.js / port 3000 in the computer's firewall.
To install it like an app on an iPhone: open the address in Safari, tap Share, then "Add to Home Screen".

Change PINs later in the app (Admin, Settings) or from the command line (works without restarting the server):

```bash
node set-pin.js worker 4821
node set-pin.js admin 654321
```

## Who can do what

| | Weighbridge worker | Admin (owner) |
|---|---|---|
| Material Inventory Intake | yes | yes |
| Stock levels, prices, dashboard, logs | no | yes |
| Process raw material into finished goods | no | yes |
| Material Inventory Output (dispatch), WZ dispatch note | no | yes |
| Settings (prices, company details, PINs) | no | yes |

The rules are enforced **on the server**, not just hidden in the UI: the worker's login cannot call any admin endpoint and never receives prices or stock.
The worker session lasts 12 h of inactivity, the admin session 15 min. Five wrong PINs lock that device out for a minute (then longer).

## How stock works

- **Intake** (accepted loads) adds to *raw material* stock. A load marked **Fail** is logged but not added to stock.
- **Process** moves raw material into a finished product (e.g. Copper Wire -> Copper Granules) and records the loss.
- **Dispatch** removes finished product from stock and cannot exceed what is in stock. Dispatch docket numbers (`WZ/2026/0001`) are suggested automatically and must be unique.
- Prices are per kg and snapshotted on every record, so changing a price later does not rewrite history.

## Project layout

```
server.js            HTTP server + API + role checks (no dependencies)
catalog.js           the material and product lists (edit here to add/rename tiles)
pins.js, set-pin.js  PIN hashing (scrypt) and the command-line PIN tool
public/              the PWA: index.html, app.js, style.css, sw.js, manifest, icons
test/api.test.js     API tests, run with: npm test
data/                created on first run (see below)
```

## Your data

Everything is in the `data/` folder: `events.jsonl` (every intake, processing and dispatch record, one per line, append-only),
`settings.json` (prices, company details), `config.json` (hashed PINs) and `backups/` (a copy of `events.jsonl` at most once per hour, one file per day, last 60 days).
**Copy the `data/` folder to another drive or computer regularly.** Backups in the same folder do not protect you from a dead disk.

For this volume (thousands of records a year) a plain file is fast and simple. If you later want SQLite or PostgreSQL, only the storage functions at the top of `server.js` need to change.

## HTTPS (needed for offline mode on iPhones)

Browsers only run service workers on HTTPS (or localhost). Over plain `http://` on the Wi-Fi the app works fully, but it will not be cached for offline start-up.
To enable HTTPS, create a certificate for the server's address (for example with [mkcert](https://github.com/FiloSottile/mkcert), then install its root certificate on the phones), put the files in `certs/cert.pem` and `certs/key.pem`, and restart. The server switches to HTTPS automatically.

## Known limits

- The weight is typed in by hand. A browser cannot read a scale directly; if your scale has a network or serial output, it can be connected through the server later.
- If Wi-Fi drops, the app tells the user and keeps the form filled in; resubmitting is safe (duplicates are ignored). There is no offline queue.
- Records cannot be edited or deleted from the app. A mistake is fixed by an offsetting entry.
