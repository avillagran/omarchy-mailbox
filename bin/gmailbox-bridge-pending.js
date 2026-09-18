#!/usr/bin/env node
// Records an explicit Gmail account selection or a verified Gmail slot map.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cacheDir = path.join(os.homedir(), '.cache', 'omarchy', 'gmailbox');
const valid = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
if (process.argv[2] === '--slot') {
  const index = String(process.argv[3] || '');
  const email = String(process.argv[4] || '').trim().toLowerCase();
  if (!/^\d+$/.test(index) || !valid(email)) process.exit(2);
  const file = path.join(cacheDir, 'gmail-slot-accounts.json');
  let slots = {}; try { slots = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  slots[index] = email;
  fs.writeFileSync(file, JSON.stringify(slots), { mode: 0o600 });
} else {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!valid(email)) process.exit(2);
  fs.writeFileSync(path.join(cacheDir, 'pending-account.json'), JSON.stringify({ email, requestedAt: Date.now() }), { mode: 0o600 });
}
