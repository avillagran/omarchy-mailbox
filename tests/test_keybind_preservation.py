#!/usr/bin/env python3
import os
from pathlib import Path
import runpy
import stat
import tempfile
suite=runpy.run_path(str(Path(__file__).with_name('test_plugin.py')))
ROOT,run,check=[suite[x] for x in ('ROOT','run','check')]
with tempfile.TemporaryDirectory() as directory:
    home=Path(directory);hypr=home/'.config/hypr';hypr.mkdir(parents=True)
    fake=home/'bin';fake.mkdir();(fake/'hyprctl').write_text('#!/bin/sh\nexit 0\n');(fake/'hyprctl').chmod(0o755)
    env={**os.environ,'HOME':str(home),'PATH':str(fake)+':'+os.environ['PATH']}
    main=hypr/'hyprland.lua';module=hypr/'mailbox.lua';helper=ROOT/'bin/mailbox-keybind.js'
    def call(arg):return run(['node',str(helper),arg],env=env)
    before=b'-- private config\r\nkeep = 1   \r\n\r\nrequire("mailbox")\r\nrequire("hypr.mailbox")\r\n\r\n'
    main.write_bytes(before);main.chmod(0o640)
    result=call('Q');check('CRLF migration succeeds',result.returncode==0,result.stderr)
    expected=before.replace(b'require("mailbox")\r\n',b'').replace(b'require("hypr.mailbox")\r\n',b'')
    block=b'-- BEGIN omarchy-mailbox keybinding\r\nrequire("hypr.mailbox")\r\n-- END omarchy-mailbox keybinding\r\n'
    check('migration preserves unrelated bytes and CRLF',main.read_bytes()==expected+block)
    check('configuration permissions survive',stat.S_IMODE(main.stat().st_mode)==0o640)
    backups=list(hypr.glob('hyprland.lua.mailbox-backup.*'))
    check('private backup contains original configuration',len(backups)==1 and backups[0].read_bytes()==before and stat.S_IMODE(backups[0].stat().st_mode)==0o600)
    call('R');check('marked block update does not duplicate or alter unrelated content',main.read_bytes()==expected+block)
    result=call('--uninstall');check('uninstall preserves unrelated bytes exactly',result.returncode==0 and main.read_bytes()==expected and not module.exists())
    module.write_text('KEEP MODULE')
    for original in ['keep=1\n-- BEGIN omarchy-mailbox keybinding\n', 'keep=1\nrequire("mailbox") -- edited by user\n', '-- BEGIN omarchy-mailbox keybinding\nkeep=1\n-- END omarchy-mailbox keybinding\n']:
        main.write_text(original)
        result=call('--uninstall')
        check('edited or partial configuration fails without removing module',result.returncode!=0 and main.read_text()==original and module.read_text()=='KEEP MODULE')
    for original in (b'keep=1', b'', b'keep=1\n\n'):
        main.write_bytes(original)
        result=call('Q');assert result.returncode==0,result.stderr
        result=call('--uninstall')
        check('install/uninstall preserves final newline state',result.returncode==0 and main.read_bytes()==original)
    module.write_text('KEEP MODULE')
    main.write_bytes(b'x'*(1024*1024+1))
    result=call('--uninstall');check('oversized config is never truncated and module stays',result.returncode!=0 and main.stat().st_size==1024*1024+1 and module.exists())
print('Keybinding preservation checks passed')
