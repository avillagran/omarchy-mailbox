#!/usr/bin/env python3
"""Integration checks for background reception, identity and failure preservation."""
import json
import os
from pathlib import Path
import runpy
import tempfile
import time

suite = runpy.run_path(str(Path(__file__).with_name('test_plugin.py')))
ROOT, native, run, check = [suite[key] for key in ('ROOT', 'native_message', 'run', 'check')]


def feed(account='reader@example.test', extra=''):
    return f'''<?xml version="1.0"?><feed xmlns="http://purl.org/atom/ns#"><title>Gmail - Inbox for {account}</title><fullcount>1</fullcount><entry><title>A &amp; B</title><summary>Preview</summary><author><name>Ada</name></author><issued>2026-10-26T20:00:00Z</issued><id>tag:gmail.google.com,2004:abc123</id></entry>{extra}</feed>'''

with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    cache = home / '.cache/omarchy/mailbox'
    cache.mkdir(parents=True)
    file = cache / 'bridge.json'
    file.write_text(json.dumps({'accounts': {'reader@example.test': {'account': 'reader@example.test', 'provider': 'gmail', 'index': '0', 'notificationPermission': 'granted', 'capturedAt': 1, 'emails': []}}}))
    env = {**os.environ, 'HOME': str(home)}
    def model():
        return json.loads(run(['node', str(ROOT / 'bin/mailbox.js'), '--refresh'], env=env).stdout)
    check('permission alone is not verified reception', not model()['accounts'][0]['notificationHealthy'])
    config = native(home, {'type': 'mailbox-feed-targets'})
    check('known Gmail account can be polled without tabs', config['targets'] == [{'account': 'reader@example.test', 'index': '0'}])
    request = {'type': 'mailbox-feed-result', 'account': 'reader@example.test', 'index': '0', 'state': 'ok', 'xml': feed()}
    response = native(home, request)
    check('verified feed updates background reception', response.get('state') == 'ok', str(response))
    result = model()
    check('successful feed reaches mailbox with decoded plain text', result['accounts'][0]['notificationHealthy'] and result['emails'][0]['subject'] == 'A & B')
    check('feed links contain no account query', result['emails'][0]['url'] == 'https://mail.google.com/mail/u/0/#inbox/abc123')
    saved = json.loads(file.read_text())['accounts']['reader@example.test']
    for state in ('signed-out', 'timeout', 'network-error', 'unavailable', 'too-large'):
        response = native(home, {**request, 'state': state, 'xml': ''})
        current = json.loads(file.read_text())['accounts']['reader@example.test']
        check(f'{state} warns and preserves previous mail', current['reception']['state'] == state and current['emails'] == saved['emails'] and not model()['accounts'][0]['notificationHealthy'])
    response = native(home, {**request, 'xml': feed('other@example.test')})
    check('account mismatch is rejected without replacing mail', response.get('state') == 'account-mismatch' and json.loads(file.read_text())['accounts']['reader@example.test']['emails'] == saved['emails'])
    for label, xml in [('html login page', '<html>Sign in</html>'), ('DTD entity', '<!DOCTYPE feed [<!ENTITY x "bad">]>' + feed()), ('oversized XML', 'x' * (256 * 1024 + 1)), ('missing identity', feed().replace('reader@example.test', 'Inbox')), ('malformed XML', '<feed>')]:
        response = native(home, {**request, 'xml': xml})
        check(f'{label} never certifies reception', response.get('state') == 'invalid-feed' and json.loads(file.read_text())['accounts']['reader@example.test']['emails'] == saved['emails'])
    data = json.loads(file.read_text())
    data['accounts']['reader@example.test']['reception'] = {'state': 'ok', 'checkedAt': int(time.time() * 1000) - 181000}
    file.write_text(json.dumps(data))
    check('missed heartbeats expire a prior success', model()['accounts'][0]['receptionState'] == 'stale' and not model()['accounts'][0]['notificationHealthy'])
print('Background reception integration checks passed')
