(() => {
  if (globalThis.__mailboxBridgeLoaded) return;
  globalThis.__mailboxBridgeLoaded = true;
  let timer = null;
  let bodyTimer = null;
  let bodyDownloadsEnabled = false;
  let allowedThreadIds = new Set();
  let lastBodySignature = '';
  let accountIdentityVerified = false;
  const heyProvider = location.hostname === 'app.hey.com' ? globalThis.MailboxHeyProvider : null;

  function text(node) { return node ? (node.innerText || node.textContent || '').trim() : ''; }
  function notificationPermission() {
    const value = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    return ['granted', 'denied', 'default'].includes(value) ? value : 'unsupported';
  }
  function accountIndex() { const match = location.pathname.match(/\/mail\/u\/(\d+)/); return match ? match[1] : '0'; }
  function accountEmail() {
    const meta = document.querySelector('meta[name="og-profile-acct"]')?.getAttribute('content') || '';
    const metaMatch = meta.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (metaMatch) { accountIdentityVerified = true; return metaMatch[0].toLowerCase(); }
    const candidates = [
      document.querySelector('a[aria-label*="Google Account"]'),
      document.querySelector('[data-email][aria-label*="Google"]'),
      document.querySelector('a[href*="SignOutOptions"]')
    ];
    for (const node of candidates) {
      const raw = `${node?.getAttribute('data-email') || ''} ${node?.getAttribute('aria-label') || ''}`;
      const match = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      if (match) { accountIdentityVerified = true; return match[0].toLowerCase(); }
    }
    return '';
  }
  function absoluteUrl(href) { try { return new URL(href, location.href).href; } catch (_) { return ''; } }
  function directLink(row) {
    const href = [...row.querySelectorAll('a[href]')].map(link => link.getAttribute('href') || '').find(value => /#(?:inbox|all|starred|important|sent|trash|spam|label\/[^/]+)\/[^/?#]+/.test(value));
    return href ? absoluteUrl(href) : '';
  }
  function rowThreadId(row) {
    const url = directLink(row);
    const fromUrl = threadIdFromUrl(url);
    if (fromUrl) return fromUrl;
    const own = row.getAttribute('data-thread-perm-id') || row.getAttribute('data-legacy-thread-id') || row.getAttribute('data-thread-id');
    const nested = row.querySelector('[data-thread-perm-id], [data-legacy-thread-id], [data-thread-id]');
    return String(own || nested?.getAttribute('data-thread-perm-id') || nested?.getAttribute('data-legacy-thread-id') || nested?.getAttribute('data-thread-id') || '').replace(/^#/, '');
  }
  function threadIdFromUrl(url) {
    try {
      const hash = new URL(url, location.href).hash.replace(/^#/, '');
      const parts = hash.split('/').filter(Boolean);
      return parts.length > 1 ? parts[parts.length - 1].split('?')[0] : '';
    } catch (_) { return ''; }
  }
  function rowSnapshot(row) {
    const direct = directLink(row);
    const threadId = rowThreadId(row);
    const url = direct || (threadId ? `https://mail.google.com/mail/u/${accountIndex()}/#inbox/${threadId}` : '');
    const dateNode = row.querySelector('.xW span[title], .xW[title], .xW span, .xW');
    const exactDate = dateNode?.getAttribute?.('datetime') || dateNode?.getAttribute?.('title') || '';
    const dateTimestamp = Date.parse(exactDate);
    return {
      from: text(row.querySelector('.yP, .zF, [email]')),
      subject: text(row.querySelector('.bog, [data-thread-id] .bog')),
      snippet: text(row.querySelector('.y2')),
      date: text(dateNode),
      dateTimestamp: Number.isFinite(dateTimestamp) ? dateTimestamp : 0,
      unread: row.classList.contains('zE') || row.getAttribute('aria-label')?.toLowerCase().includes('unread') || false,
      threadId,
      url
    };
  }
  function snapshotInbox() {
    if (heyProvider) {
      const data = heyProvider.snapshotInbox(document, location.href);
      data.notificationPermission = notificationPermission();
      if (!data.signedOut && data.account) chrome.runtime.sendMessage({ type: 'mailbox-snapshot', data });
      return;
    }
    const rows = [...document.querySelectorAll('tr[role="row"], tr.zA, div[role="row"]')];
    const emails = [];
    const seen = new Set();
    for (const row of rows) {
      const item = rowSnapshot(row);
      const key = item.threadId || item.url || `${item.from}\0${item.subject}\0${item.date}`;
      if (!item.subject || seen.has(key)) continue;
      seen.add(key); emails.push(item);
    }
    chrome.runtime.sendMessage({
      type: 'mailbox-snapshot',
      data: { account: accountEmail(), accountVerified: accountIdentityVerified, index: accountIndex(), notificationPermission: notificationPermission(), unread: emails.filter(item => item.unread).length, emails }
    });
  }
  function currentThreadId() { return heyProvider ? heyProvider.threadIdFromUrl(location.href) : threadIdFromUrl(location.href); }
  function expandConversation() {
    if (heyProvider) return false;
    let clicked = false;
    for (const node of [...document.querySelectorAll('.adx[role="button"], .ajR')].slice(0, 30)) {
      if (node.offsetParent === null) continue;
      try { node.click(); clicked = true; } catch (_) {}
    }
    return clicked;
  }
  function conversationSnapshot() {
    const threadId = currentThreadId();
    if (!threadId || !bodyDownloadsEnabled || !allowedThreadIds.has(threadId)) return null;
    if (heyProvider) return heyProvider.conversationSnapshot(document, location.href, heyProvider.snapshotInbox(document, location.href));
    const containers = [...document.querySelectorAll('div.adn.ads')];
    const messages = containers.map(container => {
      const body = container.querySelector('.a3s.aiL, .ii.gt .a3s, .a3s');
      const sender = container.querySelector('.gD[email], [email].gD, .gD');
      const date = container.querySelector('.g3[title], .g3');
      return {
        messageId: container.getAttribute('data-legacy-message-id') || container.getAttribute('data-message-id') || body?.getAttribute('data-message-id') || '',
        from: sender?.getAttribute('email') || text(sender),
        date: date?.getAttribute('title') || text(date),
        text: text(body)
      };
    }).filter(message => message.text);
    if (!messages.length) return null;
    const collapsed = [...document.querySelectorAll('.adx[role="button"]')].some(node => node.offsetParent !== null);
    return { account: accountEmail(), accountVerified: accountIdentityVerified, index: accountIndex(), threadId, url: location.href, messages, complete: !collapsed && messages.length === containers.length, capturedAt: Date.now() };
  }
  function publishConversation() {
    if (!bodyDownloadsEnabled) return;
    if (expandConversation()) {
      clearTimeout(bodyTimer);
      bodyTimer = setTimeout(publishConversation, 700);
      return;
    }
    const data = conversationSnapshot();
    if (!data) return;
    const signature = JSON.stringify({ threadId: data.threadId, complete: data.complete, messages: data.messages });
    if (signature === lastBodySignature) return;
    lastBodySignature = signature;
    chrome.runtime.sendMessage({ type: 'mailbox-thread-body', data });
  }
  function publish() {
    clearTimeout(timer);
    timer = setTimeout(() => { snapshotInbox(); publishConversation(); }, 250);
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'mailbox-refresh') publish();
    if (message?.type === 'mailbox-body-policy') {
      bodyDownloadsEnabled = message.enabled === true;
      allowedThreadIds = new Set((message.allowedThreadIds || []).map(value => String(value).replace(/^#/, '')));
      if (!bodyDownloadsEnabled) lastBodySignature = '';
      publishConversation();
    }
  });
  new MutationObserver(publish).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'aria-expanded'] });
  window.addEventListener('hashchange', () => { lastBodySignature = ''; publish(); });
  document.addEventListener('turbo:load', () => { lastBodySignature = ''; publish(); });
  publish();
  setInterval(publish, 30000);
})();
