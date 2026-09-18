#!/usr/bin/env bash
# Installs the signed Mailbox CRX at Chrome's system extension registry.
# Must run via pkexec; it never reads browser profiles or credentials.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
ID='kjmlhpckodkmfcjmelnkknkaeiognoed'
VERSION='0.0.1'
CRX="$ROOT/bridge-extension.crx"
DEST='/opt/google/chrome/extensions'
install -d -m 755 "$DEST"
if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$DEST/$ID.json"
  exit 0
fi
[ -f "$CRX" ]
printf '{"external_crx":"%s","external_version":"%s"}\n' "$CRX" "$VERSION" > "$DEST/$ID.json"
chmod 644 "$DEST/$ID.json"
