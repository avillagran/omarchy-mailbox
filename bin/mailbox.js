#!/usr/bin/env node
/* Mailbox — extract unread Gmail Inbox rows through an isolated CDP session.
 *
 * The default browser is discovered at runtime. Each signed-in Gmail account is
 * read from /mail/u/<index>/ without touching a visible browser tab.
 */
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEBUG_PORT = Number(process.env.MAILBOX_DEBUG_PORT || 9321);
const SETTINGS_FILE = path.join(os.homedir(), '.config', 'omarchy', 'mailbox.json');
function configuredMessageLimit() {
  try { return Math.max(1, Math.min(Number(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).maxMessagesPerAccount || 50), 200)); } catch (_) { return 50; }
}
const MAX_MESSAGES = configuredMessageLimit();
const MAX_ACCOUNTS = Math.max(1, Math.min(Number(process.env.MAILBOX_MAX_ACCOUNTS || 8), 12));
const CACHE_FILE = path.join(os.homedir(), '.cache', 'omarchy', 'mailbox', 'inbox.json');
const CACHE_TTL_MS = Number(process.env.MAILBOX_CACHE_TTL_MS || 300000);
const BRIDGE_FILE = path.join(os.homedir(), '.cache', 'omarchy', 'mailbox', 'bridge.json');
const BRIDGE_MAX_AGE_MS = 10 * 60 * 1000;
const NOTIFICATION_HISTORY_DIR = path.join(os.homedir(), '.local', 'state', 'omarchy', 'notifications', 'history');
const NOTIFICATION_RETENTION_MS = 24 * 60 * 60 * 1000;
const CACHE_REGRESSION_GUARD_MS = Number(process.env.MAILBOX_CACHE_REGRESSION_GUARD_MS || 3600000);
const FORCE_REFRESH = process.argv.includes('--refresh');

function commandExists(command) {
  try { execFileSync('sh', ['-lc', `command -v ${JSON.stringify(command)}`], { stdio: 'ignore' }); return true; } catch (_) { return false; }
}
function defaultDesktop() {
  try { return execFileSync('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8' }).trim(); } catch (_) { return ''; }
}
function desktopCommand(desktop) {
  const locations = ['/usr/share/applications', path.join(os.homedir(), '.local/share/applications')];
  for (const base of locations) {
    try {
      const line = fs.readFileSync(path.join(base, desktop), 'utf8').split(/\r?\n/).find(value => value.startsWith('Exec='));
      if (line) return line.slice(5).trim().split(/\s+/)[0].replace(/^"|"$/g, '');
    } catch (_) {}
  }
  return '';
}
function browserCandidates() {
  if (process.env.MAILBOX_BROWSER && process.env.MAILBOX_PROFILE) return [{ binary: process.env.MAILBOX_BROWSER, profile: process.env.MAILBOX_PROFILE }];
  const desktop = defaultDesktop();
  const preferred = desktopCommand(desktop);
  const candidates = [];
  const add = (binary, profile) => {
    if (binary && profile && fs.existsSync(profile) && (path.isAbsolute(binary) ? fs.existsSync(binary) : commandExists(binary)) && !candidates.some(item => item.binary === binary && item.profile === profile)) candidates.push({ binary, profile });
  };
  if (/chrome/i.test(desktop)) add(preferred || 'google-chrome', path.join(os.homedir(), '.config', 'google-chrome'));
  if (/chromium/i.test(desktop)) add(preferred || 'chromium', path.join(os.homedir(), '.config', 'chromium'));
  add('chromium', path.join(os.homedir(), '.config', 'chromium'));
  add('google-chrome', path.join(os.homedir(), '.config', 'google-chrome'));
  return candidates;
}
function browserName(profile) { return profile.includes('google-chrome') ? 'Google Chrome' : 'Chromium'; }
function preferencesAccounts(profile) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8'));
    return (data.account_info || []).map(account => account.email).filter(Boolean);
  } catch (_) { return []; }
}
function sourceDetails(active) {
  const known = browserCandidates().map(item => ({ browser: browserName(item.profile), profile: 'Default', emails: preferencesAccounts(item.profile) })).filter(item => item.emails.length);
  return { browser: active ? browserName(active.profile) : 'unavailable', profile: 'Default', known };
}
function badgePreferences() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return settings?.accounts && typeof settings.accounts === 'object' ? settings.accounts : {};
  } catch (_) { return {}; }
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
function parseEmailDate(value) {
  const raw = String(value || '').toLowerCase().replace(/\u202f/g, ' ');
  const spanish = raw.match(/(\d{1,2})\s+(ene|feb|mar|abr|may|jun|jul|ago|sept|set|oct|nov|dic)\s+(\d{4}),\s+(\d{1,2}):(\d{2})\D*(a|p)\.?\s*m?\.?/i);
  const english = raw.match(/(?:[a-z]{3},\s+)?([a-z]{3})\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
  const months = { ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sept: 8, set: 8, oct: 9, nov: 10, dic: 11, jan: 0, apr: 3, aug: 7, sep: 8, dec: 11 };
  const match = spanish || english;
  if (!match) return 0;
  const month = months[spanish ? match[2] : match[1]];
  const day = Number(spanish ? match[1] : match[2]);
  const year = Number(match[3]);
  let hour = Number(match[4]) % 12;
  if ((spanish ? match[6] : match[6].slice(0, 1)) === 'p') hour += 12;
  return new Date(year, month, day, hour, Number(match[5])).getTime();
}
function overlayDesktopNotifications(result) {
  try {
    const snapshotAt = Math.max(0, ...(result.accounts || []).map(account => Number(account.capturedAt || account.lastCapturedAt || result.cachedAt || 0)));
    const events = fs.readdirSync(NOTIFICATION_HISTORY_DIR).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(NOTIFICATION_HISTORY_DIR, name), 'utf8'))).filter(note => {
      const text = `${note.app || ''} ${note.summary || ''} ${note.body || ''}`.toLowerCase();
      return Number(note.timestamp || 0) > Math.max(snapshotAt, Date.now() - NOTIFICATION_RETENTION_MS) && /mail\.google\.com|app\.hey\.com|\bgmail\b|\bhey\b/.test(text);
    }).sort((a, b) => Number(a.timestamp) - Number(b.timestamp)).slice(-MAX_MESSAGES);
    if (!events.length) return result;
    const notificationEmails = events.map(note => ({ account: '__desktop_notifications__', initials: 'NEW', color: 'accent', notification: true, from: String(note.summary || 'New email notification'), subject: String(note.body || '').replace(/<[^>]*>/g, '').trim(), snippet: `Desktop notification from ${note.app || 'browser'}`, date: '', dateSort: Number(note.timestamp || 0), url: notificationDestination(note) }));
    return { ...result, total: Number(result.total || 0) + events.length, emails: notificationEmails.concat(result.emails || []), desktopNotifications: events.length, message: [result.message || '', `${events.length} new desktop email notification${events.length === 1 ? '' : 's'} pending Inbox reconciliation.`].filter(Boolean).join(' ') };
  } catch (_) { return result; }
}
function readBridge() {
  try {
    const payload = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
    const prefs = badgePreferences();
    const stored = Object.values(payload.accounts || {}).filter(item => item && item.account);
    if (!stored.length) return null;
    const live = stored.some(item => Date.now() - Number(item.capturedAt || 0) <= BRIDGE_MAX_AGE_MS);
    const accounts = stored.map(item => {
      const preference = prefs[item.account] || {};
      const isLive = Date.now() - Number(item.capturedAt || 0) <= BRIDGE_MAX_AGE_MS;
      return { email: item.account, label: String(item.label || item.account), provider: item.provider === 'hey' ? 'hey' : 'gmail', inboxUrl: String(item.inboxUrl || ''), unread: Number(item.unread || 0), initials: String(preference.initials || (item.provider === 'hey' ? 'HEY' : defaultInitials(item.account))).slice(0, 3), color: ['accent', 'urgent', 'foreground', 'muted', 'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'brown'].includes(preference.color) ? preference.color : 'accent', index: String(item.index || (item.provider === 'hey' ? '' : '0')), bridge: true, connectionState: isLive ? 'live' : 'closed', lastCapturedAt: Number(item.capturedAt || 0) };
    });
    const emails = stored.flatMap(item => (Array.isArray(item.emails) ? item.emails : (Array.isArray(item.messages) ? item.messages : [])).slice(0, MAX_MESSAGES).map(email => {
      const preference = prefs[item.account] || {};
      return { ...email, dateSort: parseEmailDate(email.date), account: item.account, provider: item.provider === 'hey' ? 'hey' : 'gmail', initials: String(preference.initials || (item.provider === 'hey' ? 'HEY' : defaultInitials(item.account))).slice(0, 3), color: ['accent', 'urgent', 'foreground', 'muted', 'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'brown'].includes(preference.color) ? preference.color : 'accent' };
    })).sort((a, b) => Number(b.dateSort || 0) - Number(a.dateSort || 0));
    return overlayDesktopNotifications({ accounts, total: accounts.reduce((sum, account) => sum + account.unread, 0), emails, status: live ? 'ok' : 'cached', source: { browser: 'Local browser bridge', profile: live ? 'Active email tabs' : 'Saved local cache', known: [] }, cacheState: live ? 'fresh' : 'cached', message: '' });
  } catch (_) { return null; }
}
function applyLocalRead(result) {
  let markedAt = 0;
  try { markedAt = Number(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).localReadAt || 0); } catch (_) {}
  if (!markedAt) return result;
  const emails = (result.emails || []).filter(email => Number(email.dateSort || 0) > markedAt || Number(email.timestamp || 0) > markedAt);
  const accounts = (result.accounts || []).map(account => ({ ...account, unread: emails.filter(email => email.account === account.email).length }));
  return { ...result, accounts, emails, total: accounts.reduce((sum, account) => sum + account.unread, 0), localReadAt: markedAt };
}
function empty(status, message, source) { return { accounts: [], total: 0, emails: [], status, message, source: source || sourceDetails(null) }; }
function readCache() {
  if (FORCE_REFRESH) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!cached || !Array.isArray(cached.accounts) || !Array.isArray(cached.emails) || Date.now() - Number(cached.cachedAt || 0) > CACHE_TTL_MS) return null;
    cached.message = cached.message || '';
    cached.cache = { hit: true, ageSeconds: Math.floor((Date.now() - cached.cachedAt) / 1000) };
    return overlayDesktopNotifications(cached);
  } catch (_) { return null; }
}
function writeCache(result) {
  try {
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) {}
    // A transient/partial Gmail scan must not make accounts disappear from the UI.
    if (previous && Array.isArray(previous.accounts) && previous.accounts.length > result.accounts.length && Date.now() - Number(previous.cachedAt || 0) < CACHE_REGRESSION_GUARD_MS) return;
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true, mode: 0o700 });
    const cached = { ...result, cachedAt: Date.now() };
    const temporary = `${CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(cached), { mode: 0o600 });
    fs.renameSync(temporary, CACHE_FILE);
  } catch (_) {}
}
function readPreviousSnapshot() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { return null; }
}
function retainStaleEmails(accounts, emails) {
  const previous = readPreviousSnapshot();
  if (!previous || !Array.isArray(previous.accounts) || !Array.isArray(previous.emails)) return [];
  const priorAccounts = new Map(previous.accounts.map(account => [account.email, account]));
  const stale = [];
  for (const account of accounts) {
    const oldAccount = priorAccounts.get(account.email);
    const freshCount = emails.filter(email => email.account === account.email).length;
    const retained = previous.emails.filter(email => email.account === account.email);
    // Gmail can report a counter before its rows finish hydrating. Retain the
    // prior preview without marking the account as disconnected.
    if (oldAccount && retained.length && freshCount === 0 && (account.unavailable || Number(account.unread) > 0)) {
      emails.push(...retained.map(email => ({ ...email, previewState: 'cached' })));
      account.connectionState = account.unavailable ? 'unknown' : 'loading';
      stale.push(account.email);
    }
  }
  return stale;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => { let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve(body)); });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('CDP request timed out')));
    request.on('error', reject);
  });
}
async function cdpPages() { return JSON.parse(await httpGet(`http://127.0.0.1:${DEBUG_PORT}/json`)); }
async function startBrowser(candidate) {
  const child = spawn(candidate.binary, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', `--user-data-dir=${candidate.profile}`, `--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-default-browser-check', '--noerrdialogs', 'about:blank'], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 30; attempt += 1) { try { if ((await cdpPages()).length) return child; } catch (_) {} await sleep(300); }
  child.kill('SIGTERM');
  throw new Error(`${browserName(candidate.profile)} did not expose a debugging endpoint`);
}
async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('CDP WebSocket timed out')), 5000); ws.onopen = () => { clearTimeout(timer); resolve(); }; ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP WebSocket failed')); }; });
  let nextId = 0; const pending = new Map();
  ws.onmessage = event => { try { const reply = JSON.parse(event.data); const done = pending.get(reply.id); if (done) { pending.delete(reply.id); done(reply); } } catch (_) {} };
  const send = (method, params = {}) => new Promise(resolve => { const id = ++nextId; const timer = setTimeout(() => { pending.delete(id); resolve(null); }, 15000); pending.set(id, reply => { clearTimeout(timer); resolve(reply); }); ws.send(JSON.stringify({ id, method, params })); });
  return { ws, send, evaluate: async expression => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.result?.value ?? null };
}
const EXTRACT_INBOX = `(() => {
  const text = node => node ? node.textContent.trim() : '';
  const sortDate = value => {
    const raw = String(value || '').toLowerCase();
    const spanish = raw.match(/(\d{1,2})[ ]+(ene|feb|mar|abr|may|jun|jul|ago|sept|set|oct|nov|dic)[ ]+(\d{4}),[ ]+(\d{1,2}):(\d{2})[^\d]*(a|p)\.?[ ]*m?\.?/i);
    const english = raw.match(/(?:[a-z]{3},[ ]+)?([a-z]{3})[ ]+(\d{1,2}),[ ]+(\d{4}),[ ]+(\d{1,2}):(\d{2})[ ]*(am|pm)/i);
    const months = { ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sept: 8, set: 8, oct: 9, nov: 10, dic: 11, jan: 0, apr: 3, aug: 7, sep: 8, dec: 11 };
    const match = spanish || english;
    if (!match) return 0;
    const month = months[spanish ? match[2] : match[1]];
    const day = Number(spanish ? match[1] : match[2]);
    const year = Number(spanish ? match[3] : match[3]);
    let hour = Number(spanish ? match[4] : match[4]) % 12;
    const suffix = spanish ? match[6] : match[6].slice(0, 1);
    if (suffix === 'p') hour += 12;
    return new Date(year, month, day, hour, Number(spanish ? match[5] : match[5])).getTime();
  };
  const directLink = row => {
    const href = [...row.querySelectorAll('a[href]')].map(link => link.getAttribute('href') || '').find(link => /#(?:inbox|all|starred|important|label)\//.test(link));
    if (!href) return null;
    try { return new URL(href, location.origin).href; } catch (_) { return null; }
  };
  const threadId = row => {
    const href = directLink(row);
    const token = href && href.match(/#(?:inbox|all|starred|important|label)\/([^/?#]+)/)?.[1];
    if (token) return token;
    const direct = row.getAttribute('data-thread-id') || row.querySelector('[data-thread-id]')?.getAttribute('data-thread-id');
    if (direct) return String(direct).replace(/^#/, '');
    const encoded = (row.getAttribute('jslog') || '').match(/(?:^|;)\\s*1:([^;]+)/)?.[1];
    if (!encoded) return '';
    try { return (atob(encoded.replace(/-/g, '+').replace(/_/g, '/')).match(/#?thread-[a-z]:\\d+/)?.[0] || '').replace(/^#/, ''); } catch (_) { return ''; }
  };
  const account = document.querySelector('meta[name="og-profile-acct"]')?.content || '';
  const accountIndex = (location.pathname.match(/\\/mail\\/u\\/(\\d+)/) || [])[1] || '0';
  const base = 'https://mail.google.com/mail/u/' + accountIndex + '/#inbox/';
  const emails = [...document.querySelectorAll('tr[role="row"], div[role="row"]')].map(row => { const unread = row.classList.contains('zE') || !!row.querySelector('.zE, .bqe, [aria-label*="Unread"]'); const id = threadId(row); const link = directLink(row); return { from: text(row.querySelector('.yW, .zF, [class*="sender"]')), subject: text(row.querySelector('.bog, .bqe, [class*="subject"]')), snippet: text(row.querySelector('.y2, .Zt, [class*="snippet"]')), date: (row.querySelector('td.xW span[title], td.xW [title], td.xW span')?.getAttribute('title') || text(row.querySelector('td.xW span, td.xW'))), dateSort: sortDate(row.querySelector('td.xW span[title], td.xW [title], td.xW span')?.getAttribute('title') || text(row.querySelector('td.xW span, td.xW'))), unread, threadId: id, url: link || (id ? base + id : base) }; }).filter(email => email.unread && (email.from || email.subject)).slice(0, ${MAX_MESSAGES});
  const titleUnread = document.title.match(/\\(([\\d,]+)\\)/);
  const signedOut = location.hostname === 'accounts.google.com' || !!document.querySelector('input[type="email"]') || /sign in/i.test(document.title);
  return JSON.stringify({ account, accountIndex, emails, unread: titleUnread ? parseInt(titleUnread[1].replace(/,/g, ''), 10) : emails.length, signedOut, notificationPermission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission });
})()`;
async function waitForInbox(evaluate) {
  // Switching Gmail identities often needs several SPA navigation cycles. A
  // manual refresh must wait for each account rather than sampling mid-load.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(1000);
    const raw = await evaluate(EXTRACT_INBOX);
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      if (data.account || data.signedOut) return data;
    } catch (_) {}
  }
  return null;
}
async function scanCandidate(candidate) {
  let launched = null;
  try {
    launched = await startBrowser(candidate);
    const page = (await cdpPages()).find(item => item.type === 'page');
    if (!page) throw new Error('CDP did not expose a page');
    const { ws, send, evaluate } = await connect(page);
    // Gmail's active session list is independent from Chrome's Preferences.
    // Probe every supported /u/N slot; the private five-minute cache keeps the
    // normal bar and popup path instant after this bounded discovery pass.
    const wanted = MAX_ACCOUNTS;
    const accounts = []; const emails = []; const seen = new Set(); let permission = '';
    for (let index = 0; index < wanted; index += 1) {
      await send('Page.navigate', { url: `https://mail.google.com/mail/u/${index}/#inbox` });
      const data = await waitForInbox(evaluate);
      if (!data) continue;
      if (data.signedOut || !data.account || seen.has(data.account)) continue;
      seen.add(data.account); permission = data.notificationPermission;
      const preference = badgePreferences()[data.account] || {};
      accounts.push({ email: data.account, unread: data.unread, initials: String(preference.initials || defaultInitials(data.account)).slice(0, 3), color: ['accent', 'urgent', 'foreground', 'muted', 'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'brown'].includes(preference.color) ? preference.color : 'accent', index: data.accountIndex });
      data.emails.forEach(email => emails.push({ ...email, dateSort: parseEmailDate(email.date), account: data.account, initials: String(preference.initials || defaultInitials(data.account)).slice(0, 3), color: ['accent', 'urgent', 'foreground', 'muted', 'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'brown'].includes(preference.color) ? preference.color : 'accent' }));
    }
    ws.close();
    if (!accounts.length) return null;
    // Include identities known by every installed browser profile. The reader
    // may legitimately fall back to Chromium when active Chrome blocks CDP,
    // but that must not hide Chrome-only accounts from the selector/settings.
    const source = sourceDetails(candidate);
    const knownEmails = [...new Set(source.known.flatMap(item => item.emails))];
    for (const email of knownEmails) {
      if (seen.has(email)) continue;
      const preference = badgePreferences()[email] || {};
      accounts.push({ email, unread: 0, initials: String(preference.initials || defaultInitials(email)).slice(0, 3), color: ['accent', 'urgent', 'foreground', 'muted', 'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'brown'].includes(preference.color) ? preference.color : 'accent', index: null, unavailable: true });
    }
    const cachedAccounts = retainStaleEmails(accounts, emails);
    // Combine account inboxes into one newest-first chronology for the ALL view.
    emails.sort((left, right) => Number(right.dateSort || 0) - Number(left.dateSort || 0));
    const notificationMessage = permission === 'denied' ? 'Browser notifications are disabled; Mailbox continues polling every 5 minutes.' : '';
    return { accounts, total: accounts.reduce((sum, account) => sum + account.unread, 0), emails, status: 'ok', source, cachedAccounts, staleAccounts: [], message: notificationMessage };
  } finally { if (launched) launched.kill('SIGTERM'); }
}
async function main() {
  const bridge = readBridge();
  if (bridge) { writeCache(bridge); return bridge; }
  const cached = readCache();
  if (cached) return cached;
  const candidates = browserCandidates();
  if (!candidates.length) return empty('unavailable', 'No supported browser profile was found. Open Gmail in your default browser, then configure a supported Mailbox source.');
  const errors = [];
  for (const candidate of candidates) {
    try {
      const result = await scanCandidate(candidate);
      if (result) { writeCache(result); return result; }
    } catch (error) { errors.push(error.message); }
  }
  const fallback = readPreviousSnapshot();
  if (fallback && Array.isArray(fallback.accounts) && Array.isArray(fallback.emails)) {
    const accounts = fallback.accounts.map(account => { const clean = { ...account, connectionState: 'unknown' }; delete clean.stale; delete clean.staleReason; return clean; });
    return { ...fallback, accounts, status: 'cached', cacheState: 'cached', staleAccounts: [], message: '', source: sourceDetails(null) };
  }
  return empty('login-required', `No signed-in Gmail Inbox could be read. ${errors[0] || 'Open Gmail in a supported browser profile and sign in.'}`);
}
main().then(result => console.log(JSON.stringify(applyLocalRead(result))));
