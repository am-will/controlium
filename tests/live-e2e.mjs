// LIVE end-to-end test: launch a throwaway Chromium with the extension loaded,
// drive it through the MCP server, and verify the bring-to-front enhancement.
//
// IMPORTANT: branded Google Chrome ignores --load-extension, so this test needs a
// Chromium build that honors it (Chrome for Testing / Chromium / Brave / Edge).
// Set CHROME_BIN to that binary. To get Chrome for Testing:
//   npx @puppeteer/browsers install chrome@stable
//
// Run: CHROME_BIN="/path/to/Chrome for Testing" node tests/live-e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 8765;
const EXT = join(__dirname, "..", "extension");
const SERVER = join(__dirname, "..", "mcp-server", "server.js");
const CHROME = process.env.CHROME_BIN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!CHROME || !existsSync(CHROME)) {
  console.error("Set CHROME_BIN to a Chromium binary that honors --load-extension (Chrome for Testing, Chromium, Brave, or Edge).");
  console.error("Install Chrome for Testing:  npx @puppeteer/browsers install chrome@stable");
  process.exit(2);
}

const udd = mkdtempSync(join(tmpdir(), "cbb-e2e-"));
const srv = spawn("node", [SERVER], { env: { ...process.env, CONTROLIUM_PORT: String(PORT) }, stdio: ["pipe", "pipe", "pipe"] });
let buf = ""; const waiters = new Map();
srv.stdout.on("data", (d) => { buf += d.toString(); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
srv.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
let idc = 100;
const rpc = (method, params) => { const id = ++idc; return new Promise((res) => { waiters.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }); };
const callTool = async (name, args) => (await rpc("tools/call", { name, arguments: args || {} })).result;

let chrome;
function cleanup() { try { srv.kill(); } catch {} try { chrome && chrome.kill(); } catch {} try { rmSync(udd, { recursive: true, force: true }); } catch {} }

async function main() {
  await sleep(500);
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  chrome = spawn(CHROME, [
    `--user-data-dir=${udd}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
    "--no-first-run", "--no-default-browser-check", "about:blank",
  ], { stdio: "ignore" });
  console.log("Launched Chromium with extension. Waiting for it to connect...");

  let ok = false;
  for (let t = 0; t < 80; t++) { await sleep(500); if (!(await callTool("list_tabs", {})).isError) { ok = true; console.log(`connected after ~${(t + 1) * 0.5}s`); break; } }
  if (!ok) throw new Error("extension never connected");

  let r = await callTool("new_tab", { url: "https://example.com" }); console.log("new_tab:", r.content?.[0]?.text);
  await sleep(1500);
  const tabs = JSON.parse((await callTool("list_tabs", {})).content[0].text);
  const ex = tabs.find((t) => (t.url || "").includes("example.com"));
  r = await callTool("navigate", { tabId: ex.tabId, url: "https://example.org" }); console.log("navigate:", r.content?.[0]?.text);
  r = await callTool("eval_js", { tabId: ex.tabId, code: "return document.title;" }); console.log("eval_js title:", r.content?.[0]?.text);
  r = await callTool("focus_tab", { tabId: ex.tabId }); console.log("focus_tab:", r.content?.[0]?.text);
  await sleep(400);
  const active = JSON.parse((await callTool("list_tabs", {})).content[0].text).find((t) => t.tabId === ex.tabId)?.active;
  const fg = JSON.parse((await callTool("eval_js", { tabId: ex.tabId, code: "return JSON.stringify({v:document.visibilityState,f:document.hasFocus()});" })).content[0].text);
  r = await callTool("screenshot", { tabId: ex.tabId }); const img = (r.content || []).find((c) => c.type === "image");

  // synthetic cursor: move it, then confirm the overlay element exists at that point
  await callTool("move_mouse", { tabId: ex.tabId, coordinate: [220, 180] });
  await sleep(300);
  const cur = JSON.parse((await callTool("eval_js", { tabId: ex.tabId, code: "const c=document.querySelector('[data-controlium-cursor]'); return JSON.stringify({present:!!c, transform:c?c.style.transform:''});" })).content[0].text);
  console.log("synthetic cursor:", cur);
  const cursorOk = cur.present === true && cur.transform.includes("220px");

  console.log("\n==== RESULT ====");
  console.log("tab active:", active, "| visibility:", fg.v, "| hasFocus:", fg.f, "| screenshot:", img ? "OK" : "MISSING", "| cursor:", cursorOk ? "OK" : "MISSING");
  const pass = active === true && fg.v === "visible" && !!img && cursorOk;
  console.log(pass ? "PASS: bring-to-front + CDP tools verified." : "FAIL");
  cleanup(); process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAILED:", e.message); cleanup(); process.exit(1); });
setTimeout(() => { cleanup(); process.exit(1); }, 60000);
