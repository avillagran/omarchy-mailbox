#!/usr/bin/env python3
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
HOST = ROOT / "bin/mailbox-bridge-host.js"
EXTENSION_ID = "kjmlhpckodkmfcjmelnkknkaeiognoed"
passed = 0
skipped = 0


def check(name, condition, detail=""):
  global passed
  if not condition:
    raise AssertionError(f"{name}: {detail}")
  passed += 1
  print(f"PASS {name}")


def skip(name, reason):
  global skipped
  skipped += 1
  print(f"SKIP {name}: {reason}")


def run(command, *, cwd=ROOT, env=None, input_data=None):
  return subprocess.run(command, cwd=cwd, env=env, input=input_data, capture_output=True, text=input_data is None)


def native_message(home, message):
  encoded = json.dumps(message).encode()
  result = run(["node", str(HOST)], env={**os.environ, "HOME": str(home)}, input_data=struct.pack("<I", len(encoded)) + encoded)
  check("native host exits cleanly", result.returncode == 0, result.stderr.decode(errors="replace"))
  check("native host returns a framed response", len(result.stdout) >= 4, str(len(result.stdout)))
  length = struct.unpack("<I", result.stdout[:4])[0]
  return json.loads(result.stdout[4:4 + length])


def test_static_files():
  for filename in ["manifest.json", "bridge-extension/source/manifest.json", "i18n.json"]:
    json.loads((ROOT / filename).read_text())
    check(f"valid JSON: {filename}", True)
  for filename in [*ROOT.glob("bin/*.js"), *ROOT.glob("bridge-extension/source/*.js")]:
    result = run(["node", "--check", str(filename)])
    check(f"JavaScript syntax: {filename.relative_to(ROOT)}", result.returncode == 0, result.stderr)
  panel = (ROOT / "Panel.qml").read_text()
  readme = (ROOT / "README.md").read_text()
  check("bridge reports its runtime version through native health", "bridgeVersion: chrome.runtime.getManifest().version" in (ROOT / "bridge-extension/source/background.js").read_text() and "bridge-health.json" in (ROOT / "bin/mailbox-bridge-status.js").read_text())
  check("no privileged helper or system registration is shipped", not (ROOT / "bin/mailbox-bridge-system-install.sh").exists() and not (ROOT / "bin/mailbox-system-extension.py").exists() and not (ROOT / "bridge-extension.crx").exists())
  scanned = [path for path in ROOT.rglob("*") if path.is_file() and ".git" not in path.parts and "tests" not in path.parts and path.suffix in {".qml", ".js", ".py", ".sh", ".md", ".json"}]
  check("no privilege boundary anywhere in the shipped tree", not any(re.search(r"\b(sudo|pkexec|polkit)\b", path.read_text(errors="replace")) for path in scanned))
  check("no setup-named helper triggers the installer capability", not any(re.search(r"(?:^|[-_])(install|installer|setup|uninstall)(?:[-_.]|$)", path.name, re.I) for path in ROOT.rglob("*") if ".git" not in path.parts))
  check("no browser-killing restart helper is shipped", not (ROOT / "bin/mailbox-browser-restart.py").exists())
  check("no predictable /tmp paths in runtime code", not any("/tmp/" in path.read_text(errors="replace") for path in scanned if path.suffix != ".md"))
  check("panel offers automatic Chromium and Brave installation", 'id: installChromiumBridgeButton' in panel and 'id: installBraveBridgeButton' in panel and 'command: ["node", root.bridgeRegisterBin, root.bridgeBrowserTarget === "brave" ? "--brave" : "--chromium"]' in panel)
  check("panel offers guided Chrome setup", 'id: installChromeBridgeButton' in panel and "ChromeGuide { id: chromeGuide; panel: root }" in panel and "chromeGuide.show()" in panel)
  check("browser setup stays available after another browser is configured", 'visible: (root.bridgeStatusKnown || root.bridgeInstallState.length > 0) && root.bridgeSectionOpen\n              width: parent.width' in panel)
  check("healthy extension settings fold and stay expandable", "readonly property bool bridgeSectionOpen: !root.bridgeStatusKnown || !root.bridgeUpToDate || root.bridgeSectionExpanded" in panel and "onClicked: root.bridgeSectionExpanded = !root.bridgeSectionExpanded" in panel)
  check("browser selection saves the last rapid choice", 'function saveBrowserTarget(browser)' in panel and 'root.pendingBrowserTargetSave = browser' in panel and 'root.saveBrowserTarget(pending)' in panel)
  busy = 'if (bridgeInstallProc.running || flagsBridgeInstallProc.running || bridgeUninstallProc.running) return'
  check("browser installers cannot overlap and stale green status clears", busy in panel and 'root.bridgeUpToDate = false' in panel[panel.index('function installFlagsBridge(browser)'):panel.index('function uninstallBridge()')])
  check("browser installer failures recheck status", 'bridgeStatusRetry.restart()' in panel[panel.index('id: bridgeInstallProc'):panel.index('id: flagsBridgeInstallProc')])
  check("uninstall cannot overlap an installer", panel.count(busy) >= 3 and 'enabled: !bridgeInstallProc.running && !flagsBridgeInstallProc.running && !bridgeUninstallProc.running' in panel)
  check("status errors clear stale green result", 'catch (_) { root.bridgeInstalled = false; root.bridgeFlagsConfigured = false; root.bridgeLegacyRegistration = false; root.bridgeUpToDate = false; root.bridgeStatusKnown = true' in panel)
  check("selected browser status does not fall back during setup", 'property string bridgeBrowserTarget: ""' in panel and 'if (!root.bridgeBrowserTarget && !root.bridgeBrowserAutomatic && status.flagsConfigured && !status.installed)' in panel and 'root.bridgeBrowserTarget = browser' in panel)
  check("chosen browser survives a panel reload", 'command: ["node", root.settingsBin, "set-browser", root.bridgeBrowserTarget]' in panel and 'value.bridgeBrowserTarget || ""' in panel)
  check("panel never opens blocked refresh page before extension is active", 'if (root.bridgeUpToDate)' in panel and '["node", root.forceRefreshBin, "--chromium"]' in panel)
  check("refresh follows explicit Brave and Chrome selection", '["node", root.forceRefreshBin, "--brave"]' in panel and '["node", root.forceRefreshBin, "--chrome"]' in panel)
  check("status does not claim an unverified live extension", 'root.tf("Extension %1 is configured; confirm it in the browser."' in panel)
  check("browser restart is manual and does not kill other sessions", "restartBrowser" not in panel)
  text_elements = re.findall(r"(?<![A-Za-z.])Text \{[^\n]*(?:\n\s+[^\n]*)?", panel + (ROOT / "ChromeGuide.qml").read_text())
  check("every QML Text renders plain text", text_elements and all("textFormat: Text.PlainText" in element for element in text_elements), str(len(text_elements)))
  check("panel opens only provider URLs from bridge data", "safeInboxUrl" in (ROOT / "bin/mailbox-bridge-host.js").read_text() and "mail\\.google\\.com|app\\.hey\\.com" in (ROOT / "bin/mailbox.js").read_text())
  check("README describes the rootless flags-file setup", "chromium-flags.conf" in readme and "brave-flags.conf" in readme and "Load unpacked" in readme and "mailbox-bridge-register.js" in readme)
  shebang_files = [path for path in (ROOT / "bin").iterdir() if path.is_file() and path.read_bytes()[:2] == b"#!"]
  check("all shebang helpers are executable", all(os.access(path, os.X_OK) for path in shebang_files))
  check("no generated Python artifacts", not any(path.suffix == ".pyc" or "__pycache__" in path.parts for path in ROOT.rglob("*")))
  check("private CRX key and packed CRX are ignored", {"bridge-extension.pem", "bridge-extension.crx"} <= set((ROOT / ".gitignore").read_text().splitlines()))


def test_i18n():
  catalog = json.loads((ROOT / "i18n.json").read_text())
  english = catalog["en"]
  keys = set(english) - {""}
  check("i18n has 19 locales", len(catalog) == 19, str(sorted(catalog)))
  check("i18n has 92 message IDs", len(keys) == 92, str(len(keys)))
  check("automatic Brave setup is localized", catalog["es"]["Install in Brave"] == "Instalar en Brave")
  check("configured status copy is localizable", "Extension %1 is configured; confirm it in the browser." in english)
  check("guided browser setup is localized", "Set up Chrome" in english and "Quit and reopen %1 to activate Mailbox Local Bridge." in english and "Drag Mailbox onto the page" in english and catalog["es"]["Turn on Developer mode"] == "Activa el Modo de desarrollador")
  for locale, translations in catalog.items():
    check(f"i18n coverage: {locale}", set(translations) - {""} == keys)
    check(f"i18n plural header: {locale}", "" in translations)
    placeholder_errors = []
    for message in keys:
      expected = sorted(re.findall(r"%\d+", message))
      actual = sorted(re.findall(r"%\d+", str(translations[message])))
      if actual != expected:
        placeholder_errors.append(f"{message}: {actual} != {expected}")
    check(f"i18n placeholders: {locale}", not placeholder_errors, "; ".join(placeholder_errors))
    sync_values = [translations["Synchronizing open Gmail tabs…"]]
    check(f"provider-neutral synchronization copy: {locale}", all("gmail" not in value.lower() for value in sync_values), str(sync_values))
  check("Spanish synchronization copy says email", catalog["es"]["Synchronizing open Gmail tabs…"] == "Sincronizando email…")
  check("notification instruction is localized", catalog["es"]["Enable notifications for this account."] == "Activa las notificaciones para esta cuenta.")


def test_versions():
  extension_manifest = json.loads((ROOT / "bridge-extension/source/manifest.json").read_text())
  extension_version = extension_manifest["version"]
  check("extension version in user registration helper", extension_version in (ROOT / "bin/mailbox-bridge-register.js").read_text())
  key = base64.b64decode(extension_manifest["key"])
  calculated_id = "".join("abcdefghijklmnop"[int(nibble, 16)] for nibble in hashlib.sha256(key).hexdigest()[:32])
  check("unpacked extension key matches native host origin", calculated_id == EXTENSION_ID, calculated_id)
  check("extension is loaded from the unpacked source directory", (ROOT / "bridge-extension/source/manifest.json").is_file())
  check("HEY is an extension host permission", "https://app.hey.com/*" in extension_manifest["host_permissions"])
  matches = [match for script in extension_manifest["content_scripts"] for match in script["matches"]]
  check("HEY receives the local bridge content script", "https://app.hey.com/*" in matches)
  background = (ROOT / "bridge-extension/source/background.js").read_text()
  content = (ROOT / "bridge-extension/source/content.js").read_text()
  check("background refreshes HEY tabs", "https://app.hey.com/*" in background)
  check("content bridge invokes the HEY provider", "MailboxHeyProvider" in content)


def test_hey_provider():
  provider = ROOT / "bridge-extension/source/hey-provider.js"
  check("HEY provider source exists", provider.is_file())
  script = r'''
const assert = require('assert');
const hey = require(process.argv[1]);

class Element {
  constructor({ text = '', attrs = {}, one = {}, many = {}, closest = {} } = {}) {
    this.innerText = text;
    this.textContent = text;
    this.attrs = attrs;
    this.one = one;
    this.many = many;
    this.closestMap = closest;
  }
  getAttribute(name) { return this.attrs[name] || null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  querySelector(selector) {
    for (const part of selector.split(',').map(value => value.trim())) if (this.one[part]) return this.one[part];
    return null;
  }
  querySelectorAll(selector) { return this.many[selector] || []; }
  closest(selector) {
    for (const part of selector.split(',').map(value => value.trim())) if (this.closestMap[part]) return this.closestMap[part];
    return null;
  }
}

const link = new Element({ attrs: { href: '/topics/12345' } });
const unseen = new Element();
const row = new Element({
  one: {
    'a.posting__link[href]': link,
    '.posting__contacts': new Element({ text: 'Ada Lovelace' }),
    '.posting__title': new Element({ text: 'Design review notes' }),
    '.posting__summary': new Element({ text: 'The latest proposal is ready.' }),
    '.posting__time': new Element({ text: '4:45 PM', attrs: { datetime: '2026-09-17T16:45:00Z' } }),
    '.posting__status--unseen': unseen
  }
});
const identity = new Element({ attrs: { content: 'andres@example.test' } });
const document = new Element({
  one: { 'meta[name="current-email-address"]': identity },
  many: { 'article.posting': [row], '.entry': [] }
});
document.documentElement = new Element();
document.body = new Element();
const snapshot = hey.snapshotInbox(document, 'https://app.hey.com/');
assert.equal(snapshot.provider, 'hey');
assert.equal(snapshot.account, 'hey:andres@example.test');
assert.equal(snapshot.label, 'andres@example.test');
assert.equal(snapshot.unread, 1);
assert.equal(snapshot.emails.length, 1);
assert.deepEqual(snapshot.emails[0], {
  from: 'Ada Lovelace',
  subject: 'Design review notes',
  snippet: 'The latest proposal is ready.',
  date: '4:45 PM',
  dateTimestamp: Date.parse('2026-09-17T16:45:00Z'),
  unread: true,
  threadId: '12345',
  url: 'https://app.hey.com/topics/12345'
});

const entry = new Element({ one: {
  '.message-content': new Element({ text: 'Complete HEY message body' }),
  '.entry__author': new Element({ text: 'Ada Lovelace' }),
  '.entry__time': new Element({ text: '4:45 PM' })
}, attrs: { id: 'entry-77' } });
document.many['.entry'] = [entry];
const conversation = hey.conversationSnapshot(document, 'https://app.hey.com/topics/12345', snapshot);
assert.equal(conversation.threadId, '12345');
assert.equal(conversation.messages.length, 1);
assert.equal(conversation.messages[0].text, 'Complete HEY message body');
assert.equal(conversation.complete, true);
'''
  result = run(["node", "-e", script, str(provider)])
  check("HEY Imbox and conversation fixtures are extracted", result.returncode == 0, result.stderr)


def test_marketplace_structure():
  manifest = json.loads((ROOT / "manifest.json").read_text())
  readme = (ROOT / "README.md").read_text()
  marketplace_manifests = [path for path in ROOT.rglob("manifest.json") if len(path.relative_to(ROOT).parts) <= 2]
  check("marketplace sees exactly one root plugin manifest", marketplace_manifests == [ROOT / "manifest.json"], str(marketplace_manifests))
  check("marketplace plugin ID is namespaced and non-reserved", manifest["id"].startswith("io.github.avillagran.") and not manifest["id"].startswith("omarchy."))
  check("plugin version advances with the guided Chrome window", manifest["version"] == "0.0.7", manifest["version"])
  check("extension version advances with reply hand-off", json.loads((ROOT / "bridge-extension/source/manifest.json").read_text())["version"] == "0.0.7")
  check("README documents Gmail and HEY support", "Gmail and HEY" in readme and "https://app.hey.com/*" in readme)
  check("marketplace root README documents installation", "## Installation" in readme and "omarchy plugin add" in readme)
  check("marketplace root README documents removal", "## Removal" in readme and "omarchy plugin remove" in readme)
  check("marketplace root README documents dependencies and rootless setup", "## Requirements" in readme and "## External dependencies and browser setup" in readme and "Nothing runs as root" in readme)
  check("marketplace root license exists", (ROOT / "LICENSE").is_file() and "Andrés Villagrán" in (ROOT / "LICENSE").read_text())
  preview = ROOT / "preview.png"
  header = preview.read_bytes()[:24]
  width, height = struct.unpack(">II", header[16:24])
  check("marketplace preview is a PNG", header[:8] == b"\x89PNG\r\n\x1a\n")
  check("marketplace preview is within size limits", preview.stat().st_size <= 50 * 1024 * 1024 and width * height <= 40_000_000, f"{width}x{height}, {preview.stat().st_size} bytes")
  check("marketplace preview is referenced by README", "![Mailbox](preview.png)" in readme)


def test_panel_badge_propagation():
  source = (ROOT / "Panel.qml").read_text()
  check("inbox connect button leads to preferences instead of a missing installer", "root.installBridge()" not in source)
  check("header hover reveals an animated Preferences button", "HoverHandler { id: headerHover }" in source and "id: preferencesReveal" in source and "Behavior on width" in source and 'root.t("Preferences")' in source)
  check("badge changes propagate to visible email rows", "emailCopy[k].account === email" in source and "root.emails = emailCopy" in source)
  check("badge changes propagate to host email rows", "hostEmails[h].account === email" in source and "root.hostWidget.emails = hostEmails" in source)
  check("panel accepts direct HEY topic URLs", "app\\.hey\\.com\\/topics" in source)
  check("panel opens each provider Inbox URL", "account.inboxUrl" in source)
  check("keyboard opens desktop notification rows", "if (email) root.openEmail(email)" in source)
  check("preferences show per-account notification health first", "notificationHealthy" in source and 'text: parent.account.notificationHealthy ? "✓" : "!"' in source)
  check("notification warning opens provider settings", "openAccountNotificationSettings" in source and "#settings/general" in source)
  check("notification warning explains itself on hover", "PanelToolTip" in source and 'root.receptionDetail(parent.account)' in source and "notificationStatusMouse.containsMouse" in source)
  check("sync status stays in fixed header space", "id: headerSyncStatus" in source and "opacity: root.syncing ? 1 : 0" in source and source.index("id: headerSyncStatus") < source.index('iconText: "󰑐"'))
  check("sync status does not shift the message list", 'Rectangle {\n            visible: root.syncing' not in source)
  check("row date derives from the resolved timestamp, not the capture-time label", "root.displayDate(modelData)" in source and '" · " + modelData.date' not in source and "toDateString() === now.toDateString()" in source)
  check("inbox flags a saved copy when the extension is missing", "function staleNotice()" in source and "root.staleNotice()" in source and 'root.t("Extension not installed")' in source)
  check("row date labels refresh while the panel is open", "onTriggered: root.nowMs = Date.now()" in source)
  guide = (ROOT / "ChromeGuide.qml").read_text()
  check("browser setup explains user-owned unpacked install", "Load unpacked" in source and "Developer mode" in guide and "root.openBrowserExtensionSetup()" in source)
  check("Chrome guide is a window beside the browser", "FloatingWindow {" in guide and "root.close()" in source[source.index("function openBrowserExtensionSetup"):][:200])
  check("Chrome guide drags the extension folder as a file URI", "Drag.dragType: Drag.Automatic" in guide and '"text/uri-list": "file://" + encodeURI(root.extensionPath)' in guide)
  check("Chrome guide ticks steps off from Chrome state", "status.developerMode === true" in guide and "status.upToDate === true" in guide and "running: window.visible && !root.finished" in guide)
  check("Chrome guide opens only fixed browser pages", 'root.openChrome("extensions")' in guide and 'root.openChrome("gmail")' in guide and "Object.hasOwn(PAGES, target)" in (ROOT / "bin/mailbox-open-browser-extensions.js").read_text())
  check("Chrome guide header moves the window", "onPressed: window.startSystemMove()" in guide)
  check("Chrome guide never elevates privileges", not re.search(r"\b(sudo|pkexec|doas)\b", guide))


def test_mark_as_read_keeps_messages():
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    config = home / ".config/omarchy"
    cache = home / ".cache/omarchy/mailbox"
    config.mkdir(parents=True)
    cache.mkdir(parents=True)
    now = int(time.time() * 1000)
    (config / "mailbox.json").write_text(json.dumps({"localReadAt": now - 60000}))
    (cache / "bridge.json").write_text(json.dumps({"accounts": {"reader@example.test": {"account": "reader@example.test", "index": "0", "unread": 2, "capturedAt": now, "emails": [
      {"threadId": "OLD", "from": "Old", "subject": "Before the mark", "dateTimestamp": now - 3600000},
      {"threadId": "NEW", "from": "New", "subject": "After the mark", "dateTimestamp": now - 1000}]}}}))
    result = run(["node", str(ROOT / "bin/mailbox.js")], env={**os.environ, "HOME": str(home), "MAILBOX_CACHE_TTL_MS": "0"})
    data = json.loads(result.stdout)
    rows = {row.get("threadId"): row for row in data.get("emails", [])}
    check("mark as read keeps earlier messages in the list", set(rows) == {"OLD", "NEW"}, str(list(rows)))
    check("mark as read flags only earlier messages", rows.get("OLD", {}).get("read") is True and not rows.get("NEW", {}).get("read"), str(rows))
    check("mark as read counts only later messages", data.get("total") == 1 and data["accounts"][0]["unread"] == 1, str(data.get("accounts")))
  panel = (ROOT / "Panel.qml").read_text()
  mark = next(line for line in panel.splitlines() if '"mark-local-read"' in line)
  check("mark as read button keeps rows in the panel", "root.emails = []" not in mark and "Object.assign({}, email, { read: true })" in mark)
  check("read rows drop the unread highlight", "font.bold: !modelData.read" in panel and "modelData.read ? 0.04 : 0.16" in panel)


def test_reply_drafts():
  drafts = ROOT / "bin/mailbox-drafts.js"
  def call(home, command, request):
    return subprocess.run(["node", str(drafts), command], input=json.dumps(request) + "\n", capture_output=True, text=True, env={**os.environ, "HOME": str(home)}, timeout=20)
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    request = {"account": "reader@example.test", "threadId": "18c0ffee", "index": "2", "provider": "gmail", "from": "Ada", "subject": "Hello", "text": "Line one\nLine two"}
    saved = call(home, "save", request)
    check("reply draft saves from stdin", saved.returncode == 0, saved.stderr)
    folder = home / ".local/state/omarchy/mailbox/drafts"
    files = list(folder.glob("*.json"))
    check("reply draft is private to the user", len(files) == 1 and stat.S_IMODE(files[0].stat().st_mode) == 0o600 and stat.S_IMODE(folder.stat().st_mode) == 0o700, str(files))
    stored = json.loads(files[0].read_text()) if files else {}
    check("reply draft rebuilds the Gmail thread link", stored.get("url") == "https://mail.google.com/mail/u/2/#inbox/18c0ffee", str(stored.get("url")))
    loaded = json.loads(call(home, "load", {"account": request["account"], "threadId": request["threadId"]}).stdout)
    check("reply draft survives and reloads", loaded.get("text") == "Line one\nLine two", str(loaded))
    bad = call(home, "save", {**request, "threadId": "x/../../evil", "index": "9999"})
    bad_draft = next((json.loads(f.read_text()) for f in folder.glob("*.json") if json.loads(f.read_text()).get("threadId") == "x/../../evil"), {})
    check("reply draft refuses links that are not provider threads", bad.returncode == 0 and bad_draft.get("url") == "", str(bad_draft))
    hey = call(home, "save", {**request, "threadId": "H1", "provider": "hey", "url": "https://evil.example/topics/1"})
    hey_draft = next((json.loads(f.read_text()) for f in folder.glob("*.json") if json.loads(f.read_text()).get("threadId") == "H1"), {})
    check("reply draft keeps only HEY pages for HEY", hey.returncode == 0 and hey_draft.get("url") == "", str(hey_draft))
    target = files[0]
    victim = home / "victim.txt"
    victim.write_text("keep")
    target.unlink()
    target.symlink_to(victim)
    linked = call(home, "save", request)
    check("reply draft never writes through a symlink", linked.returncode != 0 and victim.read_text() == "keep", linked.stderr)
    target.unlink()
    call(home, "save", request)
    listed = json.loads(subprocess.run(["node", str(drafts), "list"], capture_output=True, text=True, env={**os.environ, "HOME": str(home)}, timeout=20).stdout)
    check("draft list names threads without their text", {"account": request["account"], "threadId": request["threadId"]}.items() <= next((d for d in listed["drafts"] if d["threadId"] == "18c0ffee"), {}).items() and "text" not in json.dumps(listed), str(listed))
    call(home, "discard", {"account": request["account"], "threadId": request["threadId"]})
    check("reply draft can be discarded", not target.exists())

    # Native host hands a fresh draft to the extension and nothing else.
    call(home, "save", request)
    draft_file = next(f for f in folder.glob("*.json") if json.loads(f.read_text()).get("threadId") == "18c0ffee")
    draft_id = draft_file.stem
    response = native_message(home, {"type": "mailbox-reply-request", "id": draft_id})
    check("host refuses a draft that was not handed off", response.get("ok") is False, str(response))
    data = json.loads(draft_file.read_text()); data["handedOffAt"] = int(time.time() * 1000); draft_file.write_text(json.dumps(data))
    response = native_message(home, {"type": "mailbox-reply-request", "id": draft_id})
    check("host returns the handed-off reply", response.get("ok") is True and response.get("text") == "Line one\nLine two" and response.get("url") == "https://mail.google.com/mail/u/2/#inbox/18c0ffee", str(response))
    response = native_message(home, {"type": "mailbox-reply-request", "id": "../../etc/passwd"})
    check("host rejects malformed reply ids", response.get("ok") is False, str(response))
  panel = (ROOT / "Panel.qml").read_text()
  content = (ROOT / "bridge-extension/source/content.js").read_text()
  reply = (ROOT / "bridge-extension/source/reply.js").read_text()
  check("reply text reaches helpers over stdin, not argv", "onStarted: write(root.replyRequest({ text: replyEditor.text }))" in panel and "replyEditor.text]" not in panel)
  check("badge account address reaches settings over stdin, not argv", 'command: ["node", root.settingsBin, "set"]' in panel and "activeBadgeSave.email]" not in panel and "activeBadgeSave.email," not in panel.split("onStarted: write(JSON.stringify({ email: root.activeBadgeSave.email")[0])
  check("pending account address reaches its helper over stdin, not argv", "bridgePendingBin, account.email" not in panel and 'command: ["node", root.bridgePendingBin]' in panel)
  check("no helper receives account or message data as an argument", not re.search(r'execDetached\(\["node"[^\]]*\b(account|email|draft|reply)\.(email|text|subject|from)', panel))
  check("inbox links are revalidated right before launch", "account.inboxUrl]" not in panel and "function safeInboxUrl(account)" in panel)
  opener = (ROOT / "bin/mailbox-open-browser-extensions.js").read_text()
  check("clipboard text is piped to wl-copy, not passed as an argument", "spawnSync('wl-copy', [], { input: text" in opener and "'wl-copy', [text]" not in opener)
  check("reply draft saves while typing and on close", "draftSaveTimer.restart()" in panel and "if (!root.opened) root.saveReplyNow()" in panel)
  check("R opens the reply box and Ctrl+Enter hands it off", 'root.openReply(); event.accepted = true' in panel and "root.sendReplyToBrowser()" in panel)
  check("rows with a saved draft show a draft icon", 'root.hasDraft(modelData) ? "󰏫 " : ""' in panel and "root.refreshDrafts()" in panel)
  background = (ROOT / "bridge-extension/source/background.js").read_text()
  check("extension reloads itself after a plugin update", 'chrome.runtime.getURL("manifest.json")' in background and "chrome.runtime.reload()" in background)
  check("reply errors name a stale extension instead of a missing one", "is still running Mailbox Local Bridge" in (ROOT / "bin/mailbox-force-refresh.js").read_text())
  bar = (ROOT / "BarWidget.qml").read_text()
  check("outdated extension shows ! in the bar", 'if (root.bridgeNeedsUpdate || root.receptionNeedsAttention) return "! " + root.accountLabel()' in bar and "panelLoader.item.bridgeNeedsUpdate" in bar)
  check("header ! opens preferences", "id: bridgeWarningButton" in panel and "visible: root.bridgeNeedsUpdate" in panel and "onClicked: root.showSettings()" in panel[panel.index("id: bridgeWarningButton"):][:600])
  check("extension status is rechecked while the panel is closed", "interval: 120000; repeat: true; running: true; triggeredOnStart: true" in panel)
  check("reply is filled in Gmail but never sent", "mailbox-compose-reply" in content and "insertText" in content and not re.search(r"(?i)send", content[content.index("async function composeReply"):content.index("chrome.runtime.onMessage.addListener((message, sender, sendResponse)")]) and "never presses Send" in reply)


def test_mail_client_listing():
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    (home / ".config/omarchy").mkdir(parents=True)
    cache = home / ".cache/omarchy/mailbox"
    cache.mkdir(parents=True)
    now = int(time.time() * 1000)
    (cache / "bridge.json").write_text(json.dumps({"accounts": {"reader@example.test": {"account": "reader@example.test", "index": "0", "unread": 1, "capturedAt": now, "emails": [
      {"threadId": "SEEN", "from": "A", "subject": "Opened in Gmail", "dateTimestamp": now - 2000, "unread": False},
      {"threadId": "NEW", "from": "B", "subject": "Not opened", "dateTimestamp": now - 1000, "unread": True}]}}}))
    data = json.loads(run(["node", str(ROOT / "bin/mailbox.js")], env={**os.environ, "HOME": str(home), "MAILBOX_CACHE_TTL_MS": "0"}).stdout)
    rows = {row.get("threadId"): row for row in data.get("emails", [])}
    check("opened messages stay in the list", set(rows) == {"SEEN", "NEW"}, str(list(rows)))
    check("only unopened messages keep the highlight", rows["SEEN"].get("read") is True and not rows["NEW"].get("read"), str(rows))
  panel = (ROOT / "Panel.qml").read_text()
  check("Inbox 0 hides read messages only while enabled", "return !root.inboxZero || !email.read" in panel and 'text: "Inbox 0"' in panel and '"set-inbox-zero"' in panel)
  check("desktop notification rows use an envelope instead of [NEW]", '(modelData.notification ? "󰇮 " :' in panel and 'root.selectedAccount === "__all__" && !modelData.notification' in panel)
  check("rows are grouped under a localized day divider", "readonly property bool firstOfDay:" in panel and "locale.dateFormat(Locale.LongFormat)" in panel and 'root.t("Today")' in panel and 'root.t("Yesterday")' in panel)
  check("Inbox 0 choice persists", "data.inboxZero = data.inboxZero === true;" in (ROOT / "bin/mailbox-settings.js").read_text() and "root.inboxZero = value.inboxZero === true" in panel)


def test_reading_navigation():
  panel = (ROOT / "Panel.qml").read_text()
  check("Space keeps reading mode while moving", "if (root.readingMode) root.expandedEmailIndex = root.selectedEmailIndex" in panel)
  check("Shift+Space opens every message and toggles back", "event.key === Qt.Key_Space && (event.modifiers & Qt.ShiftModifier)" in panel and "root.expandAll = !root.expandAll" in panel and "root.expandAll || root.expandedEmailIndex === index" in panel)
  check("keyboard focus starts on the modifier-aware handler", "focusTarget: keyFront" in panel)


def test_notification_reconciliation():
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    now = 4102444800000
    config = home / ".config/omarchy"
    cache = home / ".cache/omarchy/mailbox"
    history = home / ".local/state/omarchy/notifications/history"
    config.mkdir(parents=True)
    cache.mkdir(parents=True)
    history.mkdir(parents=True)
    (config / "mailbox.json").write_text(json.dumps({"accounts": {"preview@example.test": {"initials": "PX", "color": "green"}}}))
    (cache / "bridge.json").write_text(json.dumps({"accounts": {"preview@example.test": {"account": "preview@example.test", "index": "0", "unread": 1, "capturedAt": now, "emails": [{"threadId": "T1", "from": "Example", "subject": "Example", "date": "Sep 17, 2026, 4:45 PM"}]}}}))
    (history / "gmail.json").write_text(json.dumps({"timestamp": now - 1000, "app": "Google Chrome", "summary": "Gmail", "body": "Older notification"}))
    result = run(["node", str(ROOT / "bin/mailbox.js")], env={**os.environ, "HOME": str(home)})
    check("mailbox snapshot command exits cleanly", result.returncode == 0, result.stderr)
    data = json.loads(result.stdout)
    check("notifications older than bridge capture are reconciled", result.returncode == 0 and not data.get("desktopNotifications") and all(not row.get("notification") for row in data["emails"]), str(data))
    (history / "gmail-new.json").write_text(json.dumps({"timestamp": now + 1000, "app": "Google Chrome", "summary": "Gmail", "body": "New email https://mail.google.com/"}))
    result = run(["node", str(ROOT / "bin/mailbox.js")], env={**os.environ, "HOME": str(home)})
    data = json.loads(result.stdout)
    notification = next((row for row in data["emails"] if row.get("notification")), None)
    check("desktop notifications retain a browser destination", notification is not None and notification.get("url") == "https://mail.google.com/", str(notification))

    (cache / "bridge.json").write_text(json.dumps({"accounts": {
      "newer@example.test": {"account": "newer@example.test", "index": "0", "unread": 0, "capturedAt": now + 2000, "emails": []},
      "older@example.test": {"account": "older@example.test", "index": "1", "unread": 0, "capturedAt": now, "emails": []}
    }}))
    result = run(["node", str(ROOT / "bin/mailbox.js")], env={**os.environ, "HOME": str(home), "MAILBOX_CACHE_TTL_MS": "0"})
    data = json.loads(result.stdout)
    check("notification survives until every account has reconciled it", data.get("desktopNotifications") == 1, str(data))

    for notification_file in history.iterdir():
      notification_file.unlink()
    (cache / "bridge.json").write_text(json.dumps({"accounts": {
      "before-midnight@example.test": {"account": "before-midnight@example.test", "capturedAt": 1789788600000, "emails": [{"threadId": "late", "subject": "Late yesterday", "date": "11:00 PM"}]},
      "after-midnight@example.test": {"account": "after-midnight@example.test", "capturedAt": 1789788600000, "emails": [{"threadId": "new", "subject": "New today", "date": "12:10 AM"}]}
    }}))
    result = run(["node", str(ROOT / "bin/mailbox.js")], env={**os.environ, "HOME": str(home), "MAILBOX_CACHE_TTL_MS": "0"})
    data = json.loads(result.stdout)
    check("time-only dates cross midnight in chronological order", [row["subject"] for row in data["emails"]] == ["New today", "Late yesterday"], str(data["emails"]))


def test_native_host():
  host_source = (ROOT / "bin/mailbox-bridge-host.js").read_text()
  check("native host handles complete frames before stdin closes", "if (input.length < 4 + length) return" in host_source and "process.stdin.pause()" in host_source)
  check("one-shot native host exits after replying", "process.exit(0)" in host_source)
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    config = home / ".config/omarchy"
    config.mkdir(parents=True)
    settings = {"accounts": {"real@example.com": {}}, "maxMessagesPerAccount": 2, "downloadBodies": True}
    (config / "mailbox.json").write_text(json.dumps(settings))
    response = native_message(home, {"type": "mailbox-snapshot", "account": "login@example.net", "accountVerified": False, "index": "9", "emails": []})
    check("unverified phantom account is rejected", response.get("ok") is False and "verified" in response.get("error", ""), str(response))
    emails = [{"threadId": f"T{index}", "from": "Sender", "subject": f"Subject {index}", "date": str(index), "unread": True, "url": f"https://mail.google.com/mail/u/0/#inbox/T{index}"} for index in range(3)]
    response = native_message(home, {"type": "mailbox-snapshot", "account": "real@example.com", "accountVerified": True, "index": "0", "notificationPermission": "denied", "unread": 3, "emails": emails})
    check("configured account snapshot is accepted", response.get("ok") is True, str(response))
    check("body allowlist obeys message limit", len(response.get("allowedThreadIds", [])) == 2, str(response))
    cache_file = home / ".cache/omarchy/mailbox/bridge.json"
    cache = json.loads(cache_file.read_text())
    rows = cache["accounts"]["real@example.com"]["emails"]
    check("native cache obeys message limit", len(rows) == 2)
    check("native cache preserves direct Gmail URLs", all("/#inbox/T" in row["url"] for row in rows))
    check("native cache preserves notification permission", cache["accounts"]["real@example.com"].get("notificationPermission") == "denied")
    thread_id = rows[0]["threadId"]
    response = native_message(home, {"type": "mailbox-thread-body", "account": "real@example.com", "accountVerified": True, "index": "0", "threadId": thread_id, "complete": True, "messages": [{"messageId": "M1", "from": "Sender", "date": "today", "text": "Complete body"}]})
    check("complete body is cached", response.get("saved") is True, str(response))
    settings["downloadBodies"] = False
    (config / "mailbox.json").write_text(json.dumps(settings))
    response = native_message(home, {"type": "mailbox-snapshot", "account": "real@example.com", "accountVerified": True, "index": "0", "unread": 1, "emails": [emails[-1]]})
    cache = json.loads(cache_file.read_text())
    rows = cache["accounts"]["real@example.com"]["emails"]
    check("disabled body downloads are reported", response.get("bodyDownloadsEnabled") is False)
    check("disabling body downloads purges bodies", all("body" not in row and "bodyState" not in row for row in rows))

    settings["downloadBodies"] = True
    (config / "mailbox.json").write_text(json.dumps(settings))
    hey_email = {"threadId": "12345", "from": "HEY Sender", "subject": "HEY subject", "date": "4:45 PM", "dateTimestamp": 4102444800200, "unread": True, "url": "https://app.hey.com/topics/12345"}
    response = native_message(home, {"type": "mailbox-snapshot", "provider": "hey", "account": "hey:andres@example.com", "label": "andres@example.com", "accountVerified": True, "index": "", "inboxUrl": "https://app.hey.com/", "notificationPermission": "granted", "unread": 1, "emails": [hey_email]})
    check("verified HEY account snapshot is accepted", response.get("ok") is True, str(response))
    cache = json.loads(cache_file.read_text())
    hey_account = cache["accounts"]["hey:andres@example.com"]
    check("HEY provider metadata is cached", hey_account.get("provider") == "hey" and hey_account.get("label") == "andres@example.com" and hey_account.get("inboxUrl") == "https://app.hey.com/", str(hey_account))
    response = native_message(home, {"type": "mailbox-thread-body", "provider": "hey", "account": "hey:andres@example.com", "label": "andres@example.com", "accountVerified": True, "threadId": "12345", "complete": True, "messages": [{"messageId": "77", "from": "HEY Sender", "date": "today", "text": "Complete HEY body"}]})
    check("HEY conversation body is cached", response.get("saved") is True, str(response))
    result = run(["node", str(ROOT / "bin/mailbox.js")], env={**os.environ, "HOME": str(home)})
    rendered = json.loads(result.stdout)
    rendered_hey = next((account for account in rendered["accounts"] if account.get("provider") == "hey"), None)
    check("HEY account reaches the widget model", rendered_hey and rendered_hey.get("label") == "andres@example.com" and rendered_hey.get("inboxUrl") == "https://app.hey.com/", str(rendered.get("accounts")))
    check("permission alone never certifies HEY reception", rendered_hey and rendered_hey.get("notificationPermission") == "granted" and rendered_hey.get("notificationHealthy") is False, str(rendered_hey))
    check("HEY direct topic reaches the widget model", any(email.get("url") == "https://app.hey.com/topics/12345" for email in rendered["emails"]))
    rendered_accounts = [email.get("account") for email in rendered["emails"]]
    check("ALL view interleaves providers by exact date", rendered_accounts[0] == "hey:andres@example.com" and "real@example.com" in rendered_accounts[1:], str(rendered_accounts))
    modes = [stat.S_IMODE(path.stat().st_mode) for path in (home / ".cache/omarchy/mailbox").iterdir() if path.is_file()]
    check("native cache files use mode 0600", all(mode == 0o600 for mode in modes), str(modes))


def test_settings():
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    env = {**os.environ, "HOME": str(home)}
    helper = ROOT / "bin/mailbox-settings.js"
    badge = lambda email, initials, color: json.dumps({"email": email, "initials": initials, "color": color}).encode() + b"\n"
    result = run(["node", str(helper), "set"], env=env, input_data=badge("person@example.com", "a-v!", "green"))
    data = json.loads(result.stdout)
    check("settings accept semantic color role", result.returncode == 0)
    check("settings normalize initials", data["accounts"]["person@example.com"]["initials"] == "AV")
    result = run(["node", str(helper), "set-limit", "0"], env=env)
    check("message limit clamps to one", json.loads(result.stdout)["maxMessagesPerAccount"] == 1)
    result = run(["node", str(helper), "set-limit", "999"], env=env)
    check("message limit clamps to 200", json.loads(result.stdout)["maxMessagesPerAccount"] == 200)
    result = run(["node", str(helper), "set-browser", "chrome"], env=env)
    check("explicit Chrome selection persists through settings reload", result.returncode == 0 and json.loads(run(["node", str(helper), "get"], env=env).stdout).get("bridgeBrowserTarget") == "chrome", result.stderr)
    result = run(["node", str(helper), "set-browser", "brave"], env=env)
    check("Brave selection persists without losing unrelated settings", result.returncode == 0 and json.loads(result.stdout).get("bridgeBrowserTarget") == "brave" and json.loads(result.stdout)["maxMessagesPerAccount"] == 200, result.stderr)
    check("unsupported browser selection is rejected", run(["node", str(helper), "set-browser", "firefox"], env=env).returncode == 2)
    concurrent = [subprocess.Popen(["node", str(helper), "set"], cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for i in range(24)]
    results = [process.communicate(badge(f"parallel{i}@example.com", "P", "green"), timeout=30) for i, process in enumerate(concurrent)]
    settings = json.loads((home / ".config/omarchy/mailbox.json").read_text())
    check("parallel settings updates retain all accounts and browser choice", all(process.returncode == 0 for process in concurrent) and all(f"parallel{i}@example.com" in settings["accounts"] for i in range(24)) and settings["bridgeBrowserTarget"] == "brave", str([(process.returncode, stderr.decode(errors="replace")) for process, (_, stderr) in zip(concurrent, results) if process.returncode]))
    check("invalid shortcut is rejected", run(["node", str(helper), "set-shortcut", "7"], env=env).returncode == 2)
    check("invalid color role is rejected", run(["node", str(helper), "set"], env=env, input_data=badge("person@example.com", "AV", "invalid")).returncode == 2)
    check("badge address is not accepted from process arguments", run(["node", str(helper), "set", "argv@example.com", "AV", "green"], env=env, input_data=b"{}\n").returncode == 2 and "argv@example.com" not in (home / ".config/omarchy/mailbox.json").read_text())
    start = time.monotonic()
    stalled = subprocess.Popen(["node", str(helper), "set"], cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    stalled.stdin.write(b'{"email":'); stalled.stdin.flush()
    stalled.wait(timeout=15)
    stalled.stdin.close(); stalled.stdout.close(); stalled.stderr.close()
    check("badge request on stdin has a deadline", stalled.returncode != 0 and time.monotonic() - start < 10, f"exit={stalled.returncode}")


def test_keybind():
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    hypr = home / ".config/hypr"
    hypr.mkdir(parents=True)
    main = hypr / "hyprland.lua"
    main.write_text('require("default.hypr.bindings")\nrequire("mailbox")\nrequire("mailbox")\n')
    fake_bin = home / "bin"
    fake_bin.mkdir()
    fake_hyprctl = fake_bin / "hyprctl"
    fake_hyprctl.write_text("#!/bin/bash\nexit 0\n")
    fake_hyprctl.chmod(0o755)
    env = {**os.environ, "HOME": str(home), "PATH": f"{fake_bin}:{os.environ['PATH']}"}
    helper = ROOT / "bin/mailbox-keybind.js"
    result = run(["node", str(helper), "Q"], env=env)
    check("keybind installer exits cleanly", result.returncode == 0, result.stderr)
    text = main.read_text()
    check("keybind uses prefixed Hyprland require", text.count('require("hypr.mailbox")') == 1 and 'require("mailbox")' not in text, text)
    check("generated keybind targets Mailbox", "SUPER + SHIFT + Q" in (hypr / "mailbox.lua").read_text())
    result = run(["node", str(helper), "R"], env=env)
    check("keybind installer is idempotent", result.returncode == 0 and main.read_text().count('require("hypr.mailbox")') == 1)
    check("keybind update replaces the previous letter", "SUPER + SHIFT + R" in (hypr / "mailbox.lua").read_text())
    result = run(["node", str(helper), "--uninstall"], env=env)
    check("keybind uninstaller exits cleanly", result.returncode == 0, result.stderr)
    check("keybind uninstaller removes generated file", not (hypr / "mailbox.lua").exists())
    check("keybind uninstaller removes require lines", "mailbox" not in main.read_text())


def test_browser_installer():
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    config = home / ".config"
    config.mkdir()
    flags = config / "chrome-flags.conf"
    flags.write_text(f"--load-extension={ROOT / 'bridge-extension'},{ROOT / 'bridge-extension' / 'source'},/keep/me\n--other-flag\n")
    env = {**os.environ, "HOME": str(home)}
    helper = ROOT / "bin/mailbox-bridge-register.js"
    result = run(["node", str(helper)], env=env)
    check("browser bridge installer exits cleanly", result.returncode == 0, result.stderr)
    data = json.loads(result.stdout)
    check("registration returns the unpacked Chrome directory", data["extensionPath"] == str(ROOT / "bridge-extension/source"), str(data))
    native = list(config.glob("**/NativeMessagingHosts/io.github.avillagran.mailbox.json"))
    check("browser bridge installs four native manifests", len(native) == 4, str(native))
    check("native origins match unpacked extension key", all(json.loads(p.read_text())["allowed_origins"] == [f"chrome-extension://{EXTENSION_ID}/"] for p in native))
    external = list(config.glob(f"**/External Extensions/{EXTENSION_ID}.json"))
    check("browser bridge does not claim to install an external CRX", not external, str(external))
    chrome = config / "google-chrome"
    (chrome / "Local State").write_text(json.dumps({"profile": {"last_used": "Default"}}))
    (chrome / "Default").mkdir()
    (chrome / "Default/Preferences").write_text(json.dumps({"extensions": {"settings": {
      EXTENSION_ID: {"path": str(ROOT / "bridge-extension/source"), "location": 4, "state": 1}
    }}}))
    fake_bin = home / "bin"
    fake_bin.mkdir()
    xdg = fake_bin / "xdg-settings"
    xdg.write_text("#!/bin/sh\nprintf '%s\\n' google-chrome.desktop\n")
    xdg.chmod(0o755)
    status_env = {**env, "PATH": f"{fake_bin}:{os.environ['PATH']}"}
    status = json.loads(run(["node", str(ROOT / "bin/mailbox-bridge-status.js")], env=status_env).stdout)
    check("unpacked extension reports active without system registration", status["installed"] and status["upToDate"] and not status["removalReady"], str(status))
    xdg.write_text("#!/bin/sh\nprintf '%s\\n' firefox.desktop\n")
    selected_chrome = json.loads(run(["node", str(ROOT / "bin/mailbox-bridge-status.js"), "--chrome"], env=status_env).stdout)
    selected_brave = json.loads(run(["node", str(ROOT / "bin/mailbox-bridge-status.js"), "--brave"], env=status_env).stdout)
    check("explicit Chrome status ignores the desktop default", selected_chrome["browser"] == "google-chrome.desktop" and selected_chrome["upToDate"], str(selected_chrome))
    check("explicit Brave status ignores the desktop default", "brave" in selected_brave["browser"] and not selected_brave["installed"], str(selected_brave))
    xdg.write_text("#!/bin/sh\nprintf '%s\\n' google-chrome.desktop\n")
    prefs_file = chrome / "Default/Preferences"
    prefs = json.loads(prefs_file.read_text())
    prefs["extensions"]["settings"][EXTENSION_ID]["path"] = str(ROOT / "bridge-extension.crx")
    prefs_file.write_text(json.dumps(prefs))
    wrong_path = json.loads(run(["node", str(ROOT / "bin/mailbox-bridge-status.js")], env=status_env).stdout)
    check("legacy CRX is not reported as the unpacked extension", not wrong_path["upToDate"], str(wrong_path))
    prefs["extensions"]["settings"][EXTENSION_ID].update({"path": str(ROOT / "bridge-extension/source"), "location": 1, "manifest": {"version": "0.0.4"}})
    prefs_file.write_text(json.dumps(prefs))
    wrong_location = json.loads(run(["node", str(ROOT / "bin/mailbox-bridge-status.js")], env=status_env).stdout)
    check("cached CRX manifest cannot masquerade as unpacked", not wrong_location["upToDate"], str(wrong_location))
    prefs["extensions"]["settings"][EXTENSION_ID] = {"path": str(ROOT / "bridge-extension/source"), "location": 4, "state": 1}
    prefs_file.write_text(json.dumps(prefs))
    native_file = chrome / "NativeMessagingHosts/io.github.avillagran.mailbox.json"
    native_file.unlink()
    missing_host = json.loads(run(["node", str(ROOT / "bin/mailbox-bridge-status.js")], env=status_env).stdout)
    check("missing host is repairable rather than mistaken for uninstall", not missing_host["upToDate"] and not missing_host["removalReady"], str(missing_host))
    result = run(["node", str(helper)], env=env)
    check("prepare bridge repairs the native host", result.returncode == 0 and native_file.is_file(), result.stderr)
    native_manifest = json.loads(native_file.read_text())
    native_manifest["path"] = "/nonexistent/mailbox-host"
    native_file.write_text(json.dumps(native_manifest))
    wrong_host = json.loads(run(["node", str(ROOT / "bin/mailbox-bridge-status.js")], env=status_env).stdout)
    check("wrong native host cannot appear healthy", not wrong_host["upToDate"], str(wrong_host))
    result = run(["node", str(helper)], env=env)
    check("prepare bridge repairs a wrong native host", result.returncode == 0, result.stderr)
    legacy_root = home / "system"
    legacy_file = legacy_root / "opt/google/chrome/extensions" / f"{EXTENSION_ID}.json"
    legacy_file.parent.mkdir(parents=True)
    legacy_file.write_text(json.dumps({"external_crx": "/opt/google/chrome/extensions/bridge-extension.crx", "external_version": "0.0.4"}))
    legacy_status = json.loads(run(["node", str(ROOT / "bin/mailbox-bridge-status.js")], env={**status_env, "MAILBOX_LEGACY_REGISTRY_ROOT": str(legacy_root)}).stdout)
    check("legacy system registration blocks false green and is never treated as supported", legacy_status["legacyRegistration"] and not legacy_status["upToDate"] and "systemConfigured" not in legacy_status, str(legacy_status))
    check("Chrome status reports manual setup only", legacy_status["automatic"] is False and legacy_status["flagsFile"] == "", str(legacy_status))
    prefs["extensions"]["settings"][EXTENSION_ID] = {"path": str(ROOT / "bridge-extension/source"), "location": 4, "state": 1}
    prefs_file.write_text(json.dumps(prefs))
    check("registration leaves unrelated flags files untouched", "/keep/me" in flags.read_text() and str(ROOT / "bridge-extension/source") in flags.read_text())
    chromium_flags = config / "chromium-flags.conf"
    chromium_flags.write_text("--disable-gpu\n--load-extension=/keep/chromium\n")
    result = run(["node", str(helper), "--chromium"], env=env)
    check("one-click Chromium setup exits cleanly", result.returncode == 0, result.stderr)
    check("Chromium setup adds the local extension without losing other flags", str(ROOT / 'bridge-extension/source') in chromium_flags.read_text().split('--load-extension=')[1].splitlines()[0].split(',') and "/keep/chromium" in chromium_flags.read_text() and "--disable-gpu" in chromium_flags.read_text(), chromium_flags.read_text())
    result = run(["node", str(helper), "--chromium"], env=env)
    check("Chromium setup is idempotent", result.returncode == 0 and chromium_flags.read_text().count(str(ROOT / "bridge-extension/source")) == 1, chromium_flags.read_text())
    chromium_status = json.loads(run(["node", str(ROOT / "bin/mailbox-bridge-status.js"), "--chromium"], env=status_env).stdout)
    check("status reports Chromium startup configured even when Chrome is default", chromium_status.get("flagsConfigured") is True and chromium_status.get("automatic") is True and "chromium" in chromium_status["browser"], str(chromium_status))
    brave_flags = config / "brave-flags.conf"
    brave_flags.write_text("--password-store=gnome-libsecret\n")
    result = run(["node", str(helper), "--brave"], env=env)
    check("one-click Brave setup exits cleanly", result.returncode == 0, result.stderr)
    check("Brave setup adds the local extension to brave-flags.conf only", str(ROOT / "bridge-extension/source") in brave_flags.read_text() and "--password-store=gnome-libsecret" in brave_flags.read_text() and not (config / "brave-origin-flags.conf").exists() and str(ROOT / "bridge-extension/source") in chromium_flags.read_text(), brave_flags.read_text())
    (apps_dir := home / ".local/share/applications").mkdir(parents=True, exist_ok=True)
    (apps_dir / "brave-browser.desktop").write_text("[Desktop Entry]\nType=Application\nName=Brave\n")
    brave_status = json.loads(run(["node", str(ROOT / "bin/mailbox-bridge-status.js"), "--brave"], env=status_env).stdout)
    check("status reports Brave startup configured", brave_status.get("flagsConfigured") is True and brave_status.get("automatic") is True and brave_status["flagsFile"].endswith("brave-flags.conf"), str(brave_status))
    brave_profile = config / "BraveSoftware/Brave-Browser/Default"
    brave_profile.mkdir(parents=True)
    (config / "BraveSoftware/Brave-Browser/Local State").write_text(json.dumps({"profile": {"last_used": "Default"}}))
    (brave_profile / "Preferences").write_text(json.dumps({"extensions": {"settings": {
      EXTENSION_ID: {"path": str(ROOT / "bridge-extension/source"), "location": 8}
    }}}))
    brave_loaded = json.loads(run(["node", str(ROOT / "bin/mailbox-bridge-status.js"), "--brave"], env=status_env).stdout)
    check("command-line Brave extension reports active", brave_loaded["installed"] and brave_loaded["upToDate"] and brave_loaded["registrationMode"] == "user-flags", str(brave_loaded))
    chromium_profile = config / "chromium/Default"
    chromium_profile.mkdir()
    (config / "chromium/Local State").write_text(json.dumps({"profile": {"last_used": "Default"}}))
    (chromium_profile / "Preferences").write_text(json.dumps({"extensions": {"settings": {
      EXTENSION_ID: {"path": str(ROOT / "bridge-extension/source"), "location": 8}
    }}}))
    chromium_loaded = json.loads(run(["node", str(ROOT / "bin/mailbox-bridge-status.js"), "--chromium"], env=status_env).stdout)
    check("command-line Chromium extension reports active without a cached manifest or state field", chromium_loaded["installed"] and chromium_loaded["upToDate"] and chromium_loaded["loadedVersion"] == "0.0.7", str(chromium_loaded))
    (chromium_profile / "Preferences").write_text(json.dumps({"extensions": {"settings": {
      EXTENSION_ID: {"path": str(ROOT / "bridge-extension/source"), "location": 8, "state": 1}
    }}}))
    flags_before = chromium_flags.read_text()
    chromium_flags.write_text("--disable-gpu\n--load-extension=/keep/chromium\n")
    stale_command_line = json.loads(run(["node", str(ROOT / "bin/mailbox-bridge-status.js"), "--chromium"], env=status_env).stdout)
    check("command-line extension with state one requires its startup flag", not stale_command_line["upToDate"] and stale_command_line["installed"], str(stale_command_line))
    chromium_flags.write_text(flags_before)
    result = run(["node", str(helper), "--remove"], env=env)
    check("removal drops only Mailbox flags from every flags file", result.returncode == 0 and str(ROOT / "bridge-extension") not in flags.read_text() and "/keep/me" in flags.read_text() and str(ROOT / "bridge-extension/source") not in chromium_flags.read_text() and "/keep/chromium" in chromium_flags.read_text() and str(ROOT / "bridge-extension/source") not in brave_flags.read_text() and "--password-store=gnome-libsecret" in brave_flags.read_text(), result.stderr + chromium_flags.read_text())
    result = run(["node", str(helper), "--remove"], env=env)
    check("browser bridge uninstaller exits cleanly", result.returncode == 0, result.stderr)
    check("browser bridge uninstaller removes native registrations", not list(config.glob("**/io.github.avillagran.mailbox.json")))
    status = json.loads(run(["node", str(ROOT / "bin/mailbox-bridge-status.js")], env=status_env).stdout)
    check("uninstall waits for user to remove extension in browser", status["removalReady"] and not status["upToDate"], str(status))


def test_browser_installer_symlink_safety():
  helper = ROOT / "bin/mailbox-bridge-register.js"
  native_name = "io.github.avillagran.mailbox.json"
  cases = [
    ("native manifest", ".config/google-chrome/NativeMessagingHosts/" + native_name, []),
    ("browser flags", ".config/chromium-flags.conf", ["--chromium"]),
    ("removal marker", ".config/omarchy/mailbox-bridge-removing", ["--remove"]),
    ("browser native host directory", ".config/google-chrome/NativeMessagingHosts", []),
    ("Brave flags", ".config/brave-flags.conf", ["--brave"]),
  ]
  for name, relative, args in cases:
    with tempfile.TemporaryDirectory() as directory:
      home = Path(directory)
      victim = home / "private-data"
      victim_is_dir = name.endswith("directory")
      if victim_is_dir:
        victim.mkdir()
        (victim / "sentinel").write_text("KEEP MY DATA")
      else:
        victim.write_text("KEEP MY DATA")
      link = home / relative
      link.parent.mkdir(parents=True)
      link.symlink_to(victim, target_is_directory=victim_is_dir)
      result = run(["node", str(helper), *args], env={**os.environ, "HOME": str(home)})
      check(f"{name} symlink is rejected", result.returncode != 0, result.stdout + result.stderr)
      actual = (victim / "sentinel").read_text() if victim_is_dir else victim.read_text()
      check(f"{name} symlink does not alter unrelated file", actual == "KEEP MY DATA", actual)
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    config = home / ".config"
    config.mkdir()
    victim = home / "unrelated-chrome-flags"
    victim.write_text("--other-flag\n")
    (config / "chrome-flags.conf").symlink_to(victim)
    result = run(["node", str(helper), "--chromium"], env={**os.environ, "HOME": str(home)})
    chromium_flags = config / "chromium-flags.conf"
    check("unrelated Chrome flags symlink does not block Chromium installation", result.returncode == 0 and chromium_flags.is_file() and str(ROOT / "bridge-extension/source") in chromium_flags.read_text(), result.stderr)
    check("unrelated Chrome flags symlink target is untouched", victim.read_text() == "--other-flag\n", victim.read_text())
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    config = home / ".config"
    native = config / "google-chrome/NativeMessagingHosts"
    native.mkdir(parents=True)
    original = native / native_name
    victim = home / "hardlinked-data"
    victim.write_text("KEEP MY DATA")
    os.link(victim, original)
    result = run(["node", str(helper)], env={**os.environ, "HOME": str(home)})
    check("existing manifest is replaced without changing hardlinked file", result.returncode == 0 and victim.read_text() == "KEEP MY DATA" and original.read_text() != "KEEP MY DATA", result.stdout + result.stderr)


def test_omarchy_tools():
  if subprocess.run(["bash", "-lc", "command -v omarchy >/dev/null"], capture_output=True).returncode == 0:
    result = run(["omarchy", "plugin", "validate", str(ROOT)])
    check("official Omarchy plugin validator", result.returncode == 0, result.stdout + result.stderr)
  else:
    skip("official Omarchy plugin validator", "omarchy is not installed")
  qmllint = Path("/usr/lib/qt6/bin/qmllint")
  if qmllint.exists():
    result = run([str(qmllint), "-I", "/usr/share/omarchy/shell", *map(str, ROOT.glob("*.qml"))])
    output = result.stdout + result.stderr
    syntax_errors = [line for line in output.splitlines() if re.search(r"\[syntax\]|unexpected token|parse error|unbalanced", line, re.I)]
    check("QML syntax gate", not syntax_errors, "\n".join(syntax_errors))
  else:
    skip("QML syntax gate", "qmllint is not installed")


def test_guided_browser_setup():
  helper = ROOT / "bin/mailbox-open-browser-extensions.js"
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    apps = home / ".local/share/applications"
    apps.mkdir(parents=True)
    (apps / "google-chrome.desktop").write_text("[Desktop Entry]\nType=Application\nName=Chrome\n")
    (apps / "brave-browser.desktop").write_text("[Desktop Entry]\nType=Application\nName=Brave\n")
    fakebin = home / "bin"
    fakebin.mkdir()
    for name, body in {
      "xdg-settings": '#!/bin/sh\nprintf "%s\\n" firefox.desktop\n',
      "wl-copy": '#!/bin/sh\ntest "$#" -eq 0 || exit 9\ntext=$(cat)\n(sleep 0.35; printf "%s\\n" "$text" > "$CLIP_LOG") &\nsleep 2 &\n',
      "wl-paste": '#!/bin/sh\ntest -f "$CLIP_LOG" || exit 1\nprintf "%s" "$(cat "$CLIP_LOG")"\n',
      "gio": '#!/bin/sh\nprintf "%s\\n" "$@" > "$GUI_LOG"\nsleep 3\n',
    }.items():
      file = fakebin / name
      file.write_text(body)
      file.chmod(0o755)
    gui = home / "gui.log"
    clip = home / "clip.log"
    env = {**os.environ, "HOME": str(home), "PATH": str(fakebin) + os.pathsep + os.environ["PATH"], "GUI_LOG": str(gui), "CLIP_LOG": str(clip)}
    start = time.monotonic()
    result = run(["node", str(helper), "--chrome"], env=env)
    elapsed = time.monotonic() - start
    for _ in range(20):
      if gui.exists(): break
      time.sleep(0.05)
    check("guided Chrome setup ignores a different default browser", result.returncode == 0 and "google-chrome.desktop" in gui.read_text() if gui.exists() else False, result.stderr)
    check("guided setup does not wait for the browser to quit", result.returncode == 0 and elapsed < 3, f"exit={result.returncode} elapsed={elapsed:.2f} {result.stderr}")
    check("guided setup does not wait on clipboard owner inherited pipes", elapsed < 1.2, f"clipboard blocked setup for {elapsed:.2f}s: {result.stderr}")
    check("guided setup opens the browser without a user command", gui.exists() and "about:blank" in gui.read_text(), result.stderr)
    check("guided setup copies the Extensions page address", clip.exists() and "chrome://extensions" in clip.read_text(), result.stderr)
    gui.unlink()
    result = run(["node", str(helper), "--chrome", "gmail"], env=env)
    for _ in range(20):
      if gui.exists(): break
      time.sleep(0.05)
    check("guided setup opens Gmail in Chrome", result.returncode == 0 and gui.exists() and "https://mail.google.com/mail/" in gui.read_text(), result.stderr)
    result = run(["node", str(helper), "--chrome", "toString"], env=env)
    check("guided setup rejects unknown pages", result.returncode != 0, result.stdout)
    gui.unlink()
    result = run(["node", str(helper), "--brave"], env=env)
    for _ in range(20):
      if gui.exists(): break
      time.sleep(0.05)
    check("guided Brave setup selects Brave regardless of default browser", result.returncode == 0 and gui.exists() and "brave-browser.desktop" in gui.read_text(), result.stderr)


def test_chrome_status_detection():
  status_bin = ROOT / "bin/mailbox-bridge-status.js"
  extension = ROOT / "bridge-extension/source"
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    chrome = home / ".config/google-chrome"
    (chrome / "Default").mkdir(parents=True)
    (chrome / "NativeMessagingHosts").mkdir()
    (chrome / "NativeMessagingHosts/io.github.avillagran.mailbox.json").write_text(json.dumps({"path": str(ROOT / "bin/mailbox-bridge-host.js"), "allowed_origins": ["chrome-extension://kjmlhpckodkmfcjmelnkknkaeiognoed/"]}))
    env = {**os.environ, "HOME": str(home), "MAILBOX_LEGACY_REGISTRY_ROOT": str(home / "none")}
    def status(setting, ui=None):
      prefs = {"extensions": {"settings": {"kjmlhpckodkmfcjmelnkknkaeiognoed": setting}}}
      if ui is not None: prefs["account_values"] = {"extensions": {"ui": ui}}
      (chrome / "Default/Preferences").write_text(json.dumps(prefs))
      return json.loads(run(["node", str(status_bin), "--chrome"], env=env).stdout)
    enabled = status({"location": 4, "path": str(extension)}, {"developer_mode": True})
    check("Chrome status accepts enabled unpacked entries without state", enabled["upToDate"] is True, str(enabled))
    check("Chrome status reports account-level Developer mode", enabled["developerMode"] is True, str(enabled))
    disabled = status({"location": 4, "path": str(extension), "disable_reasons": [1]})
    check("Chrome status keeps disabled unpacked entries inactive", disabled["upToDate"] is False and disabled["developerMode"] is False, str(disabled))


def test_refresh_requires_installed_extension():
  helper = ROOT / "bin/mailbox-force-refresh.js"
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    fakebin = home / "bin"
    fakebin.mkdir()
    xdg = fakebin / "xdg-settings"
    xdg.write_text('#!/bin/sh\nprintf "%s\\n" google-chrome.desktop\n')
    xdg.chmod(0o755)
    gui = fakebin / "gio"
    gui.write_text('#!/bin/sh\nprintf "%s\\n" "$@" >> "$GUI_LOG"\n')
    gui.chmod(0o755)
    apps = home / ".local/share/applications"
    apps.mkdir(parents=True)
    (apps / "google-chrome.desktop").write_text("[Desktop Entry]\nType=Application\nName=Chrome\n")
    log = home / "gui.log"
    env = {**os.environ, "HOME": str(home), "PATH": str(fakebin) + os.pathsep + os.environ["PATH"], "GUI_LOG": str(log)}
    result = run(["node", str(helper)], env=env)
    check("refresh refuses a browser without an installed bridge", result.returncode != 0 and not log.exists() and "Load unpacked" in result.stderr, result.stderr)
    brave = home / ".config/BraveSoftware/Brave-Browser"
    (brave / "Default").mkdir(parents=True)
    (brave / "Local State").write_text(json.dumps({"profile": {"last_used": "Default"}}))
    (brave / "Default/Preferences").write_text(json.dumps({"extensions": {"settings": {
      EXTENSION_ID: {"path": str(ROOT / "bridge-extension/source"), "location": 4, "state": 1}
    }}}))
    native = brave / "NativeMessagingHosts/io.github.avillagran.mailbox.json"
    native.parent.mkdir()
    native.write_text(json.dumps({"path": str(HOST), "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"]}))
    (apps / "brave-browser.desktop").write_text("[Desktop Entry]\nType=Application\nName=Brave\n")
    result = run(["node", str(helper), "--brave"], env=env)
    for _ in range(20):
      if log.exists(): break
      time.sleep(0.05)
    check("refresh targets installed Brave despite Chrome default", result.returncode == 0 and log.exists() and "brave-browser.desktop" in log.read_text(), f"exit={result.returncode} log={log.read_text() if log.exists() else 'missing'} stderr={result.stderr}")
    (apps / "brave-browser.desktop").unlink()
    (apps / "brave.desktop").write_text("[Desktop Entry]\nType=Application\nName=Brave alternate\n")
    result = run(["node", str(helper), "--brave"], env=env)
    for _ in range(40):
      if log.exists() and "brave.desktop" in log.read_text(): break
      time.sleep(0.05)
    check("refresh uses installed Brave launcher alias", result.returncode == 0 and log.exists() and "brave.desktop" in log.read_text(), f"exit={result.returncode} stderr={result.stderr}")


def test_bounded_inputs():
  bin_sources = {path.name: path.read_text() for path in (ROOT / "bin").glob("*.js")}
  check("every bin script reads files through the bounded reader", not any("readFileSync" in source for source in bin_sources.values()), ", ".join(name for name, source in bin_sources.items() if "readFileSync" in source))
  host_source = bin_sources["mailbox-bridge-host.js"]
  check("native host caps frames, accounts, rows and total bodies", all(token in host_source for token in ("MAX_FRAME_BYTES", "MAX_ACCOUNTS", "MAX_SNAPSHOT_ROWS", "MAX_THREAD_PARTS", "MAX_TOTAL_BODY_BYTES")))
  check("notification history is read as a bounded recent slice", "MAX_NOTIFICATION_FILES" in bin_sources["mailbox.js"] and "opendirSync" in bin_sources["mailbox.js"])
  check("panel validates Gmail slot indexes before building URLs", "function gmailIndex(account)" in (ROOT / "Panel.qml").read_text())

  # An oversized frame header is rejected without waiting for or buffering the body.
  with tempfile.TemporaryDirectory() as directory:
    result = subprocess.run(["node", str(HOST)], env={**os.environ, "HOME": directory}, input=struct.pack("<I", 0xFFFFFFF0) + b"{", capture_output=True, timeout=10)
    length = struct.unpack("<I", result.stdout[:4])[0] if len(result.stdout) >= 4 else 0
    reply = json.loads(result.stdout[4:4 + length]) if length else {}
    check("native host refuses oversized frames", result.returncode == 0 and reply.get("ok") is False and "too large" in reply.get("error", ""), str(reply))

  reader = ROOT / "bin/mailbox-bounded-read.js"
  with tempfile.TemporaryDirectory() as directory:
    base = Path(directory)
    small = base / "small.json"
    small.write_text('{"ok": true}')
    big = base / "big.json"
    big.write_text(" " * 2048)
    link = base / "link.json"
    link.symlink_to(small)
    script = (
      "const r = require(process.argv[1]);"
      "const out = {};"
      "for (const [name, file, max] of [['small', process.argv[2], 1024], ['big', process.argv[3], 1024], ['link', process.argv[4], 1024]]) {"
      "  try { out[name] = r.readJson(file, max); } catch (error) { out[name] = 'error:' + (error.code || error.message); }"
      "}"
      "console.log(JSON.stringify(out));"
    )
    result = run(["node", "-e", script, str(reader), str(small), str(big), str(link)])
    out = json.loads(result.stdout or "{}")
    check("bounded reader returns small regular files", out.get("small") == {"ok": True}, result.stdout + result.stderr)
    check("bounded reader refuses files over the limit", str(out.get("big", "")).startswith("error:") and "exceeds" in str(out.get("big")), str(out.get("big")))
    check("bounded reader refuses a symlinked file", out.get("link") == "error:ELOOP", str(out.get("link")))

  # Snapshot fields are clipped and non-provider row URLs are dropped.
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    (home / ".config/omarchy").mkdir(parents=True)
    (home / ".config/omarchy/mailbox.json").write_text(json.dumps({"accounts": {"real@example.com": {}}}))
    row = {"from": "A" * 5000, "subject": "S" * 5000, "snippet": "x", "date": "today", "threadId": "abc", "url": "https://evil.example/phish", "unread": True}
    reply = native_message(home, {"type": "mailbox-snapshot", "account": "real@example.com", "accountVerified": True, "index": "0", "unread": 1, "emails": [row] * 3})
    stored = json.loads((home / ".cache/omarchy/mailbox/bridge.json").read_text())["accounts"]["real@example.com"]["emails"][0]
    check("native host clips snapshot fields", reply.get("ok") is True and len(stored["from"]) == 512 and len(stored["subject"]) == 1024, str(reply))
    check("native host drops non-provider row URLs", stored["url"] == "", stored["url"])


def test_safe_paste_and_account_launch():
  with tempfile.TemporaryDirectory() as directory:
    fake = Path(directory) / "wl-paste"
    fake.write_text("#!/usr/bin/env python3\nimport os, sys, time\nmode = os.environ['PASTE_CASE']\nif mode == 'hang': time.sleep(30)\nelif mode == 'overflow': sys.stdout.buffer.write(b'x' * 65537)\nelif mode == 'exact': sys.stdout.buffer.write(b'x' * 65536)\nelif mode == 'invalid': sys.stdout.buffer.write(b'\\xff')\nelif mode == 'error': sys.stdout.write('partial'); sys.exit(1)\nelse: sys.stdout.write('Hola 😀\\nsegunda línea')\n")
    fake.chmod(0o755)
    for case in ['normal', 'exact', 'overflow', 'invalid', 'error', 'hang']:
      start = time.monotonic()
      result = subprocess.run(['node', str(ROOT / 'bin/mailbox-paste.js')], env={**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'], 'PASTE_CASE': case}, capture_output=True, timeout=4)
      elapsed = time.monotonic() - start
      if case in ['normal', 'exact']:
        expected = 'x' * 65536 if case == 'exact' else 'Hola 😀\nsegunda línea'
        check('bounded paste accepts ' + case, result.returncode == 0 and json.loads(result.stdout)['text'] == expected)
      else:
        check('bounded paste rejects ' + case, result.returncode != 0 and not result.stdout)
      check('bounded paste deadline ' + case, elapsed < 3, str(elapsed))
  panel = (ROOT / 'Panel.qml').read_text()
  functions = []
  for name in ['openAccountInbox', 'safeInboxUrl']:
    functions.append(re.search(r'  function ' + name + r'\(account\) \{.*?\n  \}', panel, re.S).group(0))
  script = """
const launched = [];
const Quickshell = { execDetached: argv => launched.push(argv) };
const pendingAccountProc = { running: false };
const root = {};
""" + '\n'.join(functions) + """
root.safeInboxUrl = safeInboxUrl;
for (const account of [
  {email: 'private@example.com', index: '2'},
  {email: 'private@example.com'},
  {email: 'private@example.com', index: '2?authuser=private@example.com'},
  {email: 'private@example.com', inboxUrl: 'https://mail.google.com/mail/?authuser=private@example.com'},
  {email: 'private@example.com', inboxUrl: 'https://mail.google.com/mail/u/3/#inbox'},
  {provider: 'hey', inboxUrl: 'https://app.hey.com/'}
]) openAccountInbox(account);
process.stdout.write(JSON.stringify(launched));
"""
  result = run(['node', '-e', script])
  urls = [argv[1] for argv in json.loads(result.stdout)]
  check('account launches never expose an email or query', all('@' not in url and '?' not in url for url in urls))
  check('known Gmail account preserves numeric slot', urls[0] == 'https://mail.google.com/mail/u/2/#inbox' and urls[4] == 'https://mail.google.com/mail/u/3/#inbox')
  check('unknown Gmail account does not guess a slot', all(url == 'https://mail.google.com/mail/#inbox' for url in urls[1:4]))
  check('HEY account keeps its inbox', urls[5] == 'https://app.hey.com/')
  runner = Path('/usr/lib/qt6/bin/qmltestrunner')
  if runner.exists():
    result = run([str(runner), '-input', str(ROOT / 'tests/qml')], env={**os.environ, 'QT_QPA_PLATFORM': 'offscreen'})
    check('real Qt keyboard interaction suite', result.returncode == 0, result.stdout + result.stderr)
  else:
    skip('real Qt keyboard interaction suite', 'qmltestrunner is not installed')


def main():
  for command in (["python3", str(ROOT / "tests/test_feed.py")], ["node", str(ROOT / "tests/background-feed.cjs")]):
    result = run(command)
    check("background reception behavioral checks", result.returncode == 0, result.stdout + result.stderr)
  test_safe_paste_and_account_launch()
  test_guided_browser_setup()
  test_refresh_requires_installed_extension()
  test_chrome_status_detection()
  test_static_files()
  test_i18n()
  test_versions()
  test_hey_provider()
  test_marketplace_structure()
  test_panel_badge_propagation()
  test_mark_as_read_keeps_messages()
  test_reply_drafts()
  test_reading_navigation()
  test_mail_client_listing()
  test_notification_reconciliation()
  test_native_host()
  test_bounded_inputs()
  test_settings()
  test_keybind()
  test_browser_installer()
  test_browser_installer_symlink_safety()
  test_omarchy_tools()
  print(f"SUMMARY {passed} PASS / 0 FAIL / {skipped} SKIP")


if __name__ == "__main__":
  main()
