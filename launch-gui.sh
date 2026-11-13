#!/bin/bash
# Launch the Progress Desktop GUI
#
# This starts a local HTTP server that serves a floating progress indicator
# panel. Open the URL in your browser or desktop app to see agent progress.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Starting OpenCode Progress Desktop GUI..."
echo ""

# Check if the state file exists, create if not
STATE_FILE="${PROGRESS_STATE_PATH:-$HOME/.opencode-progress-state.json}"
if [ ! -f "$STATE_FILE" ]; then
  echo '{"entries":{},"version":2}' > "$STATE_FILE"
fi

# Start the GUI server in the background
node "$SCRIPT_DIR/progress-gui-server.js" &
GUI_PID=$!

echo "GUI server PID: $GUI_PID"
echo ""
echo "Open this URL in your browser to see progress indicators:"
echo "  http://localhost:8765"
echo ""
echo "Or add it as a desktop app/web app in your OS."
echo ""
echo "Press Ctrl+C to stop the GUI server."
echo ""

# Wait for the GUI server
wait $GUI_PID