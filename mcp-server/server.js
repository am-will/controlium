#!/usr/bin/env node
// Controlium — MCP server (stdio) + WebSocket bridge.
//
// Claude Code launches this over stdio (via `claude mcp add`). It exposes browser
// tools over MCP, and hosts a localhost WebSocket server that the Chrome extension
// connects to. Tool calls are forwarded to the extension, which executes them via
// the DevTools Protocol and returns the result.
//
// IMPORTANT: nothing may be written to stdout except MCP protocol frames. All logs
// go to stderr.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.CONTROLIUM_PORT) || 8765;
const CALL_TIMEOUT_MS = Number(process.env.CONTROLIUM_TIMEOUT_MS) || 60000;

const log = (...a) => console.error("[controlium]", ...a);

// --------------------------------------------------------------------------
// WebSocket bridge to the extension
// --------------------------------------------------------------------------

let extSocket = null;            // the active extension connection
const pending = new Map();       // callId -> { resolve, reject, timer }
let nextId = 1;

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

wss.on("listening", () => log(`WebSocket bridge listening on 127.0.0.1:${PORT}`));
wss.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") {
    log(`Port ${PORT} already in use — another bridge instance may be running. This MCP server will still respond, but the extension can only bind to one bridge. Set CONTROLIUM_PORT to change it.`);
  } else {
    log("WebSocket server error:", e && e.message);
  }
});

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "hello" && msg.role === "extension") {
      extSocket = socket;
      log(`Extension connected (v${msg.version || "?"})`);
      return;
    }
    if (msg.type === "pong") return;
    if (msg.type === "result") {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.content);
      else p.reject(new Error(msg.error || "tool failed in extension"));
    }
  });
  socket.on("close", () => {
    if (extSocket === socket) { extSocket = null; log("Extension disconnected"); }
  });
  socket.on("error", () => {});
});

// keepalive so the MV3 service worker's WS stays active
setInterval(() => {
  if (extSocket && extSocket.readyState === extSocket.OPEN) {
    try { extSocket.send(JSON.stringify({ type: "ping" })); } catch {}
  }
}, 15000);

function callExtension(tool, args) {
  return new Promise((resolve, reject) => {
    if (!extSocket || extSocket.readyState !== extSocket.OPEN) {
      return reject(new Error(
        "The Chrome extension is not connected to the bridge. Open Chrome, make sure the 'Controlium' extension is loaded and enabled, and that its port matches " + PORT + "."
      ));
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Tool "${tool}" timed out after ${CALL_TIMEOUT_MS}ms`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      extSocket.send(JSON.stringify({ type: "call", id, tool, args }));
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
log(`MCP server ready. Bridge port ${PORT}. Tools: ${TOOLS.map((t) => t.name).join(", ")}`);
