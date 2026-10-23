// Bounded reads for local state. Every file Mailbox reads is size-capped before
// it is parsed, and a symlink in the final path component is refused.
const fs = require('fs');

const KiB = 1024;
const MiB = 1024 * KiB;
const LIMITS = Object.freeze({
  small: 64 * KiB,          // pending account, slot map, native manifests, extension manifest
  settings: 256 * KiB,      // ~/.config/omarchy/mailbox.json, browser flags files
  config: 1 * MiB,          // hyprland.lua, bridge health and diagnostics reports
  browserState: 32 * MiB,   // browser Local State and profile Preferences
  cache: 64 * MiB           // bridge.json and the panel cache
});

function readText(file, maxBytes) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${file}`);
    if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${file}`);
    // Read at most one byte past the expected size to detect growth during the read.
    const expected = stat.size;
    const buffer = Buffer.alloc(expected + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = fs.readSync(fd, buffer, total, buffer.length - total, null);
      if (!count) break;
      total += count;
    }
    if (total > expected) throw new Error(`File changed while reading: ${file}`);
    return buffer.subarray(0, total).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readJson(file, maxBytes) {
  return JSON.parse(readText(file, maxBytes));
}

module.exports = { readText, readJson, LIMITS };
