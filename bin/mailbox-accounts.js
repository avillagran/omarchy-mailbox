const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson, LIMITS } = require('./mailbox-bounded-read.js');
const settingsFile = path.join(os.homedir(), '.config', 'omarchy', 'mailbox.json');
function removedAccounts(settings) {
  let data = settings;
  if (!data) { try { data = readJson(settingsFile, LIMITS.settings); } catch (_) { data = {}; } }
  return new Set((Array.isArray(data.removedAccounts) ? data.removedAccounts : []).filter(value => typeof value === 'string' && value.length <= 320).slice(0, 128));
}
module.exports = { removedAccounts };
