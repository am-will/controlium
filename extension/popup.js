const $ = (id) => document.getElementById(id);

function parsePorts(str) {
  return [...new Set(String(str).split(",").map((p) => Number(p.trim())).filter((p) => p > 0 && p < 65536))];
}

async function refresh() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
    if (!res) return;
    $("dot").className = "dot " + (res.connected ? "on" : "off");
    const open = res.openPorts && res.openPorts.length ? " (:" + res.openPorts.join(", :") + ")" : "";
    $("status").textContent = res.connected ? "Connected" + open : "Disconnected";
    if (document.activeElement !== $("ports")) $("ports").value = (res.ports || []).join(", ");
    $("autofocus").checked = res.autoFocus;
    $("showcursor").checked = res.showCursor;
    $("curtab").textContent = res.currentTabId ? "Working tab id: " + res.currentTabId : "";
  });
}

function savePorts() {
  const ports = parsePorts($("ports").value);
  chrome.storage.local.set({ ports: ports.length ? ports : [8765, 8766] });
}

$("reconnect").addEventListener("click", () => {
  savePorts();
  chrome.runtime.sendMessage({ type: "RECONNECT" }, () => setTimeout(refresh, 400));
});

$("ports").addEventListener("change", savePorts);

$("autofocus").addEventListener("change", () => {
  chrome.storage.local.set({ autoFocus: $("autofocus").checked });
});

$("showcursor").addEventListener("change", () => {
  chrome.storage.local.set({ showCursor: $("showcursor").checked });
});

refresh();
setInterval(refresh, 1500);
