#!/usr/bin/env node
// Prepare the user-owned Native Messaging host. Chrome/Chromium/Brave load
// bridge-extension/source through their own Load unpacked UI; no root needed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..');
const extensionId = 'kjmlhpckodkmfcjmelnkknkaeiognoed';
const extensionPath = path.join(root, 'bridge-extension', 'source');
const version = '0.0.3';
const host = path.join(root, 'bin', 'mailbox-bridge-host.js');
const remove = process.argv.includes('--uninstall');
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
for (const browserRoot of browserRoots) {
  const nativeDir = path.join(browserRoot, 'NativeMessagingHosts');
  const nativeFile = path.join(nativeDir, `${manifest.name}.json`);
  // Remove only our old, user-owned CRX registrations. They are not a
  // supported installation path for branded Chrome on Linux.
  const legacyFile = path.join(browserRoot, 'External Extensions', `${extensionId}.json`);
  if (remove) {
    fs.rmSync(nativeFile, { force: true });
    fs.rmSync(legacyFile, { force: true });
  } else {
    fs.mkdirSync(nativeDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(nativeFile, JSON.stringify(manifest), { mode: 0o600 });
    fs.rmSync(legacyFile, { force: true });
  }
}
if (!remove) {
  fs.rmSync(removalMarker, { force: true });
  fs.chmodSync(host, 0o700);
  // Drop only our obsolete unpacked flags, preserving other extensions.
  for (const filename of ['chrome-flags.conf', 'chromium-flags.conf', 'brave-flags.conf', 'brave-origin-flags.conf']) {
    const file = path.join(homeConfig, filename);
    if (!fs.existsSync(file)) continue;
    const obsolete = new Set([path.join(root, 'bridge-extension'), extensionPath]);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(line => {
      if (!line.startsWith('--load-extension=')) return line;
      const paths = line.slice('--load-extension='.length).split(',').filter(item => item && !obsolete.has(item));
      return paths.length ? '--load-extension=' + paths.join(',') : '';
    });
    fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  }
} else {
  fs.mkdirSync(path.dirname(removalMarker), { recursive: true, mode: 0o700 });
  fs.writeFileSync(removalMarker, '', { mode: 0o600 });
}
console.log(JSON.stringify({ extensionId, version, extensionPath, removed: remove,
  instruction: remove ? 'Remove Mailbox Local Bridge in chrome://extensions.' :
    `In chrome://extensions enable Developer mode, choose Load unpacked, and select ${extensionPath}.` }));
