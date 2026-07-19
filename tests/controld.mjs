// Persistent Controlium controller. Keeps ONE bridge connection alive and executes
// tool commands dropped as /tmp/ctrl/req-<id>.json, writing /tmp/ctrl/res-<id>.json
// (images saved as /tmp/ctrl/shot-<id>.png). Drive it via ctl.mjs.
import { spawn } from "node:child_process";
import { writeFileSync, readdirSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = "/tmp/ctrl";
try { mkdirSync(DIR, { recursive: true }); } catch {}
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "mcp-server", "server.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn("node", [SERVER], { env: { ...process.env, CONTROLIUM_PORT: "8765" }, stdio: ["pipe", "pipe", "pipe"] });
let buf = ""; const waiters = new Map();
srv.stdout.on("data", (d) => { buf += d.toString(); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
srv.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
let idc = 1;
const rpc = (method, params) => { const id = ++idc; return new Promise((r) => { waiters.set(id, r); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }); };
const call = (name, args) => rpc("tools/call", { name, arguments: args || {} });
const writeStatus = (o) => writeFileSync(join(DIR, "status.json"), JSON.stringify(o));

async function main() {
  await sleep(400);
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "controld", version: "1" } });
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  writeStatus({ connected: false, ts: Date.now() });
  for (let i = 0; i < 120; i++) { await sleep(1000); if (!(await call("list_tabs", {})).result?.isError) { writeStatus({ connected: true, ts: Date.now() }); break; } }

  while (true) {
    let files = [];
    try { files = readdirSync(DIR).filter((f) => f.startsWith("req-") && f.endsWith(".json")).sort(); } catch {}
    for (const f of files) {
      const p = join(DIR, f);
      let cmd; try { cmd = JSON.parse(readFileSync(p, "utf8")); } catch { try { unlinkSync(p); } catch {} continue; }
      try { unlinkSync(p); } catch {}
      const id = cmd.id;
      try {
        const res = await call(cmd.name, cmd.args || {});
        const r = res.result || {};
        const out = { id, ok: !r.isError };
        out.text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
        const img = (r.content || []).find((c) => c.type === "image");
        if (img) { const ip = join(DIR, `shot-${id}.png`); writeFileSync(ip, Buffer.from(img.data, "base64")); out.image = ip; }
        writeFileSync(join(DIR, `res-${id}.json`), JSON.stringify(out));
      } catch (e) {
        writeFileSync(join(DIR, `res-${id}.json`), JSON.stringify({ id, ok: false, error: String((e && e.message) || e) }));
      }
    }
    await sleep(150);
  }
}
main().catch((e) => { writeStatus({ connected: false, error: String(e), ts: Date.now() }); process.exit(1); });
