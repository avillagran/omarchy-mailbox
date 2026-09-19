(() => {
  const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

  function text(node) {
    return node ? String(node.innerText || node.textContent || '').trim() : '';
  }

  function first(root, selectors) {
    for (const selector of selectors) {
      const node = root?.querySelector?.(selector);
      if (node) return node;
    }
    return null;
  }

  function all(root, selectors) {
    const found = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const node of Array.from(root?.querySelectorAll?.(selector) || [])) {
        if (seen.has(node)) continue;
        seen.add(node);
        found.push(node);
      }
    }
    return found;
  }

  function absoluteUrl(value, pageUrl) {
    try {
      const url = new URL(value, pageUrl);
      return url.origin === 'https://app.hey.com' && /^\/topics\/\d+/.test(url.pathname) ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  function threadIdFromUrl(value) {
    try {
      return new URL(value, 'https://app.hey.com/').pathname.match(/^\/topics\/(\d+)/)?.[1] || '';
    } catch (_) {
      return '';
    }
  }

  function identity(document, pageUrl) {
    let pathname = '';
    try { pathname = new URL(pageUrl).pathname; } catch (_) {}
    if (/^\/(?:sign_in|sign_up)(?:\/|$)/.test(pathname)) {
      return { account: '', label: 'HEY', verified: false, signedOut: true };
    }
    const node = first(document, [
      'meta[name="current-email-address"]',
      'meta[name="account-email"]',
      'meta[name="user-email"]',
      '[data-current-user-email]',
      '[data-account-email]',
      'header [data-email]',
      'nav [data-email]'
    ]);
    const raw = [
      node?.getAttribute?.('content'),
      node?.getAttribute?.('data-current-user-email'),
      node?.getAttribute?.('data-account-email'),
      node?.getAttribute?.('data-email'),
      text(node)
    ].filter(Boolean).join(' ');
    const email = raw.match(EMAIL_PATTERN)?.[0]?.toLowerCase() || '';
    if (email) return { account: `hey:${email}`, label: email, verified: true, signedOut: false };
    const accountId = document?.documentElement?.getAttribute?.('data-account-id') || document?.body?.getAttribute?.('data-account-id') || '';
    const safeId = String(accountId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
    return { account: `hey:${safeId || 'default'}`, label: 'HEY', verified: true, signedOut: false };
  }

  function rowSnapshot(row, pageUrl) {
    const link = first(row, ['a.posting__link[href]', 'a[href*="/topics/"]']);
    const url = absoluteUrl(link?.getAttribute?.('href') || '', pageUrl);
    const threadId = threadIdFromUrl(url);
    const dateNode = first(row, ['.posting__time', 'time[datetime]', 'time']);
    const exactDate = String(dateNode?.getAttribute?.('datetime') || dateNode?.getAttribute?.('title') || '');
    const dateTimestamp = Date.parse(exactDate);
    const unseen = first(row, ['.posting__status--unseen', '[data-unseen]', '[aria-label*="unread" i]']);
    const inUnreadSection = Boolean(row?.closest?.('.inbox-unseens, .postings--unread'));
    return {
      from: text(first(row, ['.posting__contacts', '.posting__byline', '[data-sender-name]'])),
      subject: text(first(row, ['.posting__title', '.posting__headline', '[data-subject]'])),
      snippet: text(first(row, ['.posting__summary', '.posting__note', '[data-snippet]'])),
      date: text(dateNode) || String(dateNode?.getAttribute?.('datetime') || ''),
      dateTimestamp: Number.isFinite(dateTimestamp) ? dateTimestamp : 0,
      unread: Boolean(unseen || (inUnreadSection && !row?.hasAttribute?.('data-seen'))),
      threadId,
      url
    };
  }

  function snapshotInbox(document, pageUrl) {
    const account = identity(document, pageUrl);
    if (account.signedOut) return { provider: 'hey', ...account, index: '', inboxUrl: 'https://app.hey.com/', unread: 0, emails: [] };
    const emails = [];
    const seen = new Set();
    for (const row of all(document, ['article.posting', '.posting'])) {
      const item = rowSnapshot(row, pageUrl);
      const key = item.threadId || item.url || `${item.from}\0${item.subject}\0${item.date}`;
      if ((!item.subject && !item.from) || seen.has(key)) continue;
      seen.add(key);
      emails.push(item);
    }
    return {
      provider: 'hey',
      account: account.account,
      label: account.label,
      accountVerified: account.verified,
      signedOut: false,
      index: '',
      inboxUrl: 'https://app.hey.com/',
      unread: emails.filter(item => item.unread).length,
      emails
    };
  }

  function conversationSnapshot(document, pageUrl, accountSnapshot) {
    const threadId = threadIdFromUrl(pageUrl);
    if (!threadId) return null;
    const messages = all(document, ['.entry']).map(entry => {
      const body = first(entry, ['.message-content', 'hey-message-content', '.entry__content', '.posting__body']);
      const sender = first(entry, ['.entry__author', '.posting__contacts', '.posting__byline', '[data-sender-name]']);
      const date = first(entry, ['.entry__time', 'time[datetime]', 'time']);
      return {
        messageId: String(entry?.getAttribute?.('data-entry-id') || entry?.getAttribute?.('id') || '').replace(/^entry-/, ''),
        from: text(sender),
        date: text(date) || String(date?.getAttribute?.('datetime') || ''),
        text: text(body)
      };
    }).filter(message => message.text);
    if (!messages.length) return null;
    return {
      provider: 'hey',
      account: accountSnapshot.account,
      label: accountSnapshot.label,
      accountVerified: accountSnapshot.accountVerified === true,
      index: '',
      threadId,
      url: absoluteUrl(pageUrl, pageUrl),
      messages,
      complete: true,
      capturedAt: Date.now()
    };
  }

  const api = { identity, rowSnapshot, snapshotInbox, conversationSnapshot, threadIdFromUrl };
  globalThis.MailboxHeyProvider = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
