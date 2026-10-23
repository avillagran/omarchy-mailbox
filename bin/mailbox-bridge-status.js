#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readText, readJson, LIMITS } = require(path.join(__dirname, 'mailbox-bounded-read.js'));
const { execFileSync } = require('child_process');

const id = 'kjmlhpckodkmfcjmelnkknkaeiognoed';
const root = path.resolve(__dirname, '..');
const extensionPath = path.join(root, 'bridge-extension', 'source');
const hostPath = path.join(root, 'bin', 'mailbox-bridge-host.js');
const latestVersion = readJson(path.join(extensionPath, 'manifest.json'), LIMITS.small).version;
let browser = '';
try { browser = execFileSync('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8' }).trim(); } catch (_) {}
// Match the installed launcher variant that the guided setup itself opens.
function installedLauncher(names) {
  const roots = [path.join(os.homedir(), '.local', 'share', 'applications'), '/usr/share/applications'];
  for (const dir of roots) {
    for (const name of names) {
      if (fs.existsSync(path.join(dir, name))) return name;
    }
  }
  return names[0];
}
if (process.argv.includes('--chromium')) browser = installedLauncher(['chromium.desktop']);
else if (process.argv.includes('--brave')) browser = installedLauncher(['brave-browser.desktop', 'brave.desktop']);
else if (process.argv.includes('--chrome')) browser = installedLauncher(['google-chrome.desktop', 'google-chrome-stable.desktop']);

const isBrave = /brave/i.test(browser);
const isChromium = !isBrave && /chromium/i.test(browser);
let profileRoot;
if (isBrave) profileRoot = path.join(os.homedir(), '.config', 'BraveSoftware', /origin/i.test(browser) ? 'Brave-Origin' : 'Brave-Browser');
else if (isChromium) profileRoot = path.join(os.homedir(), '.config', 'chromium');
else profileRoot = path.join(os.homedir(), '.config', 'google-chrome');
// Chromium and Brave load the bundled extension from the user's own flags file.
// Google Chrome ignores --load-extension, so it has no flags file here.
const flagsFile = isBrave ? path.join(os.homedir(), '.config', /origin/i.test(browser) ? 'brave-origin-flags.conf' : 'brave-flags.conf')
  : isChromium ? path.join(os.homedir(), '.config', 'chromium-flags.conf') : '';

let profile = 'Default';
try {
  const state = readJson(path.join(profileRoot, 'Local State'), LIMITS.browserState);
  const lastUsed = String(state.profile?.last_used || '');
  // Profile directory names are plain names such as Default or Profile 2.
  if (/^[A-Za-z0-9 _.-]{1,64}$/.test(lastUsed) && !lastUsed.includes('..')) profile = lastUsed;
} catch (_) {}
let loadedVersion = '';
let stagedVersion = '';
let active = false;
let loadedPath = '';
let unpacked = false;
let commandLine = false;
let stateMissing = false;
let developerMode = false;
let disabled = false;
try {
  const prefs = readJson(path.join(profileRoot, profile, 'Preferences'), LIMITS.browserState);
  const setting = prefs.extensions?.settings?.[id] || {};
  loadedVersion = setting.manifest?.version || '';
  stagedVersion = setting.idle_install_info?.manifest?.version || '';
  active = setting.state === 1;
  loadedPath = setting.path || '';
  unpacked = (setting.location === 4 || setting.location === 8) && loadedPath === extensionPath;
  commandLine = setting.location === 8;
  stateMissing = setting.state === undefined;
  disabled = Array.isArray(setting.disable_reasons) ? setting.disable_reasons.length > 0 : Boolean(setting.disable_reasons);
  // Signed-in profiles keep the Extensions page toggle under account_values.
  developerMode = prefs.extensions?.ui?.developer_mode === true || prefs.account_values?.extensions?.ui?.developer_mode === true;
} catch (_) {}
// Browsers do not cache the manifest for unpacked extensions in Preferences.
// Read the bundled manifest only for an entry loaded from this exact directory.
if (unpacked) loadedVersion = latestVersion;
const nativeFile = path.join(profileRoot, 'NativeMessagingHosts', 'io.github.avillagran.mailbox.json');
let nativeReady = false;
try {
  const manifest = readJson(nativeFile, LIMITS.small);
  nativeReady = manifest.path === hostPath && manifest.allowed_origins?.includes(`chrome-extension://${id}/`)
    && fs.statSync(hostPath).isFile() && (fs.statSync(hostPath).mode & 0o111) !== 0;
} catch (_) {}
// Retain the live bridge's runtime-health diagnostics without treating a stale or
// other-browser health report as proof of installation or readiness.
let runtimeVersion = '';
for (const name of ['bridge-health.json', 'bridge-diagnostics.json']) {
  try {
    const health = readJson(path.join(os.homedir(), '.cache', 'omarchy', 'mailbox', name), LIMITS.config);
    if (Date.now() - Number(health.receivedAt || health.capturedAt || 0) <= 2 * 60 * 1000 && health.bridgeVersion) {
      runtimeVersion = String(health.bridgeVersion);
      break;
    }
  } catch (_) {}
}
const installed = Boolean(loadedPath || loadedVersion);
// Earlier releases registered a system-wide external extension. Mailbox never
// touches those root-owned files; it only reports them so an administrator can
// remove them, because a system registration overrides the user's copy.
const legacyRoot = process.env.MAILBOX_LEGACY_REGISTRY_ROOT || '/';
const legacyDirs = isBrave ? ['opt/brave.com/brave/extensions']
  : isChromium ? ['usr/share/chromium/extensions', 'etc/chromium/extensions']
  : ['opt/google/chrome/extensions', 'usr/share/google-chrome/extensions'];
const legacyRegistration = legacyDirs.some(dir => fs.existsSync(path.join(legacyRoot, dir, `${id}.json`)));
let flagsConfigured = false;
if (flagsFile) {
  try {
    const flagsStat = fs.lstatSync(flagsFile);
    if (flagsStat.isFile() && flagsStat.uid === process.getuid()) {
      flagsConfigured = readText(flagsFile, LIMITS.settings).split(/\r?\n/).some(line =>
        line.startsWith('--load-extension=') && line.slice('--load-extension='.length).split(',').includes(extensionPath));
    }
  } catch (_) {}
}
// Command-line extensions can omit `state` from Preferences even when loaded.
// Require both the exact installed path and our current startup flag.
if (commandLine && stateMissing && unpacked && flagsConfigured) active = true;
// Recent Chrome releases also omit `state` for enabled unpacked extensions and
// record `disable_reasons` only when the user turns one off.
if (!commandLine && stateMissing && unpacked && !disabled) active = true;
// Unpacked copies read the manifest from disk, so a plugin update only reaches
// the browser after a reload. A fresh runtime report from an older copy says so.
const staleRuntime = Boolean(runtimeVersion) && runtimeVersion !== latestVersion;
const upToDate = active && nativeReady && unpacked && (!commandLine || flagsConfigured)
  && loadedVersion === latestVersion && !staleRuntime && !legacyRegistration;
const removalReady = installed && !nativeReady && fs.existsSync(path.join(os.homedir(), '.config', 'omarchy', 'mailbox-bridge-removing'));
const updateReady = !removalReady && installed && !upToDate;
console.log(JSON.stringify({ browser: browser || 'unknown', profile, installed, loadedVersion, stagedVersion, runtimeVersion,
  registrationMode: unpacked ? (commandLine ? 'user-flags' : 'user-unpacked') : 'none', extensionPath, latestVersion,
  developerMode, flagsFile, flagsConfigured, automatic: Boolean(flagsFile), upToDate, updateReady, removalReady, legacyRegistration }));
