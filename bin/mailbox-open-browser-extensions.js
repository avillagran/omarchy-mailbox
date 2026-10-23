#!/usr/bin/env node
// Guide a user through the browser's own unpacked-extension installation UI.
// Google Chrome ignores --load-extension and has no per-user external
// registration on Linux, so the user loads the unpacked folder once.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const extensionPath = path.resolve(__dirname, '..', 'bridge-extension', 'source');
if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) throw new Error(`Missing extension: ${extensionPath}`);
const browser = process.argv[2];
if (!['--chrome', '--brave'].includes(browser)) throw new Error('Select --chrome or --brave');
const names = browser === '--brave' ? ['brave-browser.desktop', 'brave.desktop'] : ['google-chrome.desktop', 'google-chrome-stable.desktop'];
const roots = [path.join(os.homedir(), '.local', 'share', 'applications'), '/usr/share/applications'];
const desktopFile = roots.flatMap(root => names.map(name => path.join(root, name))).find(file => fs.existsSync(file));
if (!desktopFile) throw new Error(`Browser launcher not found: ${browser}`);
const desktop = path.basename(desktopFile);
// wl-copy forks a clipboard owner that inherits stdout/stderr. Piped stdio
// makes spawnSync wait for that owner until timeout even after wl-copy exits.
const copy = spawnSync('wl-copy', [extensionPath], { stdio: 'ignore', timeout: 5000 });
if (copy.error || copy.status !== 0) throw new Error(`Could not copy extension directory: ${copy.error?.message || `wl-copy exited with status ${copy.status}`}`);
// Chrome rewrites chrome://extensions passed by an external launcher to a new
// tab. Open the browser normally and show its own menu steps in Mailbox.
const url = 'about:blank';
async function openBrowser() {
  // The forked clipboard owner may not publish the selection before wl-copy exits.
  // Verify it before claiming setup is ready for Load unpacked.
  const deadline = Date.now() + 2000;
  let confirmed = false;
  do {
    const pasted = spawnSync('wl-paste', ['--no-newline'], { encoding: 'utf8', timeout: 500 });
    if (pasted.error?.code === 'ENOENT') throw new Error('wl-paste is not installed');
    if (pasted.status === 0 && pasted.stdout === extensionPath) { confirmed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  if (!confirmed) throw new Error('The extension directory was not available on the Wayland clipboard');
  const child = spawn('gio', ['launch', desktopFile, url], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  console.log(JSON.stringify({ browser: desktop, extensionPath, requested: url, copied: true }));
}
openBrowser().catch(error => { console.error(`Could not open browser extensions: ${error.message}`); process.exitCode = 1; });
