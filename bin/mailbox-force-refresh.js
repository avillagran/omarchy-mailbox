#!/usr/bin/env node
// Opens the Mailbox extension command in the configured default browser,
// bypassing xdg-open's incorrect scheme handler selection for chrome-extension.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const url = 'chrome-extension://kjmlhpckodkmfcjmelnkknkaeiognoed/refresh.html';
const selectedBrowser = ['--chromium', '--brave', '--chrome'].find(flag => process.argv.includes(flag));
const status = JSON.parse(execFileSync(process.execPath,
  [path.join(__dirname, 'mailbox-bridge-status.js'), ...(selectedBrowser ? [selectedBrowser] : [])], { encoding: 'utf8' }));
if (!status.upToDate) throw new Error('Mailbox Local Bridge is not configured in this browser. Install it in Chromium or Brave from Mailbox preferences, or use Set up Chrome, then Developer mode → Load unpacked.');
const desktop = status.browser;
const chromiumFamily = /(chrome|chromium|brave|vivaldi|microsoft-edge)/i;
if (!chromiumFamily.test(desktop)) throw new Error(`The default browser does not support the installed Chromium extension: ${desktop}`);
const roots = [path.join(os.homedir(), '.local', 'share', 'applications'), '/usr/share/applications'];
const desktopFile = roots.map(root => path.join(root, desktop)).find(file => fs.existsSync(file));
if (!desktopFile) throw new Error(`Default browser launcher not found: ${desktop}`);
const child = spawn('gio', ['launch', desktopFile, url], { detached: true, stdio: 'ignore' });
child.unref();
console.log(JSON.stringify({ browser: desktop, requested: true }));
