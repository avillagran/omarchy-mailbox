#!/usr/bin/env python3
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import tempfile

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
  for filename in ["manifest.json", "bridge-extension/source/manifest.json", "i18n.json", "config/accounts.example.json"]:
    json.loads((ROOT / filename).read_text())
    check(f"valid JSON: {filename}", True)
  for filename in [*ROOT.glob("bin/*.js"), *ROOT.glob("bridge-extension/source/*.js")]:
    result = run(["node", "--check", str(filename)])
    check(f"JavaScript syntax: {filename.relative_to(ROOT)}", result.returncode == 0, result.stderr)
  result = run(["bash", "-n", str(ROOT / "bin/mailbox-bridge-system-install.sh")])
  check("system installer shell syntax", result.returncode == 0, result.stderr)
  compile((ROOT / "bin/mailbox-browser-restart.py").read_text(), "mailbox-browser-restart.py", "exec")
  check("browser restart helper Python syntax", True)
  restart_helper = (ROOT / "bin/mailbox-browser-restart.py").read_text()
  check("browser restart rescans replacement processes", restart_helper.count("browser_processes()") >= 4)
  check("browser restart identifies actual executables", "os.readlink(f'/proc/{pid}/exe')" in restart_helper and "cmdline" not in restart_helper)
  check("browser restart bypasses a surviving browser session", "[browser, 'https://mail.google.com/mail/', 'https://app.hey.com/']" in restart_helper)
  shebang_files = [path for path in (ROOT / "bin").iterdir() if path.is_file() and path.read_bytes()[:2] == b"#!"]
  check("all shebang helpers are executable", all(os.access(path, os.X_OK) for path in shebang_files))
  check("no generated Python artifacts", not any(path.suffix == ".pyc" or "__pycache__" in path.parts for path in ROOT.rglob("*")))
  check("private CRX key is ignored", "bridge-extension.pem" in (ROOT / ".gitignore").read_text().splitlines())


def test_i18n():
  catalog = json.loads((ROOT / "i18n.json").read_text())
  english = catalog["en"]
  keys = set(english) - {""}
  check("i18n has 19 locales", len(catalog) == 19, str(sorted(catalog)))
  check("i18n has 57 message IDs", len(keys) == 57, str(len(keys)))
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
    sync_values = [translations["Synchronizing open Gmail tabs…"], translations["Browser restarted · synchronizing Gmail…"]]
    check(f"provider-neutral synchronization copy: {locale}", all("gmail" not in value.lower() for value in sync_values), str(sync_values))
  check("Spanish synchronization copy says email", catalog["es"]["Synchronizing open Gmail tabs…"] == "Sincronizando email…")


def test_versions():
  extension_manifest = json.loads((ROOT / "bridge-extension/source/manifest.json").read_text())
  extension_version = extension_manifest["version"]
  check("extension version in user installer", extension_version in (ROOT / "bin/mailbox-bridge-install.js").read_text())
  check("extension version in system installer", extension_version in (ROOT / "bin/mailbox-bridge-system-install.sh").read_text())
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
  check("first public plugin version is 0.0.1", manifest["version"] == "0.0.1", manifest["version"])
  check("first public extension version is 0.0.1", json.loads((ROOT / "bridge-extension/source/manifest.json").read_text())["version"] == "0.0.1")
  check("README documents Gmail and HEY support", "Gmail and HEY" in readme and "https://app.hey.com/*" in readme)
  check("marketplace root README documents installation", "## Installation" in readme and "omarchy plugin add" in readme)
  check("marketplace root README documents removal", "## Removal" in readme and "omarchy plugin remove" in readme)
  check("marketplace root README documents dependencies", "## Requirements" in readme and "## External dependencies and privileged actions" in readme)
  check("marketplace root license exists", (ROOT / "LICENSE").is_file() and "Andrés Villagrán" in (ROOT / "LICENSE").read_text())
  preview = ROOT / "preview.png"
  header = preview.read_bytes()[:24]
  width, height = struct.unpack(">II", header[16:24])
  check("marketplace preview is a PNG", header[:8] == b"\x89PNG\r\n\x1a\n")
  check("marketplace preview is within size limits", preview.stat().st_size <= 50 * 1024 * 1024 and width * height <= 40_000_000, f"{width}x{height}, {preview.stat().st_size} bytes")
  check("marketplace preview is referenced by README", "![Mailbox](preview.png)" in readme)


def test_panel_badge_propagation():
  source = (ROOT / "Panel.qml").read_text()
  check("badge changes propagate to visible email rows", "emailCopy[k].account === email" in source and "root.emails = emailCopy" in source)
  check("badge changes propagate to host email rows", "hostEmails[h].account === email" in source and "root.hostWidget.emails = hostEmails" in source)
  check("panel accepts direct HEY topic URLs", "app\\.hey\\.com\\/topics" in source)
  check("panel opens each provider Inbox URL", "account.inboxUrl" in source)
  check("keyboard opens desktop notification rows", "if (email) root.openEmail(email)" in source)


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
    data = json.loads(result.stdout)
    check("notifications older than bridge capture are reconciled", result.returncode == 0 and not data.get("desktopNotifications") and all(not row.get("notification") for row in data["emails"]), str(data))
    (history / "gmail-new.json").write_text(json.dumps({"timestamp": now + 1000, "app": "Google Chrome", "summary": "Gmail", "body": "New email https://mail.google.com/"}))
    result = run(["node", str(ROOT / "bin/mailbox.js")], env={**os.environ, "HOME": str(home)})
    data = json.loads(result.stdout)
    notification = next((row for row in data["emails"] if row.get("notification")), None)
    check("desktop notifications retain a browser destination", notification is not None and notification.get("url") == "https://mail.google.com/", str(notification))


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
    response = native_message(home, {"type": "mailbox-snapshot", "account": "real@example.com", "accountVerified": True, "index": "0", "unread": 3, "emails": emails})
    check("configured account snapshot is accepted", response.get("ok") is True, str(response))
    check("body allowlist obeys message limit", len(response.get("allowedThreadIds", [])) == 2, str(response))
    cache_file = home / ".cache/omarchy/mailbox/bridge.json"
    cache = json.loads(cache_file.read_text())
    rows = cache["accounts"]["real@example.com"]["emails"]
    check("native cache obeys message limit", len(rows) == 2)
    check("native cache preserves direct Gmail URLs", all("/#inbox/T" in row["url"] for row in rows))
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
    hey_email = {"threadId": "12345", "from": "HEY Sender", "subject": "HEY subject", "date": "4:45 PM", "unread": True, "url": "https://app.hey.com/topics/12345"}
    response = native_message(home, {"type": "mailbox-snapshot", "provider": "hey", "account": "hey:andres@example.com", "label": "andres@example.com", "accountVerified": True, "index": "", "inboxUrl": "https://app.hey.com/", "unread": 1, "emails": [hey_email]})
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
    check("HEY direct topic reaches the widget model", any(email.get("url") == "https://app.hey.com/topics/12345" for email in rendered["emails"]))
    modes = [stat.S_IMODE(path.stat().st_mode) for path in (home / ".cache/omarchy/mailbox").iterdir() if path.is_file()]
    check("native cache files use mode 0600", all(mode == 0o600 for mode in modes), str(modes))


def test_settings():
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    env = {**os.environ, "HOME": str(home)}
    helper = ROOT / "bin/mailbox-settings.js"
    result = run(["node", str(helper), "set", "person@example.com", "a-v!", "green"], env=env)
    data = json.loads(result.stdout)
    check("settings accept semantic color role", result.returncode == 0)
    check("settings normalize initials", data["accounts"]["person@example.com"]["initials"] == "AV")
    result = run(["node", str(helper), "set-limit", "0"], env=env)
    check("message limit clamps to one", json.loads(result.stdout)["maxMessagesPerAccount"] == 1)
    result = run(["node", str(helper), "set-limit", "999"], env=env)
    check("message limit clamps to 200", json.loads(result.stdout)["maxMessagesPerAccount"] == 200)
    check("invalid shortcut is rejected", run(["node", str(helper), "set-shortcut", "7"], env=env).returncode == 2)
    check("invalid color role is rejected", run(["node", str(helper), "set", "person@example.com", "AV", "invalid"], env=env).returncode == 2)


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
    helper = ROOT / "bin/mailbox-bridge-install.js"
    result = run(["node", str(helper)], env=env)
    check("browser bridge installer exits cleanly", result.returncode == 0, result.stderr)
    native = list(config.glob("**/NativeMessagingHosts/io.github.avillagran.mailbox.json"))
    external = list(config.glob(f"**/External Extensions/{EXTENSION_ID}.json"))
    check("browser bridge installs four native manifests", len(native) == 4, str(native))
    check("browser bridge installs four external manifests", len(external) == 4, str(external))
    check("browser bridge removes only its unpacked extension flags", str(ROOT / "bridge-extension") not in flags.read_text() and "/keep/me" in flags.read_text())
    result = run(["node", str(helper), "--uninstall"], env=env)
    check("browser bridge uninstaller exits cleanly", result.returncode == 0, result.stderr)
    check("browser bridge uninstaller removes registrations", not list(config.glob("**/io.github.avillagran.mailbox.json")) and not list(config.glob(f"**/{EXTENSION_ID}.json")))


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


def main():
  test_static_files()
  test_i18n()
  test_versions()
  test_hey_provider()
  test_marketplace_structure()
  test_panel_badge_propagation()
  test_notification_reconciliation()
  test_native_host()
  test_settings()
  test_keybind()
  test_browser_installer()
  test_omarchy_tools()
  print(f"SUMMARY {passed} PASS / 0 FAIL / {skipped} SKIP")


if __name__ == "__main__":
  main()
