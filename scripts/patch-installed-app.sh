#!/bin/bash
set -euo pipefail

APP="/Applications/Open Design.app"
RESOURCES="$APP/Contents/Resources"
WEB_PUBLIC="$RESOURCES/open-design-web-standalone/apps/web/public"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Patching Open Design app..."

# Kill the app if running
killall "Open Design" 2>/dev/null && sleep 1 || true

# 1. Dock icon
sudo cp "$REPO_ROOT/tools/pack/resources/mac/icon.icns" "$RESOURCES/icon.icns"
echo "  ✓ Dock icon"

# 2. In-app logos
sudo cp "$REPO_ROOT/apps/web/public/app-icon.svg" "$WEB_PUBLIC/app-icon.svg"
sudo cp "$REPO_ROOT/apps/web/public/logo.svg" "$WEB_PUBLIC/logo.svg"
echo "  ✓ In-app logos"

# 3. Fix --dangerously-skip-permissions for OpenCode
CHUNKS_DIR="$RESOURCES/app/prebundled/daemon/chunks"
if [ -d "$CHUNKS_DIR" ]; then
  for chunk in "$CHUNKS_DIR"/chunk-*.mjs; do
    if grep -q '"--dangerously-skip-permissions"' "$chunk" 2>/dev/null; then
      sudo sed -i.bak 's/"--dangerously-skip-permissions",//' "$chunk"
      sudo rm -f "$chunk.bak"
      echo "  ✓ Removed --dangerously-skip-permissions from $(basename "$chunk")"
    fi
  done
fi

# 4. Increase agent inactivity timeout (10min -> 30min)
# See https://github.com/nexu-io/open-design/issues/1451
CHUNKS_DIR="$RESOURCES/app/prebundled/daemon/chunks"
if [ -d "$CHUNKS_DIR" ]; then
  for chunk in "$CHUNKS_DIR"/chunk-*.mjs; do
    if grep -q 'DEFAULT_CHAT_RUN_INACTIVITY_TIMEOUT_MS = 10 \* 60 \* 1e3' "$chunk" 2>/dev/null; then
      sudo sed -i.bak 's/DEFAULT_CHAT_RUN_INACTIVITY_TIMEOUT_MS = 10 \* 60 \* 1e3/DEFAULT_CHAT_RUN_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1e3/' "$chunk"
      sudo rm -f "$chunk.bak"
      echo "  ✓ Increased agent timeout to 30min in $(basename "$chunk")"
    fi
  done
fi

# 5. Clear icon cache
sudo rm -rf /Library/Caches/com.apple.iconservices.store 2>/dev/null || true
sudo killall Dock 2>/dev/null || true

echo "Done. Open the app again."
