#!/usr/bin/env node
// Local reply drafts. The panel saves what you type here as you write, so a
// crash or a closed panel never loses it. "open" hands the draft to the browser
// extension, which opens the reply in your account with the text filled in;
// sending stays in Gmail or HEY. Commands read one JSON line from stdin:
//   list | load | save | discard | open [--chromium|--brave|--chrome]
// list needs no input and returns which threads have a draft, without text.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson } = require(path.join(__dirname, 'mailbox-bounded-read.js'));

const DRAFTS_DIR = path.join(os.homedir(), '.local', 'state', 'omarchy', 'mailbox', 'drafts');
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_TEXT = 200000;
const MAX_DRAFT_BYTES = 1024 * 1024;
const MAX_LISTED = 500;

function draftId(account, threadId) {
  return crypto.createHash('sha256').update(`${account}\0${threadId}`).digest('hex').slice(0, 32);
}
function draftFile(id) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid draft id');
  return path.join(DRAFTS_DIR, `${id}.json`);
}
// Only provider pages: Gmail threads are rebuilt from a validated slot index
// and thread id; HEY keeps its own path.
function replyUrl(request) {
  if (request.provider === 'hey') {
    const url = String(request.url || '');
    return /^https:\/\/app\.hey\.com\/[A-Za-z0-9/_-]{1,256}$/.test(url) ? url : '';
  }
  const index = /^[0-9]{1,3}$/.test(String(request.index || '')) ? String(request.index) : '0';
  const threadId = String(request.threadId || '');
  return /^[A-Za-z0-9_-]{1,128}$/.test(threadId) ? `https://mail.google.com/mail/u/${index}/#inbox/${threadId}` : '';
}
// Replace a user-owned file atomically: random temp name, O_EXCL|O_NOFOLLOW, no symlinked target.
function atomicWrite(file, text) {
  let stat = null;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat && (!stat.isFile() || stat.uid !== process.getuid())) throw new Error(`Unsafe file: ${file}`);
  const temp = `${file}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, text);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }
}
function ensureDir() {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(DRAFTS_DIR);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error(`Unsafe directory: ${DRAFTS_DIR}`);
}
function readRequest() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) { reject(new Error('Draft too large')); process.stdin.destroy(); return; }
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      process.stdin.destroy();
      try { resolve(JSON.parse(text.slice(0, newline))); } catch (error) { reject(error); }
    });
    process.stdin.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (error) { reject(error); } });
    process.stdin.on('error', reject);
  });
}
function loadDraft(id) {
  try { return readJson(draftFile(id), MAX_DRAFT_BYTES); } catch (_) { return null; }
}
function saveDraft(request, extra = {}) {
  const account = String(request.account || '').slice(0, 320);
  const threadId = String(request.threadId || '').slice(0, 256);
  if (!account || !threadId) throw new Error('A reply needs an account and a thread');
  const id = draftId(account, threadId);
  const previous = loadDraft(id) || {};
  const draft = {
    schemaVersion: 1, id, account, threadId,
    provider: request.provider === 'hey' ? 'hey' : 'gmail',
    url: replyUrl(request),
    to: String(request.from || '').slice(0, 512),
    subject: String(request.subject || '').slice(0, 1024),
    text: String(request.text || '').slice(0, MAX_TEXT),
    createdAt: Number(previous.createdAt || Date.now()),
    savedAt: Date.now(),
    handedOffAt: Number(previous.handedOffAt || 0),
    ...extra,
  };
  ensureDir();
  atomicWrite(draftFile(id), JSON.stringify(draft));
  return draft;
}

function listDrafts() {
  const names = [];
  let dir;
  try { dir = fs.opendirSync(DRAFTS_DIR); } catch (_) { return []; }
  try {
    for (let entry = dir.readSync(); entry && names.length < MAX_LISTED; entry = dir.readSync()) {
      if (entry.isFile() && /^[a-f0-9]{32}\.json$/.test(entry.name)) names.push(entry.name.slice(0, 32));
    }
  } finally { dir.closeSync(); }
  return names.map(loadDraft).filter(draft => draft && String(draft.text || '').trim())
    .map(draft => ({ account: draft.account, threadId: draft.threadId, savedAt: Number(draft.savedAt || 0) }));
}

async function main() {
  const command = process.argv[2];
  if (command === 'list') { console.log(JSON.stringify({ drafts: listDrafts() })); return; }
  const request = await readRequest();
  if (command === 'load') {
    const draft = loadDraft(draftId(String(request.account || ''), String(request.threadId || '')));
    console.log(JSON.stringify(draft ? { text: draft.text, savedAt: draft.savedAt, handedOffAt: draft.handedOffAt } : {}));
  } else if (command === 'save') {
    const draft = saveDraft(request);
    console.log(JSON.stringify({ id: draft.id, savedAt: draft.savedAt }));
  } else if (command === 'discard') {
    fs.rmSync(draftFile(draftId(String(request.account || ''), String(request.threadId || ''))), { force: true });
    console.log(JSON.stringify({ discarded: true }));
  } else if (command === 'open') {
    const draft = saveDraft(request, { handedOffAt: Date.now() });
    if (!draft.url) throw new Error('This message has no reply link');
    // The text is also left on the clipboard in case the page changes.
    const { copyText } = require(path.join(__dirname, 'mailbox-open-browser-extensions.js'));
    await copyText(draft.text).catch(() => {});
    const { openExtensionPage } = require(path.join(__dirname, 'mailbox-force-refresh.js'));
    const flag = ['--chromium', '--brave', '--chrome'].find(value => process.argv.includes(value));
    const browser = openExtensionPage(`reply.html#${draft.id}`, flag);
    console.log(JSON.stringify({ id: draft.id, savedAt: draft.savedAt, browser }));
  } else {
    throw new Error('Use load, save, discard or open');
  }
}

module.exports = { DRAFTS_DIR, draftId, draftFile, replyUrl };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
