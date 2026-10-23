#!/usr/bin/env node
/* Mailbox — render the unread Inbox model for the bar widget and panel.
 *
 * Data comes only from the local browser bridge cache written by the Native
 * Messaging host and from Omarchy's local desktop-notification history. This
 * script never launches a browser or reads browser profile data.
 */
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { readJson, LIMITS } = require(path.join(__dirname, 'mailbox-bounded-read.js'));

const SETTINGS_FILE = path.join(os.homedir(), '.config', 'omarchy', 'mailbox.json');
function configuredMessageLimit() {
  try { return Math.max(1, Math.min(Number(readJson(SETTINGS_FILE, LIMITS.settings).maxMessagesPerAccount || 50), 200)); } catch (_) { return 50; }
}
const MAX_MESSAGES = configuredMessageLimit();
const CACHE_FILE = path.join(os.homedir(), '.cache', 'omarchy', 'mailbox', 'inbox.json');
const CACHE_TTL_MS = Number(process.env.MAILBOX_CACHE_TTL_MS || 300000);
const BRIDGE_FILE = path.join(os.homedir(), '.cache', 'omarchy', 'mailbox', 'bridge.json');
const BRIDGE_MAX_AGE_MS = 10 * 60 * 1000;
const NOTIFICATION_HISTORY_DIR = path.join(os.homedir(), '.local', 'state', 'omarchy', 'notifications', 'history');
const NOTIFICATION_RETENTION_MS = 24 * 60 * 60 * 1000;
// Omarchy's notification history is shared state; only look at a bounded,
// recent slice of it, and at small files only.
const MAX_NOTIFICATION_ENTRIES = 2000;
const MAX_NOTIFICATION_FILES = 500;
const MAX_NOTIFICATION_BYTES = 64 * 1024;
const MAX_ACCOUNTS = 16;
const CACHE_REGRESSION_GUARD_MS = Number(process.env.MAILBOX_CACHE_REGRESSION_GUARD_MS || 3600000);
const FORCE_REFRESH = process.argv.includes('--refresh');

function sourceDetails() { return { browser: 'unavailable', profile: 'Default', known: [] }; }
function badgePreferences() {
  try {
    const settings = readJson(SETTINGS_FILE, LIMITS.settings);
    return settings?.accounts && typeof settings.accounts === 'object' ? settings.accounts : {};
  } catch (_) { return {}; }
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
function notificationDestination(note) {
  const text = `${note.body || ''} ${note.summary || ''} ${note.execArgv || ''}`;
  const matches = text.match(/https:\/\/(?:mail\.google\.com|app\.hey\.com)(?:\/[^\s<>"']*)?/gi) || [];
  if (matches.length) return matches[0].replace(/[),.;]+$/, '');
  if (/\bhey\b|app\.hey\.com/i.test(text)) return 'https://app.hey.com/';
  return 'https://mail.google.com/mail/';
}
function defaultInitials(email) {
  const parts = String(email || '').split('@');
  const domain = (parts[1] || '').split('.')[0].replace(/[^a-z0-9]/gi, '');
  const local = (parts[0] || '').replace(/[^a-z0-9]/gi, '');
  return (domain.slice(0, 2) || local.slice(0, 2) || '?').toUpperCase();
}
function parseEmailDate(value, reference = Date.now()) {
  const raw = String(value || '').toLowerCase().replace(/\u202f/g, ' ').trim();
  const spanish = raw.match(/(\d{1,2})\s+(ene|feb|mar|abr|may|jun|jul|ago|sept|set|oct|nov|dic)\s+(\d{4}),\s+(\d{1,2}):(\d{2})\D*(a|p)\.?\s*m?\.?/i);
  const english = raw.match(/(?:[a-z]{3},\s+)?([a-z]{3})\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  const months = { ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sept: 8, set: 8, oct: 9, nov: 10, dic: 11, jan: 0, apr: 3, aug: 7, sep: 8, dec: 11 };
  const match = spanish || english;
  if (match) {
    const month = months[spanish ? match[2] : match[1]];
    const day = Number(spanish ? match[1] : match[2]);
    const year = Number(match[3]);
    let hour = Number(match[4]) % 12;
    if ((spanish ? match[6] : match[6].slice(0, 1)) === 'p') hour += 12;
    return new Date(year, month, day, hour, Number(match[5])).getTime();
  }
  const base = new Date(Number(reference) || Date.now());
  const time = raw.match(/^(\d{1,2}):(\d{2})\s*(?:(a|p)(?:\.?\s*m\.?)?)?$/i);
  if (time) {
    let hour = Number(time[1]);
    if (time[3]) { hour %= 12; if (time[3] === 'p') hour += 12; }
    let result = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, Number(time[2])).getTime();
    // Inbox UIs keep showing yesterday's clock time for several hours after
    // midnight. A clock value cannot represent a future message.
    if (result > base.getTime() + 5 * 60 * 1000) result -= 24 * 60 * 60 * 1000;
    return result;
  }
  const monthDay = raw.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})$/i);
  const dayMonth = raw.match(/^(\d{1,2})\s+(ene|feb|mar|abr|may|jun|jul|ago|sept|set|oct|nov|dic)$/i);
  if (monthDay || dayMonth) {
    const short = monthDay || dayMonth;
    const month = months[monthDay ? short[1] : short[2]];
    const day = Number(monthDay ? short[2] : short[1]);
    let result = new Date(base.getFullYear(), month, day).getTime();
    if (result > base.getTime() + 36 * 60 * 60 * 1000) result = new Date(base.getFullYear() - 1, month, day).getTime();
    return result;
  }
  const absolute = Date.parse(value);
  return Number.isFinite(absolute) ? absolute : 0;
}
function recentNotificationFiles() {
  const names = [];
  const dir = fs.opendirSync(NOTIFICATION_HISTORY_DIR);
  try {
    for (let entry = dir.readSync(); entry && names.length < MAX_NOTIFICATION_ENTRIES; entry = dir.readSync()) {
      if (entry.isFile() && entry.name.endsWith('.json') && entry.name.length <= 255) names.push(entry.name);
    }
  } finally { dir.closeSync(); }
  return names.sort().slice(-MAX_NOTIFICATION_FILES);
}
function overlayDesktopNotifications(result) {
  try {
    const snapshotTimes = (result.accounts || []).map(account => Number(account.capturedAt || account.lastCapturedAt || result.cachedAt || 0)).filter(value => value > 0);
    // Notifications are not attributable to an account. Retain each event until
    // every account has produced a snapshot newer than it.
    const reconciledThrough = snapshotTimes.length ? Math.min(...snapshotTimes) : 0;
    const events = recentNotificationFiles().map(name => {
      try { return readJson(path.join(NOTIFICATION_HISTORY_DIR, name), MAX_NOTIFICATION_BYTES); } catch (_) { return null; }
    }).filter(note => note && typeof note === 'object').filter(note => {
      const text = `${note.app || ''} ${note.summary || ''} ${note.body || ''}`.toLowerCase();
      return Number(note.timestamp || 0) > Math.max(reconciledThrough, Date.now() - NOTIFICATION_RETENTION_MS) && /mail\.google\.com|app\.hey\.com|\bgmail\b|\bhey\b/.test(text);
    }).sort((a, b) => Number(a.timestamp) - Number(b.timestamp)).slice(-MAX_MESSAGES);
    if (!events.length) return result;
    const notificationEmails = events.map(note => ({ account: '__desktop_notifications__', initials: 'NEW', color: 'accent', notification: true, from: String(note.summary || 'New email notification'), subject: String(note.body || '').replace(/<[^>]*>/g, '').trim(), snippet: `Desktop notification from ${note.app || 'browser'}`, date: '', dateSort: Number(note.timestamp || 0), url: notificationDestination(note) }));
    return { ...result, total: Number(result.total || 0) + events.length, emails: notificationEmails.concat(result.emails || []), desktopNotifications: events.length, message: [result.message || '', `${events.length} new desktop email notification${events.length === 1 ? '' : 's'} pending Inbox reconciliation.`].filter(Boolean).join(' ') };
  } catch (_) { return result; }
}
function readBridge() {
  try {
    const payload = readJson(BRIDGE_FILE, LIMITS.cache);
    const prefs = badgePreferences();
    const stored = Object.values(payload.accounts || {}).filter(item => item && item.account).slice(0, MAX_ACCOUNTS);
    if (!stored.length) return null;
    const live = stored.some(item => Date.now() - Number(item.capturedAt || 0) <= BRIDGE_MAX_AGE_MS);
    const accounts = stored.map(item => {
      const preference = prefs[item.account] || {};
      const isLive = Date.now() - Number(item.capturedAt || 0) <= BRIDGE_MAX_AGE_MS;
      const notificationPermission = ['granted', 'denied', 'default', 'unsupported'].includes(item.notificationPermission) ? item.notificationPermission : 'unknown';
      return { email: item.account, label: String(item.label || item.account), provider: item.provider === 'hey' ? 'hey' : 'gmail', inboxUrl: /^https:\/\/(?:mail\.google\.com|app\.hey\.com)\//.test(String(item.inboxUrl || '')) ? String(item.inboxUrl) : '', unread: Number(item.unread || 0), initials: String(preference.initials || (item.provider === 'hey' ? 'HEY' : defaultInitials(item.account))).slice(0, 3), color: ['accent', 'urgent', 'foreground', 'muted', 'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'brown'].includes(preference.color) ? preference.color : 'accent', index: String(item.index || (item.provider === 'hey' ? '' : '0')), bridge: true, connectionState: isLive ? 'live' : 'closed', lastCapturedAt: Number(item.capturedAt || 0), notificationPermission, notificationHealthy: notificationPermission === 'granted' };
    });
    const emails = stored.flatMap(item => (Array.isArray(item.emails) ? item.emails : (Array.isArray(item.messages) ? item.messages : [])).slice(0, MAX_MESSAGES).map(email => {
      const preference = prefs[item.account] || {};
      return { ...email, dateSort: Number(email.dateTimestamp || 0) || parseEmailDate(email.date, item.capturedAt), account: item.account, provider: item.provider === 'hey' ? 'hey' : 'gmail', initials: String(preference.initials || (item.provider === 'hey' ? 'HEY' : defaultInitials(item.account))).slice(0, 3), color: ['accent', 'urgent', 'foreground', 'muted', 'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'brown'].includes(preference.color) ? preference.color : 'accent' };
    })).sort((a, b) => Number(b.dateSort || 0) - Number(a.dateSort || 0));
    return overlayDesktopNotifications({ accounts, total: accounts.reduce((sum, account) => sum + account.unread, 0), emails, status: live ? 'ok' : 'cached', source: { browser: 'Local browser bridge', profile: live ? 'Active email tabs' : 'Saved local cache', known: [] }, cacheState: live ? 'fresh' : 'cached', message: '' });
  } catch (_) { return null; }
}
function applyLocalRead(result) {
  let markedAt = 0;
  try { markedAt = Number(readJson(SETTINGS_FILE, LIMITS.settings).localReadAt || 0); } catch (_) {}
  if (!markedAt) return result;
  const emails = (result.emails || []).filter(email => Number(email.dateSort || 0) > markedAt || Number(email.timestamp || 0) > markedAt);
  const accounts = (result.accounts || []).map(account => ({ ...account, unread: emails.filter(email => email.account === account.email).length }));
  return { ...result, accounts, emails, total: accounts.reduce((sum, account) => sum + account.unread, 0), localReadAt: markedAt };
}
function empty(status, message) { return { accounts: [], total: 0, emails: [], status, message, source: sourceDetails() }; }
function readCache() {
  if (FORCE_REFRESH) return null;
  try {
    const cached = readJson(CACHE_FILE, LIMITS.cache);
    if (!cached || !Array.isArray(cached.accounts) || !Array.isArray(cached.emails) || Date.now() - Number(cached.cachedAt || 0) > CACHE_TTL_MS) return null;
    cached.message = cached.message || '';
    cached.cache = { hit: true, ageSeconds: Math.floor((Date.now() - cached.cachedAt) / 1000) };
    return overlayDesktopNotifications(cached);
  } catch (_) { return null; }
}
function writeCache(result) {
  try {
    let previous = null;
    try { previous = readJson(CACHE_FILE, LIMITS.cache); } catch (_) {}
    // A transient/partial Gmail scan must not make accounts disappear from the UI.
    if (previous && Array.isArray(previous.accounts) && previous.accounts.length > result.accounts.length && Date.now() - Number(previous.cachedAt || 0) < CACHE_REGRESSION_GUARD_MS) return;
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true, mode: 0o700 });
    const cached = { ...result, cachedAt: Date.now() };
    atomicWrite(CACHE_FILE, JSON.stringify(cached));
  } catch (_) {}
}
function readPreviousSnapshot() {
  try { return readJson(CACHE_FILE, LIMITS.cache); } catch (_) { return null; }
}
async function main() {
  const bridge = readBridge();
  if (bridge) { writeCache(bridge); return bridge; }
  const cached = readCache();
  if (cached) return cached;
  const fallback = readPreviousSnapshot();
  if (fallback && Array.isArray(fallback.accounts) && Array.isArray(fallback.emails)) {
    const accounts = fallback.accounts.map(account => { const clean = { ...account, connectionState: 'unknown' }; delete clean.stale; delete clean.staleReason; return clean; });
    return overlayDesktopNotifications({ ...fallback, accounts, status: 'cached', cacheState: 'cached', staleAccounts: [], message: '', source: sourceDetails() });
  }
  return overlayDesktopNotifications(empty('login-required', 'Mailbox Local Bridge has no data yet. Set up the browser extension in Mailbox preferences, then open Gmail or the HEY Imbox.'));
}
main().then(result => console.log(JSON.stringify(applyLocalRead(result))));
