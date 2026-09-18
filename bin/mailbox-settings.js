#!/usr/bin/env node
/* Mailbox badge preferences: per-account initials and semantic color role. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const file = path.join(os.homedir(), '.config', 'omarchy', 'mailbox.json');
const colors = new Set(['accent', 'urgent', 'foreground', 'muted', 'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'brown']);

function read() {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : { accounts: {} };
  } catch (_) {
    return { accounts: {} };
  }
}
function write(value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function purgeBodies() {
  const bridge = path.join(os.homedir(), '.cache', 'omarchy', 'mailbox', 'bridge.json');
  try {
    const data = JSON.parse(fs.readFileSync(bridge, 'utf8'));
    for (const account of Object.values(data.accounts || {})) {
      const messages = Array.isArray(account.emails) ? account.emails : (Array.isArray(account.messages) ? account.messages : []);
      for (const message of messages) { delete message.body; delete message.bodyState; }
    }
    const temporary = `${bridge}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(temporary, bridge);
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
} else if (command === 'set-download-bodies') {
  if (email !== 'true' && email !== 'false') process.exit(2);
  data.downloadBodies = email === 'true';
  write(data);
  if (!data.downloadBodies) purgeBodies();
} else if (command === 'clear-bodies') {
  purgeBodies();
}
console.log(JSON.stringify(data));
