#!/usr/bin/env node
// Controlium — MCP server (stdio), a thin client of the shared bridge daemon.
//
// Claude (Code / Desktop) launches this over stdio. Instead of hosting its own
// WebSocket server (which collided when several Claude apps ran at once), it
// connects to a single shared daemon (bridge.js) that owns the port and the one
// connection to the Chrome extension. If no daemon is running yet, this starts
// one (detached), so any number of Claude apps share the same bridge.
//
// IMPORTANT: nothing may be written to stdout except MCP protocol frames. All
// logs go to stderr.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = Number(process.env.CONTROLIUM_PORT) || 8765;
const CALL_TIMEOUT_MS = Number(process.env.CONTROLIUM_TIMEOUT_MS) || 60000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.error("[controlium]", ...a);

// --------------------------------------------------------------------------
// Connection to the shared bridge daemon (auto-spawned if absent)
// --------------------------------------------------------------------------

let ws = null;
let daemonStarted = false;
const pending = new Map();   // id -> { resolve, reject, timer }
let nextId = 1;

// Start the shared bridge daemon. Idempotent: if one already owns the port, the
// spawned process exits immediately (EADDRINUSE).
function startDaemon() {
  if (daemonStarted) return;
  daemonStarted = true;
  try {
    spawn(process.execPath, [join(__dirname, "bridge.js")], {
      detached: true, stdio: "ignore",
      env: { ...process.env, CONTROLIUM_PORT: String(PORT) },
    }).unref();
  } catch (_) {}
}

function connect() {
  let sock;
  try { sock = new WebSocket(`ws://127.0.0.1:${PORT}`); }
  catch (_) { setTimeout(connect, 300); return; }
  ws = sock;
  sock.on("open", () => { log(`connected to bridge :${PORT}`); try { sock.send(JSON.stringify({ type: "hello", role: "mcp" })); } catch {} });
  sock.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "ping") { try { sock.send(JSON.stringify({ type: "pong" })); } catch {} return; }
    if (m.type === "result") {
      const p = pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(m.id);
      if (m.ok) p.resolve(m.content);
      else p.reject(new Error(m.error || "tool failed"));
    }
  });
  // Never let a socket error crash us; let the natural 'close' drive the retry.
  sock.on("error", () => {});   // let the natural 'close' drive the retry
  sock.on("close", () => {
    if (ws === sock) ws = null;
    startDaemon();               // make sure a daemon exists, then keep retrying
    setTimeout(connect, 300);
  });
}

startDaemon();
connect();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callExtension(tool, args) {
  // On cold start the daemon is still coming up; wait briefly for the connection
  // instead of failing the first tool call.
  const deadline = Date.now() + 10000;
  while ((!ws || ws.readyState !== WebSocket.OPEN) && Date.now() < deadline) await sleep(150);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Not connected to the Controlium bridge. Make sure Chrome is open with the Controlium extension enabled (its toolbar dot should be green).");
  }
  return await new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Tool "${tool}" timed out after ${CALL_TIMEOUT_MS}ms`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      ws.send(JSON.stringify({ type: "call", id, tool, args }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}

// --------------------------------------------------------------------------
// Tool definitions
// --------------------------------------------------------------------------

const tabTarget = {
  tabId: { type: "number", description: "Target tab id (from list_tabs). Omit to use the current working tab / active tab." },
};

const TOOLS = [
  {
    name: "list_tabs",
    description: "List all open browser tabs with their tabId, title, url, active state and windowId.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "focus_tab",
    description: "Bring a tab to the FRONT of Chrome: make it the active tab and focus its window so it is visible on top (within Chrome). This is the enhanced behavior the official extension lacks.",
    inputSchema: { type: "object", properties: { ...tabTarget } },
  },
  {
    name: "new_tab",
    description: "Open a new tab. Optionally navigate to a url. Becomes the current working tab.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, active: { type: "boolean", description: "Focus the new tab (default true)." } } },
  },
  {
    name: "close_tab",
    description: "Close a tab.",
    inputSchema: { type: "object", properties: { ...tabTarget } },
  },
  {
    name: "navigate",
    description: "Navigate a tab to a url (or 'back' / 'forward'). Waits for load. Brings the tab to front first unless focus:false.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "URL, or 'back' / 'forward'." }, ...tabTarget, focus: { type: "boolean" } }, required: ["url"] },
  },
  {
    name: "screenshot",
    description: "Capture a PNG screenshot of the tab's viewport (CSS-pixel resolution; click coordinates use the same space). Brings the tab to front first unless focus:false.",
    inputSchema: { type: "object", properties: { ...tabTarget, focus: { type: "boolean" } } },
  },
  {
    name: "read_page",
    description: "Return a compact accessibility-style outline of the visible page. Interactive elements are tagged [ref_N] which you can pass to click/type_text.",
    inputSchema: { type: "object", properties: { ...tabTarget, focus: { type: "boolean" } } },
  },
  {
    name: "get_page_text",
    description: "Return the visible text of the page (article/main if present, else body).",
    inputSchema: { type: "object", properties: { ...tabTarget, max_chars: { type: "number" }, focus: { type: "boolean" } } },
  },
  {
    name: "find",
    description: "Find interactive elements whose label matches a query. Returns their ref ids and coordinates.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, ...tabTarget }, required: ["query"] },
  },
  {
    name: "click",
    description: "Click at a coordinate [x,y] (CSS px, matching the screenshot) or at a ref from read_page/find. Brings the tab to front first unless focus:false.",
    inputSchema: {
      type: "object",
      properties: {
        coordinate: { type: "array", items: { type: "number" }, description: "[x, y] in CSS pixels." },
        x: { type: "number" }, y: { type: "number" },
        ref: { type: "string", description: "A ref_N id from read_page/find." },
        button: { type: "string", enum: ["left", "right", "middle"] },
        double: { type: "boolean" },
        clickCount: { type: "number" },
        ...tabTarget, focus: { type: "boolean" },
      },
    },
  },
  {
    name: "move_mouse",
    description: "Move the (visible synthetic) cursor to a coordinate [x,y] or a ref, dispatching a real mouse-move so hover states trigger. Useful to show where you're about to act.",
    inputSchema: {
      type: "object",
      properties: {
        coordinate: { type: "array", items: { type: "number" }, description: "[x, y] in CSS pixels." },
        x: { type: "number" }, y: { type: "number" },
        ref: { type: "string", description: "A ref_N id from read_page/find." },
        ...tabTarget, focus: { type: "boolean" },
      },
    },
  },
  {
    name: "type_text",
    description: "Type text into the page. If ref/coordinate is given, clicks it first to focus. Set submit:true to press Enter afterward.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        ref: { type: "string" }, coordinate: { type: "array", items: { type: "number" } }, x: { type: "number" }, y: { type: "number" },
        submit: { type: "boolean" },
        ...tabTarget, focus: { type: "boolean" },
      },
      required: ["text"],
    },
  },
  {
    name: "press_key",
    description: "Press a key or key combo, e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown', 'Ctrl+A', 'Meta+L'. Pass multiple via keys[].",
    inputSchema: { type: "object", properties: { key: { type: "string" }, keys: { type: "array", items: { type: "string" } }, ...tabTarget, focus: { type: "boolean" } } },
  },
  {
    name: "scroll",
    description: "Scroll the page. Use direction ('up'|'down'|'left'|'right') + amount, or explicit dx/dy. x/y set the scroll anchor point.",
    inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number" }, dx: { type: "number" }, dy: { type: "number" }, x: { type: "number" }, y: { type: "number" }, ...tabTarget, focus: { type: "boolean" } } },
  },
  {
    name: "eval_js",
    description: "Run JavaScript in the page and return the result. Write a function body that uses `return` to produce a value (async allowed).",
    inputSchema: { type: "object", properties: { code: { type: "string" }, ...tabTarget, focus: { type: "boolean" } }, required: ["code"] },
  },
  {
    name: "read_console",
    description: "Return recently buffered console messages and page errors for the tab.",
    inputSchema: { type: "object", properties: { ...tabTarget, limit: { type: "number" } } },
  },
  {
    name: "read_network",
    description: "Return recently buffered network requests/responses for the tab.",
    inputSchema: { type: "object", properties: { ...tabTarget, limit: { type: "number" } } },
  },
  {
    name: "resize_window",
    description: "Resize the Chrome window that contains the tab.",
    inputSchema: { type: "object", properties: { width: { type: "number" }, height: { type: "number" }, ...tabTarget } },
  },
];

// --------------------------------------------------------------------------
// MCP server
// --------------------------------------------------------------------------

const server = new Server(
  { name: "controlium", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const content = await callExtension(name, args || {});
    return { content: Array.isArray(content) ? content : [{ type: "text", text: String(content) }] };
  } catch (e) {
    return { content: [{ type: "text", text: (e && e.message) || String(e) }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`MCP server ready; using shared bridge on :${PORT}. Tools: ${TOOLS.map((t) => t.name).join(", ")}`);
