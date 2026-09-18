#!/usr/bin/env python3
# Restart the user's Chrome-family browser cleanly so external extensions load.
# Invoked only by the explicit Gmailbox settings button.
import os
import signal
import subprocess
import time

me = os.getpid()
targets = []
for entry in os.scandir('/proc'):
    if not entry.name.isdigit():
        continue
    pid = int(entry.name)
    if pid == me:
        continue
    try:
        raw = open(f'/proc/{pid}/cmdline', 'rb').read().split(b'\0')
        exe = raw[0].decode('utf-8', 'replace')
    except OSError:
        continue
    if exe in ('/opt/google/chrome/chrome', '/usr/lib/chromium/chromium', '/usr/bin/chromium', '/opt/brave.com/brave/brave'):
        targets.append(pid)
for pid in targets:
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
limit = time.monotonic() + 8
while time.monotonic() < limit:
    alive = [pid for pid in targets if os.path.exists(f'/proc/{pid}')]
    if not alive:
        break
    time.sleep(0.25)
for pid in targets:
    if os.path.exists(f'/proc/{pid}'):
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
subprocess.Popen(['xdg-open', 'https://mail.google.com/mail/'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
print('Chrome restarted. Gmailbox is synchronizing open Gmail tabs.')
