#!/usr/bin/env node
/* mailbox-notify — watch for Chrome Gmail notifications, trigger refresh.
 * Listens on D-Bus for Chrome notifications with "mail.google.com" in the body.
 * When detected, writes a trigger file that the QML timer checks.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TRIGGER = '/tmp/mailbox-trigger';
const COOLDOWN = 10; // seconds between triggers

let lastTrigger = 0;

function checkNotification() {
  try {
    // Use dbus-monitor to watch for Chrome notifications
    const proc = spawn('dbus-monitor', [
      '--session',
      "interface='org.freedesktop.Notifications',member='Notify'"
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    let buffer = '';
    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      // Check if this is a Gmail notification
      if (buffer.includes('mail.google.com') || buffer.includes('Gmail')) {
        const now = Date.now();
        if (now - lastTrigger > COOLDOWN * 1000) {
          lastTrigger = now;
          fs.writeFileSync(TRIGGER, String(now));
        }
      }
      // Reset buffer after a chunk
      if (buffer.length > 5000) buffer = buffer.slice(-2000);
    });

    proc.on('exit', () => {
      // Restart if crashed
      setTimeout(checkNotification, 1000);
    });
  } catch (e) {
    // dbus-monitor not available, fall back to polling
  }
}

// Also check for trigger file removal (cache invalidation)
function watchCache() {
  try {
    fs.unlinkSync(TRIGGER);
  } catch (e) {}
}

checkNotification();
watchCache();

// Keep alive
setInterval(() => {}, 60000);
