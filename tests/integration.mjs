// Integration test: MCP stdio protocol <-> server.js <-> WS bridge <-> a MOCK extension.
// Verifies the bridge without needing Chrome. Run: node tests/integration.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "mcp-server", "server.js");
const PORT = 8799;

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
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); srv.kill(); process.exit(1); } console.log("PASS:", m); };

async function main() {
  await sleep(600);
  const ext = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise((res, rej) => { ext.on("open", res); ext.on("error", rej); });
  ext.send(JSON.stringify({ type: "hello", role: "extension", version: "mock-1" }));
  ext.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "ping") return ext.send(JSON.stringify({ type: "pong" }));
    if (m.type === "call") {
      const reply = (content) => ext.send(JSON.stringify({ type: "result", id: m.id, ok: true, content }));
      if (m.tool === "list_tabs") reply([{ type: "text", text: '[{"tabId":1}]' }]);
      else if (m.tool === "focus_tab") reply([{ type: "text", text: "Brought tab 1 to front" }]);
      else if (m.tool === "screenshot") reply([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
      else ext.send(JSON.stringify({ type: "result", id: m.id, ok: false, error: "nope" }));
    }
  });
  await sleep(200);

  const init = await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert(init.result?.serverInfo?.name === "controlium", "initialize handshake");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await rpc(2, "tools/list", {});
  const names = (list.result?.tools || []).map((t) => t.name);
  assert(names.includes("focus_tab") && names.length >= 15, `tools/list (${names.length} tools incl focus_tab)`);

  const c1 = await rpc(3, "tools/call", { name: "list_tabs", arguments: {} });
  assert(c1.result?.content?.[0]?.text?.includes("tabId"), "list_tabs round-trip");

  const c2 = await rpc(4, "tools/call", { name: "focus_tab", arguments: { tabId: 1 } });
  assert(c2.result?.content?.[0]?.text?.includes("front"), "focus_tab round-trip");

  const c3 = await rpc(5, "tools/call", { name: "screenshot", arguments: {} });
  assert((c3.result?.content || []).some((c) => c.type === "image"), "image content passthrough");

  ext.close(); await sleep(300);
  const c4 = await rpc(6, "tools/call", { name: "list_tabs", arguments: {} });
  assert(c4.result?.isError === true, "graceful error when extension disconnected");

  console.log("\nALL INTEGRATION TESTS PASSED");
  srv.kill(); process.exit(0);
}
main().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
setTimeout(() => { console.error("TIMEOUT"); srv.kill(); process.exit(1); }, 15000);
