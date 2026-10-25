#!/usr/bin/env node
// Records an explicit Gmail account selection. The address arrives on stdin so it
// never shows in process arguments.
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { readStdinJson, LIMITS } = require(path.join(__dirname, 'mailbox-bounded-read.js'));
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
readStdinJson(LIMITS.small).then(request => {
  const email = String(request.email || '').trim().toLowerCase();
  if (!valid(email) || email.length > 320) process.exit(2);
  atomicWrite(path.join(cacheDir, 'pending-account.json'), JSON.stringify({ email, requestedAt: Date.now() }));
}).catch(error => { console.error(error.message); process.exit(1); });
