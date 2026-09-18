#!/usr/bin/env node
// Native host for Gmailbox Local Bridge. Receives local Gmail DOM snapshots
// and stores bounded, private plain-text cache data for the current user.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_DIR = path.join(os.homedir(), '.cache', 'omarchy', 'gmailbox');
const CACHE = path.join(CACHE_DIR, 'bridge.json');
const SETTINGS = path.join(os.homedir(), '.config', 'omarchy', 'gmailbox.json');
const PENDING = path.join(CACHE_DIR, 'pending-account.json');
const SLOT_MAP = path.join(CACHE_DIR, 'gmail-slot-accounts.json');
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_SINGLE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ACCOUNT_BODY_BYTES = 10 * 1024 * 1024;

function settings() {
  try {
    const value = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    return {
      maxMessages: Math.max(1, Math.min(Number(value.maxMessagesPerAccount || 50), 200)),
      downloadBodies: value.downloadBodies !== false,
      configuredAccounts: Object.keys(value.accounts || {})
    };
  } catch (_) { return { maxMessages: 50, downloadBodies: true, configuredAccounts: [] }; }
}
function pendingAccount() {
  try {
    const pending = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
    return Date.now() - Number(pending.requestedAt) <= PENDING_MAX_AGE_MS ? String(pending.email || '') : '';
  } catch (_) { return ''; }
}
function slotAccounts() { try { return JSON.parse(fs.readFileSync(SLOT_MAP, 'utf8')); } catch (_) { return {}; } }
function mappedAccount(index) { return String(slotAccounts()[String(index || '')] || ''); }
function rememberSlot(index, account) {
  if (!String(index).length || !account) return;
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  const slots = slotAccounts(); slots[String(index)] = account;
  fs.writeFileSync(SLOT_MAP, JSON.stringify(slots), { mode: 0o600 });
}
function send(message) {
  const encoded = Buffer.from(JSON.stringify(message));
  const size = Buffer.alloc(4); size.writeUInt32LE(encoded.length, 0);
  process.stdout.write(Buffer.concat([size, encoded]));
}
function load() {
  try {
    const value = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    value.accounts = value.accounts || {};
    return value;
  } catch (_) { return { schemaVersion: 2, accounts: {} }; }
}
function save(data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  data.schemaVersion = 2;
  data.updatedAt = Date.now();
  const temp = `${CACHE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(temp, CACHE);
}
function keyFor(message) {
  if (message.threadId) return `thread:${String(message.threadId).replace(/^#/, '')}`;
  if (message.url) return `url:${message.url}`;
  return `row:${message.from || ''}\u0000${message.subject || ''}\u0000${message.date || ''}`;
}
function accountMessages(account) {
  const rows = Array.isArray(account?.emails) ? account.emails : (Array.isArray(account?.messages) ? account.messages : []);
  return rows.map(row => ({ ...row, key: row.key || keyFor(row), firstSeenAt: Number(row.firstSeenAt || row.lastSeenAt || Date.now()), lastSeenAt: Number(row.lastSeenAt || row.firstSeenAt || Date.now()) }));
}
function bodyBytes(message) { return message.body ? Buffer.byteLength(JSON.stringify(message.body)) : 0; }
function enforceLimits(account, prefs) {
  account.emails = accountMessages(account).sort((a, b) => Number(b.presentInLatestSnapshot) - Number(a.presentInLatestSnapshot) || b.lastSeenAt - a.lastSeenAt).slice(0, prefs.maxMessages);
  let bytes = account.emails.reduce((sum, row) => sum + bodyBytes(row), 0);
  if (bytes <= MAX_ACCOUNT_BODY_BYTES) return;
  const oldest = account.emails.filter(row => row.body).sort((a, b) => a.lastSeenAt - b.lastSeenAt);
  for (const row of oldest) {
    if (bytes <= MAX_ACCOUNT_BODY_BYTES) break;
    bytes -= bodyBytes(row);
    delete row.body;
    row.bodyState = 'evicted';
  }
}
function purgeBodies(data) {
  for (const account of Object.values(data.accounts || {})) {
    account.emails = accountMessages(account).map(row => {
      delete row.body; delete row.bodyState; return row;
    });
  }
}
function mergeSnapshot(data, message, prefs) {
  const account = message.account;
  const previous = data.accounts[account] || { account, emails: [] };
  const oldByKey = new Map(accountMessages(previous).map(row => [row.key, row]));
  const now = Date.now();
  const fresh = (message.emails || []).map(raw => {
    const key = keyFor(raw);
    let old = oldByKey.get(key) || null;
    if (!old) {
      for (const candidate of oldByKey.values()) {
        if (candidate.from === String(raw.from || '') && candidate.subject === String(raw.subject || '') && candidate.date === String(raw.date || '')) { old = candidate; break; }
      }
    }
    old = old || {};
    oldByKey.delete(old.key || key);
    return {
      ...old,
      from: String(raw.from || ''), subject: String(raw.subject || ''), snippet: String(raw.snippet || ''),
      date: String(raw.date || ''), unread: raw.unread === true,
      threadId: String(raw.threadId || '').replace(/^#/, ''), url: String(raw.url || ''),
      key, firstSeenAt: Number(old.firstSeenAt || now), lastSeenAt: now, presentInLatestSnapshot: true
    };
  });
  const retained = [...oldByKey.values()].map(row => ({ ...row, presentInLatestSnapshot: false }));
  const merged = {
    ...previous, account, index: String(message.index || previous.index || '0'),
    unread: Number(message.unread || 0), capturedAt: now, emails: fresh.concat(retained)
  };
  if (!prefs.downloadBodies) purgeBodies({ accounts: { [account]: merged } });
  enforceLimits(merged, prefs);
  data.accounts[account] = merged;
  return merged;
}
function mergeThreadBody(data, message, prefs) {
  if (!prefs.downloadBodies) return false;
  const account = data.accounts[message.account];
  if (!account) return false;
  const threadId = String(message.threadId || '').replace(/^#/, '');
  const rows = accountMessages(account);
  const row = rows.find(item => String(item.threadId || '').replace(/^#/, '') === threadId);
  if (!row) return false;
  const parts = Array.isArray(message.messages) ? message.messages.map(part => ({
    messageId: String(part.messageId || ''), from: String(part.from || ''), date: String(part.date || ''), text: String(part.text || '')
  })).filter(part => part.text.trim()) : [];
  const body = { format: 'text/plain', capturedAt: Date.now(), complete: message.complete === true, messages: parts };
  const bytes = Buffer.byteLength(JSON.stringify(body));
  if (!parts.length) return false;
  if (bytes > MAX_SINGLE_BODY_BYTES) { delete row.body; row.bodyState = 'too-large'; return true; }
  row.body = { ...body, bytes };
  row.bodyState = body.complete ? 'cached' : 'partial';
  row.lastSeenAt = Date.now();
  account.emails = rows;
  enforceLimits(account, prefs);
  return true;
}

let input = Buffer.alloc(0);
process.stdin.on('data', chunk => { input = Buffer.concat([input, chunk]); });
process.stdin.on('end', () => {
  try {
    if (input.length < 4) throw new Error('Missing native message');
    const length = input.readUInt32LE(0);
    const message = JSON.parse(input.subarray(4, 4 + length).toString('utf8'));
    if (message.type === 'bridge-health' || message.type === 'bridge-diagnostics') {
      const file = path.join(CACHE_DIR, message.type === 'bridge-health' ? 'bridge-health.json' : 'bridge-diagnostics.json');
      fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ ...message, receivedAt: Date.now() }), { mode: 0o600 });
      send({ ok: true });
      return;
    }
    const prefs = settings();
    const data = load();
    const configured = new Set(prefs.configuredAccounts);
    const knownForIndex = Object.values(data.accounts || {}).find(account => configured.has(account.account) && String(account.index) === String(message.index));
    const mapped = mappedAccount(message.index);
    const pending = pendingAccount();
    const reported = String(message.account || '').toLowerCase();
    message.account = knownForIndex?.account || (configured.has(mapped) ? mapped : '') || (configured.has(reported) ? reported : '') || pending || (message.accountVerified === true ? reported : '');
    if (!message.account) throw new Error('Gmail account could not be verified');
    rememberSlot(message.index, message.account);
    if (message.type === 'gmailbox-thread-body') {
      const saved = mergeThreadBody(data, message, prefs);
      if (saved) save(data);
      send({ ok: true, saved, bodyDownloadsEnabled: prefs.downloadBodies });
      return;
    }
    if (!Array.isArray(message.emails)) throw new Error('Invalid Gmail snapshot');
    const account = mergeSnapshot(data, message, prefs);
    save(data);
    send({ ok: true, bodyDownloadsEnabled: prefs.downloadBodies, allowedThreadIds: account.emails.map(row => row.threadId).filter(Boolean) });
  } catch (error) { send({ ok: false, error: error.message }); }
});
