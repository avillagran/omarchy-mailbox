#!/usr/bin/env python3
"""Account removal must survive cached results and in-flight browser captures."""
import json
import os
from pathlib import Path
import runpy
import tempfile

suite = runpy.run_path(str(Path(__file__).with_name('test_plugin.py')))
ROOT, native, run, check = [suite[key] for key in ('ROOT', 'native_message', 'run', 'check')]
with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    config = home / '.config/omarchy'
    cache = home / '.cache/omarchy/mailbox'
    drafts = home / '.local/state/omarchy/mailbox/drafts'
    for p in (config, cache, drafts): p.mkdir(parents=True)
    email, keep = 'remove@example.test', 'keep@example.test'
    (config / 'mailbox.json').write_text(json.dumps({'accounts': {email: {'initials': 'RM', 'color': 'red'}, keep: {'initials': 'KP', 'color': 'green'}}}))
    (cache / 'gmail-slot-accounts.json').write_text(json.dumps({'0': email, '1': keep}))
    (drafts / 'saved.json').write_text('PRIVATE DRAFT TO PRESERVE')
    bridge = {'accounts': {a: {'account': a, 'index': str(i), 'provider': 'gmail', 'unread': 1, 'capturedAt': 1, 'emails': [{'subject': 'saved', 'account': a, 'unread': True}]} for i,a in enumerate((email, keep))}}
    (cache / 'bridge.json').write_text(json.dumps(bridge))
    inbox = {'accounts': [{'email': email, 'unread': 1}, {'email': keep, 'unread': 1}], 'emails': [{'account': email, 'subject': 'REMOVE'}, {'account': keep, 'subject': 'KEEP'}], 'total': 2}
    (cache / 'inbox.json').write_text(json.dumps(inbox))
    env = {**os.environ, 'HOME': str(home)}
    def settings(command, data=None):
        return run(['node', str(ROOT / 'bin/mailbox-settings.js'), command], env=env, input_data=(json.dumps(data) + '\n').encode() if data is not None else None)
    result = settings('remove-account', {'email': email})
    check('remove account succeeds with address on stdin', result.returncode == 0, str(result.stderr))
    check('exclusion is persistent', json.loads((config / 'mailbox.json').read_text())['removedAccounts'] == [email])
    check('removed previews are purged from both caches', email not in json.loads((cache / 'bridge.json').read_text())['accounts'] and all(a['email'] != email for a in json.loads((cache / 'inbox.json').read_text())['accounts']))
    check('drafts and account badge preferences survive removal', (drafts / 'saved.json').read_text() == 'PRIVATE DRAFT TO PRESERVE' and email in json.loads((config / 'mailbox.json').read_text())['accounts'])
    check('removed accounts are not polled', all(a['account'] != email for a in native(home, {'type': 'mailbox-feed-targets'})['targets']))
    response = native(home, {'type': 'mailbox-snapshot', 'account': email, 'accountVerified': True, 'index': '0', 'emails': [], 'unread': 5})
    check('DOM rediscovery cannot re-add removed account', response.get('ignored') and email not in json.loads((cache / 'bridge.json').read_text())['accounts'])
    response = native(home, {'type': 'mailbox-feed-result', 'account': email, 'index': '0', 'state': 'network-error'})
    check('in-flight feed cannot re-add removed account', response.get('ignored'))
    (cache / 'bridge.json').unlink()
    (cache / 'inbox.json').write_text(json.dumps(inbox))
    model = json.loads(run(['node', str(ROOT / 'bin/mailbox.js')], env=env).stdout)
    check('stale cache fallback never shows removed account or mail', all(a['email'] != email for a in model['accounts']) and all(a['account'] != email for a in model['emails']) and model['total'] == 1)
    hey = 'hey:removed@example.test'
    result = settings('remove-account', {'email': hey})
    response = native(home, {'type': 'mailbox-snapshot', 'provider': 'hey', 'account': hey, 'accountVerified': True, 'emails': []})
    check('HEY rediscovery also respects exclusions', result.returncode == 0 and response.get('ignored'))
    result = settings('restore-accounts')
    check('restore clears exclusions', result.returncode == 0 and json.loads((config / 'mailbox.json').read_text())['removedAccounts'] == [])
    targets = native(home, {'type': 'mailbox-feed-targets'})['targets']
    check('restored Gmail is polled without opening tabs', {'account': email, 'index': '0'} in targets)
    xml = '<feed xmlns="http://purl.org/atom/ns#"><title>Gmail - Inbox for remove@example.test</title><fullcount>0</fullcount></feed>'
    response = native(home, {'type': 'mailbox-feed-result', 'account': email, 'index': '0', 'state': 'ok', 'xml': xml})
    check('restored feed recreates account after identity verification', response.get('state') == 'ok' and email in json.loads((cache / 'bridge.json').read_text())['accounts'])
print('Account removal integration checks passed')
