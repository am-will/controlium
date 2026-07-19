#!/usr/bin/env bash
# Controlium installer.
#
# Sets up everything that can be automated:
#   1. installs the MCP server's dependencies
#   2. registers the MCP server with Claude Code   (needs the `claude` CLI)
#   3. builds the Claude Desktop extension bundle   (build/controlium.mcpb)
#   4. guides the one manual step: loading the unpacked Chrome extension
#
# Usage:
#   ./install.sh                 # do everything
#   ./install.sh --code-only     # only Claude Code + extension
#   ./install.sh --desktop-only  # only build the Claude Desktop .mcpb
#   ./install.sh --no-desktop    # skip the .mcpb build
#   ./install.sh --open-desktop  # also open the .mcpb install dialog (macOS)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$DIR/extension"
SERVER="$DIR/mcp-server/server.js"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
step() { printf "\n\033[1m%s\033[0m\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$*"; }
info() { printf "    %s\n" "$*"; }

DO_CODE=1; DO_DESKTOP=1; DO_EXT=1; OPEN_DESKTOP=0
for a in "$@"; do
  case "$a" in
    --code-only)    DO_DESKTOP=0 ;;
    --desktop-only) DO_CODE=0; DO_EXT=0 ;;
    --no-desktop)   DO_DESKTOP=0 ;;
    --open-desktop) OPEN_DESKTOP=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) warn "unknown option: $a" ;;
  esac
done

bold "Controlium installer"

# Prerequisites
command -v node >/dev/null 2>&1 || { echo "node is required — install from https://nodejs.org"; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "npm is required"; exit 1; }
ok "node $(node -v), npm $(npm -v)"

# 1. MCP server dependencies
step "1. Installing MCP server dependencies"
( cd "$DIR/mcp-server" && npm install --silent )
ok "installed"

# 2. Claude Code
if [ "$DO_CODE" = 1 ]; then
  step "2. Registering the MCP server with Claude Code"
  if command -v claude >/dev/null 2>&1; then
    claude mcp remove controlium --scope user >/dev/null 2>&1 || true
    claude mcp add controlium --scope user -- node "$SERVER"
    ok "registered as 'controlium' (verify: claude mcp list)"
  else
    warn "'claude' CLI not found — register manually:"
    info "claude mcp add controlium --scope user -- node \"$SERVER\""
  fi
fi

# 3. Claude Desktop bundle
if [ "$DO_DESKTOP" = 1 ]; then
  step "3. Building the Claude Desktop extension (.mcpb)"
  if bash "$DIR/scripts/build-mcpb.sh" >/dev/null 2>&1; then
    ok "built: build/controlium.mcpb"
    if [ "$OPEN_DESKTOP" = 1 ] && [ "$(uname)" = "Darwin" ] && open -a "Claude" "$DIR/build/controlium.mcpb" 2>/dev/null; then
      ok "opened the install dialog in Claude Desktop — click Install"
    else
      info "install it: Claude Desktop → Settings → Extensions → Install Extension…"
      info "then pick:  $DIR/build/controlium.mcpb"
      [ "$(uname)" = "Darwin" ] && info "or run:      open -a Claude \"$DIR/build/controlium.mcpb\""
    fi
  else
    warn "could not build the .mcpb (needs internet for 'npx @anthropic-ai/mcpb'). Skipped."
  fi
fi

# 4. Chrome extension (manual — Chrome blocks CLI loading of unpacked extensions)
if [ "$DO_EXT" = 1 ]; then
  step "4. Load the Chrome extension (one-time, manual)"
  info "1) open  chrome://extensions"
  info "2) turn on 'Developer mode' (top-right)"
  info "3) click 'Load unpacked' and choose this folder:"
  bold  "       $EXT_DIR"
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$EXT_DIR" | pbcopy && ok "extension path copied to your clipboard"
  fi
fi

step "Done."
info "The extension's toolbar dot turns green once it's connected to a running bridge."
info "Then ask Claude (Code or Desktop) to control your browser — tools are prefixed 'controlium'."
