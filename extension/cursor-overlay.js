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
      "position:fixed", "left:0", "top:0", "width:40px", "height:40px",
      "z-index:2147483647", "pointer-events:none", "will-change:transform",
      "transform:translate(-100px,-100px)",
      "transition:transform .22s cubic-bezier(.22,1,.36,1)",
      // layered glow halo (warm) + a dark drop shadow for contrast on light pages
      "filter:drop-shadow(0 0 4px rgba(217,119,87,.95)) drop-shadow(0 0 10px rgba(217,119,87,.8)) drop-shadow(0 0 20px rgba(217,119,87,.55)) drop-shadow(0 1px 2px rgba(0,0,0,.55))",
    ].join(";");
    cursor.innerHTML =
      '<svg width="40" height="40" viewBox="0 0 24 24" xmlns="' + SVG_NS + '">' +
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
    const c = color || "#d97757";
    const r = document.createElement("div");
    r.style.cssText = [
      "position:fixed", "left:" + x + "px", "top:" + y + "px",
      "width:16px", "height:16px", "margin:-8px 0 0 -8px",
      "border:3px solid " + c, "border-radius:50%",
      "box-shadow:0 0 10px " + c + ", 0 0 18px " + c + ", inset 0 0 8px " + c,
      "z-index:2147483646", "pointer-events:none", "opacity:.95",
      "transition:width .45s ease-out,height .45s ease-out,margin .45s ease-out,opacity .45s ease-out",
    ].join(";");
    document.documentElement.appendChild(r);
    requestAnimationFrame(() => {
      r.style.width = "64px"; r.style.height = "64px"; r.style.margin = "-32px 0 0 -32px"; r.style.opacity = "0";
    });
    setTimeout(() => r.remove(), 500);
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
