#!/bin/bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
python3 "$ROOT/tests/test_plugin.py"
