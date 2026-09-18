const HOST = "io.github.avillagran.gmailbox";
const GMAIL_URL = "https://mail.google.com/*";

function sendNative(message, callback = () => {}) {
  chrome.runtime.sendNativeMessage(HOST, message, response => {
    if (chrome.runtime.lastError) { callback(null); return; }
    callback(response || null);
  });
}
function refreshTab(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "gmailbox-refresh" }, () => {
    if (!chrome.runtime.lastError) return;
    chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }, () => {
      void chrome.runtime.lastError;
      chrome.tabs.sendMessage(tabId, { type: "gmailbox-refresh" }, () => void chrome.runtime.lastError);
    });
  });
}
function requestSnapshots() {
  chrome.tabs.query({ url: GMAIL_URL }, tabs => {
    sendNative({ type: "bridge-diagnostics", tabs: tabs.map(tab => ({ id: tab.id, url: tab.url || "", title: tab.title || "" })), capturedAt: Date.now() });
    for (const tab of tabs) refreshTab(tab.id);
  });
}
function startupProbe() {
  sendNative({ type: "bridge-health", capturedAt: Date.now() });
  chrome.alarms.create("gmailbox-refresh", { periodInMinutes: 1 });
  requestSnapshots();
}
chrome.runtime.onStartup.addListener(startupProbe);
chrome.runtime.onInstalled.addListener(startupProbe);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "gmailbox-refresh") requestSnapshots(); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if ((change.status === "complete" || change.url) && String(tab.url || change.url || "").startsWith("https://mail.google.com/")) refreshTab(tabId);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "gmailbox-force-capture") { requestSnapshots(); return; }
  if (!message?.data || (message.type !== "gmailbox-snapshot" && message.type !== "gmailbox-thread-body")) return;
  sendNative({ type: message.type, ...message.data }, response => {
    if (message.type !== "gmailbox-snapshot" || !sender.tab?.id || !response?.ok) return;
    chrome.tabs.sendMessage(sender.tab.id, {
      type: "gmailbox-body-policy",
      enabled: response.bodyDownloadsEnabled === true,
      allowedThreadIds: response.allowedThreadIds || []
    }, () => void chrome.runtime.lastError);
  });
});
