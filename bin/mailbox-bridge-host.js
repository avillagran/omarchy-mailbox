#!/usr/bin/env node
// Native host for Mailbox Local Bridge. Receives local Gmail DOM snapshots
// and stores bounded, private plain-text cache data for the current user.
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { readJson, LIMITS } = require(path.join(__dirname, 'mailbox-bounded-read.js'));

const CACHE_DIR = path.join(os.homedir(), '.cache', 'omarchy', 'mailbox');
const CACHE = path.join(CACHE_DIR, 'bridge.json');
const SETTINGS = path.join(os.homedir(), '.config', 'omarchy', 'mailbox.json');
const PENDING = path.join(CACHE_DIR, 'pending-account.json');
const SLOT_MAP = path.join(CACHE_DIR, 'gmail-slot-accounts.json');
const DRAFTS_DIR = path.join(os.homedir(), '.local', 'state', 'omarchy', 'mailbox', 'drafts');
// A reply hand-off is only honoured shortly after the panel asked for it.
const REPLY_HANDOFF_MAX_AGE_MS = 2 * 60 * 1000;
const MAX_DRAFT_BYTES = 1024 * 1024;
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_SINGLE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ACCOUNT_BODY_BYTES = 10 * 1024 * 1024;
// Ceilings for everything the browser extension can send or make Mailbox keep.
const MAX_TOTAL_BODY_BYTES = 40 * 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_BYTES = 256 * 1024;
const MAX_ACCOUNTS = 16;
const MAX_SLOTS = 32;
const MAX_SNAPSHOT_ROWS = 500;
const MAX_THREAD_PARTS = 200;
function clip(value, max) { return String(value ?? '').slice(0, max); }

function settings() {
  try {
    const value = readJson(SETTINGS, LIMITS.settings);
    return {
      maxMessages: Math.max(1, Math.min(Number(value.maxMessagesPerAccount || 50), 200)),
      downloadBodies: value.downloadBodies !== false,
      configuredAccounts: Object.keys(value.accounts || {}).slice(0, MAX_ACCOUNTS)
    };
  } catch (_) { return { maxMessages: 50, downloadBodies: true, configuredAccounts: [] }; }
}
function pendingAccount() {
  try {
    const pending = readJson(PENDING, LIMITS.small);
    return Date.now() - Number(pending.requestedAt) <= PENDING_MAX_AGE_MS ? clip(pending.email, 320) : '';
  } catch (_) { return ''; }
}
function slotAccounts() {
  try {
    const slots = readJson(SLOT_MAP, LIMITS.small);
    return slots && typeof slots === 'object' && !Array.isArray(slots) ? slots : {};
  } catch (_) { return {}; }
}
function mappedAccount(index) { return clip(slotAccounts()[String(index || '')] || '', 320); }
function rememberSlot(index, account) {
  if (!/^\d{1,3}$/.test(String(index)) || !account) return;
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  const slots = slotAccounts(); slots[String(index)] = account;
  const bounded = Object.fromEntries(Object.entries(slots).filter(([key]) => /^\d{1,3}$/.test(key)).slice(-MAX_SLOTS));
  atomicWrite(SLOT_MAP, JSON.stringify(bounded));
}
function send(message) {
  const encoded = Buffer.from(JSON.stringify(message));
  const size = Buffer.alloc(4); size.writeUInt32LE(encoded.length, 0);
  process.stdout.write(Buffer.concat([size, encoded]), () => process.exit(0));
}
function load() {
  try {
    const value = readJson(CACHE, LIMITS.cache);
    value.accounts = value.accounts && typeof value.accounts === 'object' ? value.accounts : {};
    return value;
  } catch (_) { return { schemaVersion: 2, accounts: {} }; }
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
function save(data) {
  enforceTotalBodyBudget(data);
  fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  data.schemaVersion = 2;
  data.updatedAt = Date.now();
  atomicWrite(CACHE, JSON.stringify(data));
}
function keyFor(message) {
  if (message.threadId) return `thread:${String(message.threadId).replace(/^#/, '')}`;
  if (message.url) return `url:${clip(message.url, 2048)}`;
  return `row:${clip(message.from, 512)}\u0000${clip(message.subject, 1024)}\u0000${clip(message.date, 128)}`;
}
function accountMessages(account) {
  const rows = Array.isArray(account?.emails) ? account.emails : (Array.isArray(account?.messages) ? account.messages : []);
  return rows.map(row => ({ ...row, key: row.key || keyFor(row), firstSeenAt: Number(row.firstSeenAt || row.lastSeenAt || Date.now()), lastSeenAt: Number(row.lastSeenAt || row.firstSeenAt || Date.now()) }));
}
function bodyBytes(message) { return message.body ? Buffer.byteLength(JSON.stringify(message.body)) : 0; }
// Only provider Inbox pages may be opened from the panel; anything else from the
// page is discarded rather than passed to xdg-open later.
function safeInboxUrl(value) { return /^https:\/\/(?:mail\.google\.com|app\.hey\.com)\//.test(String(value || '')) ? String(value).slice(0, 2048) : ''; }
function normalizedNotificationPermission(value) {
  return ['granted', 'denied', 'default', 'unsupported'].includes(value) ? value : 'unknown';
}
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
// Evict the oldest cached bodies across all accounts so bridge.json stays bounded.
function enforceTotalBodyBudget(data) {
  const rows = Object.values(data.accounts || {}).flatMap(account => Array.isArray(account.emails) ? account.emails : []).filter(row => row.body);
  let bytes = rows.reduce((sum, row) => sum + bodyBytes(row), 0);
  for (const row of rows.sort((a, b) => Number(a.lastSeenAt || 0) - Number(b.lastSeenAt || 0))) {
    if (bytes <= MAX_TOTAL_BODY_BYTES) break;
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
  const fresh = (message.emails || []).slice(0, MAX_SNAPSHOT_ROWS).map(raw => {
    const key = keyFor(raw);
    let old = oldByKey.get(key) || null;
    if (!old) {
      for (const candidate of oldByKey.values()) {
        if (candidate.from === clip(raw.from, 512) && candidate.subject === clip(raw.subject, 1024) && candidate.date === clip(raw.date, 128)) { old = candidate; break; }
      }
    }
    old = old || {};
    oldByKey.delete(old.key || key);
    return {
      ...old,
      from: clip(raw.from, 512), subject: clip(raw.subject, 1024), snippet: clip(raw.snippet, 2048),
      date: clip(raw.date, 128), dateTimestamp: Number(raw.dateTimestamp || old.dateTimestamp || 0), unread: raw.unread === true,
      threadId: clip(raw.threadId, 256).replace(/^#/, ''), url: safeInboxUrl(raw.url),
      key, firstSeenAt: Number(old.firstSeenAt || now), lastSeenAt: now, presentInLatestSnapshot: true
    };
  });
  const retained = [...oldByKey.values()].map(row => ({ ...row, presentInLatestSnapshot: false }));
  const merged = {
    ...previous, account,
    provider: message.provider === 'hey' ? 'hey' : 'gmail',
    label: clip(message.label || previous.label || account, 256),
    inboxUrl: safeInboxUrl(message.inboxUrl) || safeInboxUrl(previous.inboxUrl),
    notificationPermission: normalizedNotificationPermission(message.notificationPermission || previous.notificationPermission),
    index: clip(message.index || previous.index || (message.provider === 'hey' ? '' : '0'), 16),
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
  const threadId = clip(message.threadId, 256).replace(/^#/, '');
  const rows = accountMessages(account);
  const row = rows.find(item => String(item.threadId || '').replace(/^#/, '') === threadId);
  if (!row) return false;
  const parts = Array.isArray(message.messages) ? message.messages.slice(0, MAX_THREAD_PARTS).map(part => ({
    messageId: clip(part.messageId, 512), from: clip(part.from, 512), date: clip(part.date, 128), text: clip(part.text, MAX_SINGLE_BODY_BYTES)
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

function handle(message) {
  try {
    if (message.type === 'bridge-health' || message.type === 'bridge-diagnostics') {
      const file = path.join(CACHE_DIR, message.type === 'bridge-health' ? 'bridge-health.json' : 'bridge-diagnostics.json');
      if (Buffer.byteLength(JSON.stringify(message)) > MAX_REPORT_BYTES) throw new Error('Bridge report too large');
      fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
      atomicWrite(file, JSON.stringify({ ...message, receivedAt: Date.now() }));
      send({ ok: true });
      return;
    }
    if (message.type === 'mailbox-reply-request') {
      const id = String(message.id || '');
      if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid reply request');
      const draft = readJson(path.join(DRAFTS_DIR, `${id}.json`), MAX_DRAFT_BYTES);
      if (Date.now() - Number(draft.handedOffAt || 0) > REPLY_HANDOFF_MAX_AGE_MS) throw new Error('Reply request expired');
      const url = draft.provider === 'hey' ? (/^https:\/\/app\.hey\.com\/[A-Za-z0-9/_-]{1,256}$/.test(String(draft.url || '')) ? draft.url : '')
        : (/^https:\/\/mail\.google\.com\/mail\/u\/[0-9]{1,3}\/#inbox\/[A-Za-z0-9_-]{1,128}$/.test(String(draft.url || '')) ? draft.url : '');
      if (!url) throw new Error('Reply link is not a provider page');
      send({ ok: true, provider: draft.provider === 'hey' ? 'hey' : 'gmail', url, threadId: clip(draft.threadId, 256), text: clip(draft.text, 200000) });
      return;
    }
    const prefs = settings();
    const data = load();
    const configured = new Set(prefs.configuredAccounts);
    const provider = message.provider === 'hey' ? 'hey' : 'gmail';
    const reported = clip(message.account, 320).toLowerCase();
    if (provider === 'hey') {
      message.account = message.accountVerified === true && reported.startsWith('hey:') ? reported : '';
    } else {
      const knownForIndex = Object.values(data.accounts || {}).find(account => configured.has(account.account) && String(account.index) === String(message.index));
      const mapped = mappedAccount(message.index);
      const pending = pendingAccount();
      message.account = knownForIndex?.account || (configured.has(mapped) ? mapped : '') || (configured.has(reported) ? reported : '') || pending || (message.accountVerified === true ? reported : '');
    }
    message.provider = provider;
    if (!message.account) throw new Error('Email account could not be verified');
    if (!data.accounts[message.account] && Object.keys(data.accounts).length >= MAX_ACCOUNTS) throw new Error('Too many email accounts');
    if (provider === 'gmail') rememberSlot(message.index, message.account);
    if (message.type === 'mailbox-thread-body') {
      const saved = mergeThreadBody(data, message, prefs);
      if (saved) save(data);
      send({ ok: true, saved, bodyDownloadsEnabled: prefs.downloadBodies });
      return;
    }
    if (!Array.isArray(message.emails)) throw new Error('Invalid email snapshot');
    const account = mergeSnapshot(data, message, prefs);
    save(data);
    send({ ok: true, bodyDownloadsEnabled: prefs.downloadBodies, allowedThreadIds: account.emails.map(row => row.threadId).filter(Boolean) });
  } catch (error) { send({ ok: false, error: error.message }); }
}

let input = Buffer.alloc(0);
let handled = false;
process.stdin.on('data', chunk => {
  if (handled) return;
  input = Buffer.concat([input, chunk]);
  if (input.length < 4) return;
  const length = input.readUInt32LE(0);
  // Refuse oversized frames before buffering them; the browser cannot make the
  // host accumulate more than one bounded message.
  if (length > MAX_FRAME_BYTES) {
    handled = true;
    process.stdin.pause();
    send({ ok: false, error: 'Native message too large' });
    return;
  }
  if (input.length < 4 + length) return;
  handled = true;
  process.stdin.pause();
  try {
    handle(JSON.parse(input.subarray(4, 4 + length).toString('utf8')));
  } catch (error) { send({ ok: false, error: error.message }); }
});
process.stdin.on('end', () => {
  if (!handled) send({ ok: false, error: 'Missing native message' });
});
