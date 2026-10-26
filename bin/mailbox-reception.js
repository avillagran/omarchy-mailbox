// A browser notification permission is not evidence of mail delivery.
function receptionStatus(account, now = Date.now()) {
  const probe = account.reception || { state: account.receptionState, checkedAt: account.receptionCheckedAt,
    lastSuccessAt: account.receptionLastSuccessAt, transport: account.receptionTransport };
  const checkedAt = Number(probe.checkedAt || 0);
  const fresh = checkedAt > 0 && now >= checkedAt && now - checkedAt <= 3 * 60 * 1000;
  const states = ['ok', 'network-error', 'timeout', 'signed-out', 'unavailable', 'too-large', 'invalid-feed', 'account-mismatch'];
  const state = fresh && states.includes(probe.state) ? probe.state : checkedAt ? 'stale' : 'unverified';
  return { receptionState: state, receptionCheckedAt: checkedAt,
    receptionLastSuccessAt: Number(probe.lastSuccessAt || 0), receptionTransport: probe.transport === 'gmail-feed' ? 'gmail-feed' : 'unknown',
    notificationHealthy: state === 'ok' };
}
module.exports = { receptionStatus };
