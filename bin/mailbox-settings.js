#!/usr/bin/env node
/* Mailbox badge preferences: per-account initials and semantic color role. */
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { readText, readJson, readStdinJson, LIMITS } = require(path.join(__dirname, 'mailbox-bounded-read.js'));
const { spawnSync } = require('child_process');
const { removedAccounts } = require('./mailbox-accounts.js');

const file = path.join(os.homedir(), '.config', 'omarchy', 'mailbox.json');
const colors = new Set(['accent', 'urgent', 'foreground', 'muted', 'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'brown']);

// Every writer must reread the settings under the same lock. An atomic rename
// protects readers, but without serialization concurrent writers lose updates.
// A stdin request is read before taking the lock, so a slow writer never holds it.
async function runLocked() {
  const input = ['set', 'remove-account'].includes(process.argv[2]) ? JSON.stringify(await readStdinJson(LIMITS.small)) + '\n' : undefined;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const result = spawnSync('flock', ['-x', '-w', '10', `${file}.lock`, process.execPath, __filename, ...process.argv.slice(2)], {
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
    env: { ...process.env, MAILBOX_SETTINGS_LOCKED: '1' }
  });
  if (result.error) console.error(`Mailbox settings lock failed: ${result.error.message}`);
  process.exit(result.status === null ? 1 : result.status);
}

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
function read() {
  try {
    const value = readJson(file, LIMITS.settings);
    return value && typeof value === 'object' ? value : { accounts: {} };
  } catch (_) {
    return { accounts: {} };
  }
}
function write(value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}
function purgeBodies() {
  const bridge = path.join(os.homedir(), '.cache', 'omarchy', 'mailbox', 'bridge.json');
  try {
    const data = readJson(bridge, LIMITS.cache);
    for (const account of Object.values(data.accounts || {})) {
      const messages = Array.isArray(account.emails) ? account.emails : (Array.isArray(account.messages) ? account.messages : []);
      for (const message of messages) { delete message.body; delete message.bodyState; }
    }
    atomicWrite(bridge, JSON.stringify(data));
  } catch (_) {}
}
function initials(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
}
function purgeRemovedAccounts(removed) {
  const root = path.join(os.homedir(), '.cache', 'omarchy', 'mailbox');
  for (const name of ['bridge.json', 'inbox.json']) {
    const target = path.join(root, name);
    let data;
    try { data = readJson(target, LIMITS.cache); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (Array.isArray(data.accounts)) data.accounts = data.accounts.filter(account => !removed.has(account.email));
    else data.accounts = Object.fromEntries(Object.entries(data.accounts || {}).filter(([email]) => !removed.has(email)));
    if (Array.isArray(data.emails)) data.emails = data.emails.filter(email => !removed.has(email.account));
    if (Array.isArray(data.accounts)) data.total = data.accounts.reduce((sum, account) => sum + Number(account.unread || 0), 0);
    atomicWrite(target, JSON.stringify(data));
  }
}

async function main() {
  const [command, value] = process.argv.slice(2);
  const data = read();
  data.accounts = data.accounts && typeof data.accounts === 'object' ? data.accounts : {};
  data.maxMessagesPerAccount = Math.max(1, Math.min(Number(data.maxMessagesPerAccount || 50), 200));
  data.shortcutKey = /^[A-Z]$/.test(String(data.shortcutKey || '').toUpperCase()) ? String(data.shortcutKey).toUpperCase() : 'Q';
  data.downloadBodies = data.downloadBodies !== false;
  data.bridgeBrowserTarget = ['chrome', 'brave', 'chromium'].includes(data.bridgeBrowserTarget) ? data.bridgeBrowserTarget : '';
  data.inboxZero = data.inboxZero === true;
  if (command === 'remove-account') {
    const request = await readStdinJson(LIMITS.small);
    const email = String(request.email || '').trim();
    if (!email || email.length > 320) throw new Error('Invalid account');
    const removed = removedAccounts(data);
    if (!removed.has(email) && removed.size >= 128) throw new Error('Removed account limit reached');
    removed.add(email);
    data.removedAccounts = [...removed];
    write(data); // Persist exclusion first, including when a concurrent capture is in flight.
    purgeRemovedAccounts(removed);
  } else if (command === 'restore-accounts') {
    data.removedAccounts = [];
    write(data);
  } else if (command === 'set') {
    // The account address arrives on stdin so it never shows in process arguments.
    const request = await readStdinJson(LIMITS.small);
    const email = String(request.email || '').trim().slice(0, 320);
    const color = String(request.color || '');
    if (!email || !initials(request.initials) || !colors.has(color)) process.exit(2);
    data.accounts[email] = { initials: initials(request.initials), color };
    write(data);
  } else if (command === 'mark-local-read') {
    data.localReadAt = Date.now();
    write(data);
  } else if (command === 'set-limit') {
    const limit = Math.max(1, Math.min(Number(value), 200));
    if (!Number.isInteger(limit)) process.exit(2);
    data.maxMessagesPerAccount = limit;
    write(data);
  } else if (command === 'set-shortcut') {
    const key = String(value || '').trim().toUpperCase();
    if (!/^[A-Z]$/.test(key)) process.exit(2);
    data.shortcutKey = key;
    write(data);
  } else if (command === 'set-browser') {
    if (!['chrome', 'brave', 'chromium'].includes(value)) process.exit(2);
    data.bridgeBrowserTarget = value;
    write(data);
  } else if (command === 'set-download-bodies') {
    if (value !== 'true' && value !== 'false') process.exit(2);
    data.downloadBodies = value === 'true';
    write(data);
    if (!data.downloadBodies) purgeBodies();
  } else if (command === 'set-inbox-zero') {
    if (value !== 'true' && value !== 'false') process.exit(2);
    data.inboxZero = value === 'true';
    write(data);
  } else if (command === 'clear-bodies') {
    purgeBodies();
  }
  console.log(JSON.stringify(data));
}

const run = process.argv[2] !== 'get' && process.env.MAILBOX_SETTINGS_LOCKED !== '1' ? runLocked : main;
run().catch(error => { console.error(error.message); process.exit(1); });
