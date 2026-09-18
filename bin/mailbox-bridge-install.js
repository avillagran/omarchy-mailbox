#!/usr/bin/env node
// Installs Mailbox Local Bridge as a signed local CRX for Chrome-family
// browsers. This makes it visible in chrome://extensions without Developer
// Mode. It only writes user-owned browser configuration.
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..');
const extensionId = 'kjmlhpckodkmfcjmelnkknkaeiognoed';
const version = '0.0.2';
const host = path.join(root, 'bin', 'mailbox-bridge-host.js');
const crx = path.join(root, 'bridge-extension.crx');
const unpackedExtensionPaths = new Set([
  path.join(root, 'bridge-extension'),
  path.join(root, 'bridge-extension', 'source'),
]);
if (!fs.existsSync(crx)) throw new Error(`Missing packaged bridge: ${crx}`);
fs.chmodSync(host, 0o700);
const nativeManifest = { name: 'io.github.avillagran.mailbox', description: 'Mailbox local browser bridge', path: host, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] };
const homeConfig = path.join(os.homedir(), '.config');
const nativeRoots = [
  path.join(homeConfig, 'google-chrome', 'NativeMessagingHosts'),
  path.join(homeConfig, 'chromium', 'NativeMessagingHosts'),
  path.join(homeConfig, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
  path.join(homeConfig, 'BraveSoftware', 'Brave-Origin', 'NativeMessagingHosts')
];
for (const dir of nativeRoots) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'io.github.avillagran.mailbox.json'), JSON.stringify(nativeManifest), { mode: 0o600 });
}
const externalRoots = [
  path.join(homeConfig, 'google-chrome', 'External Extensions'),
  path.join(homeConfig, 'chromium', 'External Extensions'),
  path.join(homeConfig, 'BraveSoftware', 'Brave-Browser', 'External Extensions'),
  path.join(homeConfig, 'BraveSoftware', 'Brave-Origin', 'External Extensions')
];
const externalManifest = { external_crx: crx, external_version: version };
if (process.argv.includes('--uninstall')) {
  for (const dir of nativeRoots) fs.rmSync(path.join(dir, 'io.github.avillagran.mailbox.json'), { force: true });
  for (const dir of externalRoots) fs.rmSync(path.join(dir, `${extensionId}.json`), { force: true });
  console.log(JSON.stringify({ extensionId, removed: true, instruction: 'Restart the default browser to finish removing Mailbox Local Bridge.' }));
  process.exit(0);
}
for (const dir of externalRoots) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${extensionId}.json`), JSON.stringify(externalManifest), { mode: 0o600 });
}
// Do not load a second unpacked copy beside the signed CRX.
for (const filename of ['chrome-flags.conf', 'chromium-flags.conf', 'brave-flags.conf', 'brave-origin-flags.conf']) {
  const file = path.join(homeConfig, filename);
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(line => {
    if (!line.startsWith('--load-extension=')) return line;
    const paths = line.slice('--load-extension='.length).split(',').filter(item => item && !unpackedExtensionPaths.has(item));
    return paths.length ? '--load-extension=' + paths.join(',') : '';
  });
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
}
console.log(JSON.stringify({ extensionId, version, crx, instruction: 'Restart the browser once. Mailbox Local Bridge will appear in chrome://extensions and collect open Gmail and HEY tabs.' }));
