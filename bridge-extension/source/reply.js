// Opens a reply prepared in Mailbox: asks the native host for the draft named
// in the URL fragment, shows the thread in the matching account tab and fills
// the reply box. It never presses Send.
const HOST = 'io.github.avillagran.mailbox';
const status = document.getElementById('status');

function say(text) { status.textContent = text; }
function nativeRequest(message) {
  return new Promise(resolve => chrome.runtime.sendNativeMessage(HOST, message, response => resolve(chrome.runtime.lastError ? null : response)));
}
function waitForTab(tabId) {
  return new Promise(resolve => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); resolve(); };
    const listener = (id, change) => { if (id === tabId && change.status === 'complete') done(); };
    const timer = setTimeout(done, 15000);
    chrome.tabs.onUpdated.addListener(listener);
  });
}
function sendToTab(tabId, message) {
  return new Promise(resolve => chrome.tabs.sendMessage(tabId, message, response => resolve(chrome.runtime.lastError ? null : response)));
}

async function main() {
  const id = location.hash.slice(1);
  if (!/^[a-f0-9]{32}$/.test(id)) { say('Unknown reply.'); return; }
  const draft = await nativeRequest({ type: 'mailbox-reply-request', id });
  if (!draft?.ok) { say(`Could not open the reply: ${draft?.error || 'Mailbox did not answer.'}`); return; }
  // Reuse a tab that already shows the same account so the right session replies.
  const base = draft.provider === 'hey' ? 'https://app.hey.com/' : draft.url.match(/^https:\/\/mail\.google\.com\/mail\/u\/[0-9]{1,3}\//)[0];
  const [existing] = await chrome.tabs.query({ url: `${base}*` });
  const tab = existing ? await chrome.tabs.update(existing.id, { url: draft.url, active: true }) : await chrome.tabs.create({ url: draft.url, active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  if (!existing) await waitForTab(tab.id);
  let result = null;
  for (let attempt = 0; attempt < 20 && !result; attempt++) {
    result = await sendToTab(tab.id, { type: 'mailbox-compose-reply', threadId: draft.threadId, text: draft.text });
    if (!result) await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (result?.ok) { window.close(); return; }
  say('The reply text is on the clipboard. Open Reply in the message and paste it with Ctrl+V.');
}
main();
