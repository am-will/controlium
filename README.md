# Controlium

A Chrome extension + local MCP bridge that lets Claude drive **your** browser over the
Chrome DevTools Protocol — the same way the official "Claude in Chrome" extension does —
with two things the official one doesn't do:

1. **Brings the working tab to the front.** Every action first makes the target tab the
   active, visible tab and focuses its Chrome window. Claude's tab is never hidden in the
   background. (The official extension deliberately works on background tabs — see
   [RESEARCH.md](RESEARCH.md).)
2. **Shows a synthetic cursor.** A visible pointer animates to each click with a ripple,
   so you can watch Claude work. It also appears in screenshots.

It runs in your **normal Chrome profile** (your logins, your tabs) — not a separate
instance.

```
Claude Code (MCP client)
   └─ stdio ──> mcp-server/server.js  (MCP server + WebSocket bridge on 127.0.0.1:8765)
                   └─ WebSocket ──> extension service worker
                                       └─ chrome.debugger (CDP) + chrome.tabs/windows
                                            └─ your tab  ──> brought to the FRONT, with a visible cursor
```

## Layout

| Path | What it is |
|------|-----------|
| `extension/` | The Chrome extension (MV3). Load this unpacked. |
| `mcp-server/` | Node MCP server + WebSocket bridge Claude Code launches. |
| `tests/` | `integration.mjs` (no Chrome) and `live-e2e.mjs` (real browser). |
| `RESEARCH.md` | How the official extension works (reverse-engineered). |
| `research/key-files/` | The official extension's key source files, for reference. |

## Setup

### 1. Load the extension into your existing Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` folder in this project.
4. It appears as **"Controlium"**. Pin it if you like.

> This loads into your current profile, so Claude controls your real Chrome with all your
> sessions. (Chrome's `--load-extension` command-line flag is blocked in branded Chrome
> for security, which is why loading through this UI is the supported path. It only needs
> to be done once; the extension persists across restarts.)

The extension's toolbar popup shows a status dot (green = connected to the bridge) and
toggles for **Bring working tab to front** and **Show synthetic cursor**.

### 2. Register the MCP server with Claude Code

```bash
claude mcp add controlium --scope user -- node "$(pwd)/mcp-server/server.js"
```

(Or run `./install.sh`, which does this for you.)

That's it. When Claude Code starts, it launches the bridge; the extension auto-connects
(status dot goes green within a few seconds). Ask Claude to control your browser and it
will use the `controlium` tools.

To confirm it's registered: `claude mcp list`.

### 3. (Optional) Also add it to Claude Desktop — as a `.mcpb` extension

The bridge WebSocket port can only be owned by one server process at a time, so if you
want Controlium in **both** Claude Code and Claude Desktop, give each its own port. The
extension connects to **all configured ports at once**, so either app can drive it (one
at a time). The bundle below is preconfigured for port **8766** (Claude Code stays 8765).

Recent Claude Desktop builds manage `claude_desktop_config.json` themselves and overwrite
hand-added `mcpServers`, so the reliable way is a Desktop Extension bundle:

```bash
./scripts/build-mcpb.sh          # produces build/controlium.mcpb
open -a Claude build/controlium.mcpb   # opens Claude Desktop's install dialog
```

Or install manually: Claude Desktop → **Settings → Extensions → Install Extension…** →
pick `build/controlium.mcpb`. Then make sure the extension's **Bridge ports** field
(popup/options) lists both ports — the default `8765, 8766` already covers Claude Code
(8765) and Claude Desktop (8766).

> Use one host at a time to drive the browser. Both bridges can be connected, but issuing
> conflicting commands from both simultaneously will fight over the same tabs.

## Tools Claude can call

| Tool | Description |
|------|-------------|
| `list_tabs` | List open tabs (id, title, url, active, window). |
| `focus_tab` | **Bring a tab to the front** (active + window focused). |
| `new_tab` / `close_tab` | Open / close a tab. |
| `navigate` | Go to a URL (or `back`/`forward`); waits for load. |
| `screenshot` | PNG of the viewport (CSS-pixel space; matches click coords). |
| `read_page` | Accessibility-style outline with `[ref_N]` handles. |
| `get_page_text` | Visible page text. |
| `find` | Find elements by label; returns refs + coordinates. |
| `click` | Click a coordinate or a ref (with the visible cursor). |
| `move_mouse` / `hover` | Move the synthetic cursor / trigger hover. |
| `type_text` | Type into the page (optionally click-to-focus, submit). |
| `press_key` | Keys and combos (`Enter`, `Tab`, `Ctrl+A`, `Meta+L`, …). |
| `scroll` | Scroll by direction/amount or dx/dy. |
| `eval_js` | Run JS in the page and return the result. |
| `read_console` / `read_network` | Buffered console / network activity. |
| `resize_window` | Resize the tab's Chrome window. |

Every tab-targeting tool honors the **Bring working tab to front** setting (pass
`focus: false` on a call to skip it for that call).

## Configuration

- **Ports**: the extension connects to every port in its **Bridge ports** list
  (default `8765, 8766`) on `127.0.0.1`. Each MCP server instance binds one port via
  `CONTROLIUM_PORT` (default 8765). A port the extension lists but nothing is serving is
  just skipped/retried. Bound to localhost only.
- **Bring to front** and **Synthetic cursor**: toggle in the popup/options (both default on).

## Testing

```bash
npm test                 # bridge/protocol test, no browser needed
# Full browser test needs a Chromium that honors --load-extension:
npx @puppeteer/browsers install chrome@stable
CHROME_BIN="/path/to/Chrome for Testing" npm run test:live
```

## Notes & limits

- Uses `chrome.debugger`, so Chrome shows a "…started debugging this browser" banner while
  active — same as the official extension. That's the price of CDP access.
- Only one CDP client can attach to a given tab. If the official Claude extension is also
  attached to the same tab, disable it (or use different tabs).
- One bridge instance owns the WebSocket port at a time; run one Claude Code session
  driving the browser at once (others still work over MCP but share the one bridge).
- After the bridge (re)starts, a sleeping service worker can take up to ~30s to reconnect;
  any browser activity wakes it sooner.
