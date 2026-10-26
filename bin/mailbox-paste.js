#!/usr/bin/env node
// Clipboard ownership is untrusted. Bound bytes and wall time outside the
// shared shell, and kill the entire producer group on failure or completion.
const { spawn } = require('child_process');
const { TextDecoder } = require('util');
const MAX_BYTES = 64 * 1024;
const child = spawn('wl-paste', ['--no-newline', '--type', 'text/plain'], {
  detached: true, stdio: ['ignore', 'pipe', 'ignore']
});
let chunks = [], size = 0, finished = false;
const timer = setTimeout(() => finish(false), 2000);
function finish(ok) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  child.stdout.destroy();
  if (ok) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      process.stdout.write(JSON.stringify({ text }) + '\n');
    } catch (_) { process.exitCode = 1; }
  } else process.exitCode = 1;
  chunks = [];
}
child.stdout.on('data', chunk => {
  size += chunk.length;
  if (size > MAX_BYTES) finish(false);
  else chunks.push(chunk);
});
child.on('error', () => finish(false));
child.on('close', code => finish(code === 0));
