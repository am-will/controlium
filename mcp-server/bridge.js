#!/usr/bin/env node
// Controlium — shared bridge daemon.
//
// ONE of these runs per machine. It owns the WebSocket port and the single
// connection to the Chrome extension, and routes tool calls from ANY number of
// MCP server clients (Claude Code, Claude Desktop, Claude WORK, …) to the
// extension. This is what makes multiple Claude apps coexist: they no longer each
// try to bind the port — they all connect here as clients.
//
// server.js auto-spawns this if it isn't already running. If the port is taken
// (another daemon already owns it), this process exits immediately.

import { WebSocketServer } from "ws";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.CONTROLIUM_PORT) || 8765;
const LOGFILE = process.env.CONTROLIUM_BRIDGE_LOG || "";
const log = (...a) => {
  const line = "[controlium-bridge] " + a.join(" ");
  console.error(line);
  if (LOGFILE) { try { appendFileSync(LOGFILE, line + "\n"); } catch {} }
};

let extSocket = null;              // the Chrome extension (most recent wins)
const pending = new Map();         // globalId -> { client, origId }
let gid = 1;

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

wss.on("error", (e) => {
  if (e && e.code === "EADDRINUSE") { log(`port ${PORT} already served by another daemon — exiting`); process.exit(0); }
  log("server error:", e && e.message);
  process.exit(1);
});
wss.on("listening", () => log(`shared bridge listening on 127.0.0.1:${PORT}`));

wss.on("connection", (sock) => {
  sock.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.type === "hello") {
      if (m.role === "extension") { extSocket = sock; sock._role = "ext"; log(`extension connected (v${m.version || "?"})`); }
      else { sock._role = "mcp"; log("mcp client connected"); }
      return;
    }
    if (m.type === "pong") return;

    // MCP client → extension
    if (sock._role === "mcp" && m.type === "call") {
      if (!extSocket || extSocket.readyState !== extSocket.OPEN) {
        try { sock.send(JSON.stringify({ type: "result", id: m.id, ok: false, error: "The Chrome extension is not connected. Load/enable the Controlium extension in Chrome (its toolbar dot should be green)." })); } catch {}
        return;
      }
      const g = gid++;
      pending.set(g, { client: sock, origId: m.id });
      try { extSocket.send(JSON.stringify({ type: "call", id: g, tool: m.tool, args: m.args })); }
      catch (e) {
        pending.delete(g);
        try { sock.send(JSON.stringify({ type: "result", id: m.id, ok: false, error: "bridge→extension send failed" })); } catch {}
      }
      return;
    }

    // extension → originating MCP client
    if (sock._role === "ext" && m.type === "result") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      try { p.client.send(JSON.stringify({ type: "result", id: p.origId, ok: m.ok, content: m.content, error: m.error })); } catch {}
      return;
    }
  });

  sock.on("close", () => {
    if (sock === extSocket) { extSocket = null; log("extension disconnected"); }
    // drop any pending calls that were waiting on this MCP client
    for (const [g, p] of pending) if (p.client === sock) pending.delete(g);
  });
  sock.on("error", () => {});
});

// keepalive so the MV3 service worker's WebSocket stays alive
setInterval(() => {
  if (extSocket && extSocket.readyState === extSocket.OPEN) {
    try { extSocket.send(JSON.stringify({ type: "ping" })); } catch {}
  }
}, 15000);
