#!/usr/bin/env node
/* Mailbox badge preferences: per-account initials and semantic color role. */
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { readText, readJson, LIMITS } = require(path.join(__dirname, 'mailbox-bounded-read.js'));
const { spawnSync } = require('child_process');

const file = path.join(os.homedir(), '.config', 'omarchy', 'mailbox.json');
const colors = new Set(['accent', 'urgent', 'foreground', 'muted', 'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'brown']);

// Every writer must reread the settings under the same lock. An atomic rename
// protects readers, but without serialization concurrent writers lose updates.
if (process.argv[2] !== 'get' && process.env.MAILBOX_SETTINGS_LOCKED !== '1') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const result = spawnSync('flock', ['-x', '-w', '10', `${file}.lock`, process.execPath, __filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
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

const [command, email, badge, color] = process.argv.slice(2);
const data = read();
data.accounts = data.accounts && typeof data.accounts === 'object' ? data.accounts : {};
data.maxMessagesPerAccount = Math.max(1, Math.min(Number(data.maxMessagesPerAccount || 50), 200));
data.shortcutKey = /^[A-Z]$/.test(String(data.shortcutKey || '').toUpperCase()) ? String(data.shortcutKey).toUpperCase() : 'Q';
data.downloadBodies = data.downloadBodies !== false;
data.bridgeBrowserTarget = ['chrome', 'brave', 'chromium'].includes(data.bridgeBrowserTarget) ? data.bridgeBrowserTarget : '';
if (command === 'set') {
  if (!email || !initials(badge) || !colors.has(color)) process.exit(2);
  data.accounts[email] = { initials: initials(badge), color };
  write(data);
} else if (command === 'mark-local-read') {
  data.localReadAt = Date.now();
  write(data);
} else if (command === 'set-limit') {
  const limit = Math.max(1, Math.min(Number(email), 200));
  if (!Number.isInteger(limit)) process.exit(2);
  data.maxMessagesPerAccount = limit;
  write(data);
} else if (command === 'set-shortcut') {
  const key = String(email || '').trim().toUpperCase();
  if (!/^[A-Z]$/.test(key)) process.exit(2);
  data.shortcutKey = key;
  write(data);
} else if (command === 'set-browser') {
  if (!['chrome', 'brave', 'chromium'].includes(email)) process.exit(2);
  data.bridgeBrowserTarget = email;
  write(data);
} else if (command === 'set-download-bodies') {
  if (email !== 'true' && email !== 'false') process.exit(2);
  data.downloadBodies = email === 'true';
  write(data);
  if (!data.downloadBodies) purgeBodies();
} else if (command === 'clear-bodies') {
  purgeBodies();
}
console.log(JSON.stringify(data));
