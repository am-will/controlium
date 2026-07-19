// Controlium — service worker
//
// Connects to the local MCP bridge over WebSocket, receives tool calls, and
// executes them against Chrome tabs using the DevTools Protocol (chrome.debugger)
// plus chrome.tabs / chrome.windows.
//
// The defining enhancement vs. the official extension: every tool that targets a
// tab first brings that tab to the FRONT of Chrome (active tab + focused window),
// so Claude's working tab is always visible instead of hidden in the background.

const DEFAULT_PORTS = [8765, 8766];
const CDP_VERSION = "1.3";
const MAX_BUF = 300;
const LOAD_TIMEOUT_MS = 30000;

let currentTabId = null;
const conns = new Map();   // port -> { sock, connecting, delay, timer }
let anyConnected = false;

function dlog(...a) { try { console.log("[controlium]", ...a); } catch (_) {} }

const attached = new Set();            // tabIds with the debugger attached
const consoleBuffers = new Map();      // tabId -> [entries]
const networkBuffers = new Map();      // tabId -> [entries]
const refMaps = new Map();             // tabId -> Map(refId -> {x,y,tag,text})

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function getConfig() {
  const { autoFocus, showCursor } = await chrome.storage.local.get(["autoFocus", "showCursor"]);
  return {
    autoFocus: autoFocus !== false, // default true
    showCursor: showCursor !== false, // default true
  };
}

// The extension connects to EVERY configured bridge port at once, so different MCP
// hosts (e.g. Claude Code on 8765, Claude Desktop on 8766) can each drive it — one
// at a time. Configure the list in the popup/options (comma-separated).
async function getPorts() {
  const { ports, port } = await chrome.storage.local.get(["ports", "port"]);
  let list = [];
  if (Array.isArray(ports)) list = ports;
  else if (typeof ports === "string") list = ports.split(",");
  else if (port != null) list = [port];
  list = list.map((p) => Number(String(p).trim())).filter((p) => p > 0 && p < 65536);
  return list.length ? [...new Set(list)] : DEFAULT_PORTS.slice();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cursorEnabled = true;

// Tell the tab's content-script overlay to move the visible cursor / show a click
// ripple. Falls back to injecting the overlay on demand for tabs that were open
// before the extension loaded.
async function cursorSignal(tabId, action, x, y) {
  if (!cursorEnabled) return;
  const msg = { type: "CONTROLIUM_CURSOR", action, x, y };
  try { await chrome.tabs.sendMessage(tabId, msg); return; } catch (_) {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["cursor-overlay.js"] });
    await chrome.tabs.sendMessage(tabId, msg);
  } catch (__) {}
}

// ---------------------------------------------------------------------------
// WebSocket connection to the MCP bridge
// ---------------------------------------------------------------------------

// Open (and keep open) a connection to every configured port.
async function connectAll() {
  const ports = await getPorts();
  for (const p of ports) {
    if (!conns.has(p)) conns.set(p, { sock: null, connecting: false, delay: 1000, timer: null });
    connectPort(p);
  }
}

function connectPort(p) {
  const c = conns.get(p);
  if (!c) return;
  clearTimeout(c.timer);
  if (c.connecting) return;
  if (c.sock && (c.sock.readyState === WebSocket.OPEN || c.sock.readyState === WebSocket.CONNECTING)) return;
  c.connecting = true;

  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${p}`);
  } catch (e) {
    c.connecting = false;
    scheduleReconnectPort(p);
    return;
  }
  c.sock = sock;

  sock.onopen = () => {
    c.connecting = false;
    c.delay = 1000;
    dlog("connected to bridge on :" + p);
    try {
      sock.send(JSON.stringify({ type: "hello", role: "extension", version: chrome.runtime.getManifest().version }));
    } catch (_) {}
    updateAnyConnected();
  };

  sock.onmessage = (ev) => handleMessage(ev.data, sock);

  sock.onclose = () => {
    c.connecting = false;
    if (c.sock === sock) c.sock = null;
    updateAnyConnected();
    scheduleReconnectPort(p);
  };

  sock.onerror = () => { try { sock.close(); } catch (_) {} };
}

function scheduleReconnectPort(p) {
  const c = conns.get(p);
  if (!c) return;
  clearTimeout(c.timer);
  c.delay = Math.min(c.delay * 1.5, 15000);
  c.timer = setTimeout(() => connectPort(p), c.delay);
}

function updateAnyConnected() {
  anyConnected = [...conns.values()].some((c) => c.sock && c.sock.readyState === WebSocket.OPEN);
  updateBadge();
}

async function handleMessage(data, sock) {
  let msg;
  try { msg = JSON.parse(data); } catch (_) { return; }

  if (msg.type === "ping") {
    safeSend(sock, { type: "pong" });
    return;
  }
  if (msg.type === "call") {
    const { id, tool, args } = msg;
    let resp;
    try {
      const content = await runTool(tool, args || {});
      resp = { type: "result", id, ok: true, content };
    } catch (e) {
      resp = { type: "result", id, ok: false, error: errStr(e) };
    }
    safeSend(sock, resp);
  }
}

function safeSend(sock, obj) {
  try {
    if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(obj));
  } catch (_) {}
}

function updateBadge() {
  try {
    chrome.action.setBadgeText({ text: anyConnected ? "on" : "" });
    chrome.action.setBadgeBackgroundColor({ color: anyConnected ? "#2e7d32" : "#9e9e9e" });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

function sendCDP(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(`${method}: ${err.message}`));
      resolve(result);
    });
  });
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        if (/already attached/i.test(err.message)) { attached.add(tabId); return resolve(); }
        return reject(new Error(err.message));
      }
      attached.add(tabId);
      resolve();
    });
  });
  // Enable domains we buffer from. Failures are non-fatal.
  await sendCDP(tabId, "Page.enable").catch(() => {});
  await sendCDP(tabId, "Runtime.enable").catch(() => {});
  await sendCDP(tabId, "Log.enable").catch(() => {});
  await sendCDP(tabId, "Network.enable").catch(() => {});
}

function pushBuf(map, tabId, entry) {
  let arr = map.get(tabId);
  if (!arr) { arr = []; map.set(tabId, arr); }
  arr.push(entry);
  if (arr.length > MAX_BUF) arr.splice(0, arr.length - MAX_BUF);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  try {
    if (method === "Runtime.consoleAPICalled") {
      pushBuf(consoleBuffers, tabId, {
        level: params.type,
        text: (params.args || []).map(fmtRemoteObject).join(" "),
        ts: params.timestamp,
      });
    } else if (method === "Runtime.exceptionThrown") {
      const d = params.exceptionDetails || {};
      pushBuf(consoleBuffers, tabId, {
        level: "error",
        text: (d.exception && (d.exception.description || d.exception.value)) || d.text || "exception",
        ts: params.timestamp,
      });
    } else if (method === "Log.entryAdded") {
      pushBuf(consoleBuffers, tabId, { level: params.entry.level, text: params.entry.text, ts: params.entry.timestamp });
    } else if (method === "Network.requestWillBeSent") {
      pushBuf(networkBuffers, tabId, {
        phase: "request", requestId: params.requestId,
        method: params.request.method, url: params.request.url, ts: params.timestamp,
      });
    } else if (method === "Network.responseReceived") {
      pushBuf(networkBuffers, tabId, {
        phase: "response", requestId: params.requestId,
        status: params.response.status, mimeType: params.response.mimeType, url: params.response.url, ts: params.timestamp,
      });
    } else if (method === "Network.loadingFailed") {
      pushBuf(networkBuffers, tabId, { phase: "failed", requestId: params.requestId, error: params.errorText, ts: params.timestamp });
    }
  } catch (_) {}
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

function fmtRemoteObject(o) {
  if (o == null) return "";
  if (o.value !== undefined) return typeof o.value === "object" ? safeJson(o.value) : String(o.value);
  if (o.unserializableValue !== undefined) return String(o.unserializableValue);
  if (o.description !== undefined) return o.description;
  return o.type || "";
}
function safeJson(v) { try { return JSON.stringify(v); } catch (_) { return String(v); } }

// ---------------------------------------------------------------------------
// Tab helpers + the bring-to-front enhancement
// ---------------------------------------------------------------------------

async function resolveTab(args) {
  let tabId = args && args.tabId != null ? Number(args.tabId) : null;
  if (tabId == null && currentTabId != null) tabId = currentTabId;
  if (tabId != null) {
    try {
      const t = await chrome.tabs.get(tabId);
      currentTabId = t.id;
      return t;
    } catch (_) { /* fall through to active tab */ }
  }
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error("No active tab found. Open a tab in Chrome or pass a tabId.");
  currentTabId = t.id;
  return t;
}

// THE ENHANCEMENT: make `tab` the visible, foreground tab inside Chrome.
async function bringToFront(tab) {
  currentTabId = tab.id;
  try { await chrome.tabs.update(tab.id, { active: true }); } catch (_) {}
  if (tab.windowId != null) {
    try {
      const win = await chrome.windows.get(tab.windowId);
      if (win.state === "minimized") {
        await chrome.windows.update(tab.windowId, { state: "normal" });
      }
    } catch (_) {}
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
  }
  // Also raise it at the CDP level (equivalent to Target.activateTarget).
  try { await ensureAttached(tab.id); await sendCDP(tab.id, "Page.bringToFront"); } catch (_) {}
}

async function maybeFocus(tab, cfg, args) {
  const wants = !args || args.focus !== false;
  if (cfg.autoFocus && wants) await bringToFront(tab);
}

function waitForLoad(tabId, timeout = LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "complete" || Date.now() - start > timeout) return resolve();
      } catch (_) { return resolve(); }
      setTimeout(poll, 200);
    };
    setTimeout(poll, 200);
  });
}

// ---------------------------------------------------------------------------
// Coordinate / input helpers
// ---------------------------------------------------------------------------

function buttonMask(button) {
  return button === "right" ? 2 : button === "middle" ? 4 : 1;
}

async function coordsFrom(tabId, args) {
  if (args.ref != null) {
    const m = refMaps.get(tabId);
    const hit = m && m.get(String(args.ref));
    if (!hit) throw new Error(`Unknown ref "${args.ref}". Call read_page again to refresh element refs.`);
    return { x: hit.x, y: hit.y };
  }
  if (Array.isArray(args.coordinate) && args.coordinate.length === 2) {
    return { x: Number(args.coordinate[0]), y: Number(args.coordinate[1]) };
  }
  if (args.x != null && args.y != null) return { x: Number(args.x), y: Number(args.y) };
  throw new Error("Provide a coordinate [x,y], x/y, or a ref (from read_page).");
}

async function clickAt(tabId, x, y, button = "left", clickCount = 1) {
  // Animate the visible cursor to the target first, so the click is watchable.
  await cursorSignal(tabId, "move", x, y);
  if (cursorEnabled) await sleep(170);
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount, buttons: buttonMask(button) });
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount, buttons: 0 });
  await cursorSignal(tabId, "click", x, y);
}

// Minimal named-key table for press_key.
const KEY_TABLE = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};
// CDP modifier bitmask: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8
const MOD_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

async function pressKey(tabId, combo) {
  const parts = String(combo).split("+").map((s) => s.trim()).filter(Boolean);
  const keyName = parts.pop();
  let modifiers = 0;
  for (const p of parts) modifiers |= (MOD_BITS[p.toLowerCase()] || 0);
  const lower = keyName.toLowerCase();
  let spec = KEY_TABLE[lower];
  if (!spec) {
    // Single printable character.
    const ch = keyName.length === 1 ? keyName : keyName;
    spec = { key: ch, code: "Key" + ch.toUpperCase(), vk: ch.toUpperCase().charCodeAt(0), text: modifiers ? undefined : ch };
  }
  const base = { modifiers, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
  await sendCDP(tabId, "Input.dispatchKeyEvent", { type: spec.text ? "keyDown" : "rawKeyDown", ...base, text: spec.text });
  await sendCDP(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

// ---------------------------------------------------------------------------
// read_page: build a compact accessibility-ish tree with clickable refs
// ---------------------------------------------------------------------------

const READ_PAGE_FN = `
(() => {
  const out = [];
  const refs = [];
  let n = 0;
  const INTERACTIVE = new Set(["A","BUTTON","INPUT","TEXTAREA","SELECT","SUMMARY","OPTION"]);
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0") return null;
    return r;
  }
  function label(el) {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return aria.trim();
    if (el.tagName === "INPUT") {
      const ph = el.getAttribute("placeholder"); if (ph) return ph.trim();
      if (el.value) return String(el.value).slice(0,80);
      const t = el.getAttribute("type"); if (t) return t + " input";
    }
    const txt = (el.innerText || el.textContent || "").replace(/\\s+/g," ").trim();
    return txt.slice(0, 120);
  }
  function role(el) {
    const r = el.getAttribute && el.getAttribute("role");
    if (r) return r;
    const map = { A:"link", BUTTON:"button", INPUT:"textbox", TEXTAREA:"textbox", SELECT:"combobox", IMG:"image", H1:"heading", H2:"heading", H3:"heading", H4:"heading", NAV:"navigation" };
    return map[el.tagName] || el.tagName.toLowerCase();
  }
  function isInteractive(el) {
    if (INTERACTIVE.has(el.tagName)) return true;
    const r = el.getAttribute && el.getAttribute("role");
    if (r && ["button","link","checkbox","tab","menuitem","switch","radio"].includes(r)) return true;
    if (el.hasAttribute && el.hasAttribute("onclick")) return true;
    if (el.tabIndex >= 0 && el.tagName !== "BODY") return true;
    return false;
  }
  function walk(el, depth) {
    if (depth > 22) return;
    for (const child of el.children) {
      if (["SCRIPT","STYLE","NOSCRIPT","SVG","TEMPLATE"].includes(child.tagName)) continue;
      const r = visible(child);
      if (!r) { walk(child, depth); continue; }
      const interactive = isInteractive(child);
      const lab = label(child);
      if (interactive || (lab && child.children.length === 0)) {
        let line = "  ".repeat(Math.min(depth,12)) + role(child);
        if (lab) line += ': "' + lab.replace(/"/g,"'") + '"';
        if (interactive) {
          const id = "ref_" + (++n);
          line += " [" + id + "]";
          refs.push({ ref: id, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), tag: child.tagName, text: lab });
        }
        if (lab || interactive) out.push(line);
      }
      walk(child, depth + 1);
    }
  }
  walk(document.body, 0);
  return { tree: out.join("\\n").slice(0, 20000), refs, title: document.title, url: location.href };
})()
`;

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function text(t) { return [{ type: "text", text: String(t) }]; }

async function runTool(tool, args) {
  const cfg = await getConfig();
  cursorEnabled = cfg.showCursor;
  switch (tool) {
    case "list_tabs":
    case "tabs_context": {
      const tabs = await chrome.tabs.query({});
      const rows = tabs.map((t) => ({ tabId: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url }));
      return text(JSON.stringify(rows, null, 2));
    }
    case "focus_tab":
    case "bring_to_front": {
      const tab = await resolveTab(args);
      await bringToFront(tab);
      return text(`Brought tab ${tab.id} to front: ${tab.title || tab.url}`);
    }
    case "new_tab":
    case "tabs_create": {
      const active = args.active !== false;
      const tab = await chrome.tabs.create({ url: normalizeUrl(args.url) || "about:blank", active });
      currentTabId = tab.id;
      if (active && tab.windowId != null) { try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {} }
      return text(`Opened tab ${tab.id}: ${tab.pendingUrl || tab.url || args.url || "about:blank"}`);
    }
    case "close_tab":
    case "tabs_close": {
      const tab = await resolveTab(args);
      await chrome.tabs.remove(tab.id);
      if (currentTabId === tab.id) currentTabId = null;
      return text(`Closed tab ${tab.id}`);
    }
    case "navigate": {
      const tab = await resolveTab(args);
      await maybeFocus(tab, cfg, args);
      const target = String(args.url || "");
      if (target === "back") { await chrome.tabs.goBack(tab.id).catch(() => {}); }
      else if (target === "forward") { await chrome.tabs.goForward(tab.id).catch(() => {}); }
      else { await chrome.tabs.update(tab.id, { url: normalizeUrl(target) }); }
      await waitForLoad(tab.id);
      const t = await chrome.tabs.get(tab.id);
      return text(`Navigated tab ${tab.id} to ${t.url}`);
    }
    case "screenshot":
    case "computer_screenshot": {
      const tab = await resolveTab(args);
      await maybeFocus(tab, cfg, args);
      await ensureAttached(tab.id);
      const metrics = await sendCDP(tab.id, "Page.getLayoutMetrics");
      const vp = metrics.cssVisualViewport || metrics.visualViewport || { clientWidth: 1280, clientHeight: 800 };
      const width = Math.max(1, Math.ceil(vp.clientWidth));
      const height = Math.max(1, Math.ceil(vp.clientHeight));
      const shot = await sendCDP(tab.id, "Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width, height, scale: 1 },
        captureBeyondViewport: false,
      });
      return [
        { type: "image", data: shot.data, mimeType: "image/png" },
        { type: "text", text: `Screenshot of tab ${tab.id} (${width}x${height} css px) — ${tab.url}` },
      ];
    }
    case "click": {
      const tab = await resolveTab(args);
      await maybeFocus(tab, cfg, args);
      await ensureAttached(tab.id);
      const { x, y } = await coordsFrom(tab.id, args);
      const button = args.button || "left";
      const clickCount = args.double ? 2 : (args.clickCount || 1);
      await clickAt(tab.id, x, y, button, clickCount);
      return text(`Clicked (${x},${y})${button !== "left" ? " [" + button + "]" : ""}${clickCount > 1 ? " x" + clickCount : ""} on tab ${tab.id}`);
    }
    case "move_mouse":
    case "hover": {
      const tab = await resolveTab(args);
      await maybeFocus(tab, cfg, args);
      await ensureAttached(tab.id);
      const { x, y } = await coordsFrom(tab.id, args);
      await cursorSignal(tab.id, "move", x, y);
      if (cursorEnabled) await sleep(150);
      await sendCDP(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
      return text(`Moved cursor to (${x},${y}) on tab ${tab.id}`);
    }
    case "type_text":
    case "type": {
      const tab = await resolveTab(args);
      await maybeFocus(tab, cfg, args);
      await ensureAttached(tab.id);
      if (args.ref != null || args.coordinate || (args.x != null && args.y != null)) {
        const { x, y } = await coordsFrom(tab.id, args);
        await clickAt(tab.id, x, y);
      }
      const str = String(args.text != null ? args.text : "");
      await sendCDP(tab.id, "Input.insertText", { text: str });
      if (args.submit) await pressKey(tab.id, "Enter");
      return text(`Typed ${JSON.stringify(str)} into tab ${tab.id}${args.submit ? " + Enter" : ""}`);
    }
    case "press_key":
    case "key": {
      const tab = await resolveTab(args);
      await maybeFocus(tab, cfg, args);
      await ensureAttached(tab.id);
      const combos = Array.isArray(args.keys) ? args.keys : [args.key || args.text];
      for (const c of combos) await pressKey(tab.id, c);
      return text(`Pressed ${combos.join(", ")} on tab ${tab.id}`);
    }
    case "scroll": {
      const tab = await resolveTab(args);
      await maybeFocus(tab, cfg, args);
      await ensureAttached(tab.id);
      const x = args.x != null ? Number(args.x) : 100;
      const y = args.y != null ? Number(args.y) : 100;
      const amount = args.amount != null ? Number(args.amount) : 400;
      let dx = args.dx != null ? Number(args.dx) : 0;
      let dy = args.dy != null ? Number(args.dy) : 0;
      if (dx === 0 && dy === 0) {
        const dir = args.direction || "down";
        if (dir === "down") dy = amount;
        else if (dir === "up") dy = -amount;
        else if (dir === "right") dx = amount;
        else if (dir === "left") dx = -amount;
      }
      await sendCDP(tab.id, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
      return text(`Scrolled tab ${tab.id} by (${dx},${dy})`);
    }
    case "eval_js":
    case "javascript_tool": {
      const tab = await resolveTab(args);
      await maybeFocus(tab, cfg, args);
      await ensureAttached(tab.id);
      const code = String(args.code != null ? args.code : (args.expression != null ? args.expression : args.script || ""));
      const wrapped = `(async () => { ${code} })()`;
      const res = await sendCDP(tab.id, "Runtime.evaluate", {
        expression: wrapped, returnByValue: true, awaitPromise: true, userGesture: true,
      });
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        return text(`JS error: ${(d.exception && (d.exception.description || d.exception.value)) || d.text}`);
      }
      const val = res.result && res.result.value;
      return text(val === undefined ? "(undefined)" : (typeof val === "object" ? safeJson(val) : String(val)));
    }
    case "get_page_text": {
      const tab = await resolveTab(args);
      await maybeFocus(tab, cfg, args);
      await ensureAttached(tab.id);
      const res = await sendCDP(tab.id, "Runtime.evaluate", {
        expression: `(() => { const a = document.querySelector('article,main'); return (a? a.innerText : document.body.innerText).slice(0, ${Number(args.max_chars) || 40000}); })()`,
        returnByValue: true,
      });
      return text((res.result && res.result.value) || "");
    }
    case "read_page": {
      const tab = await resolveTab(args);
      await maybeFocus(tab, cfg, args);
      await ensureAttached(tab.id);
      const res = await sendCDP(tab.id, "Runtime.evaluate", { expression: READ_PAGE_FN, returnByValue: true });
      const data = (res.result && res.result.value) || { tree: "", refs: [] };
      const m = new Map();
      for (const r of data.refs || []) m.set(r.ref, r);
      refMaps.set(tab.id, m);
      return text(`# ${data.title || ""}\n${data.url || ""}\n\n${data.tree || "(no visible content)"}`);
    }
    case "find": {
      const tab = await resolveTab(args);
      await ensureAttached(tab.id);
      let m = refMaps.get(tab.id);
      if (!m) {
        const res = await sendCDP(tab.id, "Runtime.evaluate", { expression: READ_PAGE_FN, returnByValue: true });
        const data = (res.result && res.result.value) || { refs: [] };
        m = new Map();
        for (const r of data.refs || []) m.set(r.ref, r);
        refMaps.set(tab.id, m);
      }
      const q = String(args.query || "").toLowerCase();
      const hits = [...m.values()].filter((r) => (r.text || "").toLowerCase().includes(q));
      return text(hits.length ? hits.map((h) => `${h.ref} <${h.tag}> "${h.text}" @(${h.x},${h.y})`).join("\n") : `No matches for "${args.query}". Try read_page first.`);
    }
    case "read_console_messages":
    case "read_console": {
      const tab = await resolveTab(args, false);
      const arr = consoleBuffers.get(tab.id) || [];
      const limit = Number(args.limit) || 100;
      const rows = arr.slice(-limit);
      return text(rows.length ? rows.map((e) => `[${e.level}] ${e.text}`).join("\n") : "(no console messages buffered)");
    }
    case "read_network_requests":
    case "read_network": {
      const tab = await resolveTab(args, false);
      const arr = networkBuffers.get(tab.id) || [];
      const limit = Number(args.limit) || 100;
      const rows = arr.slice(-limit);
      return text(rows.length ? rows.map((e) => JSON.stringify(e)).join("\n") : "(no network activity buffered)");
    }
    case "resize_window": {
      const tab = await resolveTab(args);
      const upd = {};
      if (args.width) upd.width = Number(args.width);
      if (args.height) upd.height = Number(args.height);
      if (tab.windowId != null && (upd.width || upd.height)) await chrome.windows.update(tab.windowId, upd);
      return text(`Resized window of tab ${tab.id} to ${JSON.stringify(upd)}`);
    }
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

function normalizeUrl(u) {
  if (!u) return u;
  u = String(u);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u) || u.startsWith("about:") || u.startsWith("chrome:")) return u;
  return "https://" + u;
}

function errStr(e) {
  return e && e.message ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  consoleBuffers.delete(tabId);
  networkBuffers.delete(tabId);
  refMaps.delete(tabId);
  if (currentTabId === tabId) currentTabId = null;
});

chrome.runtime.onInstalled.addListener(() => { connectAll(); });
chrome.runtime.onStartup.addListener(() => { connectAll(); });

// Reconnect backstop: alarms also wake the SW if it was suspended.
chrome.alarms.create("bridge-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "bridge-keepalive") connectAll();
});

// Popup / options can ask for status and trigger a reconnect.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "GET_STATUS") {
    Promise.all([getConfig(), getPorts()]).then(([cfg, ports]) => {
      const openPorts = [...conns.entries()].filter(([, c]) => c.sock && c.sock.readyState === WebSocket.OPEN).map(([p]) => p);
      sendResponse({ connected: anyConnected, ports, openPorts, autoFocus: cfg.autoFocus, showCursor: cfg.showCursor, currentTabId });
    });
    return true;
  }
  if (msg && msg.type === "RECONNECT") { connectAll(); sendResponse({ ok: true }); return true; }
  return false;
});

connectAll();
updateBadge();
