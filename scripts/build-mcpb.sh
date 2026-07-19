#!/usr/bin/env bash
# Build a Claude Desktop extension bundle (build/controlium.mcpb) from source.
# The bundle wraps mcp-server/server.js + its deps with desktop-extension/manifest.json.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$DIR/build/controlium-mcpb"

echo "==> Installing MCP server deps"
( cd "$DIR/mcp-server" && npm install --silent )

echo "==> Staging bundle at $STAGE"
rm -rf "$STAGE" && mkdir -p "$STAGE/server"
cp "$DIR/desktop-extension/manifest.json" "$STAGE/manifest.json"
cp "$DIR/extension/icon-128.png" "$STAGE/icon.png"
cp "$DIR/mcp-server/server.js" "$STAGE/server/index.js"
cp -R "$DIR/mcp-server/node_modules" "$STAGE/server/node_modules"
cat > "$STAGE/server/package.json" <<'JSON'
{
  "name": "controlium-server",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "ws": "^8.18.0"
  }
}
JSON

echo "==> Packing"
npx --yes @anthropic-ai/mcpb pack "$STAGE" "$DIR/build/controlium.mcpb"

echo "==> Done: $DIR/build/controlium.mcpb"
echo "    Install:  open -a Claude \"$DIR/build/controlium.mcpb\""
