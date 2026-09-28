#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const id = 'kjmlhpckodkmfcjmelnkknkaeiognoed';
const root = path.resolve(__dirname, '..');
const extensionPath = path.join(root, 'bridge-extension', 'source');
const hostPath = path.join(root, 'bin', 'mailbox-bridge-host.js');
const latestVersion = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8')).version;
let browser = '';
try { browser = execFileSync('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8' }).trim(); } catch (_) {}

let profileRoot;
if (/brave/i.test(browser)) {
  profileRoot = path.join(os.homedir(), '.config', 'BraveSoftware', 'Brave-Browser');
} else if (/chromium/i.test(browser)) {
  profileRoot = path.join(os.homedir(), '.config', 'chromium');
} else {
  profileRoot = path.join(os.homedir(), '.config', 'google-chrome');
}

let profile = 'Default';
try {
  const state = JSON.parse(fs.readFileSync(path.join(profileRoot, 'Local State'), 'utf8'));
  profile = state.profile?.last_used || profile;
} catch (_) {}
let loadedVersion = '';
let stagedVersion = '';
let active = false;
let loadedPath = '';
let unpacked = false;
try {
  const prefs = JSON.parse(fs.readFileSync(path.join(profileRoot, profile, 'Preferences'), 'utf8'));
  const setting = prefs.extensions?.settings?.[id] || {};
  loadedVersion = setting.manifest?.version || '';
  stagedVersion = setting.idle_install_info?.manifest?.version || '';
  active = setting.state === 1;
  loadedPath = setting.path || '';
  unpacked = setting.location === 4 && loadedPath === extensionPath;
} catch (_) {}
// Chromium does not cache the manifest for unpacked extensions in Preferences.
// Read the bundled manifest only for an entry loaded from this exact directory.
if (unpacked) loadedVersion = latestVersion;
const nativeFile = path.join(profileRoot, 'NativeMessagingHosts', 'io.github.avillagran.mailbox.json');
let nativeReady = false;
try {
  const manifest = JSON.parse(fs.readFileSync(nativeFile, 'utf8'));
  nativeReady = manifest.path === hostPath && manifest.allowed_origins?.includes(`chrome-extension://${id}/`)
    && fs.statSync(hostPath).isFile() && (fs.statSync(hostPath).mode & 0o111) !== 0;
} catch (_) {}
const installed = Boolean(loadedPath || loadedVersion);
const legacyRoot = process.env.MAILBOX_LEGACY_REGISTRY_ROOT || '/';
const legacyFiles = /brave/i.test(browser) ? ['opt/brave.com/brave/extensions']
  : /chromium/i.test(browser) ? ['usr/share/chromium/extensions', 'etc/chromium/extensions']
  : ['opt/google/chrome/extensions'];
const legacyRegistration = legacyFiles.some(dir => fs.existsSync(path.join(legacyRoot, dir, `${id}.json`)));
const upToDate = active && nativeReady && unpacked && loadedVersion === latestVersion && !legacyRegistration;
const removalReady = installed && !nativeReady && fs.existsSync(path.join(os.homedir(), '.config', 'omarchy', 'mailbox-bridge-removing'));
const updateReady = !removalReady && installed && !upToDate;
console.log(JSON.stringify({ browser: browser || 'unknown', profile, installed, loadedVersion, stagedVersion, registeredVersion: '', latestVersion, upToDate, updateReady, removalReady, legacyRegistration }));
