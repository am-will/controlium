// Synthetic cursor overlay — draws a visible mouse pointer and click ripples so you
// can see where Claude is acting. The real input is dispatched via CDP by the service
// worker; this is the visual layer (and it also shows up in screenshots).
//
// Coordinates are viewport CSS pixels — the same space CDP Input events and the
// screenshot tool use, so the drawn cursor lines up with the actual click point.

(() => {
  if (window.__controliumCursorInstalled) return;
  window.__controliumCursorInstalled = true;

  const SVG_NS = "http://www.w3.org/2000/svg";
  let cursor = null;
  let hideTimer = null;

  function ensure() {
    if (cursor && document.documentElement.contains(cursor)) return;
    cursor = document.createElement("div");
    cursor.setAttribute("data-controlium-cursor", "1");
    cursor.style.cssText = [
      "position:fixed", "left:0", "top:0", "width:22px", "height:22px",
      "z-index:2147483647", "pointer-events:none", "will-change:transform",
      "transform:translate(-100px,-100px)",
      "transition:transform .22s cubic-bezier(.22,1,.36,1)",
      "filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))",
    ].join(";");
    cursor.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24" xmlns="' + SVG_NS + '">' +
      '<path d="M3 2 L3 19 L8 14.5 L11.2 21.5 L14 20.3 L10.9 13.5 L18 13.5 Z" ' +
      'fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(cursor);
  }

  function move(x, y) {
    ensure();
    clearTimeout(hideTimer);
    cursor.style.opacity = "1";
    cursor.style.transform = "translate(" + x + "px," + y + "px)";
  }

  function ripple(x, y, color) {
    ensure();
    const r = document.createElement("div");
    r.style.cssText = [
      "position:fixed", "left:" + x + "px", "top:" + y + "px",
      "width:12px", "height:12px", "margin:-6px 0 0 -6px",
      "border:2px solid " + (color || "#d97757"), "border-radius:50%",
      "z-index:2147483646", "pointer-events:none", "opacity:.95",
      "transition:width .42s ease-out,height .42s ease-out,margin .42s ease-out,opacity .42s ease-out",
    ].join(";");
    document.documentElement.appendChild(r);
    requestAnimationFrame(() => {
      r.style.width = "46px"; r.style.height = "46px"; r.style.margin = "-23px 0 0 -23px"; r.style.opacity = "0";
    });
    setTimeout(() => r.remove(), 480);
  }

  function hide() {
    if (!cursor) return;
    cursor.style.opacity = "0";
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.type !== "CONTROLIUM_CURSOR") return;
    if (m.action === "move") move(m.x, m.y);
    else if (m.action === "click") { move(m.x, m.y); setTimeout(() => ripple(m.x, m.y, m.color), 110); }
    else if (m.action === "hide") hide();
  });
})();
