const HOST = "io.github.avillagran.mailbox";
const GMAIL_URL = "https://mail.google.com/*";
const HEY_URL = "https://app.hey.com/*";
const SUPPORTED_URLS = [GMAIL_URL, HEY_URL];
let feedPollRunning = false;

function nativeRequest(message) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 5000);
    sendNative(message, response => { clearTimeout(timer); resolve(response); });
  });
}

// Browser sends its existing session cookies itself. Never extract or export
// cookies, and never open a mail page to collect previews or renew a session.
async function fetchInboxFeed(index) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  let reader;
  try {
    const response = await fetch(`https://mail.google.com/mail/u/${index}/feed/atom`, {
      credentials: 'include', cache: 'no-store', redirect: 'manual', signal: controller.signal
    });
    if (response.type === 'opaqueredirect' || [301, 302, 303, 307, 308, 401, 403].includes(response.status)) return { state: 'signed-out' };
    if (!response.ok || !response.body) return { state: 'unavailable' };
    if (Number(response.headers.get('content-length') || 0) > 256 * 1024) return { state: 'too-large' };
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) return { state: 'too-large' };
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { state: 'ok', xml: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch (_) { return { state: controller.signal.aborted ? 'timeout' : 'network-error' }; }
  finally {
    controller.abort();
    if (reader) reader.cancel().catch(() => {});
    clearTimeout(timer);
  }
}

async function pollInboxFeeds() {
  if (feedPollRunning) return;
  feedPollRunning = true;
  try {
    const config = await nativeRequest({ type: 'mailbox-feed-targets' });
    const targets = Array.isArray(config?.targets) ? config.targets.slice(0, 16) : [];
    // Each fetch finishes within 7s; a bounded batch avoids overlapping alarms.
    for (let start = 0; start < targets.length; start += 4) {
      const results = await Promise.all(targets.slice(start, start + 4).map(async target => {
        if (!/^\d{1,3}$/.test(String(target.index)) || typeof target.account !== 'string' || target.account.length > 320) return null;
        const result = await fetchInboxFeed(String(target.index));
        return { type: 'mailbox-feed-result', account: target.account, index: String(target.index), ...result };
      }));
      for (const result of results) if (result) await nativeRequest(result);
    }
  } finally { feedPollRunning = false; }
}

function isSupportedUrl(url) {
  return String(url || "").startsWith("https://mail.google.com/") || String(url || "").startsWith("https://app.hey.com/");
}

function sendNative(message, callback = () => {}) {
  chrome.runtime.sendNativeMessage(HOST, message, response => {
    if (chrome.runtime.lastError) { callback(null); return; }
    callback(response || null);
  });
}
function refreshTab(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "mailbox-refresh" }, () => {
    if (!chrome.runtime.lastError) return;
    chrome.scripting.executeScript({ target: { tabId }, files: ["hey-provider.js", "content.js"] }, () => {
      void chrome.runtime.lastError;
      chrome.tabs.sendMessage(tabId, { type: "mailbox-refresh" }, () => void chrome.runtime.lastError);
    });
  });
}
function requestSnapshots() {
  chrome.tabs.query({ url: SUPPORTED_URLS }, tabs => {
    sendNative({ type: "bridge-diagnostics", bridgeVersion: chrome.runtime.getManifest().version, tabs: tabs.map(tab => ({ id: tab.id, url: tab.url || "", title: tab.title || "" })), capturedAt: Date.now() });
    for (const tab of tabs) refreshTab(tab.id);
  });
}
// Unpacked installs read files from the plugin folder, but the running copy
// only changes on reload. Reload once when the manifest on disk is newer, so a
// plugin update reaches the browser without a trip to chrome://extensions.
async function reloadIfUpdated() {
  try {
    const response = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
    const onDisk = (await response.json()).version;
    if (onDisk && onDisk !== chrome.runtime.getManifest().version) chrome.runtime.reload();
  } catch (_) {}
}
function startupProbe() {
  reloadIfUpdated();
  sendNative({ type: "bridge-health", bridgeVersion: chrome.runtime.getManifest().version, capturedAt: Date.now() });
  chrome.alarms.create("mailbox-refresh", { periodInMinutes: 1 });
  requestSnapshots();
  pollInboxFeeds();
}
chrome.runtime.onStartup.addListener(startupProbe);
chrome.runtime.onInstalled.addListener(startupProbe);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "mailbox-refresh") { reloadIfUpdated(); requestSnapshots(); pollInboxFeeds(); } });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if ((change.status === "complete" || change.url) && isSupportedUrl(tab.url || change.url)) refreshTab(tabId);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "mailbox-force-capture") { requestSnapshots(); pollInboxFeeds(); return; }
  if (!message?.data || (message.type !== "mailbox-snapshot" && message.type !== "mailbox-thread-body")) return;
  sendNative({ type: message.type, ...message.data }, response => {
    if (message.type !== "mailbox-snapshot" || !sender.tab?.id || !response?.ok) return;
    chrome.tabs.sendMessage(sender.tab.id, {
      type: "mailbox-body-policy",
      enabled: response.bodyDownloadsEnabled === true,
      allowedThreadIds: response.allowedThreadIds || []
    }, () => void chrome.runtime.lastError);
  });
});
