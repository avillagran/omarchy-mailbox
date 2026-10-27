#!/usr/bin/env python3
"""Run the actual account-action QML Process against isolated settings."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
ROOT=Path(__file__).resolve().parents[1]
block=re.search(r'  Process \{\n    id: accountActionProc\n.*?\n  \}',(ROOT/'Panel.qml').read_text(),re.S)[0]
with tempfile.TemporaryDirectory() as directory:
    home=Path(directory);config=home/'.config/omarchy';config.mkdir(parents=True)
    (config/'mailbox.json').write_text(json.dumps({'accounts':{'fixture@example.test':{'initials':'FX','color':'green'}}}))
    preamble='''import QtQuick
import Quickshell
import Quickshell.Io
Scope {
 id: root
 property string settingsBin: SETTINGS_BIN
 property var removedAccounts: []
 property var accountToRemove: ({ email: "fixture@example.test" })
 property string accountAction: "remove-account"
 property string accountActionState: ""
 property string selectedAccount: "fixture@example.test"
 property var hostWidget: null
 function t(text) { return text }
 QtObject { id: shortcutLoadProc; property bool running: false }
 property int stage: 0
 Timer { interval: 50; repeat: true; running: true; onTriggered: {
   if (accountActionProc.running) return
   if (root.stage === 0) { root.stage = 1; accountActionProc.running = true }
   else if (root.stage === 1) {
     if (root.removedAccounts.length !== 1 || root.selectedAccount !== "__all__" || root.accountActionState.length) { console.error("ACTION_FAILED"); Qt.quit(); return }
     root.stage = 2; root.accountAction = "restore-accounts"; accountActionProc.stdinEnabled = true; accountActionProc.running = true
   } else {
     console.log(root.removedAccounts.length === 0 && !root.accountActionState.length ? "ACCOUNT_PROCESS_PASS" : "ACTION_FAILED"); Qt.quit()
   }
 } }
'''.replace('SETTINGS_BIN',json.dumps(str(ROOT/'bin/mailbox-settings.js')))
    qml=home/'shell.qml';qml.write_text(preamble+block+'\n}\n')
    result=subprocess.run(['qs','-p',str(qml)],env={**os.environ,'HOME':str(home),'QT_QPA_PLATFORM':'offscreen'},capture_output=True,text=True,timeout=12)
    assert 'ACCOUNT_PROCESS_PASS' in result.stdout+result.stderr, result.stdout+result.stderr
    assert json.loads((config/'mailbox.json').read_text())['removedAccounts']==[]
    print('PASS actual QML account Process removes and restores through bounded stdin')
