#!/usr/bin/env bash
# Installer for Controlium.
# - installs the MCP server's dependencies
# - registers the MCP server with Claude Code (user scope)
# - prints how to load the extension into your existing Chrome
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$DIR/mcp-server/server.js"

echo "==> Installing MCP server dependencies"
( cd "$DIR/mcp-server" && npm install --silent )

if command -v claude >/dev/null 2>&1; then
  echo "==> Registering MCP server with Claude Code (user scope)"
  claude mcp remove controlium --scope user >/dev/null 2>&1 || true
  claude mcp add controlium --scope user -- node "$SERVER"
  echo "    Registered. Verify with: claude mcp list"
else
  echo "!! 'claude' CLI not found. Register manually:"
  echo "   claude mcp add controlium --scope user -- node \"$SERVER\""
fi

cat <<EOF

==> Load the extension into your existing Chrome
    1. Open chrome://extensions
    2. Enable "Developer mode" (top-right)
    3. Click "Load unpacked" and choose:
         $DIR/extension
    4. The toolbar popup's status dot turns green when connected.

Done. Ask Claude Code to control your browser (tools are prefixed controlium).
EOF
