#!/usr/bin/env node
// Opens the Mailbox extension command in the configured default browser,
// bypassing xdg-open's incorrect scheme handler selection for chrome-extension.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const url = 'chrome-extension://kjmlhpckodkmfcjmelnkknkaeiognoed/refresh.html';
const desktop = execFileSync('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8' }).trim();
const chromiumFamily = /(chrome|chromium|brave|vivaldi|microsoft-edge)/i;
if (!chromiumFamily.test(desktop)) throw new Error(`The default browser does not support the installed Chromium extension: ${desktop}`);
const roots = [path.join(os.homedir(), '.local', 'share', 'applications'), '/usr/share/applications'];
const desktopFile = roots.map(root => path.join(root, desktop)).find(file => fs.existsSync(file));
if (!desktopFile) throw new Error(`Default browser launcher not found: ${desktop}`);
const child = spawn('gio', ['launch', desktopFile, url], { detached: true, stdio: 'ignore' });
child.unref();
console.log(JSON.stringify({ browser: desktop, requested: true }));
