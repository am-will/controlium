# How the official "Claude in Chrome" extension works (reverse-engineering notes)

Research target: extension ID `fcoeoabgfenejglbffodgkkbkcdhcgfn` ("Claude"),
version 1.0.81, installed from the Chrome Web Store. Native host binary at
`/Applications/Claude.app/Contents/Helpers/chrome-native-host`.

A full copy of the unpacked extension was preserved at
`research/official-1.0.81/` for reference.

## 1. End-to-end architecture

```
Claude Code / Claude Desktop         (the MCP *client*)
        │
        │  MCP over a Unix domain socket
        ▼
chrome-native-host  (Rust / tokio binary — a relay/"bridge")
        │
        │  Chrome Native Messaging (stdio, 4-byte length-prefixed JSON)
        ▼
Extension service worker  (service-worker.ts-*.js)
        │
        │  chrome.debugger (CDP) + chrome.tabs / chrome.windows / chrome.scripting
        ▼
The target browser tab  ◀── executed while the tab stays in the BACKGROUND
```

Key point for this project: the official design intentionally drives the target
tab **without ever bringing it to the foreground**. Everything the model "sees"
comes from `Page.captureScreenshot` (which works on background tabs via the
debugger protocol) and injected DOM reads; everything it "does" comes from
`Input.dispatch*` CDP events (which also work on background tabs). There is **no**
`chrome.tabs.update({active:true})`, no `chrome.windows.update({focused:true})`,
no `Page.bringToFront`, and no `Target.activateTarget` anywhere in the tool
execution path. That is the exact behavior our enhanced extension changes.

## 2. The extension (MV3)

From `manifest.json`:

- `manifest_version: 3`, background is a **module service worker**.
- Permissions: `sidePanel, storage, activeTab, scripting, debugger, tabGroups,
  tabs, alarms, notifications, webNavigation,
  declarativeNetRequestWithHostAccess, offscreen, nativeMessaging,
  unlimitedStorage, downloads, identity`.
- `host_permissions: ["<all_urls>"]`.
- Content scripts: an accessibility-tree builder injected at `document_start`
  into **all frames** of every URL, plus an "agent visual indicator" overlay,
  plus a claude.ai-only content script for the web app integration.
- The `debugger` permission is what grants Chrome DevTools Protocol access.

The service worker (`assets/service-worker.ts-Cq4zmsU-.js`, ~24 KB) is the whole
control plane. The heavy lifting (the tool executor `v(...)`, the tab-group
manager, CDP session management) lives in `assets/mcpPermissions-*.js`.

### 2.1 Native-messaging connection

`connectNative` is attempted against two host names, in order:

1. `com.anthropic.claude_browser_extension` ("Desktop")
2. `com.anthropic.claude_code_browser_extension` ("Claude Code")

Handshake: the SW `postMessage({type:"ping"})` and waits up to 10 s for a
`{type:"pong"}`. On success it keeps the port, registers `onMessage`/`onDisconnect`,
and sends `{type:"get_status"}`.

Inbound message types the SW handles from the host:
`tool_request`, `status_response`, `mcp_connected`, `mcp_disconnected`.

A `tool_request` carries `{method:"execute_tool", params:{tool, args, client_id,
session_scope}}`. The SW extracts `tabId`/`tabGroupId` from the args and calls the
executor `v({toolName, args, tabId, tabGroupId, clientId, source})`, then posts
back `{type:"tool_response", result|error:{content}}`.

The native-messaging manifest
(`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_browser_extension.json`)
points `path` at the `chrome-native-host` binary and whitelists the extension IDs
in `allowed_origins`.

### 2.2 The native host (`chrome-native-host`)

A Rust binary (tokio 1.47, anyhow, serde_json — `src/main.rs`). Recovered strings
show it is a **bridge**, not the browser controller:

- "Socket server listening for connections" → it opens a **Unix domain socket**
  (tokio `net/unix/listener.rs`) named like `claude-mcp-browser-bridge-*`.
- "Accepted new MCP connection (client …)", "Forwarding tool request from MCP
  client", "Failed to parse tool request from MCP client" → MCP clients connect
  to that socket; the host forwards their tool calls into Chrome.
- "Failed to notify Chrome of MCP connection/disconnection", `mcp_connected` /
  `mcp_disconnected` / `tool_request` → it emits exactly the native-messaging
  message types the SW switches on.

So Chrome launches this binary as the native-messaging host (stdio ↔ extension),
and the same process independently accepts MCP client connections on a Unix
socket and relays between the two. Claude Code's `tengu_copper_bridge` /
`tengu_ccr_bridge` feature flags are the client side of that connection.

### 2.3 The tool executor and CDP usage

`chrome.debugger` calls found in `mcpPermissions-*.js`: `attach`, `detach`,
`getTargets`, `onDetach`, `onEvent`, `sendCommand`.

CDP commands actually sent:
`Page.enable`, `Page.captureScreenshot`, `Page.handleJavaScriptDialog`,
`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`,
`Runtime.enable`, `Runtime.evaluate`, `Network.enable/disable`, plus event
subscriptions (`Page.frameNavigated`, `Page.javascriptDialogOpening`,
`Runtime.consoleAPICalled`, `Runtime.exceptionThrown`,
`Network.requestWillBeSent`, `Network.responseReceived`,
`Network.loadingFailed`).

The 16 tool names exposed (from the SW's allow-list `de`):
`javascript_tool, read_page, find, form_input, computer, browser_batch,
navigate, resize_window, gif_creator, upload_image, get_page_text,
tabs_context_mcp, tabs_create_mcp, tabs_close_mcp, read_console_messages,
read_network_requests`.

`read_page`/`find` are backed by the injected accessibility-tree content script,
which tags interactive elements with `ref_N` ids; `computer`/`form_input` act on
either coordinates or those refs.

### 2.4 Tab-group isolation model

Instead of activating tabs, the extension puts each agent session's tab(s) into a
Chrome **tab group** (`chrome.tabGroups`) so work is visually corralled but not
foregrounded. The only places the code *does* activate a tab / focus a window are
user-initiated, outside tool execution:

- clicking a notification (`chrome.tabs.update({active:true})` +
  `chrome.windows.update({focused:true})`),
- the `clau.de/chrome/tab/<id>` deep link,
- the "switch to main tab" message.

This confirms the capability exists in the codebase but is deliberately kept out
of the automation loop.

## 3. What our enhanced extension changes

1. **Bring-tab-to-front is the default.** Every tool that targets a tab first
   calls `chrome.tabs.update(tabId,{active:true})` and
   `chrome.windows.update(windowId,{focused:true})` (and, for good measure, CDP
   `Page.bringToFront`). The tab Claude is working in becomes the visible,
   foreground tab inside Chrome — exactly the requested behavior. (It focuses the
   Chrome *window*; it does not fight other OS apps for the very top of the
   screen, which matches the requirement.)
2. **A dedicated `focus_tab` tool** to raise any tab on demand.
3. **Simpler, fully-owned transport.** We replace the Rust/Unix-socket/native-
   messaging bridge with a Node MCP server that also hosts a localhost WebSocket
   the extension connects to. Claude Code owns the MCP server lifecycle
   (`claude mcp add`); the extension auto-connects and auto-reconnects.
4. **Same CDP toolset** (screenshot, click, type, key, scroll, navigate,
   read_page, get_page_text, eval_js, console, network, tabs, resize) so Claude
   drives it the same way it drives the official one.
