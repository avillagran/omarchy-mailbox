#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const id = 'ljaeaiekecpbmpkcknojllebemmbockk';
const latestVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'bridge-extension', 'manifest.json'), 'utf8')).version;
let browser = '';
try { browser = execFileSync('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8' }).trim(); } catch (_) {}

let profileRoot;
let registryFiles;
if (/brave/i.test(browser)) {
  profileRoot = path.join(os.homedir(), '.config', 'BraveSoftware', 'Brave-Browser');
  registryFiles = [`/opt/brave.com/brave/extensions/${id}.json`];
} else if (/chromium/i.test(browser)) {
  profileRoot = path.join(os.homedir(), '.config', 'chromium');
  registryFiles = [`/usr/share/chromium/extensions/${id}.json`, `/etc/chromium/extensions/${id}.json`];
} else {
  profileRoot = path.join(os.homedir(), '.config', 'google-chrome');
  registryFiles = [`/opt/google/chrome/extensions/${id}.json`];
}

let profile = 'Default';
try {
  const state = JSON.parse(fs.readFileSync(path.join(profileRoot, 'Local State'), 'utf8'));
  profile = state.profile?.last_used || profile;
} catch (_) {}
let loadedVersion = '';
let stagedVersion = '';
try {
  const prefs = JSON.parse(fs.readFileSync(path.join(profileRoot, profile, 'Preferences'), 'utf8'));
  const setting = prefs.extensions?.settings?.[id] || {};
  loadedVersion = setting.manifest?.version || '';
  stagedVersion = setting.idle_install_info?.manifest?.version || '';
} catch (_) {}
let registeredVersion = '';
for (const file of registryFiles) {
  try {
    registeredVersion = JSON.parse(fs.readFileSync(file, 'utf8')).external_version || '';
    if (registeredVersion) break;
  } catch (_) {}
}
const installed = Boolean(loadedVersion || registeredVersion);
const upToDate = loadedVersion === latestVersion;
const removalReady = Boolean(loadedVersion && !registeredVersion);
const updateReady = !removalReady && (stagedVersion === latestVersion || registeredVersion === latestVersion) && !upToDate;
console.log(JSON.stringify({ browser: browser || 'unknown', profile, installed, loadedVersion, stagedVersion, registeredVersion, latestVersion, upToDate, updateReady, removalReady }));
