#!/usr/bin/env node
// Register the Mailbox Local Bridge for the current user only.
// Writes per-user Native Messaging host manifests and, for Chromium or Brave,
// the user's own startup flags file so the bundled extension loads on the next
// start. Nothing here needs administrator access, system policies or downloads.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readText, readJson, LIMITS } = require(path.join(__dirname, 'mailbox-bounded-read.js'));
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const extensionId = 'kjmlhpckodkmfcjmelnkknkaeiognoed';
const extensionPath = path.join(root, 'bridge-extension', 'source');
const version = '0.0.7';
const host = path.join(root, 'bin', 'mailbox-bridge-host.js');
const remove = process.argv.includes('--remove') || process.argv.includes('--uninstall');
// Browsers that honour --load-extension from their user flags file. Omarchy
// loads its own copy-url and yt-dlp extensions the same way. Google Chrome
// ignores the flag, so it keeps the guided Load unpacked path instead.
const flagsTargets = { chromium: 'chromium-flags.conf', brave: 'brave-flags.conf' };
const target = remove ? '' : Object.keys(flagsTargets).find(name => process.argv.includes(`--${name}`)) || '';
if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) throw new Error(`Missing extension: ${extensionPath}`);
const homeConfig = path.join(os.homedir(), '.config');
const removalMarker = path.join(homeConfig, 'omarchy', 'mailbox-bridge-removing');
const browserRoots = [
  path.join(homeConfig, 'google-chrome'),
  path.join(homeConfig, 'chromium'),
  path.join(homeConfig, 'BraveSoftware', 'Brave-Browser'),
  path.join(homeConfig, 'BraveSoftware', 'Brave-Origin')
];
const manifest = {
  name: 'io.github.avillagran.mailbox',
  description: 'Mailbox local browser bridge', path: host, type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`]
};
function safeStat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function safeDirectory(dir, create = false) {
  const home = path.resolve(os.homedir());
  const relative = path.relative(home, dir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Outside HOME: ${dir}`);
  let current = home;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let stat = safeStat(current);
    if (!stat && create) {
      fs.mkdirSync(current, { mode: 0o700 });
      stat = safeStat(current);
    }
    if (!stat) return false;
    if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error(`Unsafe directory: ${current}`);
  }
  return true;
}
function safeFile(file) {
  const stat = safeStat(file);
  if (stat && (!stat.isFile() || stat.uid !== process.getuid())) throw new Error(`Unsafe file: ${file}`);
  return stat;
}
function atomicWrite(file, text) {
  safeDirectory(path.dirname(file), true);
  safeFile(file);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(16).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    safeFile(file);
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }
}
// Validate all pre-existing paths before changing anything. A normal file is
// replaced atomically; a symlink (including a parent directory) is refused.
const nativeFiles = browserRoots.map(browserRoot => ({
  nativeDir: path.join(browserRoot, 'NativeMessagingHosts'),
  nativeFile: path.join(browserRoot, 'NativeMessagingHosts', `${manifest.name}.json`),
  legacyDir: path.join(browserRoot, 'External Extensions'),
  legacyFile: path.join(browserRoot, 'External Extensions', `${extensionId}.json`)
}));
const flagsFiles = ['chrome-flags.conf', 'chromium-flags.conf', 'brave-flags.conf', 'brave-origin-flags.conf']
  .map(filename => path.join(homeConfig, filename));
// Installation touches only the selected browser's flags file, so Chromium and
// Brave registrations can coexist. Removal cleans Mailbox entries from every
// flags file that already exists as a plain user-owned file.
function plainUserFile(file) { const stat = safeStat(file); return Boolean(stat && stat.isFile() && stat.uid === process.getuid()); }
const touchedFlags = flagsFiles.filter(file => remove ? plainUserFile(file) : path.basename(file) === flagsTargets[target]);
safeDirectory(homeConfig);
safeDirectory(path.dirname(removalMarker));
safeFile(removalMarker);
for (const item of nativeFiles) {
  safeDirectory(item.nativeDir);
  safeDirectory(item.legacyDir);
  safeFile(item.nativeFile);
  safeFile(item.legacyFile);
}
for (const file of touchedFlags) safeFile(file);
if (!remove) {
  const hostStat = fs.lstatSync(host);
  if (!hostStat.isFile() || (hostStat.mode & 0o111) === 0) throw new Error(`Unsafe native host: ${host}`);
}
// Preserve unrelated browser flags and extension paths.
function rewriteFlags(file, enable) {
  const stat = safeFile(file);
  if (!stat && !enable) return;
  const original = stat ? readText(file, LIMITS.settings) : '';
  const oldPaths = new Set([path.join(root, 'bridge-extension'), extensionPath]);
  const lines = original ? original.split(/\r?\n/) : [];
  const paths = [];
  let insertion = -1;
  const retained = [];
  for (const line of lines) {
    if (!line.startsWith('--load-extension=')) { retained.push(line); continue; }
    if (insertion < 0) insertion = retained.length;
    for (const item of line.slice('--load-extension='.length).split(',')) {
      if (item && !oldPaths.has(item) && !paths.includes(item)) paths.push(item);
    }
  }
  if (enable) paths.push(extensionPath);
  if (paths.length) retained.splice(insertion < 0 ? retained.length : insertion, 0, '--load-extension=' + paths.join(','));
  const updated = retained.join('\n');
  if (updated !== original) atomicWrite(file, updated);
}
for (const { nativeFile, legacyFile } of nativeFiles) {
  if (remove) fs.rmSync(nativeFile, { force: true });
  else atomicWrite(nativeFile, JSON.stringify(manifest));
  // Remove only our old user-owned registration file from earlier releases.
  fs.rmSync(legacyFile, { force: true });
}
if (!remove) fs.rmSync(removalMarker, { force: true });
for (const file of touchedFlags) rewriteFlags(file, !remove && path.basename(file) === flagsTargets[target]);
if (remove) atomicWrite(removalMarker, '');
const browserName = target === 'brave' ? 'Brave' : 'Chromium';
console.log(JSON.stringify({ extensionId, version, extensionPath, removed: remove, flagsConfigured: target, flagsFile: target ? path.join(homeConfig, flagsTargets[target]) : '',
  instruction: remove ? 'Quit and reopen the browser, or remove Mailbox Local Bridge from its Extensions page, to finish.' :
    target ? `Quit and reopen ${browserName} to activate Mailbox Local Bridge.` :
    `In chrome://extensions enable Developer mode, choose Load unpacked, and select ${extensionPath}.` }));
