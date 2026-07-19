# Controlium

![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-brightgreen)
![MCP](https://img.shields.io/badge/MCP-stdio%20server-8A2BE2)

**Let Claude drive your real Chrome.** Controlium is a Chrome extension + local MCP
bridge that gives Claude — in **Claude Code** *and* **Claude Desktop** — control of your
browser over the Chrome DevTools Protocol: navigate, click, type, scroll, screenshot,
read pages, run JS. It does what the official "Claude in Chrome" extension does, with two
differences:

- 🔝 **It brings the working tab to the front.** Every action first makes the target tab
  the active, visible tab and focuses its window. Claude's tab is never hidden in the
  background. (The official extension deliberately drives background tabs — see
  [RESEARCH.md](RESEARCH.md).)
- ✨ **It shows a synthetic cursor.** A glowing pointer animates to each click with a
  ripple, so you can watch Claude work — and it shows up in screenshots too.

It runs in **your normal Chrome profile** (your logins, your tabs), not a throwaway
instance.

```
Claude Code / Claude Desktop  (MCP client)
        │  stdio
        ▼
mcp-server/server.js  ── MCP server + WebSocket bridge on 127.0.0.1  (8765 / 8766)
        │  WebSocket
        ▼
extension service worker
        │  chrome.debugger (CDP) + chrome.tabs / chrome.windows
        ▼
your Chrome tab  ──▶  brought to the FRONT, with a visible cursor
```

## Quick start

```bash
git clone https://github.com/am-will/controlium.git
cd controlium
./install.sh
```

The installer:

1. installs the MCP server's dependencies,
2. registers the MCP server with **Claude Code** (`claude mcp add controlium`),
3. builds the **Claude Desktop** bundle (`build/controlium.mcpb`),
4. copies the extension's path to your clipboard and prints the one manual step.

Then **load the extension** (the one thing Chrome won't let a script do):

1. open `chrome://extensions`
2. turn on **Developer mode** (top-right)
3. click **Load unpacked** and choose the **`extension/`** folder (already on your clipboard)

It appears as **Controlium** — the toolbar dot turns green once it's connected. Now ask
Claude to control your browser.

Installer options: `./install.sh --code-only`, `--desktop-only`, `--no-desktop`,
`--open-desktop` (macOS: also pops the Claude Desktop install dialog).

## Manual setup

<details>
<summary><b>Chrome extension</b></summary>

Chrome blocks loading unpacked extensions from the command line in branded builds, so load
it once through the UI: `chrome://extensions` → **Developer mode** → **Load unpacked** →
select the `extension/` folder. It persists across restarts. The popup has a status dot
and toggles for **bring-to-front** and the **synthetic cursor**.
</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add controlium --scope user -- node "$(pwd)/mcp-server/server.js"
```

Claude Code launches the server (bridge on port **8765**); the extension auto-connects.
Verify with `claude mcp list`.
</details>

<details>
<summary><b>Claude Desktop</b></summary>

Recent Claude Desktop builds manage `claude_desktop_config.json` themselves and overwrite
hand-added `mcpServers`, so install it as a **Desktop Extension** (`.mcpb`) instead:

```bash
./scripts/build-mcpb.sh                  # produces build/controlium.mcpb (bridge on 8766)
open -a Claude build/controlium.mcpb     # opens the install dialog (macOS)
```

Or: Claude Desktop → **Settings → Extensions → Install Extension…** → pick
`build/controlium.mcpb`.

Claude Code uses **8765**, Claude Desktop uses **8766**, and the extension connects to
both at once — so either app can drive the browser (one at a time). The **Bridge ports**
field in the popup defaults to `8765, 8766`.
</details>

## Tools Claude can call

| Tool | Description |
|------|-------------|
| `list_tabs` | List open tabs (id, title, url, active, window). |
| `focus_tab` | **Bring a tab to the front** (active + window focused). |
| `new_tab` / `close_tab` | Open / close a tab. |
| `navigate` | Go to a URL (or `back` / `forward`); waits for load. |
| `screenshot` | PNG of the viewport (CSS-pixel space; matches click coords). |
| `read_page` | Accessibility-style outline with `[ref_N]` handles. |
| `get_page_text` | Visible page text. |
| `find` | Find elements by label; returns refs + coordinates. |
| `click` | Click a coordinate or a ref (with the visible cursor). |
| `move_mouse` / `hover` | Move the synthetic cursor / trigger hover. |
| `type_text` | Type into the page (optionally click-to-focus, then submit). |
| `press_key` | Keys and combos (`Enter`, `Tab`, `Ctrl+A`, `Meta+L`, …). |
| `scroll` | Scroll by direction/amount or dx/dy. |
| `eval_js` | Run JS in the page and return the result. |
| `read_console` / `read_network` | Buffered console / network activity. |
| `resize_window` | Resize the tab's Chrome window. |

Every tab-targeting tool honors the **bring-to-front** setting; pass `focus: false` on a
call to skip it just for that call.

## Configuration

- **Bridge ports** — the extension connects to every port in its list (default
  `8765, 8766`) on `127.0.0.1` only. Each MCP server instance binds one port via the
  `CONTROLIUM_PORT` env var (default `8765`). Listed ports with nothing serving are just
  retried.
- **Bring to front** and **Synthetic cursor** — toggles in the popup/options, both on by
  default.

## Development

| Path | What it is |
|------|-----------|
| `extension/` | The MV3 Chrome extension (service worker, cursor overlay, popup, options). |
| `mcp-server/` | Node MCP server + localhost WebSocket bridge. |
| `desktop-extension/` + `scripts/build-mcpb.sh` | Source + builder for the Claude Desktop `.mcpb`. |
| `tests/` | `integration.mjs` (no browser) and `live-e2e.mjs` (real Chromium). |
| `RESEARCH.md` | How the official extension works (reverse-engineered). |

```bash
npm install             # dev deps (ws) for the tests
npm test                # protocol/bridge test — no browser needed

# Full browser test needs a Chromium that honors --load-extension:
npx @puppeteer/browsers install chrome@stable
CHROME_BIN="/path/to/Chrome for Testing" npm run test:live
```

## Notes & limits

- Uses `chrome.debugger`, so Chrome shows a *"…started debugging this browser"* banner
  while active — the price of CDP access, same as the official extension.
- Only one CDP client can attach to a given tab; if the official Claude extension is
  attached to the same tab, use a different tab (or disable it there).
- Drive from **one host at a time**. Both bridges can be connected, but issuing commands
  from Claude Code and Claude Desktop simultaneously will fight over the same tabs.
- After a bridge (re)starts, a sleeping service worker can take up to ~30s to reconnect;
  any browser activity wakes it sooner.

## License

[MIT](LICENSE)
