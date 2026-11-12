#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EXT="${MYSPOTI_EXT:-myspoti-ext}"
if ! command -v "$EXT" >/dev/null 2>&1; then
  for candidate in \
    "$HOME/myspoti-debug/base/extensions-cli/build/install/myspoti-ext/bin/myspoti-ext" \
    "/opt/myspoti-ext/bin/myspoti-ext"; do
    if [ -x "$candidate" ]; then
      EXT="$candidate"
      break
    fi
  done
fi

if ! command -v "$EXT" >/dev/null 2>&1; then
  echo "myspoti-ext was not found. Set MYSPOTI_EXT to its path." >&2
  exit 1
fi

if [ -z "${JAVA_HOME:-}" ] && [ -x "$HOME/.local/jdk17/bin/java" ]; then
  export JAVA_HOME="$HOME/.local/jdk17"
fi

"$EXT" check .
mkdir -p packages
"$EXT" pack . packages
"$EXT" index packages "Orpheon Eclipse Bridge"

python3 - <<'PY'
import json
from pathlib import Path

root = Path.cwd()
source = root / "packages" / "index.json"
target = root / "index.json"
if not source.exists():
    raise SystemExit("packages/index.json was not generated")

data = json.loads(source.read_text())
for extension in data.get("extensions", []):
    url = extension.get("url", "")
    if url and not url.startswith("packages/"):
        extension["url"] = "packages/" + url
target.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
print(f"wrote {target}")
PY
