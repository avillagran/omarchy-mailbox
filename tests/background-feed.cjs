const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { TextEncoder, TextDecoder } = require('node:util');
const reports = [];
let scenario = 'ok', opened = 0, calls = 0;
const event = () => ({ addListener() {} });
const chrome = {
  runtime: { onMessage: event(), onStartup: event(), onInstalled: event(), getManifest: () => ({ version: 'test' }),
    sendNativeMessage(host, message, callback) {
      if (message.type === 'mailbox-feed-targets') callback({ targets: [{ account: 'reader@example.test', index: '0' }] });
      else { reports.push(message); callback({ ok: true }); }
    }
  }, tabs: { onUpdated: event(), create() { opened++; } }, alarms: { onAlarm: event() }
};
async function fetch(url, options) {
  calls++;
  assert.equal(url, 'https://mail.google.com/mail/u/0/feed/atom');
  assert.equal(options.credentials, 'include');
  assert.equal(options.redirect, 'manual');
  if (scenario === 'network') throw Error('offline');
  if (scenario === 'timeout') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted'))));
  if (scenario === 'redirect') return { type: 'opaqueredirect', status: 0 };
  const bytes = scenario === 'large' ? new Uint8Array(256 * 1024 + 1) : new TextEncoder().encode('<feed/>');
  let read = false;
  return { ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => ({
    async read() { if (read) return { done: true }; read = true; return { done: false, value: bytes }; },
    async cancel() {}
  }) } };
}
const context = vm.createContext({ chrome, fetch, AbortController, TextDecoder, Uint8Array,
  setTimeout: (fn, delay) => setTimeout(fn, delay === 7000 ? 30 : delay), clearTimeout });
vm.runInContext(fs.readFileSync('bridge-extension/source/background.js', 'utf8'), context);
(async () => {
  for (const [input, expected] of [['ok', 'ok'], ['redirect', 'signed-out'], ['large', 'too-large'], ['network', 'network-error'], ['timeout', 'timeout']]) {
    scenario = input;
    await vm.runInContext('pollInboxFeeds()', context);
    assert.equal(reports.at(-1).state, expected);
    if (expected !== 'ok') assert.equal(reports.at(-1).xml, undefined);
  }
  scenario = 'timeout';
  const before = calls;
  await Promise.all([vm.runInContext('pollInboxFeeds()', context), vm.runInContext('pollInboxFeeds()', context)]);
  assert.equal(calls - before, 1);
  assert.equal(opened, 0);
  console.log('PASS fetch credentials, redirect refusal, streaming cap, timeout, offline errors, overlap prevention and zero opened tabs');
})().catch(error => { console.error(error); process.exitCode = 1; });
