// Integration test for the shared-daemon architecture:
//   MCP client (stdio) <-> server.js <-> bridge.js daemon <-> MOCK extension
// No Chrome needed. Run: node tests/integration.mjs
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "mcp-server", "server.js");
const PORT = 8799;

function freePort() { try { execSync(`lsof -ti tcp:${PORT} | xargs kill -9`, { stdio: "ignore" }); } catch {} }
freePort();

const srv = spawn("node", [SERVER], { env: { ...process.env, CONTROLIUM_PORT: String(PORT) }, stdio: ["pipe", "pipe", "pipe"] });
let buf = ""; const waiters = new Map();
srv.stdout.on("data", (d) => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { console.error("NON-JSON STDOUT:", line); continue; }
    if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  }
});
srv.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
const send = (o) => srv.stdin.write(JSON.stringify(o) + "\n");
const rpc = (id, method, params) => new Promise((r) => { waiters.set(id, r); send({ jsonrpc: "2.0", id, method, params }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanup() { try { srv.kill(); } catch {} freePort(); }
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); cleanup(); process.exit(1); } console.log("PASS:", m); };

// Mock extension: retry-connect (daemon is spawned by server.js ~1s in), speak the extension protocol.
let ext = null;
function connectExt() {
  const s = new WebSocket(`ws://127.0.0.1:${PORT}`);
  s.on("open", () => { ext = s; s.send(JSON.stringify({ type: "hello", role: "extension", version: "mock-1" })); });
  s.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "ping") return s.send(JSON.stringify({ type: "pong" }));
    if (m.type === "call") {
      const reply = (content) => s.send(JSON.stringify({ type: "result", id: m.id, ok: true, content }));
      if (m.tool === "list_tabs") reply([{ type: "text", text: '[{"tabId":1}]' }]);
      else if (m.tool === "focus_tab") reply([{ type: "text", text: "Brought tab 1 to front" }]);
      else if (m.tool === "screenshot") reply([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
      else s.send(JSON.stringify({ type: "result", id: m.id, ok: false, error: "nope" }));
    }
  });
  s.on("error", () => { if (!ext) setTimeout(connectExt, 400); });
  s.on("close", () => { if (ext === s) ext = null; });
}

async function main() {
  connectExt();
  // wait for daemon + extension handshake
  for (let i = 0; i < 30 && !ext; i++) await sleep(200);
  assert(ext, "mock extension connected to the shared daemon (auto-spawned by server.js)");
  await sleep(200);

  const init = await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert(init.result?.serverInfo?.name === "controlium", "MCP initialize handshake");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await rpc(2, "tools/list", {});
  const names = (list.result?.tools || []).map((t) => t.name);
  assert(names.includes("focus_tab") && names.length >= 15, `tools/list (${names.length} tools incl focus_tab)`);

  const c1 = await rpc(3, "tools/call", { name: "list_tabs", arguments: {} });
  assert(c1.result?.content?.[0]?.text?.includes("tabId"), "list_tabs round-trip via daemon");

  const c2 = await rpc(4, "tools/call", { name: "focus_tab", arguments: { tabId: 1 } });
  assert(c2.result?.content?.[0]?.text?.includes("front"), "focus_tab round-trip via daemon");

  const c3 = await rpc(5, "tools/call", { name: "screenshot", arguments: {} });
  assert((c3.result?.content || []).some((c) => c.type === "image"), "image content passthrough");

  // Second MCP client sharing the SAME daemon (simulates a second Claude app)
  const srv2 = spawn("node", [SERVER], { env: { ...process.env, CONTROLIUM_PORT: String(PORT) }, stdio: ["pipe", "pipe", "ignore"] });
  let buf2 = ""; const w2 = new Map();
  srv2.stdout.on("data", (d) => { buf2 += d.toString(); let i; while ((i = buf2.indexOf("\n")) >= 0) { const l = buf2.slice(0, i).trim(); buf2 = buf2.slice(i + 1); if (!l) continue; let m; try { m = JSON.parse(l); } catch { continue; } if (m.id != null && w2.has(m.id)) { w2.get(m.id)(m); w2.delete(m.id); } } });
  const rpc2 = (id, method, params) => new Promise((r) => { w2.set(id, r); srv2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  await sleep(500);
  await rpc2(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t2", version: "1" } });
  srv2.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const c4 = await rpc2(2, "tools/call", { name: "list_tabs", arguments: {} });
  assert(c4.result?.content?.[0]?.text?.includes("tabId"), "SECOND MCP client shares the same daemon (no port collision)");
  try { srv2.kill(); } catch {}

  console.log("\nALL INTEGRATION TESTS PASSED");
  cleanup(); process.exit(0);
}
main().catch((e) => { console.error(e); cleanup(); process.exit(1); });
setTimeout(() => { console.error("TIMEOUT"); cleanup(); process.exit(1); }, 20000);
