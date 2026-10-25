#!/usr/bin/env node
// Open the browser for the guided Chrome connection window.
// Google Chrome ignores --load-extension and has no per-user external
// registration on Linux, so the user loads the unpacked folder once.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const extensionPath = path.resolve(__dirname, '..', 'bridge-extension', 'source');

function browserLauncher(browser) {
  if (!['--chrome', '--brave'].includes(browser)) throw new Error('Select --chrome or --brave');
  const names = browser === '--brave' ? ['brave-browser.desktop', 'brave.desktop'] : ['google-chrome.desktop', 'google-chrome-stable.desktop'];
  const roots = [path.join(os.homedir(), '.local', 'share', 'applications'), '/usr/share/applications'];
  const desktopFile = roots.flatMap(root => names.map(name => path.join(root, name))).find(file => fs.existsSync(file));
  if (!desktopFile) throw new Error(`Browser launcher not found: ${browser}`);
  return desktopFile;
}

async function copyText(text) {
  // The text goes over stdin, never argv: a reply may be private and process
  // arguments are visible to other local accounts. wl-copy forks a clipboard
  // owner that inherits stdout/stderr; piped stdout/stderr would make spawnSync
  // wait for that owner until timeout even after wl-copy exits.
  const copy = spawnSync('wl-copy', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
  if (copy.error || copy.status !== 0) throw new Error(`Could not copy to the clipboard: ${copy.error?.message || `wl-copy exited with status ${copy.status}`}`);
  // The forked clipboard owner may not publish the selection before wl-copy exits.
  // Verify it before telling the user to paste.
  const deadline = Date.now() + 2000;
  do {
    const pasted = spawnSync('wl-paste', ['--no-newline'], { encoding: 'utf8', timeout: 500, maxBuffer: Buffer.byteLength(text) + 1024 });
    if (pasted.error?.code === 'ENOENT') throw new Error('wl-paste is not installed');
    if (pasted.status === 0 && pasted.stdout === text) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('The text was not available on the Wayland clipboard');
}

async function launchBrowser(desktopFile, url) {
  const child = spawn('gio', ['launch', desktopFile, url], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}

// Fixed destinations only; the panel never passes a URL through.
const PAGES = {
  // Chrome rewrites chrome://extensions passed by an external launcher to a new
  // tab, so open the browser and leave the address on the clipboard to paste.
  extensions: { url: 'about:blank', copy: 'chrome://extensions' },
  gmail: { url: 'https://mail.google.com/mail/' },
  hey: { url: 'https://app.hey.com/' },
};

async function main() {
  if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) throw new Error(`Missing extension: ${extensionPath}`);
  const desktopFile = browserLauncher(process.argv[2]);
  const target = process.argv[3] || 'extensions';
  const page = Object.hasOwn(PAGES, target) ? PAGES[target] : null;
  if (!page) throw new Error('Select extensions, gmail or hey');
  if (page.copy) await copyText(page.copy);
  await launchBrowser(desktopFile, page.url);
  console.log(JSON.stringify({ browser: path.basename(desktopFile), requested: page.url, copied: page.copy || '' }));
}

module.exports = { extensionPath, browserLauncher, copyText, launchBrowser };
if (require.main === module) main().catch(error => { console.error(`Could not open browser extensions: ${error.message}`); process.exitCode = 1; });
