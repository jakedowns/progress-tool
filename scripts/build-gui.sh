#!/usr/bin/env bash
# Build the desktop GUI bundle off the shared mount.
#
# The repo lives on a VM/shared disk mount, where walking node_modules is slow
# and occasionally flaky (and a macOS `npm install` can clobber the deps
# symlink). Stage the plugin sources in a local temp dir, build there, and copy
# only the built bundle back.
#
# Usage: scripts/build-gui.sh
#   PROGRESS_BUILD_DIR  staging dir (default: /tmp/opencode/build/progress-gui)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PLUGIN="$ROOT/plugin"
STAGE="${PROGRESS_BUILD_DIR:-/tmp/opencode/build/progress-gui}"

if [ ! -e "$PLUGIN/node_modules" ]; then
  echo "error: $PLUGIN/node_modules is missing; install deps first" >&2
  exit 1
fi
DEPS=$(cd "$PLUGIN/node_modules" && pwd -P)

mkdir -p "$STAGE"
rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  "$PLUGIN/" "$STAGE/"

# Reuse the already-installed deps (usually a local-disk symlink).
ln -sfn "$DEPS" "$STAGE/node_modules"

(
  cd "$STAGE"
  npx vite build
)

mkdir -p "$PLUGIN/dist"
cp "$STAGE/dist/gui-experimental.cjs" "$PLUGIN/dist/gui-experimental.cjs"
echo "copied dist/gui-experimental.cjs back to $PLUGIN/dist"
