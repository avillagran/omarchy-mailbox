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
HOST = ROOT / "bin/gmailbox-bridge-host.js"
EXTENSION_ID = "ljaeaiekecpbmpkcknojllebemmbockk"
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
  for filename in ["manifest.json", "bridge-extension/manifest.json", "i18n.json", "config/accounts.example.json"]:
    json.loads((ROOT / filename).read_text())
    check(f"valid JSON: {filename}", True)
  for filename in [*ROOT.glob("bin/*.js"), *ROOT.glob("bridge-extension/*.js")]:
    result = run(["node", "--check", str(filename)])
    check(f"JavaScript syntax: {filename.relative_to(ROOT)}", result.returncode == 0, result.stderr)
  result = run(["bash", "-n", str(ROOT / "bin/gmailbox-bridge-system-install.sh")])
  check("system installer shell syntax", result.returncode == 0, result.stderr)
  compile((ROOT / "bin/gmailbox-browser-restart.py").read_text(), "gmailbox-browser-restart.py", "exec")
  check("browser restart helper Python syntax", True)
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


def test_versions():
  extension_version = json.loads((ROOT / "bridge-extension/manifest.json").read_text())["version"]
  check("extension version in user installer", extension_version in (ROOT / "bin/gmailbox-bridge-install.js").read_text())
  check("extension version in system installer", extension_version in (ROOT / "bin/gmailbox-bridge-system-install.sh").read_text())


def test_marketplace_structure():
  manifest = json.loads((ROOT / "manifest.json").read_text())
  readme = (ROOT / "README.md").read_text()
  check("marketplace plugin ID is namespaced and non-reserved", manifest["id"].startswith("io.github.avillagran.") and not manifest["id"].startswith("omarchy."))
  check("marketplace root README documents installation", "## Installation" in readme and "omarchy plugin add" in readme)
  check("marketplace root README documents removal", "## Removal" in readme and "omarchy plugin remove" in readme)
  check("marketplace root README documents dependencies", "## Requirements" in readme and "## External dependencies and privileged actions" in readme)
  check("marketplace root license exists", (ROOT / "LICENSE").is_file() and "Andrés Villagrán" in (ROOT / "LICENSE").read_text())
  preview = ROOT / "preview.png"
  header = preview.read_bytes()[:24]
  width, height = struct.unpack(">II", header[16:24])
  check("marketplace preview is a PNG", header[:8] == b"\x89PNG\r\n\x1a\n")
  check("marketplace preview is within size limits", preview.stat().st_size <= 50 * 1024 * 1024 and width * height <= 40_000_000, f"{width}x{height}, {preview.stat().st_size} bytes")
  check("marketplace preview is referenced by README", "![Gmailbox](preview.png)" in readme)


def test_panel_badge_propagation():
  source = (ROOT / "Panel.qml").read_text()
  check("badge changes propagate to visible email rows", "emailCopy[k].account === email" in source and "root.emails = emailCopy" in source)
  check("badge changes propagate to host email rows", "hostEmails[h].account === email" in source and "root.hostWidget.emails = hostEmails" in source)


def test_notification_reconciliation():
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    now = 4102444800000
    config = home / ".config/omarchy"
    cache = home / ".cache/omarchy/gmailbox"
    history = home / ".local/state/omarchy/notifications/history"
    config.mkdir(parents=True)
    cache.mkdir(parents=True)
    history.mkdir(parents=True)
    (config / "gmailbox.json").write_text(json.dumps({"accounts": {"preview@example.test": {"initials": "PX", "color": "green"}}}))
    (cache / "bridge.json").write_text(json.dumps({"accounts": {"preview@example.test": {"account": "preview@example.test", "index": "0", "unread": 1, "capturedAt": now, "emails": [{"threadId": "T1", "from": "Example", "subject": "Example", "date": "Sep 17, 2026, 4:45 PM"}]}}}))
    (history / "gmail.json").write_text(json.dumps({"timestamp": now - 1000, "app": "Google Chrome", "summary": "Gmail", "body": "Older notification"}))
    result = run(["node", str(ROOT / "bin/gmailbox.js")], env={**os.environ, "HOME": str(home)})
    data = json.loads(result.stdout)
    check("notifications older than bridge capture are reconciled", result.returncode == 0 and not data.get("desktopNotifications") and all(not row.get("notification") for row in data["emails"]), str(data))


def test_native_host():
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    config = home / ".config/omarchy"
    config.mkdir(parents=True)
    settings = {"accounts": {"real@example.com": {}}, "maxMessagesPerAccount": 2, "downloadBodies": True}
    (config / "gmailbox.json").write_text(json.dumps(settings))
    response = native_message(home, {"type": "gmailbox-snapshot", "account": "login@example.net", "accountVerified": False, "index": "9", "emails": []})
    check("unverified phantom account is rejected", response.get("ok") is False and "verified" in response.get("error", ""), str(response))
    emails = [{"threadId": f"T{index}", "from": "Sender", "subject": f"Subject {index}", "date": str(index), "unread": True, "url": f"https://mail.google.com/mail/u/0/#inbox/T{index}"} for index in range(3)]
    response = native_message(home, {"type": "gmailbox-snapshot", "account": "real@example.com", "accountVerified": True, "index": "0", "unread": 3, "emails": emails})
    check("configured account snapshot is accepted", response.get("ok") is True, str(response))
    check("body allowlist obeys message limit", len(response.get("allowedThreadIds", [])) == 2, str(response))
    cache_file = home / ".cache/omarchy/gmailbox/bridge.json"
    cache = json.loads(cache_file.read_text())
    rows = cache["accounts"]["real@example.com"]["emails"]
    check("native cache obeys message limit", len(rows) == 2)
    check("native cache preserves direct Gmail URLs", all("/#inbox/T" in row["url"] for row in rows))
    thread_id = rows[0]["threadId"]
    response = native_message(home, {"type": "gmailbox-thread-body", "account": "real@example.com", "accountVerified": True, "index": "0", "threadId": thread_id, "complete": True, "messages": [{"messageId": "M1", "from": "Sender", "date": "today", "text": "Complete body"}]})
    check("complete body is cached", response.get("saved") is True, str(response))
    settings["downloadBodies"] = False
    (config / "gmailbox.json").write_text(json.dumps(settings))
    response = native_message(home, {"type": "gmailbox-snapshot", "account": "real@example.com", "accountVerified": True, "index": "0", "unread": 1, "emails": [emails[-1]]})
    cache = json.loads(cache_file.read_text())
    rows = cache["accounts"]["real@example.com"]["emails"]
    check("disabled body downloads are reported", response.get("bodyDownloadsEnabled") is False)
    check("disabling body downloads purges bodies", all("body" not in row and "bodyState" not in row for row in rows))
    modes = [stat.S_IMODE(path.stat().st_mode) for path in (home / ".cache/omarchy/gmailbox").iterdir() if path.is_file()]
    check("native cache files use mode 0600", all(mode == 0o600 for mode in modes), str(modes))


def test_settings():
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    env = {**os.environ, "HOME": str(home)}
    helper = ROOT / "bin/gmailbox-settings.js"
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
    main.write_text('require("default.hypr.bindings")\nrequire("gmailbox")\nrequire("gmailbox")\n')
    fake_bin = home / "bin"
    fake_bin.mkdir()
    fake_hyprctl = fake_bin / "hyprctl"
    fake_hyprctl.write_text("#!/bin/bash\nexit 0\n")
    fake_hyprctl.chmod(0o755)
    env = {**os.environ, "HOME": str(home), "PATH": f"{fake_bin}:{os.environ['PATH']}"}
    helper = ROOT / "bin/gmailbox-keybind.js"
    result = run(["node", str(helper), "Q"], env=env)
    check("keybind installer exits cleanly", result.returncode == 0, result.stderr)
    text = main.read_text()
    check("keybind uses prefixed Hyprland require", text.count('require("hypr.gmailbox")') == 1 and 'require("gmailbox")' not in text, text)
    check("generated keybind targets Gmailbox", "SUPER + SHIFT + Q" in (hypr / "gmailbox.lua").read_text())
    result = run(["node", str(helper), "R"], env=env)
    check("keybind installer is idempotent", result.returncode == 0 and main.read_text().count('require("hypr.gmailbox")') == 1)
    check("keybind update replaces the previous letter", "SUPER + SHIFT + R" in (hypr / "gmailbox.lua").read_text())
    result = run(["node", str(helper), "--uninstall"], env=env)
    check("keybind uninstaller exits cleanly", result.returncode == 0, result.stderr)
    check("keybind uninstaller removes generated file", not (hypr / "gmailbox.lua").exists())
    check("keybind uninstaller removes require lines", "gmailbox" not in main.read_text())


def test_browser_installer():
  with tempfile.TemporaryDirectory() as directory:
    home = Path(directory)
    config = home / ".config"
    config.mkdir()
    flags = config / "chrome-flags.conf"
    flags.write_text(f"--load-extension={ROOT / 'bridge-extension'},/keep/me\n--other-flag\n")
    env = {**os.environ, "HOME": str(home)}
    helper = ROOT / "bin/gmailbox-bridge-install.js"
    result = run(["node", str(helper)], env=env)
    check("browser bridge installer exits cleanly", result.returncode == 0, result.stderr)
    native = list(config.glob("**/NativeMessagingHosts/io.github.avillagran.gmailbox.json"))
    external = list(config.glob(f"**/External Extensions/{EXTENSION_ID}.json"))
    check("browser bridge installs four native manifests", len(native) == 4, str(native))
    check("browser bridge installs four external manifests", len(external) == 4, str(external))
    check("browser bridge removes only its unpacked extension flag", str(ROOT / "bridge-extension") not in flags.read_text() and "/keep/me" in flags.read_text())
    result = run(["node", str(helper), "--uninstall"], env=env)
    check("browser bridge uninstaller exits cleanly", result.returncode == 0, result.stderr)
    check("browser bridge uninstaller removes registrations", not list(config.glob("**/io.github.avillagran.gmailbox.json")) and not list(config.glob(f"**/{EXTENSION_ID}.json")))


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
