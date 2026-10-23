#!/usr/bin/env node
// Records an explicit Gmail account selection or a verified Gmail slot map.
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { readText, readJson, LIMITS } = require(path.join(__dirname, 'mailbox-bounded-read.js'));
const cacheDir = path.join(os.homedir(), '.cache', 'omarchy', 'mailbox');
// Replace a user-owned file atomically: random temp name, O_EXCL|O_NOFOLLOW, no symlinked target.
function atomicWrite(file, text, mode = 0o600) {
  let stat = null;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat && (!stat.isFile() || stat.uid !== process.getuid())) throw new Error(`Unsafe file: ${file}`);
  const temp = `${file}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    fs.writeFileSync(fd, text);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }
}
const valid = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
if (process.argv[2] === '--slot') {
  const index = String(process.argv[3] || '');
  const email = String(process.argv[4] || '').trim().toLowerCase();
  if (!/^\d{1,3}$/.test(index) || !valid(email) || email.length > 320) process.exit(2);
  const file = path.join(cacheDir, 'gmail-slot-accounts.json');
  let slots = {}; try { slots = readJson(file, LIMITS.small); } catch (_) {}
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) slots = {};
  slots[index] = email;
  // Gmail exposes one slot per signed-in account; keep the map small and bounded.
  slots = Object.fromEntries(Object.entries(slots).filter(([key]) => /^\d{1,3}$/.test(key)).slice(-32));
  atomicWrite(file, JSON.stringify(slots));
} else {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!valid(email) || email.length > 320) process.exit(2);
  atomicWrite(path.join(cacheDir, 'pending-account.json'), JSON.stringify({ email, requestedAt: Date.now() }));
}
