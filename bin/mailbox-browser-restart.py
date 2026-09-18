#!/usr/bin/env python3
# Restart the user's Chrome-family browser cleanly so external extensions load.
# Invoked only by the explicit Mailbox settings button.
import os
import signal
import subprocess
import time

me = os.getpid()
BROWSER_EXECUTABLES = (
    '/opt/google/chrome/chrome',
    '/usr/lib/chromium/chromium',
    '/usr/bin/chromium',
    '/opt/brave.com/brave/brave',
)

def browser_processes():
    result = []
    for entry in os.scandir('/proc'):
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid == me:
            continue
        try:
            state = next(line for line in open(f'/proc/{pid}/status') if line.startswith('State:'))
            executable = os.readlink(f'/proc/{pid}/exe')
        except (OSError, StopIteration):
            continue
        if executable in BROWSER_EXECUTABLES and '\tZ' not in state:
            result.append(pid)
    return result

targets = browser_processes()
for pid in targets:
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass

limit = time.monotonic() + 5
while time.monotonic() < limit and browser_processes():
    time.sleep(0.1)

# Chrome can spawn replacement children while handling SIGTERM. Re-scan instead
# of killing only the original PID snapshot, and do not relaunch until none remain.
limit = time.monotonic() + 5
while time.monotonic() < limit:
    alive = browser_processes()
    if not alive:
        break
    for pid in alive:
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
    time.sleep(0.1)
if browser_processes():
    raise RuntimeError('Chrome-family processes survived SIGKILL; browser was not restarted')

browser = next((item for item in BROWSER_EXECUTABLES if os.path.exists(item)), None)
if not browser:
    raise RuntimeError('No supported Chrome-family browser executable was found')
subprocess.Popen(
    [browser, 'https://mail.google.com/mail/', 'https://app.hey.com/'],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    start_new_session=True,
)
print('Browser fully restarted. Mailbox is synchronizing email.')
