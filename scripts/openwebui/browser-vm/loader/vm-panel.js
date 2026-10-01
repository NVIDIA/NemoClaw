// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// vm-panel.js — in-browser CheerpX/WebVM sandbox for the browser-vm relay.
//
// Appended to loader.js by loader/build.sh (single deploy artifact via the
// existing bind mount). Self-contained: boots one fresh, memory-only Debian
// pod per OpenWebUI chat, exposes window.__owuiVm, and pipes the pod to the
// relay so BOTH the model (via browser_shell tool) and the native OpenWebUI
// "Open Terminal" panel can drive it.
//
// Protocol (relay):
//   browser -> relay   {"type":"register","chat_id":…}   on connect
//                      {"type":"pong"}                    on {"type":"ping"}
//                      {"type":"exec_result","id",…}      exec completion
//                      {"type":"reset_ack","id"}          reset completion
//                      <non-JSON text/binary>             VM console output
//   relay -> browser   {"type":"exec","id","cmd","cwd","timeout_ms"}
//                      {"type":"term:data","data","enc":"b64"|absent}
//                                                         native-terminal input
//                      {"type":"term:resize","rows","cols"}
//                      {"type":"term:require"}            boot the pod now
//                      {"type":"reset","id"}
//                      {"type":"ping"} | {"type":"error",…}
//
// CheerpX integration, verified against @leaningtech/cheerpx@1.3.9 (the pinned
// version above — check index.d.ts and the shipped bundle before changing it):
//   Linux.create({mounts, networkInterface})   — no `cmd`, no `network`
//   Linux.run(file, args, {env, cwd})          — resolves on exit, returns
//                                               {status} only; no stdout
//   Linux.setCustomConsole(write, cols, rows)  — returns (keyCode) => void;
//                                               write is called ONE BYTE per
//                                               call. This is the only way to
//                                               read output, and the only way
//                                               to write input.
//   Linux.delete()                             — teardown
// There is no XtermConsole, no stdin, no spawn(), and no global `CheerpX` in
// that version; code that assumed any of those silently fell back to the mock.
// Verified headlessly in test_vm_panel.js against a fake modelled on those
// signatures. What still needs a real browser: the keycode translation in
// textToKeycodes() against a live tty, and the disk-image boot time.

(function () {
  "use strict";

  // ── Configuration (overridable from the console/devtools) ──────────────
  const CFG = Object.assign(
    {
      // relay base URL; dev example:
      //   window.__BROWSER_VM = { relay: "ws://127.0.0.1:8787" }
      // prod default assumes the relay is behind the same reverse proxy at
      // /vm-bridge (e.g. chat.supachad.com/vm-bridge for cloudflared).
      relay: (() => {
        const proto = location.protocol === "https:" ? "wss://" : "ws://";
        return proto + location.host + "/vm-bridge";
      })(),
      token: "", // relay WEB socket key, if RELAY_WS_KEY is set in prod
      // Pinned exactly. @latest resolves to a different major on any given day
      // and this file is a single deploy artifact with no lockfile to catch it.
      //
      // These are ESM *modules*, not UMD bundles: the npm entry re-exports the
      // named classes and never touches `window`. There is no
      // `build/cheerpx.min.js` and no global `CheerpX` — an earlier version of
      // this file pointed at both, so the import 404'd, the error was swallowed,
      // and the panel silently fell back to the mock pod. That is the entire
      // reason the dock used to say "No console available in this VM."
      // Served from a versioned subdir so the whole CheerpX runtime (cx_esm.js
      // + cxcore*.js/.wasm + tun/*, all resolved RELATIVE to this file) lives on
      // fresh URLs Cloudflare has never cached. The edge had negatively cached a
      // 404 for /static/vendor/cxcore.js from before the assets were vendored,
      // and the API token in use lacks Cache-Purge, so a new path is the
      // reliable bust. Bump r1 -> r2 if it ever happens again.
      cheerpxUrl: "/static/vendor/r1/cheerpx_v3.esm.js",
      // We own the terminal, because CheerpX 1.3.9 only exposes VM output
      // through setCustomConsole(). xterm.js is the VT emulator for it; the
      // .mjs builds are self-contained (no bare specifiers), so import() works.
      xtermUrl: "/static/vendor/xterm.mjs",
      xtermFitUrl: "/static/vendor/addon-fit.mjs",
      xtermCss: "/static/vendor/xterm.css",
      imageWs: "/static/vendor/debian.ext2",
      // Docker terminal URL (Terminals Orchestrator); defaults to same-origin /terminals/docker-term
      dockerTerminalUrl: "",
      // No network by default: this is a sandbox, and egress should be an
      // explicit opt-in. 1.3.9 takes a networkInterface *object* (authKey,
      // controlUrl, …), so `true` was never a working value.
      //   window.__BROWSER_VM = { network: { authKey: "…" } }
      network: false,
      // exec() recovers the command's output by printing OSC markers around it
      // on the shared tty. Output is coalesced before each xterm.write so a
      // burst of 1-byte CheerpX callbacks becomes a handful of writes.
      flushBytes: 256,
      // Open the terminal and boot the pod as soon as a chat is open, rather
      // than waiting for a click. The lazy default was chosen to avoid
      // streaming the disk image on every page load — but it made the panel
      // look dead: the agent's commands ran and their output was written to an
      // xterm inside a dock that was never opened, so the user saw nothing at
      // all. Cost is one cached disk image per browser profile. Set false (or
      // window.__BROWSER_VM = { autoOpen: false }) to go back to lazy.
      autoOpen: true,
    },
    window.__BROWSER_VM || {}
  );

  const STATE = {
    chatId: null, // active chat the pod is bound to
    ws: null,
    cx: null, // CheerpX.Linux instance
    cxLib: null, // the CheerpX module namespace (Linux, CloudDevice, …)
    xtermLib: null, // {Terminal, FitAddon}
    console: null, // {el, term, fit, sink, send, …} — ours, not CheerpX's
    ready: false, // broker + pod booted
    booting: false,
    pubAdapter: null, // resolved adapter (real or mock)
    execSeq: 0,
    reconnectTimer: null,
    backoff: 0,
    lastResetAt: 0,
    // The user closed the dock on purpose. Auto-open must not fight them, and
    // must not re-arm until they open it again or switch chat.
    dismissed: false,
    // Agent activity that happened while the dock was closed. Drives the badge
    // on the terminal button so output is never silently invisible.
    unseenAgentRuns: 0,
  };

  // ── Panel UI (draggable terminal bar + dock + terminal selector) ────────
  const CSS =
    /* ── Draggable terminal bar (thin; collapses to an edge thumbnail) ───── */
    "#bv-vmbar{" +
    "position:fixed;right:0.6rem;bottom:0.6rem;z-index:9999;" +
    "display:flex;align-items:center;gap:0.25rem;padding:0.12rem 0.3rem;" +
    "font:10px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e4e4e7;" +
    "background:rgba(24,24,27,0.9);border:1px solid #3f3f46;border-radius:7px;" +
    "box-shadow:0 2px 10px rgba(0,0,0,0.3);cursor:grab;" +
    "touch-action:none;user-select:none;" +
    "transition:background 0.15s,border-color 0.15s;" +
    "}" +
    "#bv-vmbar.bv-dragging{cursor:grabbing;opacity:0.92;}" +
    "#bv-vmbar .bv-dot{width:6px;height:6px;border-radius:50%;flex:none;background:#71717a;margin:0 0.1rem;}" +
    "#bv-vmbar.bv-idle .bv-dot{background:#71717a;}" +
    "#bv-vmbar.bv-booting .bv-dot{background:#f59e0b;animation:bv-pulse 1s infinite;}" +
    "#bv-vmbar.bv-ready .bv-dot{background:#22c55e;}" +
    "#bv-vmbar.bv-error .bv-dot{background:#ef4444;}" +
    "#bv-vmbar button{" +
    "border:1px solid #3f3f46;border-radius:4px;background:transparent;" +
    "color:#e4e4e7;font-size:9px;padding:0.08rem 0.32rem;cursor:pointer;margin-left:0.1rem;" +
    "}" +
    "#bv-vmbar button:hover{background:#27272a;}" +
    /* Terminal icon is the primary affordance: bigger hit target, no label. */
    "#bv-vmbar .bv-iconbtn{display:inline-flex;align-items:center;justify-content:center;" +
    "width:19px;height:19px;padding:0;margin-left:0.2rem;border-radius:4px;flex:none;position:relative;}" +
    "#bv-vmbar .bv-iconbtn svg{width:12px;height:12px;stroke:currentColor;fill:none;" +
    "stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}" +
    "#bv-vmbar .bv-iconbtn[aria-expanded='true']{background:#3f3f46;color:#fff;}" +
    // Badge on the terminal button: the agent ran commands while the dock was
    // closed, so there is unseen terminal output waiting.
    "#bv-vmbar .bv-badge{position:absolute;top:-4px;right:-4px;min-width:12px;" +
    "height:12px;padding:0 2px;border-radius:6px;background:#ef4444;color:#fff;" +
    "font:8px/12px ui-monospace,monospace;text-align:center;font-weight:700;" +
    "box-shadow:0 0 0 1px #18181b;pointer-events:none;}" +
    "#bv-vmbar .bv-iconbtn.bv-busy{color:#fca5a5;animation:bv-pulse 1.4s ease-in-out infinite;}" +
    "@keyframes bv-pulse{0%,100%{opacity:1}50%{opacity:.45}}" +
    /* ── Collapse chevron ───────────────────────────────────────────────── */
    "#bv-vmbar-collapse{display:inline-flex;align-items:center;justify-content:center;" +
    "width:16px;height:16px;padding:0;margin-left:0.15rem;border-radius:4px;flex:none;" +
    "border:1px solid transparent;color:#a1a1aa;}" +
    "#bv-vmbar-collapse:hover{color:#e4e4e7;background:#27272a;}" +
    "#bv-vmbar-collapse svg{width:11px;height:11px;stroke:currentColor;fill:none;" +
    "stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}" +
    /* ── Collapsed thumbnail: a small pill hugging a screen edge ─────────── */
    "#bv-vmbar-thumb{display:none;align-items:center;gap:0.2rem;cursor:pointer;" +
    "padding:0 0.05rem;}" +
    "#bv-vmbar-thumb svg{width:13px;height:13px;stroke:currentColor;fill:none;" +
    "stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}" +
    "#bv-vmbar.bv-collapsed{padding:0.18rem 0.28rem;gap:0.2rem;cursor:pointer;border-radius:999px;}" +
    "#bv-vmbar.bv-collapsed > *{display:none;}" +
    "#bv-vmbar.bv-collapsed .bv-dot{display:block;}" +
    "#bv-vmbar.bv-collapsed #bv-vmbar-thumb{display:inline-flex;}" +
    /* ── Terminal toggle buttons ─────────────────────────────────────────── */
    "#bv-terminal-toggles{display:flex;gap:0.15rem;}" +
    ".bv-terminal-toggle{display:inline-flex;align-items:center;gap:0.2rem;padding:0.1rem 0.4rem;border:1px solid #3f3f46;border-radius:4px;background:transparent;color:#e4e4e7;font:9px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer;transition:all 0.15s;}" +
    ".bv-terminal-toggle:hover{border-color:#52525b;background:rgba(63,63,70,0.1);}" +
    ".bv-terminal-toggle.active{background:rgba(79,70,229,0.15);border-color:#4f46e5;color:#818cf8;}" +
    /* Mobile: larger touch target for toggle buttons */
    "@media (max-width: 640px){" +
    ".bv-terminal-toggle{padding:0.3rem 0.7rem;font-size:12px;min-width:92px;}" +
    "}" +
    /* ── The interactive terminal dock ─────────────────────────────────── */
    "#bv-term{position:fixed;right:0.75rem;bottom:3.25rem;z-index:9998;" +
    "width:min(720px,calc(100vw - 1.5rem));height:min(460px,calc(100vh - 7rem));" +
    "display:none;flex-direction:column;overflow:hidden;" +
    "background:rgba(9,9,11,0.97);border:1px solid #3f3f46;border-radius:10px;" +
    "box-shadow:0 18px 48px rgba(0,0,0,0.55);color:#e4e4e7;" +
    "font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;" +
    "backdrop-filter:blur(6px);}" +
    "#bv-term.bv-open{display:flex;}" +
    "#bv-term-head{display:flex;align-items:center;gap:0.5rem;flex:none;" +
    "padding:0.4rem 0.6rem;border-bottom:1px solid #27272a;background:#18181b;}" +
    "#bv-term-title{font-weight:600;font-size:11px;letter-spacing:0.02em;}" +
    "#bv-term-state{font-size:10px;color:#a1a1aa;flex:1;min-width:0;" +
    "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    "#bv-term-head button{border:1px solid #3f3f46;background:transparent;color:#e4e4e7;" +
    "font-size:10px;padding:0.1rem 0.45rem;border-radius:5px;cursor:pointer;}" +
    "#bv-term-head button:hover{background:#27272a;}" +
    "#bv-term-body{flex:1;min-height:0;position:relative;overflow:hidden;background:#000;}" +
    "#bv-term-body .xterm{height:100%;}" +
    "#bv-term-xterm{position:absolute;inset:0;}" +
    "#bv-term-note{position:absolute;left:0;right:0;bottom:0;z-index:2;" +
    "padding:0.15rem 0.4rem;background:rgba(120,53,15,0.92);color:#fde68a;" +
    "font-size:10px;}" +
    "#bv-term-fallback{position:absolute;inset:0;display:none;flex-direction:column;" +
    "gap:0.4rem;align-items:center;justify-content:center;color:#71717a;font-size:11px;" +
    "text-align:center;padding:1rem;}" +
    "#bv-term-fallback.bv-on{display:flex;}" +
    "#bv-term-foot{flex:none;display:flex;align-items:center;gap:0.5rem;" +
    "padding:0.3rem 0.6rem;border-top:1px solid #27272a;background:#18181b;font-size:10px;" +
    "color:#a1a1aa;}" +
    "#bv-term-agent{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    "#bv-term-agent.bv-busy{color:#f59e0b;}" +
    /* (The composer chip #bv-chip + #bv-chip-menu styles were removed with the chip.) */
    "@keyframes bv-pulse{50%{opacity:0.35;}}";

  function ensureStyles() {
    if (!document.getElementById("bv-vmbar-style")) {
      const st = document.createElement("style");
      st.id = "bv-vmbar-style";
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }
  }

  const TERM_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="16" ' +
    'rx="2"/><path d="M6.5 9.5l3 2.5-3 2.5"/><path d="M12.5 15h5"/></svg>';

  // Chevron pointing down-right into a corner: "tuck this away".
  const COLLAPSE_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 9l-6 6"/>' +
    '<path d="M20 10v10H10"/></svg>';

  let barEl = null;

  // True when a pointer event landed on a button (or any descendant of one, e.g.
  // the terminal icon's <svg>/<path> or a toggle's <span>). Used by the drag
  // handlers so a click on any bar control is never swallowed by drag-to-move.
  function isInteractiveTarget(t) {
    if (!t || t.nodeType !== 1) return false;
    if (typeof t.closest === "function") return !!t.closest("button");
    // SVGElement.closest exists everywhere we run, but degrade safely: walk up.
    for (let el = t; el; el = el.parentNode) {
      if (el.tagName === "BUTTON") return true;
    }
    return false;
  }

  // ── Terminal type registry ──────────────────────────────────────────────
  // Supports multiple terminal backends: browser-vm (CheerpX) and docker (Open Terminal)
  // Docker terminal is currently disabled due to API incompatibility between
  // Open Terminal image and OpenWebUI's terminal proxy expectations.
  const TERMINAL_TYPES = {
    webvm: {
      id: "webvm",
      name: "Browser VM (WebVM)",
      icon: "🌐",
      description: "CheerpX x86 VM running in browser",
      // makeCheerpxAdapter() reads STATE.cxLib, so the library must be loaded
      // first. resolveAdapter() does this on the boot path; switchTerminal()
      // uses createAdapter() directly, so load it here too.
      createAdapter: async () => { await loadCheerpX(); return makeCheerpxAdapter(); },
    },
    docker: {
      id: "docker",
      name: "Docker Terminal",
      icon: "🐳",
      description: "Container-backed PTY via the terminals relay",
      createAdapter: () => makeDockerAdapter(),
    },
  };

  let currentTerminalType = "webvm"; // default
  let dockerAdapter = null;

  function ensureBar() {
    if (barEl && document.body.contains(barEl)) return barEl;
    ensureStyles();
    barEl = document.createElement("div");
    barEl.id = "bv-vmbar";
    barEl.className = "bv-idle";

    // Make the bar draggable. A pointer-down that never moves past a small
    // threshold is treated as a click (used to expand the collapsed pill), so
    // dragging and tapping the thumbnail do not fight each other.
    let dragOffsetX = 0, dragOffsetY = 0, isDragging = false, moved = false, downX = 0, downY = 0;
    const DRAG_THRESHOLD = 4;

    const beginDrag = (cx, cy, e) => {
      // Don't start a drag when the pointer went down on an interactive control.
      // The terminal icon is an <svg> INSIDE a <button>, and the WebVM/Docker
      // toggles wrap their label in a <span>, so e.target is frequently a
      // descendant, not the <button> itself. A tagName === "BUTTON" check
      // missed every click on the glyph and started a drag that
      // preventDefault()'d the click — the terminal icon "did nothing".
      if (isInteractiveTarget(e.target)) return;
      isDragging = true;
      moved = false;
      downX = cx;
      downY = cy;
      barEl.classList.add("bv-dragging");
      const rect = barEl.getBoundingClientRect();
      dragOffsetX = cx - rect.left;
      dragOffsetY = cy - rect.top;
    };
    const moveDrag = (cx, cy) => {
      if (!isDragging) return;
      if (!moved && Math.abs(cx - downX) + Math.abs(cy - downY) > DRAG_THRESHOLD) moved = true;
      const maxX = window.innerWidth - barEl.offsetWidth;
      const maxY = window.innerHeight - barEl.offsetHeight;
      barEl.style.left = Math.max(0, Math.min(cx - dragOffsetX, maxX)) + "px";
      barEl.style.right = "auto";
      barEl.style.top = Math.max(0, Math.min(cy - dragOffsetY, maxY)) + "px";
      barEl.style.bottom = "auto";
    };
    const endDrag = () => {
      if (!isDragging) return;
      isDragging = false;
      barEl.classList.remove("bv-dragging");
      if (moved) {
        snapBarToEdge();
        saveBarPos();
      } else if (barEl.classList.contains("bv-collapsed")) {
        // A tap on the collapsed pill expands it back to the full bar.
        setBarCollapsed(false);
      }
    };

    barEl.addEventListener("mousedown", (e) => {
      beginDrag(e.clientX, e.clientY, e);
      if (isDragging) e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => moveDrag(e.clientX, e.clientY));
    document.addEventListener("mouseup", endDrag);
    barEl.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      beginDrag(t.clientX, t.clientY, e);
    }, { passive: false });
    document.addEventListener("touchmove", (e) => {
      if (!isDragging) return;
      const t = e.touches[0];
      moveDrag(t.clientX, t.clientY);
    }, { passive: false });
    document.addEventListener("touchend", endDrag);

    const dot = document.createElement("span");
    dot.className = "bv-dot";
    const label = document.createElement("span");
    label.id = "bv-vmbar-label";

    // Terminal type toggle buttons (two buttons, one selected at a time)
    const buttonContainer = document.createElement("div");
    buttonContainer.style.cssText = "display:flex;gap:0.25rem;";

    const createToggleBtn = (type, info) => {
      const btn = document.createElement("button");
      btn.type = "button";
      // Styling (including the thinner sizing and the selected look) lives in
      // the .bv-terminal-toggle / .active CSS classes — no inline overrides, so
      // the bar actually renders thin.
      btn.className = "bv-terminal-toggle" + (type === currentTerminalType ? " active" : "");
      btn.innerHTML = `${info.icon} <span>${info.name}</span>`;
      btn.title = info.description;
      btn.dataset.type = type;
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await switchTerminal(type);
      });
      return btn;
    };

    const webvmBtn = createToggleBtn("webvm", TERMINAL_TYPES.webvm);
    const dockerBtn = createToggleBtn("docker", TERMINAL_TYPES.docker);
    buttonContainer.appendChild(webvmBtn);
    buttonContainer.appendChild(dockerBtn);

    // Primary affordance: the terminal icon opens the interactive dock.
    const term = document.createElement("button");
    term.id = "bv-vmbar-term";
    term.className = "bv-iconbtn";
    term.type = "button";
    term.title = "Open terminal (shared with the agent)";
    term.setAttribute("aria-label", "Open terminal");
    term.setAttribute("aria-expanded", "false");
    term.innerHTML = TERM_ICON;
    // Badge: agent commands ran while the dock was closed. Without it the
    // output was written to a terminal nobody was looking at, which is exactly
    // the "the agent ran commands but nothing appeared" failure.
    const badge = document.createElement("span");
    badge.id = "bv-vmbar-badge";
    badge.className = "bv-badge";
    badge.hidden = true;
    term.appendChild(badge);
    term.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTerminal().catch(function (err) {
        console.error("[bv-vmbar-term] toggle failed", err);
      });
    });
    const reset = document.createElement("button");
    reset.id = "bv-vmbar-reset";
    reset.textContent = "Reset";
    reset.addEventListener("click", (e) => {
      e.stopPropagation();
      resetVm();
    });

    // Collapse chevron: shrinks the bar to a small draggable edge thumbnail.
    const collapse = document.createElement("button");
    collapse.id = "bv-vmbar-collapse";
    collapse.type = "button";
    collapse.title = "Collapse to a thumbnail";
    collapse.setAttribute("aria-label", "Collapse terminal bar");
    collapse.innerHTML = COLLAPSE_ICON;
    collapse.addEventListener("click", (e) => {
      e.stopPropagation();
      setBarCollapsed(true);
    });

    // The collapsed pill's content: the status dot (appended above) plus a
    // terminal glyph so it still reads as "the terminal". Tapping the pill
    // expands it (handled in endDrag), so this is not itself a button.
    const thumb = document.createElement("span");
    thumb.id = "bv-vmbar-thumb";
    thumb.title = "Expand terminal bar";
    thumb.innerHTML = TERM_ICON;

    barEl.appendChild(dot);
    barEl.appendChild(label);
    barEl.appendChild(buttonContainer);
    barEl.appendChild(term);
    barEl.appendChild(reset);
    barEl.appendChild(collapse);
    barEl.appendChild(thumb);
    document.body.appendChild(barEl);

    // Restore where the user last put it, and whether it was collapsed.
    restoreBarPos();
    if (loadCollapsed()) setBarCollapsed(true, true);
    return barEl;
  }

  // setBar rewrites the status class (bv-idle/booting/ready/error); preserve the
  // collapsed flag across those updates, or a status change would silently
  // expand a bar the user deliberately collapsed.
  function setBar(state, text) {
    const bar = ensureBar();
    const wasCollapsed = bar.classList.contains("bv-collapsed");
    bar.className = "bv-" + state + (wasCollapsed ? " bv-collapsed" : "");
    const lbl = bar.querySelector("#bv-vmbar-label");
    if (lbl) lbl.textContent = text || "";
  }

  // ── Bar collapse + position persistence ─────────────────────────────────
  const BAR_POS_KEY = "bv.barPos";
  const BAR_COLLAPSE_KEY = "bv.barCollapsed";

  function setBarCollapsed(on, skipSnap) {
    const bar = ensureBar();
    bar.classList.toggle("bv-collapsed", !!on);
    try { localStorage.setItem(BAR_COLLAPSE_KEY, on ? "1" : "0"); } catch (_) { /* private mode */ }
    if (on && !skipSnap) {
      // Collapsing docks the pill to whichever horizontal edge it is nearest.
      snapBarToEdge();
      saveBarPos();
    }
  }

  function loadCollapsed() {
    try { return localStorage.getItem(BAR_COLLAPSE_KEY) === "1"; } catch (_) { return false; }
  }

  // Snap the bar's left edge to whichever side of the viewport it is closest to,
  // keeping its vertical position — the "thumbnail on the side of the screen"
  // feel. Operates on whatever size the bar currently is (collapsed or not).
  function snapBarToEdge() {
    if (!barEl) return;
    const margin = 8;
    const rect = barEl.getBoundingClientRect();
    const w = barEl.offsetWidth;
    const nearRight = rect.left + w / 2 > window.innerWidth / 2;
    const left = nearRight ? window.innerWidth - w - margin : margin;
    const maxY = window.innerHeight - barEl.offsetHeight - margin;
    barEl.style.left = left + "px";
    barEl.style.right = "auto";
    barEl.style.top = Math.max(margin, Math.min(rect.top, maxY)) + "px";
    barEl.style.bottom = "auto";
  }

  function saveBarPos() {
    if (!barEl) return;
    try {
      localStorage.setItem(BAR_POS_KEY, JSON.stringify({ left: barEl.style.left, top: barEl.style.top }));
    } catch (_) { /* private mode */ }
  }

  function restoreBarPos() {
    if (!barEl) return;
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem(BAR_POS_KEY) || "null"); } catch (_) { pos = null; }
    if (pos && pos.left && pos.top) {
      barEl.style.left = pos.left;
      barEl.style.right = "auto";
      barEl.style.top = pos.top;
      barEl.style.bottom = "auto";
    }
  }

  // ── Terminal switching ──────────────────────────────────────────────────
  async function switchTerminal(type) {
    if (type === currentTerminalType) return;

    // Clean up current terminal ONLY if we're switching to a working terminal
    const info = TERMINAL_TYPES[type];
    if (!info) {
      setBar("error", "Unknown terminal type: " + type);
      return;
    }

    const cid = STATE.chatId || currentChatId();
    if (!cid) {
      setBar("error", "No chat ID available");
      return;
    }
    const prevType = currentTerminalType;
    setBar("booting", "Switching to " + info.name + "…");

    try {
      // 1. Stop the OLD backend but KEEP the shared xterm. detach() (not reset(),
      //    which disposes the console) leaves one terminal + one scrollback for
      //    the incoming adapter — the fix for "WebVM dead after switching back".
      if (STATE.pubAdapter && typeof STATE.pubAdapter.detach === "function") {
        try { await STATE.pubAdapter.detach(); } catch (_) { /* keep going */ }
      }
      // Keep the agent relay connected across the switch (it routes agent exec to
      // whichever terminal is now active). Dropping it here is what produced the
      // "WebSocket closed before the connection is established" error.
      STATE.pubAdapter = null;
      STATE.ready = false;
      STATE.booting = false;
      STATE.cx = null;
      // Visually reset the shared terminal so the new backend starts clean.
      if (STATE.console && STATE.console.term) {
        try { STATE.console.term.clear(); } catch (_) { /* fresh console */ }
      }

      // 2. Activate the new adapter, then init it. pubAdapter is set FIRST so
      //    the shared console's onData routes keystrokes to the new backend.
      currentTerminalType = type;
      const newAdapter = await info.createAdapter();
      STATE.pubAdapter = newAdapter;
      await newAdapter.init(cid);
      STATE.ready = true;

      // 3. Ensure the agent relay is connected (idempotent) so the agent can
      //    drive the newly-active terminal too.
      connectRelay();
      setBar("ready", info.name + " ready");

      // Reflect the selection via the .active class (styling lives in CSS).
      document.querySelectorAll(".bv-terminal-toggle").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.type === type);
      });

      // Make sure the (shared) console is visible and focused in the dock.
      if (dockEl && dockEl.classList.contains("bv-open")) {
        mountConsole();
        fitConsole();
        setTermState(info.name + " · " + cid.slice(0, 8));
        setTimeout(focusConsole, 60);
      }
    } catch (e) {
      console.error("[browser-vm] Terminal switch failed:", e);
      setBar("error", "Switch failed: " + (e.message || e));
      // Leave the toggles reflecting the type we actually landed on so the UI
      // does not claim a backend that failed to start.
      document.querySelectorAll(".bv-terminal-toggle").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.type === currentTerminalType);
      });
    }
  }

  // ── Interactive terminal dock ───────────────────────────────────────────
  // The dock hosts our own xterm, wired straight to the pod's tty through
  // setCustomConsole: the user types into it, the guest tty echoes, and the
  // relay mirrors the same bytes to the native Open Terminal panel. The agent's
  // exec() calls type into that same tty, so both sides share one machine and
  // one scrollback.
  let dockEl = null;
  let chipEl = null;  // only used by ensureChip() to sweep a stale cached-loader chip

  function ensureDock() {
    if (dockEl && document.body.contains(dockEl)) return dockEl;
    ensureStyles();
    dockEl = document.createElement("div");
    dockEl.id = "bv-term";
    dockEl.innerHTML =
      '<div id="bv-term-head">' +
      '<span id="bv-term-title">Browser VM</span>' +
      '<span id="bv-term-state">idle</span>' +
      '<button id="bv-term-reset" type="button">Reset</button>' +
      '<button id="bv-term-close" type="button" aria-label="Close terminal">Close</button>' +
      "</div>" +
      '<div id="bv-term-body"><div id="bv-term-fallback">' +
      "<span>Booting the VM&hellip;</span></div>" +
      // We own this element: CheerpX 1.3.9 hands output to us and takes
      // keycodes back, so there is no third-party console node to adopt.
      '<div id="bv-term-xterm"></div></div>' +
      '<div id="bv-term-foot"><span id="bv-term-agent">idle</span>' +
      '<span id="bv-term-hint">shared with the agent</span></div>';
    document.body.appendChild(dockEl);
    dockEl.querySelector("#bv-term-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closeTerminal();
    });
    dockEl.querySelector("#bv-term-reset").addEventListener("click", (e) => {
      e.stopPropagation();
      resetVm();
    });
    // Clicking the body focuses the tty so the keyboard reaches the VM.
    dockEl.querySelector("#bv-term-body").addEventListener("mousedown", () => focusConsole());
    return dockEl;
  }

  function setTermState(text) {
    if (!dockEl) return;
    const el = dockEl.querySelector("#bv-term-state");
    if (el) el.textContent = text || "";
  }

  function setAgentState(text, busy) {
    if (!dockEl) return;
    const el = dockEl.querySelector("#bv-term-agent");
    if (!el) return;
    el.textContent = text || "idle";
    el.className = busy ? "bv-busy" : "";
  }

  // Put our own xterm in the dock. CheerpX never builds a console node for us
  // any more (1.3.9 has no XtermConsole), so this is parenting, not adoption.
  function mountConsole() {
    const c = STATE.console;
    if (!c || !c.el) return false;
    const body = dockEl && dockEl.querySelector("#bv-term-body");
    if (!body) return false;
    const fb = body.querySelector("#bv-term-fallback");
    if (fb) fb.classList.remove("bv-on");
    if (c.el.parentNode !== body) body.appendChild(c.el);
    fitConsole();
    return true;
  }

  function fitConsole() {
    const c = STATE.console;
    if (!c || !c.fit || !c.term) return;
    try {
      c.fit.fit();
    } catch (_) {
      /* the dock can be display:none, so there is nothing to measure yet */
    }
  }

  function focusConsole() {
    const t = STATE.console && STATE.console.term;
    if (!t) return;
    try {
      if (typeof t.focus === "function") t.focus();
    } catch (_) {
      /* no-op */
    }
  }

  // Transient in-dock warning. Used for the things that are genuinely lossy —
  // non-ASCII input, exec output that ran past the sentinel, etc. — so the user
  // is never quietly handed incomplete results.
  function setTermNote(text) {
    const body = dockEl && dockEl.querySelector("#bv-term-body");
    if (!body) return;
    let note = body.querySelector("#bv-term-note");
    if (!text) {
      if (note && note.parentNode) note.parentNode.removeChild(note);
      return;
    }
    if (!note) {
      note = document.createElement("div");
      note.id = "bv-term-note";
      body.appendChild(note);
    }
    note.textContent = text;
  }

  async function openTerminal() {
    const dock = ensureDock();
    dock.classList.add("bv-open");
    // Opening by any route re-arms auto-open for future chat switches.
    STATE.dismissed = false;
    clearAgentBadge();
    const btn = ensureBar().querySelector("#bv-vmbar-term");
    if (btn) btn.setAttribute("aria-expanded", "true");
    setTermState(STATE.ready ? "ready" : "booting…");
    if (!STATE.ready) {
      const fb = dock.querySelector("#bv-term-fallback");
      if (fb) {
        fb.classList.add("bv-on");
        fb.firstElementChild.textContent = "Booting the VM…";
      }
      await ensureBooted();
    }
    if (!mountConsole()) {
      const fb = dock.querySelector("#bv-term-fallback");
      if (fb) {
        fb.classList.add("bv-on");
        fb.firstElementChild.textContent = STATE.ready
          ? "No console available in this VM."
          : "VM unavailable.";
      }
      setTermState(STATE.ready ? "no console" : "unavailable");
      return;
    }
    setTermState("ready · " + (STATE.chatId || "").slice(0, 8));
    // Give xterm a frame to lay out before focusing, or the caret lands wrong.
    setTimeout(focusConsole, 60);
  }

  function closeTerminal() {
    if (dockEl) dockEl.classList.remove("bv-open");
    // Closing is a decision, so it always records one. There is no
    // "close but keep auto-opening" case: the only way back to auto-open is for
    // the user to open it again, or to switch chat.
    STATE.dismissed = true;
    const btn = ensureBar().querySelector("#bv-vmbar-term");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  async function toggleTerminal() {
    if (dockEl && dockEl.classList.contains("bv-open")) {
      closeTerminal();
    } else {
      await openTerminal();
    }
  }

  // Should the dock come up by itself? Only when the feature is on, a chat is
  // open, the agent is allowed to drive this terminal, and the user has not
  // just closed it. Everything else stays lazy.
  function shouldAutoOpen() {
    return !!(CFG.autoOpen && STATE.chatId && shareEnabled() && !STATE.dismissed);
  }

  function autoOpenTerminal() {
    if (!shouldAutoOpen()) return false;
    openTerminal();
    return true;
  }

  function setAgentBadge(n) {
    STATE.unseenAgentRuns = Math.max(0, n | 0);
    const bar = ensureBar();
    const badge = bar.querySelector("#bv-vmbar-badge");
    if (!badge) return;
    if (STATE.unseenAgentRuns > 0) {
      badge.textContent = STATE.unseenAgentRuns > 99 ? "99+" : String(STATE.unseenAgentRuns);
      badge.hidden = false;
      bar.querySelector("#bv-vmbar-term").classList.add("bv-busy");
    } else {
      badge.hidden = true;
      bar.querySelector("#bv-vmbar-term").classList.remove("bv-busy");
    }
  }

  function clearAgentBadge() {
    setAgentBadge(0);
  }

  // Called whenever the agent does something visible in the terminal. If the
  // dock is closed the output still lands in the xterm (and in the relay's
  // mirror for the native panel), so this only has to make it *discoverable*.
  function noteAgentActivity() {
    if (dockEl && dockEl.classList.contains("bv-open")) return;
    setAgentBadge(STATE.unseenAgentRuns + 1);
  }

  // Echo into the local tty so the agent's work is visible in the shared
  // scrollback instead of only in the chat bubble. Goes straight to xterm,
  // bypassing the sink, so it is not mirrored back to the relay — the relay
  // already has the exec_result frame.
  //
  // Deliberately does NOT touch the badge: one exec writes several lines here
  // (the [agent] banner, any stderr, the exit line), and the badge counts runs,
  // not writes. noteAgentActivity() is called once per exec in execRequest.
  function agentWrite(text) {
    const t = STATE.console && STATE.console.term;
    if (!t || typeof t.write !== "function") return;
    try {
      // Ensure proper line endings
      t.write(text.replace(/\n/g, "\r\n"));
    } catch (_) {
      /* no-op */
    }
  }

  // ── Composer chip: which terminal the agent may drive ──────────────────
  // OWUI's own terminal selector is gated on per-user settings that ship empty,
  // so the chat gets an explicit, always-visible control instead.
  const SHARE_KEY = "bv.shareWithAgent";

  // Sharing is now ALWAYS ON. The composer chip that used to toggle it was
  // removed (redundant with the hover bar's terminal toggles and OpenWebUI's
  // own terminal selector), so there is no UI to turn it off — and a stale
  // "0" from the old chip must not lock the agent out. Always true.
  function shareEnabled() {
    return true;
  }

  // Kept for API/back-compat (window.__owuiVm.setShare); the "off" direction is
  // a no-op now that sharing is always on. Clear any stale persisted "off".
  function setShare(_on) {
    try { localStorage.removeItem(SHARE_KEY); } catch (_) { /* private mode */ }
    connectRelay();
  }

  // The composer "Browser VM" chip (and its popup menu) was removed — it
  // duplicated the hover bar's terminal toggles and OpenWebUI's own terminal
  // selector, and its green label read as a redundant selector under the chat
  // box. Sharing is always on now (see shareEnabled), so there is nothing for it
  // to toggle. ensureChip() is kept as a no-op that sweeps away any chip a stale
  // cached loader may have left in the DOM. All the chip helpers (renderChip,
  // ensureMenu, toggleMenu, closeMenu, chipHost, isEditorSurface) were deleted.
  function ensureChip() {
    if (chipEl && typeof chipEl.remove === "function") {
      try { chipEl.remove(); } catch (_) { /* already detached */ }
    }
    chipEl = null;
    return null;
  }

  // ── Chat detection (OpenWebUI SPA) ─────────────────────────────────────
  function currentChatId() {
    const m = location.pathname.match(/^\/c\/([^/]+)/);
    if (m) return m[1];
    try {
      const stored = JSON.parse(localStorage.getItem("chat") || "null");
      if (stored && stored.id) return String(stored.id);
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function watchChat() {
    let last = currentChatId();
    setInterval(() => {
      const now = currentChatId();
      if (now !== last) {
        last = now;
        STATE.chatId = now;
        // Chat switched: the relay maps native-terminal traffic by chat_id, so
        // a stale open browser WS would bridge the wrong chat. Re-register.
        dropRelay();
        connectRelay();
        bootOnChatChange();
      }
    }, 800);
  }

  // The pod must be FRESH per chat (plan: fresh every time). Talking to a
  // different chat id through the old pod would violate isolation, so tear
  // down and re-boot whenever the route changes chats.
  async function bootOnChatChange() {
    if (STATE.booting) return;
    if (!STATE.chatId) {
      setBar("idle", "VM: no chat");
      return;
    }
    // A new chat is a new audience: whatever the user dismissed in the old one
    // was about that one. Reset the badge too, or it would carry a stale count
    // into a terminal that has never run anything.
    STATE.dismissed = false;
    clearAgentBadge();
    const wasReady = STATE.ready;
    if (STATE.ready) await teardown();
    if (wasReady || autoOpenTerminal()) {
      // Either the user already had a live pod, or auto-open is on. Either way
      // a pod is expected for this chat, so bring the terminal up now rather
      // than leaving an empty terminal on screen until the first command.
      // openTerminal() owns the boot, and it is the same call in both cases.
      await openTerminal();
    } else {
      // Otherwise stay lazy: don't stream the whole disk image on every chat
      // navigation. The pod boots the moment the dock asks (term:require) or
      // the agent runs a command.
      setBar("idle", "VM: " + STATE.chatId.slice(0, 8) + " (boot on demand)");
    }
  }

  // ── Adapters: real CheerpX vs mock (protocol testing) ──────────────────
  // The mock adapter makes the whole relay + tool + WS protocol testable in
  // plain browsers and headless WS clients without touching CheerpX.
  //
  // The CheerpX npm entry is an ES module with named exports; it never sets a
  // global. So the library is resolved by import() and cached, not sniffed off
  // `window`. The two globals below are pre-bundling hooks, checked first so a
  // page that already ships CheerpX/xterm does not pay for a second download —
  // and so the headless test can drive the identical code path.
  async function loadCheerpX() {
    if (STATE.cxLib) return STATE.cxLib;
    let mod = null;
    if (window.__BROWSER_VM_CHEERPX) mod = window.__BROWSER_VM_CHEERPX;
    else mod = await import(/* webpackIgnore: true */ CFG.cheerpxUrl);
    // Tolerate a CJS default wrapper, but do not paper over a shape we cannot
    // drive: a half-present library would boot a pod with no way to read it.
    const lib = mod && mod.Linux ? mod : mod && mod.default ? mod.default : mod;
    if (!lib || !lib.Linux || !lib.CloudDevice) {
      throw new Error("CheerpX module loaded but exposes no Linux/CloudDevice");
    }
    STATE.cxLib = lib;
    return lib;
  }

  async function loadXterm() {
    if (STATE.xtermLib) return STATE.xtermLib;
    let Terminal = null;
    let FitAddon = null;
    if (window.__BROWSER_VM_XTERM) {
      Terminal = window.__BROWSER_VM_XTERM.Terminal;
      FitAddon = window.__BROWSER_VM_XTERM.FitAddon;
    } else {
      const mods = await Promise.all([
        import(/* webpackIgnore: true */ CFG.xtermUrl),
        import(/* webpackIgnore: true */ CFG.xtermFitUrl),
      ]);
      Terminal = mods[0].Terminal;
      FitAddon = mods[1].FitAddon;
    }
    if (!Terminal) throw new Error("xterm.js failed to load (no Terminal export)");
    STATE.xtermLib = { Terminal: Terminal, FitAddon: FitAddon || null };
    return STATE.xtermLib;
  }

  async function resolveAdapter() {
    if (window.__BROWSER_VM_FORCE_MOCK) return makeMockAdapter();
    
    if (currentTerminalType === "docker") {
      return await makeDockerAdapter();
    }
    
    try {
      await loadCheerpX();
      return await makeCheerpxAdapter();
    } catch (e) {
      // Hard failure, on purpose. The mock must NEVER be an automatic fallback:
      // it answers exec() with "[mock] <cmd>" and exit 0, so the agent reports
      // success for commands that never ran while the UI looks alive — the very
      // bug that hid this integration for weeks. A test fixture is not a
      // fallback. When the real VM cannot load, the honest answer is that there
      // is no VM. (The Sep-28 edit re-introduced the mock fallback here; this
      // restores makeFailedAdapter, and the smoke test guards it.)
      console.error("[browser-vm] CheerpX unavailable, VM disabled:", e);
      return makeFailedAdapter(e);
    }
  }

  // Stands in for the adapter when CheerpX cannot be loaded and the mock was
  // not explicitly requested. Nothing here pretends to work: exec() reports a
  // non-zero exit and the reason, so the truth reaches the agent through
  // exec_result and it can tell the user instead of claiming a command ran.
  function makeFailedAdapter(err) {
    const why = String((err && err.message) || err || "unknown error");
    const msg = "browser VM unavailable: " + why;
    STATE.failedReason = msg;
    console.error("[browser-vm] " + msg);
    setBar("error", "VM: " + msg);
    return {
      name: "failed",
      failed: true,
      async init() {
        STATE.ready = false;
        setBar("error", "VM: " + msg);
      },
      async exec() {
        return { exit: 127, stdout: "", stderr: msg };
      },
      async reset() {
        setBar("error", "VM: " + msg);
      },
      writeTerm() {
        /* no VM, so no tty */
      },
    };
  }

  function makeMockAdapter() {
    console.warn("[browser-vm] using MOCK adapter (forced by __BROWSER_VM_FORCE_MOCK)");
    return {
      name: "mock",
      async init(chatId) {
        setBar("booting", "VM(mock): " + chatId.slice(0, 8));
        await sleep(300);
        STATE.ready = true;
        setBar("ready", "VM(mock): " + chatId.slice(0, 8) + " ready");
      },
      async exec(cmd, opts) {
        const t0 = Date.now();
        await sleep(50);
        return {
          exit: 0,
          stdout: "[mock] " + cmd + " (ran for " + (Date.now() - t0) + "ms)\n",
          stderr: "",
        };
      },
      async reset() {
        STATE.ready = false;
        await STATE.pubAdapter.init(STATE.chatId);
      },
      writeTerm() {
        /* mock has no terminal */
      },
    };
  }

  // ── Console keycodes ────────────────────────────────────────────────────
  // CheerpX 1.3.9's setCustomConsole() does not take bytes. It returns a
  // handler that takes a *legacy DOM keyCode* — that is exactly what CheerpX's
  // own built-in console posts, from its `keypress` listener (`~~event.keyCode`)
  // plus a `keydown` special case for backspace. So the wire format between
  // our xterm and the guest tty is keycodes, and this is the translation table.
  //
  // xterm speaks VT sequences (onData); a keypress channel is one byte wide.
  // Greedy longest-match at scan time, so "\x1b[A" is Up rather than
  // Escape-then-"[A".
  const KEY_SEQS = {
    // arrows, normal and application-cursor-mode
    "\x1bOA": 38,
    "\x1bOB": 40,
    "\x1bOC": 39,
    "\x1bOD": 37,
    "\x1b[A": 38,
    "\x1b[B": 40,
    "\x1b[C": 39,
    "\x1b[D": 37,
    // home / end
    "\x1bOH": 36,
    "\x1bOF": 35,
    "\x1b[H": 36,
    "\x1b[F": 35,
    "\x1b[1~": 36,
    "\x1b[4~": 35,
    // insert / delete, page up / page down. Note 33 and 46 are each shared by
    // two keys in the DOM keyCode space (Insert/PgUp, Delete/PgDn) — that is
    // upstream's collision, and matching it is the correct thing to do.
    "\x1b[2~": 33,
    "\x1b[3~": 46,
    "\x1b[5~": 33,
    "\x1b[6~": 46,
    // shift+tab is not expressible; degrade to tab rather than lose the keypress
    "\x1b[Z": 9,
  };
  // Single characters are deliberately NOT in this table: printable ASCII and
  // C0 controls pass through unchanged, and the handful that need rewriting
  // (\n -> Enter, DEL -> Backspace) are handled in the scanner below. Keeping
  // them out of the table is what stops \n being read as Ctrl+J.
  const KEY_SEQS_BY_LEN = Object.keys(KEY_SEQS).sort((a, b) => b.length - a.length);

  // Returns {codes, skipped}. `skipped` counts input we could not represent —
  // non-ASCII, which has no single-byte keycode. Dropping it is the honest
  // option; inventing a code would corrupt the user's command line.
  function textToKeycodes(text) {
    const s = text == null ? "" : String(text);
    const codes = [];
    let skipped = 0;
    let i = 0;
    while (i < s.length) {
      const code = s.charCodeAt(i);
      if (code === 0x1b) {
        // Longest match, so "\x1b[A" is Up rather than Escape-then-"[A".
        let hit = null;
        for (const seq of KEY_SEQS_BY_LEN) {
          if (seq.length > 1 && s.startsWith(seq, i)) {
            hit = seq;
            break;
          }
        }
        if (hit) {
          codes.push(KEY_SEQS[hit]);
          i += hit.length;
          continue;
        }
        codes.push(27);
        i++;
        continue;
      }
      // Enter arrives as \r from most clients and \n from some; both mean the
      // same keypress, and a keypress listener would have reported 13.
      if (code === 0x0a) {
        codes.push(13);
      } else if (code === 0x7f) {
        codes.push(8); // DEL is how most terminals send Backspace
      } else if (code < 0x80) {
        // Printable ASCII and C0 controls (so Ctrl+A -> 1) both pass through
        // unchanged, which is what a keypress listener would have reported.
        codes.push(code);
      } else {
        skipped++;
      }
      i++;
    }
    return { codes: codes, skipped: skipped };
  }

  const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
  function stripAnsi(s) {
    return String(s).replace(ANSI_RE, "");
  }

  function shQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  // ── Output sink ─────────────────────────────────────────────────────────
  // setCustomConsole() delivers VM output ONE BYTE PER CALL. Writing that
  // straight into xterm would be a write() per byte, so bytes are buffered and
  // flushed in batches, and decoded as a *stream* because a multi-byte UTF-8
  // character routinely straddles two callbacks.
  function makeOutputSink() {
    let bytes = [];
    let timer = null;
    const decoder = new TextDecoder("utf-8");
    const cap = { on: false, buf: "" };

    function flush() {
      timer = null;
      if (!bytes.length) return;
      const chunk = decoder.decode(new Uint8Array(bytes), { stream: true });
      bytes = [];
      if (!chunk) return;
      if (cap.on) cap.buf += chunk;
      const t = STATE.console && STATE.console.term;
      if (t) {
        try {
          t.write(chunk);
        } catch (_) {
          /* a torn-down terminal must not stall the VM's output path */
        }
      }
      sendTerminalOutput(chunk);
    }

    return {
      write(buf) {
        if (!buf) return;
        if (typeof buf === "string") {
          for (let i = 0; i < buf.length; i++) bytes.push(buf.charCodeAt(i) & 0xff);
        } else {
          for (let i = 0; i < buf.length; i++) bytes.push(buf[i] & 0xff);
        }
        if (bytes.length >= CFG.flushBytes) {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          flush();
          return;
        }
        if (timer === null) timer = setTimeout(flush, 0);
      },
      flush: flush,
      // exec() has no other way to see the command's output — run() returns
      // only {status} and there is no stdout stream anywhere in 1.3.9 — so it
      // borrows the console between two OSC sentinels.
      beginCapture() {
        flush();
        cap.on = true;
        cap.buf = "";
      },
      // Non-destructive, because the exec poll has to look at the same growing
      // buffer repeatedly while it waits for the closing marker.
      readCapture() {
        flush();
        return cap.buf;
      },
      endCapture() {
        flush();
        cap.on = false;
        return cap.buf;
      },
    };
  }

  // Create the dock's xterm ONCE, adapter-agnostic. Both the WebVM and Docker
  // adapters attach to this same console, so switching between them keeps one
  // terminal and one scrollback instead of disposing and rebuilding it — which
  // is what left the WebVM dead after a round-trip through Docker: the switch
  // tore down the console the other adapter had just started writing to.
  async function ensureConsole() {
    if (STATE.console && STATE.console.term) return STATE.console;
    const lib = await loadXterm();
    const dock = ensureDock();
    const host = dock.querySelector("#bv-term-xterm");
    if (!host) throw new Error("terminal host missing from dock");
    const term = new lib.Terminal({
      convertEol: true,  // Properly handle \r\n -> \n conversion
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: { background: "#000000" },
      scrollback: 5000,
      allowTransparency: true,
      rightClickSelectsWord: true,
      lineHeight: 1.45,
      letterSpacing: 0,
    });
    let fit = null;
    if (lib.FitAddon) {
      // Both modules export the class directly ({ Terminal }, { FitAddon }) —
      // there is no namespace to unwrap.
      fit = new lib.FitAddon();
      term.loadAddon(fit);
    }
    term.open(host);
    const sink = makeOutputSink();
    const con = { el: host, term: term, fit: fit, sink: sink, send: null };
    STATE.console = con;
    if (dockEl.classList.contains("bv-open")) mountConsole();
    // Input routing follows the ACTIVE adapter, so a terminal switch re-points
    // keystrokes without re-wiring the terminal. The user's keystrokes and the
    // native panel's keystrokes take the exact same path from here.
    term.onData((data) => {
      if (STATE.pubAdapter && typeof STATE.pubAdapter.writeTerm === "function") {
        STATE.pubAdapter.writeTerm(data);
      }
    });
    return con;
  }

  // WebVM-specific: attach the shared console to a CheerpX pod's tty. CheerpX
  // 1.3.9 exposes output only through setCustomConsole(), so this wires the
  // pod's bytes into the shared sink and keeps the returned keycode handler.
  async function attachConsole(cx) {
    const con = await ensureConsole();
    // Attach BEFORE run(): the shell's first prompt would otherwise go to a
    // console that is not listening yet and be lost. Re-arms the sink on a
    // reused console (e.g. after a Docker round-trip).
    con.send = cx.setCustomConsole(con.sink.write, con.term.cols || 80, con.term.rows || 24);
    return con;
  }

  async function makeCheerpxAdapter() {
    const lib = STATE.cxLib;
    // exec() drives the one shared tty by typing sentinels around the command,
    // so two concurrent execs would interleave and each would capture the
    // other's output. The agent can absolutely fire commands back to back, so
    // they are serialised here rather than in the relay.
    let execQueue = Promise.resolve();
    const enqueue = (job) => {
      const run = execQueue.then(job, job); // run even if the last one threw
      execQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };

    return {
      name: "cheerpx",

      async init(chatId) {
        setBar("booting", "VM: " + chatId.slice(0, 8) + " booting…");
        // HttpBytesDevice + IDBDevice + OverlayDevice. The overlay provides a
        // writable memory-only layer on top of the read-only disk image.
        // IDBDevice requires a non-empty name in CheerpX 1.3.9.
        const imageUrl = new URL(CFG.imageWs.replace("wss://", "https://"), location.origin).href;
        console.log("[browser-vm] loading disk image from:", imageUrl);
        const httpDevice = await lib.HttpBytesDevice.create(imageUrl);
        console.log("[browser-vm] httpDevice created:", httpDevice);
        if (!httpDevice) throw new Error("HttpBytesDevice.create returned undefined");
        const memOverlay = await lib.IDBDevice.create("block1");
        console.log("[browser-vm] memOverlay created:", memOverlay);
        if (!memOverlay) throw new Error("IDBDevice.create returned undefined");
        const overlayDevice = await lib.OverlayDevice.create(httpDevice, memOverlay);
        console.log("[browser-vm] overlayDevice created:", overlayDevice);
        if (!overlayDevice) throw new Error("OverlayDevice.create returned undefined");
        const mounts = [{ type: "ext2", path: "/", dev: overlayDevice }];

        // 1.3.9 takes `networkInterface`, not `network`, and an object — the
        // old `network: true` was silently ignored. Default is no network at
        // all: this is a sandbox, and egress should be an explicit opt-in via
        // window.__BROWSER_VM = { network: { authKey: "…" } }.
        // Only pass networkInterface when explicitly configured — passing
        // undefined causes CheerpX to throw "Cannot read properties of
        // undefined (reading 'hasOwnProperty')" in the HW init path.
        const createOpts = {};
        if (CFG.network && typeof CFG.network === "object") {
          createOpts.networkInterface = CFG.network;
        }

        let cx;
        try {
          // /proc and /dev are what make the shell usable — ps, /dev/null
          // redirects, tty handling. A build that rejects them should still
          // yield a bootable root rather than nothing, so fall back to the
          // root-only mount set. (Sep-28 dropped these mounts entirely.)
          cx = await lib.Linux.create({
            mounts: mounts.concat([
              { type: "proc", path: "/proc" },
              { type: "devs", path: "/dev" },
            ]),
            ...createOpts,
          });
        } catch (e) {
          console.warn("[browser-vm] full mount set rejected, retrying with / only:", e);
          try {
            cx = await lib.Linux.create({ mounts: mounts, ...createOpts });
          } catch (e2) {
            console.warn("[browser-vm] Linux.create failed:", e2);
            setBar("error", "VM: Linux.create failed — " + (e2 && e2.message ? e2.message : e2));
            throw e2;
          }
        }
        STATE.cx = cx;

        await attachConsole(cx);
        STATE.ready = true;
        setBar("ready", "VM: " + chatId.slice(0, 8) + " ready");

        // run() resolves when the process exits, and an interactive shell does
        // not exit — so this is deliberately not awaited. Awaisting it would
        // hang init() forever and the dock would never finish booting.
        cx.run("/bin/sh", ["-i"], {
          cwd: "/",
          env: [
            "HOME=/root",
            "USER=root",
            "SHELL=/bin/sh",
            "TERM=xterm-256color",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          ],
        }).catch((e) => {
          // Only reachable if the pod dies; a clean exit is a user typing `exit`.
          if (e) console.warn("[browser-vm] shell ended:", e);
        });

        // The dock may already be open (user clicked the icon before the pod
        // finished booting); adopt the console as soon as it exists.
        if (dockEl && dockEl.classList.contains("bv-open")) {
          mountConsole();
          setTermState("ready · " + chatId.slice(0, 8));
          setTimeout(focusConsole, 60);
        }
      },

      // exec: there is no spawn(), no getStdout(), and no stdin in 1.3.9. The
      // only channel that carries bytes in both directions is the console, so
      // we *type* the command into the shared tty and read it back between two
      // OSC 999 sentinels that xterm swallows (unknown OSC = no output).
      async exec(cmd, opts) {
        return enqueue(() => runExec(cmd, opts));
      },

      // Plan §6 freshness: teardown cx and re-create everything pristine.
      async reset() {
        STATE.ready = false;
        setBar("booting", "VM: resetting…");
        await teardown();
        await ensureBooted();
      },

      // Stop the pod for a terminal SWITCH: delete the CheerpX worker but keep
      // the shared xterm alive so the next adapter can reuse it. (reset() above
      // disposes the console; that is wrong when we are handing the same
      // terminal to Docker.)
      async detach() {
        STATE.ready = false;
        const cx = STATE.cx;
        STATE.cx = null;
        if (cx && typeof cx.delete === "function") {
          try { cx.delete(); } catch (_) { /* best effort */ }
        }
      },

      // Keystrokes from the native "Open Terminal" panel, or from our own
      // xterm's onData. Both land here, so there is one translation path.
      writeTerm(data, enc) {
        // Decode base64 envelopes back to the raw byte string.
        let text = data;
        if (enc === "b64") {
          try {
            text = b64ToBinary(data);
          } catch (_) {
            return; // malformed frame: drop it rather than kill the handler
          }
        }
        const con = STATE.console;
        if (!con || !con.send) return;
        const parsed = textToKeycodes(text);
        if (parsed.skipped) {
          setTermNote(
            parsed.skipped +
              (parsed.skipped === 1 ? " character was" : " characters were") +
              " dropped: this VM console takes one-byte keycodes, so non-ASCII input is not expressible.",
          );
        }
        for (const kc of parsed.codes) {
          try {
            con.send(kc);
          } catch (_) {
            /* pod died mid-keystroke; the relay will report the session as gone */
          }
        }
      },

      resizing(cols, rows) {
        const con = STATE.console;
        if (!con) return;
        if (con.term) {
          try {
            con.term.resize(cols, rows);
          } catch (_) {
            /* best effort; the guest redraws on the next prompt */
          }
        }
        // setCustomConsole is also the resize channel: it posts the new geometry
        // to the worker, so re-calling it (and keeping the handler it returns)
        // is how the guest learns the terminal changed size.
        if (STATE.cx && con.send) {
          try {
            con.send = STATE.cx.setCustomConsole(con.sink.write, cols, rows);
          } catch (_) {
            /* keep the previous handler rather than lose input entirely */
          }
        }
      },
    };

    // ── exec: the only way to read output ────────────────────────────
    // There is no spawn(), no getStdout() and no stdin in 1.3.9, and
    // run() resolves with {status} only. So the command is *typed* into
    // the shared tty between two OSC 999 sentinels — xterm swallows an
    // unknown OSC code, so the markers are invisible to the user and
    // never reach the relay mirror.
    async function runExec(cmd, opts) {
      // The original cwd is saved and put back, so an exec cannot leave the
      // user's interactive shell somewhere they did not ask to be.
      const con = STATE.console;
      if (!STATE.cx || !con || !con.send) {
        return { exit: -1, stdout: "", stderr: "pod not booted" };
      }
      const token = Math.random().toString(36).slice(2, 10);
      const half = token.slice(0, 4);
      const rest = token.slice(4);
      const begin = "\x1b]999;bv" + token + "-b\x07";
      const endRe = new RegExp("\x1b\\]999;bv" + token + "-e:(-?\\d+)\x07");
      const cwd = (opts && opts.cwd) || "/root";

      // The token is assembled from two arguments so the *echo* of the typed
      // line can never contain it — otherwise we would match our own echo
      // instead of the printf output and capture nothing. No trailing
      // newline here: the caller owns the line terminator, and `extra` (the
      // exit code argument) has to land on the same line as the format.
      const marker = (tag, extra) =>
        "printf '\\033]999;bv%s%s" + tag + "\\007' " + shQuote(half) + " " + shQuote(rest) + (extra || "");

      // Order matters. `stty -echo` stops the tty reflecting what we type, and
      // blanking PS1 keeps the shell's own prompts out of the captured text.
      // The command goes in bare — no braces, no subshell — so a command
      // containing an unbalanced } or ) cannot break the wrapper. The
      const script = [
        "stty -echo\n",
        '__bvps1="$PS1"; __bvcd="$PWD"; PS1=""; PS2=""\n',
        marker("-b") + "\n",
        "cd " + shQuote(cwd) + " 2>/dev/null\n",
        String(cmd) + "\n",
        "__bvrc=$?\n",
        marker("-e", '"$__bvrc"') + "\n",
        // The trailing newline is load-bearing. Without it the shell is left
        // holding this line *unexecuted* on the command line, so the cwd, PS1
        // and tty echo were never put back and every agent command silently
        // relocated the user's own shell.
        'cd "$__bvcd" 2>/dev/null; PS1="$__bvps1"; stty echo\n',
      ].join("");

      con.sink.beginCapture();
      try {
        await typeIntoTty(script);
      } catch (e) {
        con.sink.endCapture();
        restoreTty();
        return { exit: -1, stdout: "", stderr: String(e && e.message ? e.message : e) };
      }

      // Poll the same growing buffer for the closing sentinel rather than
      // assuming one round-trip is enough: the tty is asynchronous and a
      // command that never ends must still hit the caller's deadline.
      const deadline = Date.now() + ((opts && opts.timeout_ms) || 30000);
      let text = "";
      let sawBegin = false;
      let matched = null;
      for (;;) {
        const raw = con.sink.readCapture();
        const i = raw.indexOf(begin);
        if (i >= 0) {
          sawBegin = true;
          const rest = raw.slice(i + begin.length);
          matched = endRe.exec(rest);
          if (matched) {
            text = rest.slice(0, matched.index);
            break;
          }
          text = rest;
        }
        if (Date.now() > deadline) break;
        await sleep(50);
      }
      con.sink.endCapture();
      // Only on the paths where the script's own restore line did not run. On
      // success it already put back the cwd, PS1 and tty echo, and calling
      // restoreTty() again would fire a Ctrl+C at a healthy shell — printing a
      // bare `^C` into the user's terminal after every single agent command.
      // A missing end marker means the shell may be mid-command, and that is
      // exactly when the interrupt is wanted.
      if (!matched) restoreTty();

      if (!sawBegin) {
        return {
          exit: -1,
          stdout: "",
          stderr: "no output captured — the shell may not be ready yet",
        };
      }
      if (!matched) {
        setTermNote("exec output was cut off before the end marker");
        return {
          exit: -1,
          stdout: stripAnsi(text).replace(/\r/g, ""),
          stderr: "command did not finish (timed out)",
        };
      }
      setTermNote(null);
      // A tty has one stream, so stdout and stderr are interleaved exactly as
      // the user sees them. Reporting them merged is honest; pretending to
      // split them would be a lie the model then reasons from.
      // Normalize line endings: replace \r\n and lone \r with \n
      const normalized = stripAnsi(text).replace(/\r\n?/g, "\n");
      return {
        exit: Number(matched[1]),
        stdout: normalized,
        stderr: "",
      };
    }

    // Type a script into the tty, one keycode at a time, yielding after each
    // newline so the shell has a chance to consume the line.
    async function typeIntoTty(script) {
      const con = STATE.console;
      if (!con || !con.send) throw new Error("no console");
      const parsed = textToKeycodes(script);
      for (let i = 0; i < parsed.codes.length; i++) {
        const kc = parsed.codes[i];
        try {
          con.send(kc);
        } catch (_) {
          /* keep going: a dropped key is better than a hung exec */
        }
        if (kc === 13) await sleep(0);
      }
    }

    // Unconditionally put the tty back the way we found it. Idempotent, so
    // calling it after a normal exec and again after a timeout is fine —
    // which matters, because a timeout that left `stty -echo` in place would
    // leave the user typing into a terminal that never echoes. It also restores
    // the cwd and PS1, because a command that hung never reached the script's
    // own restore line.
    function restoreTty() {
      const con = STATE.console;
      if (!con || !con.send) return;
      const parsed = textToKeycodes('\x03cd "$__bvcd" 2>/dev/null; PS1="$__bvps1"; stty echo\n');
      for (const kc of parsed.codes) {
        try {
          con.send(kc);
        } catch (_) {
          /* nothing left to do */
        }
      }
    }
  }

  // ── Docker Terminal Adapter (Terminals Orchestrator) ───────────────────
  // Connects to OpenWebUI's Terminals orchestrator via WebSocket proxy
  async function makeDockerAdapter() {
    let dockerWs = null;
    let dockerSessionId = null;
    let dockerExecQueue = Promise.resolve();
    const dockerEnqueue = (job) => {
      const run = dockerExecQueue.then(job, job);
      dockerExecQueue = run.then(() => undefined, () => undefined);
      return run;
    };

    // Docker-specific helpers — declared BEFORE the returned object so its
    // methods can reach them. They used to sit after `return {…}`, i.e. dead
    // code: the `let`/`const` never initialised, so init() threw
    // "Cannot access 'dockerKeepalive' before initialization" (TDZ) and exec()
    // would have thrown the same for runDockerExec.
    let dockerKeepalive = null;

    async function teardownDocker() {
      if (dockerKeepalive) clearInterval(dockerKeepalive);
      if (dockerWs) {
        try { dockerWs.close(); } catch (_) {}
        dockerWs = null;
      }
      dockerSessionId = null;
    }

    const runDockerExec = async (cmd, opts) => {
      // Agent exec runs SERVER-SIDE in the container relay, which captures the
      // command's output via sentinels (DockerSession.run) — reached through the
      // OpenWebUI proxy at /api/cmd. Typing straight into the interactive PTY
      // (the old behaviour) could not capture output and would corrupt what the
      // user is typing; the server-side run is isolated from the live tty.
      const token = localStorage.getItem("token") ?? "";
      const base = window.location.origin;
      const cid = STATE.chatId || currentChatId();
      if (!cid) return { exit: -1, stdout: "", stderr: "no chat context" };
      try {
        const res = await fetch(`${base}/api/v1/terminals/docker-term/api/cmd`, {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "X-Session-Id": cid,
          },
          body: JSON.stringify({
            chat_id: cid,
            command: String(cmd),
            cwd: (opts && opts.cwd) || "/root",
            timeout_ms: (opts && opts.timeout_ms) || 30000,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { exit: -1, stdout: "", stderr: data.message || ("docker exec failed: " + res.status) };
        }
        return {
          exit: typeof data.exit === "number" ? data.exit : 0,
          stdout: data.stdout || "",
          stderr: data.stderr || "",
        };
      } catch (e) {
        return { exit: -1, stdout: "", stderr: String(e && e.message ? e.message : e) };
      }
    };

    return {
      name: "docker",

      async init(chatId) {
        setBar("booting", "Docker: " + chatId.slice(0, 8) + " connecting…");

        // The Docker adapter shares the dock's xterm with the WebVM adapter, so
        // make sure it exists (and is mounted) before wiring output into it —
        // otherwise onmessage has no term to write to and nothing appears.
        await ensureConsole();
        if (dockEl && dockEl.classList.contains("bv-open")) mountConsole();

        // Create terminal session via OpenWebUI proxy
        const token = localStorage.getItem("token") ?? "";
        // Use OpenWebUI's terminal proxy: /terminals/{server_id}/api/terminals
        const baseUrl = window.location.origin;

        try {
          // Create session
          const createRes = await fetch(`${baseUrl}/api/v1/terminals/docker-term/api/terminals`, {
            method: "POST",
            headers: { 
              "Authorization": "Bearer " + token,
              "Content-Type": "application/json",
              "X-Session-Id": chatId
            }
          });
          if (!createRes.ok) throw new Error("Failed to create session: " + createRes.status);
          const session = await createRes.json();
          dockerSessionId = session.id;

          // Connect WebSocket via OpenWebUI proxy
          const wsBase = baseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
          const wsUrl = `${wsBase}/api/v1/terminals/docker-term/api/terminals/${dockerSessionId}`;
          dockerWs = new WebSocket(wsUrl);
          dockerWs.binaryType = "arraybuffer";

          dockerWs.onopen = () => {
            // First-message auth. chat_id is REQUIRED: OpenWebUI's terminal proxy
            // reads it from this frame (payload.get('chat_id')) and forwards it to
            // the relay as X-Session-Id. Without it the relay gets an empty chat
            // context, closes the session before bridging, and the terminal is
            // dead — exactly the "unresponsive Docker terminal" symptom.
            dockerWs.send(JSON.stringify({ type: "auth", token, chat_id: chatId }));
          };

          dockerWs.onmessage = (ev) => {
            if (STATE.console && STATE.console.term) {
              if (ev.data instanceof ArrayBuffer) {
                STATE.console.term.write(new Uint8Array(ev.data));
              } else {
                STATE.console.term.write(ev.data);
              }
            }
          };

          dockerWs.onclose = () => {
            STATE.ready = false;
            setBar("idle", "Docker: disconnected");
          };

          dockerWs.onerror = () => {
            setBar("error", "Docker: connection error");
          };

          // Wait for connection
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Docker connection timeout")), 15000);
            const check = () => {
              if (dockerWs && dockerWs.readyState === WebSocket.OPEN) {
                clearTimeout(timeout);
                resolve();
              } else if (!dockerWs || dockerWs.readyState === WebSocket.CLOSED) {
                clearTimeout(timeout);
                reject(new Error("Docker WebSocket closed"));
              } else {
                setTimeout(check, 50);
              }
            };
            check();
          });

          // Send initial resize
          if (STATE.console && dockerWs) {
            dockerWs.send(JSON.stringify({ 
              type: "resize", 
              cols: STATE.console.term.cols, 
              rows: STATE.console.term.rows 
            }));
          }

          // Setup keepalive
          if (dockerKeepalive) clearInterval(dockerKeepalive);
          dockerKeepalive = setInterval(() => {
            if (dockerWs && dockerWs.readyState === WebSocket.OPEN) {
              dockerWs.send(JSON.stringify({ type: "ping" }));
            }
          }, 25000);

          STATE.ready = true;
          setBar("ready", "Docker: " + chatId.slice(0, 8) + " ready");
        } catch (e) {
          console.warn("[docker-term] init failed:", e);
          setBar("error", "Docker: " + (e.message || e));
          throw e;
        }
      },

      async exec(cmd, opts) {
        return dockerEnqueue(() => runDockerExec(cmd, opts));
      },

      async reset() {
        STATE.ready = false;
        setBar("booting", "Docker: resetting…");
        await teardownDocker();
        await ensureBooted();
      },

      // Stop the Docker session for a terminal SWITCH: close the socket but keep
      // the shared xterm alive for the next adapter.
      async detach() {
        STATE.ready = false;
        await teardownDocker();
      },

      writeTerm(data, enc) {
        let text = data;
        if (enc === "b64") {
          try {
            text = b64ToBinary(data);
          } catch (_) { return; }
        }
        if (dockerWs && dockerWs.readyState === WebSocket.OPEN) {
          dockerWs.send(text);
        }
      },

      resizing(cols, rows) {
        if (dockerWs && dockerWs.readyState === WebSocket.OPEN) {
          dockerWs.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      },
    };
  }

  // ── Boot / teardown ────────────────────────────────────────────────────
  async function ensureBooted() {
    if (STATE.ready || STATE.booting) return;
    if (!STATE.chatId) return;
    STATE.booting = true;
    try {
      STATE.pubAdapter = await resolveAdapter();
      await STATE.pubAdapter.init(STATE.chatId);
      connectRelay();
    } catch (e) {
      // Logged as well as shown: the bar is one line of text that a caller can
      // immediately overwrite, and a boot failure that vanishes is exactly how
      // this integration stayed broken for months.
      console.error("[browser-vm] boot failed:", e);
      setBar("error", "VM boot failed: " + (e && e.message ? e.message : e));
    } finally {
      STATE.booting = false;
    }
  }

  async function teardown() {
    STATE.ready = false;
    const cx = STATE.cx;
    STATE.cx = null;
    const con = STATE.console;
    STATE.console = null;
    if (con) {
      // Empty the host, but keep the host itself. `#bv-term-xterm` is permanent
      // dock markup (see ensureDock), not something the xterm owns — unparenting
      // it here used to leave the dock structurally broken after a single
      // reset, so the next attachConsole() found no host and the pod never came
      // back. Only the xterm's own child element goes; the host stays.
      if (con.el) {
        try {
          while (con.el.firstChild) con.el.removeChild(con.el.firstChild);
        } catch (_) {
          /* already detached */
        }
      }
      // Flush whatever the pod emitted before we let go of the sink, then stop
      // mirroring: a dead pod must not keep writing to a live terminal.
      try {
        con.sink.flush();
      } catch (_) {
        /* best effort */
      }
      if (con.term && typeof con.term.dispose === "function") {
        try {
          con.term.dispose();
        } catch (_) {
          /* xterm may already be gone with its element */
        }
      }
    }
    setTermNote(null);
    if (cx) {
      try {
        // 1.3.9 spells teardown `delete()`. There is no close() and no
        // destroy() — the old fallbacks silently did nothing, leaking the
        // worker and the whole disk image on every reset.
        if (typeof cx.delete === "function") cx.delete();
        else if (cx.close) await cx.close();
      } catch (_) {
        /* best-effort shutdown */
      }
    }
  }

  async function resetVm() {
    if (STATE.pubAdapter) {
      setBar("booting", "VM: reset…");
      try {
        await STATE.pubAdapter.reset();
        // Check the outcome rather than assuming it. ensureBooted() swallows
        // boot errors and reports them on the bar itself, so a reset that
        // silently failed used to be announced here as "fresh" — the user saw
        // success and a dead terminal.
        if (STATE.ready) {
          setBar("ready", "VM: " + (STATE.chatId || "").slice(0, 8) + " fresh");
        } else if (barEl && barEl.classList.contains("bv-error")) {
          // Leave the boot error on the bar; it is more specific than "reset
          // failed" and names the real cause.
          console.error("[browser-vm] reset did not produce a ready pod");
        } else {
          setBar("error", "reset failed: the VM did not come back");
        }
      } catch (e) {
        setBar("error", "reset failed: " + (e && e.message ? e.message : e));
      }
    } else {
      await ensureBooted();
    }
  }

  // ── Relay WebSocket ────────────────────────────────────────────────────
  function relayUrl() {
    const sep = CFG.relay.includes("?") ? "&" : "?";
    const tok = CFG.token ? sep + "token=" + encodeURIComponent(CFG.token) : "";
    return CFG.relay + "/vm?chat_id=" + encodeURIComponent(STATE.chatId || "") + tok;
  }

  async function connectRelay() {
    if (!STATE.chatId) return;
    // The /vm-bridge relay is the agent<->browser bridge: the agent's exec is
    // delivered here and dispatched to whichever terminal is ACTIVE (execRequest
    // -> STATE.pubAdapter.exec), so it must stay connected for BOTH WebVM and
    // Docker — the browser is the router. (The Docker adapter's exec then runs
    // server-side in the container relay; see runDockerExec.)
    // Chip is off: stay unregistered so the agent gets an explicit
    // no_browser instead of silently sharing a VM the user disabled.
    if (!shareEnabled()) return;
    if (STATE.ws && (STATE.ws.readyState === WebSocket.OPEN || STATE.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    let ws;
    try {
      ws = new WebSocket(relayUrl());
    } catch (e) {
      setBar("error", "WS failed");
      return;
    }
    STATE.ws = ws;
    ws.addEventListener("open", () => {
      STATE.backoff = 0;
      ws.send(JSON.stringify({ type: "register", chat_id: STATE.chatId, client: "loader-1.0" }));
    });
    ws.addEventListener("message", (ev) => handleMessage(ev.data));
    ws.addEventListener("close", () => {
      if (STATE.ws === ws) {
        STATE.ws = null;
        scheduleReconnect();
      }
    });
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch (_) {
        /* ignore */
      }
    });
  }

  function scheduleReconnect() {
    STATE.backoff = Math.min(STATE.backoff ? STATE.backoff * 2 : 1000, 15000);
    if (STATE.reconnectTimer) clearTimeout(STATE.reconnectTimer);
    STATE.reconnectTimer = setTimeout(() => {
      STATE.reconnectTimer = null;
      connectRelay();
    }, STATE.backoff);
  }

  // Hard-drop the browser socket without scheduling a reconnect. Used when the
  // active chat changes: the relay keys native-terminal traffic by chat_id, so
  // a socket still bound to the previous chat would bridge the wrong pod.
  // Any later need for a socket re-enters through connectRelay().
  function dropRelay() {
    if (STATE.reconnectTimer) {
      clearTimeout(STATE.reconnectTimer);
      STATE.reconnectTimer = null;
    }
    STATE.backoff = 0;
    const ws = STATE.ws;
    STATE.ws = null;
    if (ws) {
      try {
        ws.onclose = null;
        ws.close();
      } catch (_) {
        /* already closing/closed */
      }
    }
  }

  function handleMessage(data) {
    const text = typeof data === "string" ? data : data.data;
    let msg = null;
    if (text && (text.startsWith("{") || text.startsWith("["))) {
      try {
        msg = JSON.parse(text);
      } catch (_) {
        msg = null;
      }
    }
    if (msg && msg.type) {
      switch (msg.type) {
        case "ping":
          if (STATE.ws) STATE.ws.send(JSON.stringify({ type: "pong" }));
          break;
        case "exec":
          execRequest(msg);
          break;
        case "reset":
          resetVm().then(() => {
            if (STATE.ws) STATE.ws.send(JSON.stringify({ type: "reset_ack", id: msg.id || "" }));
          });
          break;
        case "term:data":
          // Native dock keystrokes (line-mode input path).
          if (STATE.pubAdapter) STATE.pubAdapter.writeTerm(msg.data, msg.enc);
          break;
        case "term:resize":
          resizeVm(msg);
          break;
        case "term:require":
          // Native "Open Terminal" dock attached for this chat. Boot the pod
          // right now so its console streams straight into the dock; a blank
          // pod would otherwise make the dock sit on "Session has ended".
          ensureBooted().then(() => {
            if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
              STATE.ws.send(JSON.stringify({ type: "term:ready", chat_id: STATE.chatId }));
            }
          });
          break;
        case "error":
          setBar("error", "relay: " + (msg.message || "error"));
          break;
        default:
          break;
      }
      return;
    }
    // Raw frame: VM console output to echo into the (mirrored) panel.
    sendTerminalOutput(text);
  }

  // Mirror VM console output up to the relay so the native OpenWebUI "Open
  // Terminal" panel shows the same bytes as our dock. The Sep-28 edit deleted
  // this definition but left two callers — one guarded (relay mirroring
  // silently dead), one unguarded (a ReferenceError on every raw relay frame).
  function sendTerminalOutput(data) {
    if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
      try {
        STATE.ws.send(typeof data === "string" ? data : String(data));
      } catch (_) {
        /* drop on failure; keepalive/reconnect covers it */
      }
    }
  }

  function resizeVm(msg) {
    const rows = clampInt(msg.rows, 2, 300, 24);
    const cols = clampInt(msg.cols, 2, 300, 80);
    if (STATE.pubAdapter && typeof STATE.pubAdapter.resizing === "function") {
      STATE.pubAdapter.resizing(cols, rows);
      return;
    }
    try {
      if (STATE.console && STATE.console.term) {
        STATE.console.term.resize(cols, rows);
      }
    } catch (_) {
      /* best-effort */
    }
  }

  function clampInt(v, lo, hi, dflt) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  async function execRequest(msg) {
    const id = msg.id || "x" + ++STATE.execSeq;
    const timeout = Math.min(Number(msg.timeout_ms) || 30000, 300000);
    let result = { exit: -1, stdout: "", stderr: "timed out in browser" };
    // Counted once per run, before the boot: a run that boots the pod is
    // exactly the one the user is most likely not watching.
    noteAgentActivity();
    await ensureBooted();
    // Collaboration: show the agent's command and its result in the same
    // terminal the user is typing into, so both sides watch one machine.
    const oneLine = String(msg.cmd || "").replace(/\s+/g, " ").trim();
    setAgentState("agent: " + oneLine.slice(0, 60), true);
    agentWrite("\r\n\x1b[2m[agent]\x1b[0m " + msg.cmd + "\r\n");
    try {
      const timedOut = new Promise((_, rej) =>
        setTimeout(() => rej(new Error("exec timed out in browser")), timeout)
      );
      result = await Promise.race([
        Promise.resolve(STATE.pubAdapter.exec(msg.cmd, { cwd: msg.cwd, timeout_ms: timeout })),
        timedOut,
      ]);
    } catch (e) {
      result = { exit: -1, stdout: "", stderr: String(e && e.message ? e.message : e) };
    }
    if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
      STATE.ws.send(
        JSON.stringify({
          type: "exec_result",
          id: id,
          exit: Number.isInteger(result.exit) ? result.exit : -1,
          stdout: clip(String(result.stdout || "")),
          stderr: clip(String(result.stderr || "")),
        })
      );
    }
    // exec() types the command into the shared tty and recovers its output from
    // the same console, so the output is *already* on screen — echoing it here
    // too would print everything twice. Only the command banner and the exit
    // status are ours to add; note the banner matters because `stty -echo` is
    // active during exec, so the tty itself will not reflect the command.
    if (String(result.stderr || "")) {
      agentWrite("\x1b[31m" + result.stderr + "\x1b[0m\r\n");
    }
    agentWrite(
      "\x1b[2m[agent] exit " + (Number.isInteger(result.exit) ? result.exit : -1) + "\x1b[0m\r\n",
    );
    setAgentState("agent idle", false);
    if (dockEl && dockEl.classList.contains("bv-open")) setTimeout(focusConsole, 0);
  }

  function clip(s) {
    const MAX = 512 * 1024;
    if (s.length <= MAX) return s;
    return s.slice(0, MAX) + "\n[… truncated by browser-vm …]";
  }

  // The relay base64-encodes every binary keystroke from the native Open
  // Terminal panel (relay.py `_native_to_vm_loop`). atob gives back a
  // one-char-per-byte "binary string", which is what textToKeycodes() and the
  // guest tty expect — decoding to UTF-8 text instead would corrupt any
  // keystroke above U+007F and mangle multi-byte paste. (Non-ASCII is then
  // dropped with a visible note, because the keycode channel is one byte wide.)
  function b64ToBinary(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ""));
    let out = "";
    for (let i = 0; i < bin.length; i++) out += String.fromCharCode(bin.charCodeAt(i) & 0xff);
    return out;
  }

  function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
  }

  // ── Public API (plan §6: window.__owuiVm) ─────────────────────────────
  window.__owuiVm = {
    async init(chatId) {
      STATE.chatId = chatId || null;
      await ensureBooted();
    },
    async exec(cmd, opts) {
      await ensureBooted();
      return STATE.pubAdapter.exec(cmd, opts || {});
    },
    async reset() {
      await resetVm();
    },
    isBooted() {
      return STATE.ready;
    },
    openTerminal,
    closeTerminal,
    toggleTerminal,
    isTerminalOpen() {
      return !!(dockEl && dockEl.classList.contains("bv-open"));
    },
    // Lets the chat/agent surface the VM state and toggle the share flag.
    shareEnabled,
    setShare,
    shouldAutoOpen,
    // Collapse/expand the floating bar into its edge thumbnail. Exposed so the
    // page and the smoke test can drive it without synthesising a drag.
    setBarCollapsed,
    // Switch the active terminal backend (webvm <-> docker). Exposed for the
    // page and the smoke test.
    switchTerminal,
    getState() {
      return {
        chatId: STATE.chatId,
        ready: STATE.ready,
        booting: STATE.booting,
        adapter: STATE.pubAdapter ? STATE.pubAdapter.name : null,
        connected: !!(STATE.ws && STATE.ws.readyState === WebSocket.OPEN),
        share: shareEnabled(),
        terminalOpen: !!(dockEl && dockEl.classList.contains("bv-open")),
        autoOpen: !!CFG.autoOpen,
        dismissed: STATE.dismissed,
        unseenAgentRuns: STATE.unseenAgentRuns,
        barCollapsed: !!(barEl && barEl.classList.contains("bv-collapsed")),
        // Non-null when the real VM could not load. Surfaced so the page (and
        // the smoke test) can tell an honest failure from a booting pod; the
        // Sep-28 edit dropped it along with makeFailedAdapter.
        failedReason: STATE.failedReason,
      };
    },
  };

  // ── Boot ───────────────────────────────────────────────────────────────
  function start() {
    STATE.chatId = currentChatId();
    watchChat();
    ensureBar();
    // Composer chip removed (see ensureChip): sweep away any chip a stale
    // cached loader may have left in the DOM.
    ensureChip();
    // Register with the relay immediately (even with no pod booted) so the
    // native "Open Terminal" dock can reach this browser, then bring the
    // terminal up for the chat already on screen.
    connectRelay();
    if (STATE.chatId) {
      if (autoOpenTerminal()) {
        // openTerminal() owns the bar text from here.
      } else {
        setBar("idle", "VM: " + STATE.chatId.slice(0, 8) + " (boot on demand)");
      }
    } else {
      setBar("idle", "VM: no chat");
    }
    window.__owuiVm.connectRelay = connectRelay;
    window.__owuiVm.reset = resetVm;
    window.__owuiVm.reconnect = connectRelay;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
