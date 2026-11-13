#!/bin/bash
# Setup script for OpenCode Progress Tool
#
# Installs the MCP server into OpenCode so agents can call the `progress` tool.
# The desktop GUI can be installed separately (see README.md).
#
# Note: `opencode plugin add` only accepts npm registry packages or Git
# specifiers, not local paths. The plugin code is complete at `plugin/`
# but needs to be published to npm or a Git repo before it can be installed
# via `opencode plugin add`.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_SERVER="$SCRIPT_DIR/mcp-server/index.js"

echo "=== OpenCode Progress Tool Setup ==="
echo ""

# Check OpenCode is installed
if ! command -v opencode &> /dev/null && [ ! -x "$HOME/.opencode/bin/opencode" ]; then
  echo "ERROR: OpenCode is not installed or not in PATH"
  echo "Install it first: https://opencode.ai/"
  exit 1
fi

OPENCODE_BIN="$(command -v opencode 2>/dev/null || echo "$HOME/.opencode/bin/opencode")"

echo "1. Adding MCP server 'progress-server'..."
"$OPENCODE_BIN" mcp add progress-server -- "$MCP_SERVER"
echo "   ✓ MCP server added"

echo ""
echo "2. Restarting OpenCode service..."
"$OPENCODE_BIN" service restart 2>/dev/null || true
echo "   ✓ Service restarted (or will restart on next launch)"

echo ""
echo "=== Setup complete! ==="
echo ""
echo "The \`progress\` tool is now available to agents via MCP."
echo ""
echo "Next step - install the desktop GUI:"
echo "  Option A (plugin): Publish plugin/ to npm, then: opencode plugin add opencode-progress-plugin"
echo "  Option B (standalone): Run ./launch-gui.sh and open http://localhost:8765"
echo ""
echo "Example usage from an agent:"
echo '  progress({ id: "build-1", status: "running", title: "Building", progress: 0.5 })'
