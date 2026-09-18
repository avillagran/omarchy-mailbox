const HOST = "io.github.avillagran.mailbox";
const GMAIL_URL = "https://mail.google.com/*";
const HEY_URL = "https://app.hey.com/*";
const SUPPORTED_URLS = [GMAIL_URL, HEY_URL];

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
    sendNative({ type: "bridge-diagnostics", tabs: tabs.map(tab => ({ id: tab.id, url: tab.url || "", title: tab.title || "" })), capturedAt: Date.now() });
    for (const tab of tabs) refreshTab(tab.id);
  });
}
function startupProbe() {
  sendNative({ type: "bridge-health", capturedAt: Date.now() });
  chrome.alarms.create("mailbox-refresh", { periodInMinutes: 1 });
  requestSnapshots();
}
chrome.runtime.onStartup.addListener(startupProbe);
chrome.runtime.onInstalled.addListener(startupProbe);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "mailbox-refresh") requestSnapshots(); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if ((change.status === "complete" || change.url) && isSupportedUrl(tab.url || change.url)) refreshTab(tabId);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "mailbox-force-capture") { requestSnapshots(); return; }
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
