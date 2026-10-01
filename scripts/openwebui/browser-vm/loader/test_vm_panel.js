#!/usr/bin/env node
// Headless smoke test for vm-panel.js: runs the real IIFE against a minimal
// DOM/WebSocket stub and asserts the dock, the chip, and the share toggle come
// up and behave. This is the closest thing to a browser check that runs
// without Chromium, and it catches the class of bug that killed the panel
// before (a ReferenceError, or a bad merge that parses but throws on load).
//
// Two modes, because they exercise different halves of the panel:
//   mock     — window.__BROWSER_VM_FORCE_MOCK, so the relay/chip/dock wiring
//              runs with a pod that has no console.
//   cheerpx  — a fake CheerpX global, so the real adapter runs: the console
//              node gets adopted into the dock, the tty echoes keystrokes, and
//              the agent's exec() output lands in the same scrollback.
//
// Usage: node test_vm_panel.js [panel-path]     (runs both modes)
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// ── Parent: fan out one child per mode so global stubs never leak between ──
if (!process.env.BV_TEST_CHILD) {
  let bad = 0;
  for (const mode of ["mock", "cheerpx", "nocheerpx"]) {
    console.log("\n═══ mode: " + mode + " ═══");
    const r = spawnSync(process.execPath, [__filename, mode, ...process.argv.slice(2)], {
      env: { ...process.env, BV_TEST_CHILD: "1" },
      stdio: "inherit",
    });
    if (r.status !== 0) bad++;
  }
  if (bad) {
    console.log("\n" + bad + " mode(s) FAILED");
    process.exit(1);
  }
  console.log("\nALL MODES PASS");
  process.exit(0);
}

// Every mode is named explicitly and an unknown one is a hard error. This used
// to fold anything that wasn't "cheerpx" into "mock", which silently ran the
// full suite with the mock escape hatch set — so a typo in the fan-out list
// would have quietly tested the wrong adapter and reported green.
const MODE = process.argv[2];
if (!["mock", "cheerpx", "nocheerpx"].includes(MODE)) {
  console.error("unknown mode: " + JSON.stringify(MODE));
  process.exit(2);
}
const PANEL = process.argv[3] || path.join(__dirname, "vm-panel.js");
const src = fs.readFileSync(PANEL, "utf8");

const failures = [];
const ok = [];
function check(name, cond, extra) {
  if (cond) ok.push(name);
  else failures.push(name + (extra ? " -> " + extra : ""));
}

function safe(fn, arg) {
  try {
    return fn(arg);
  } catch (e) {
    failures.push("event listener threw: " + e.message);
    return undefined;
  }
}

// ── Minimal DOM ────────────────────────────────────────────────────────────
// Enough of the DOM that a selector engine can resolve the queries vm-panel.js
// makes: id, class, tag, and [attr="value"] compounds, comma lists, and
// closest(). Not a browser — but it fails loudly rather than quietly returning
// null for something a real page would find.
const ATTR_SEL = /^\[([\w-]+)(?:([~|^$*]?=)"?([^"\]]*)"?)?\]$/;

function matchesCompound(el, compound) {
  for (const simple of compound.trim().split(/(?=[.#[])/)) {
    if (!simple) continue;
    if (simple[0] === "#") {
      if (el.id !== simple.slice(1)) return false;
    } else if (simple[0] === ".") {
      if (!el.classList.contains(simple.slice(1))) return false;
    } else if (simple[0] === "[") {
      const a = ATTR_SEL.exec(simple);
      if (!a) return false;
      const v = el.getAttribute(a[1]);
      if (v === null) return false;
      if (a[2] === "=" && v !== a[3]) return false;
    } else if (el.tagName !== simple.toUpperCase()) {
      return false;
    }
  }
  return true;
}

class El {
  constructor(tag) {
    this.tagName = (tag || "div").toUpperCase();
    this.nodeType = 1; // vm-panel.js guards on this to spot editing surfaces
    // Real elements expose this; the panel refuses to insert into anything
    // where it is true, so the stub has to model it too.
    this.isContentEditable = false;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    // The terminal-type toggle buttons carry their id in data-type and are
    // re-styled by switchTerminal() via el.dataset.type. Without this the panel
    // throws at load ("Cannot set properties of undefined") the moment it builds
    // the bar — which is exactly the gap that let the untested Sep-28 edit ship.
    this.dataset = {};
    this.classList = {
      _s: new Set(),
      add: (...c) => c.forEach((x) => this.classList._s.add(x)),
      remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
      contains: (c) => this.classList._s.has(c),
      // The bar collapse + toggle-button selection use classList.toggle.
      toggle: (c, force) => {
        const on = force === undefined ? !this.classList._s.has(c) : !!force;
        if (on) this.classList._s.add(c);
        else this.classList._s.delete(c);
        return on;
      },
    };
    // snapBarToEdge()/drag clamps read these; a real layout would compute them.
    this.offsetWidth = 120;
    this.offsetHeight = 24;
    this._attrs = {};
    this._text = "";
    this._html = "";
    this.listeners = {};
    this.rows = 24;
  }
  get className() {
    return this._attrs.class || "";
  }
  set className(v) {
    this._attrs.class = v;
    this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get id() {
    return this._attrs.id || "";
  }
  set id(v) {
    this._attrs.id = v;
  }
  // Parse our own markup into a nested element tree. Only enough HTML to make
  // the panel's selectors resolvable — self-closing and void tags are skipped
  // so children do not get nested one level too deep.
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    const stack = [this];
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>/g;
    let m;
    while ((m = re.exec(this._html))) {
      const [, closing, tag, attrStr, selfClose] = m;
      if (closing) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const el = new El(tag);
      for (const a of attrStr.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
        el.setAttribute(a[1], a[2] === undefined ? "" : a[2]);
      }
      stack[stack.length - 1].appendChild(el);
      if (!selfClose && !/^(img|br|hr|input|meta|link|source)$/i.test(tag)) stack.push(el);
    }
  }
  get innerHTML() {
    return this._html;
  }
  set textContent(v) {
    this._text = v;
  }
  get textContent() {
    return this._text;
  }
  get firstElementChild() {
    return this.children[0] || new El("span");
  }
  setAttribute(k, v) {
    this._attrs[k] = String(v);
    if (k === "class") this.className = v; // keep classList in sync like a browser
  }
  getAttribute(k) {
    return k in this._attrs ? this._attrs[k] : null;
  }
  removeAttribute(k) {
    delete this._attrs[k];
    if (k === "class") this.classList._s = new Set();
  }
  appendChild(c) {
    if (c.parentNode) c.parentNode.children = c.parentNode.children.filter((x) => x !== c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = null;
    return c;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  insertBefore(node, ref) {
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, node);
    node.parentNode = this;
    return node;
  }
  contains(n) {
    for (let p = n; p; p = p.parentNode) if (p === this) return true;
    return false;
  }
  addEventListener(t, fn) {
    (this.listeners[t] = this.listeners[t] || []).push(fn);
  }
  removeEventListener() {}
  dispatchEvent() {}
  // Fire listeners from the target up through its ancestors, the way a real
  // click bubbles, so delegated handlers (`menu.addEventListener("click",
  // e => e.target.closest("button[data-v]"))`) actually run.
  click() {
    this.closest = El.prototype.closest.bind(this);
    const ev = {
      target: this,
      defaultPrevented: false,
      _stopped: false,
      stopPropagation() {
        ev._stopped = true;
      },
      preventDefault() {
        ev.defaultPrevented = true;
      },
    };
    for (let node = this; node && !ev._stopped; node = node.parentNode) {
      (node.listeners.click || []).slice().forEach((f) => safe(() => f(ev)));
    }
  }
  closest(sel) {
    for (let p = this; p; p = p.parentNode) {
      if (
        String(sel)
          .split(",")
          .some((c) => matchesCompound(p, c.trim()))
      )
        return p;
    }
    return null;
  }
  getBoundingClientRect() {
    return { top: 100, right: 200, bottom: 120, left: 100, width: 100, height: 20 };
  }
  matches(sel) {
    return String(sel)
      .split(",")
      .some((c) => matchesCompound(this, c.trim()));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  querySelectorAll(sel) {
    const groups = String(sel)
      .split(",")
      .map((s) => s.trim());
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (groups.some((g) => matchesCompound(c, g))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

// ── Page skeleton ──────────────────────────────────────────────────────────
// Shaped like the real OpenWebUI composer: a <form> holding a toolbar row, a
// message-input container, and #chat-input as a TipTap/ProseMirror
// contenteditable. The old fixture used a bare <footer>, which is why the
// chip-hosting bug below shipped: nothing in the suite ever put a ProseMirror
// editor next to the chip.
const body = new El("body");

const composer = new El("form");
composer.id = "bv-composer";
body.appendChild(composer);

const msgInputContainer = new El("div");
msgInputContainer.id = "message-input-container";
composer.appendChild(msgInputContainer);

const inputRow = new El("div");
inputRow.className = "px-2 relative";
composer.appendChild(inputRow);

const chatInputContainer = new El("div");
chatInputContainer.id = "chat-input-container";
inputRow.appendChild(chatInputContainer);

const chatInput = new El("div");
chatInput.id = "chat-input";
chatInput.className = "ProseMirror";
chatInput.isContentEditable = true;
chatInput.setAttribute("contenteditable", "true");
chatInputContainer.appendChild(chatInput);

const store = {};
const queryDoc = (sel) => {
  const found = body.querySelectorAll(sel);
  if (found.length) return found[0];
  return composer.matches(sel) ? composer : null;
};
global.document = {
  readyState: "complete",
  body,
  head: new El("head"),
  documentElement: new El("html"),
  createElement: (t) => new El(t),
  getElementById: (id) => body.querySelector("#" + id) || store[id] || null,
  querySelector: queryDoc,
  querySelectorAll: (sel) => body.querySelectorAll(sel),
  addEventListener: (t, fn) => {
    (global.__docListeners[t] = global.__docListeners[t] || []).push(fn);
  },
};
global.__docListeners = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => {
    store[k] = String(v);
  },
  removeItem: (k) => delete store[k],
};
global.location = {
  protocol: "https:",
  host: "chad.supachad.com",
  // origin is what `new URL(CFG.imageWs, location.origin)` resolves the
  // self-hosted disk-image path against; without it the panel throws
  // "Invalid URL" at boot.
  origin: "https://chad.supachad.com",
  pathname: "/c/chat-abc123",
};
global.navigator = { userAgent: "node" };

// The panel re-attaches the composer chip from a MutationObserver rather than
// a polling interval. Deliver callbacks on a macrotask so the microtask
// coalescing inside the panel's handler has already run, and expose the
// observers so a test can simulate the SPA re-rendering the composer.
const observers = [];
global.MutationObserver = class {
  constructor(cb) {
    this.cb = cb;
    this.connected = false;
    observers.push(this);
  }
  observe() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
  // Test hook: pretend the DOM mutated.
  fire() {
    if (this.connected) this.cb([], this);
  }
};
global.window = {
  innerWidth: 1280,
  innerHeight: 800,
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  addEventListener() {},
  removeEventListener() {},
  localStorage: global.localStorage,
  location: global.location,
  requestAnimationFrame: (f) => realSetTimeout(f, 0),
};

// ── WebSocket stub ─────────────────────────────────────────────────────────
const sockets = [];
let wsInstances = 0;
global.WebSocket = class {
  constructor(url) {
    this.url = url;
    this.readyState = 1; // OPEN once constructed
    this.sent = [];
    wsInstances++;
    sockets.push(this);
  }
  addEventListener(t, fn) {
    (this["on_" + t] = this["on_" + t] || []).push(fn);
  }
  send(d) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  // A real socket opens asynchronously; fire it on the next tick so the
  // register frame and reconnect logic are actually exercised. Fire BOTH the
  // addEventListener('open') handlers (relay leg) and the .onopen property
  // (Docker adapter uses property-style handlers).
  _open() {
    (this.on_open || []).forEach((f) => safe(f, { data: "" }));
    if (typeof this.onopen === "function") safe(this.onopen, { data: "" });
  }
  // Deliver a relay frame down to the panel.
  _recv(frame) {
    const data = typeof frame === "string" ? frame : JSON.stringify(frame);
    (this.on_message || []).forEach((f) => safe(f, { data }));
    if (typeof this.onmessage === "function") safe(this.onmessage, { data });
  }
};
global.WebSocket.OPEN = 1;
global.WebSocket.CONNECTING = 0;
global.WebSocket.CLOSED = 3;

// The Docker adapter creates its PTY session with a POST through the OpenWebUI
// terminal proxy. Stub it so a terminal switch to Docker can be exercised; the
// WebSocket stub above is OPEN on construction, so the adapter's connect-wait
// resolves without needing property-style handlers.
global.fetchCalls = [];
global.fetch = async (url, opts) => {
  const u = String(url);
  global.fetchCalls.push({ url: u, opts });
  // /api/cmd is the server-side agent-exec endpoint (docker); everything else in
  // this suite is the terminal-session create.
  const body = u.includes("/api/cmd")
    ? { ok: true, exit: 0, stdout: "agent-ran\n", stderr: "" }
    : { id: "docker-sess-test" };
  return {
    ok: true,
    status: 200,
    async json() { return body; },
    async text() { return ""; },
  };
};

// ── Timers ─────────────────────────────────────────────────────────────────
// Real timers: the boot path and the socket open are async, so the suite drains
// them rather than pretending they are synchronous. Exceptions inside timers
// become failures instead of killing the run.
const realSetTimeout = setTimeout;
// Capture the real clearTimeout too. `global.clearTimeout = (t) => clearTimeout(t)`
// looks harmless but the arrow resolves `clearTimeout` to itself, so any code
// that cancels a timer recurses until the stack blows — and the panel's output
// sink cancels a timer on every 256-byte batch, so this wedged every test after
// the first sizeable burst of VM output.
const realClearTimeout = clearTimeout;
global.setTimeout = (f, ms, ...a) =>
  realSetTimeout(
    (...args) => {
      try {
        f(...args);
      } catch (e) {
        failures.push("setTimeout callback threw: " + e.message);
      }
    },
    ms,
    ...a,
  );
global.clearTimeout = (t) => realClearTimeout(t);
// Capture intervals so the suite can drive the chat watcher by hand.
const intervals = [];
global.setInterval = (f, ms) => {
  const handle = { f, ms, cleared: false };
  intervals.push(handle);
  return handle;
};
global.clearInterval = (h) => {
  if (h) h.cleared = true;
};
global.Blob = class {};
global.InputEvent = class {};
const drain = (ms) => new Promise((r) => realSetTimeout(r, ms));

// ── Fake CheerpX 1.3.9 + xterm (cheerpx mode) ────────────────────────────────
// Modelled from the shipped artefacts, not from what the panel would like to
// exist: `@leaningtech/cheerpx@1.3.9/index.d.ts` and cx_esm.js. Specifically —
//
//   Linux.create({mounts, networkInterface})   returns a pod
//   pod.setCustomConsole(write, cols, rows)    returns (keyCode) => void;
//                                               `write` is called ONE BYTE
//                                               per call
//   pod.run(file, args, {env, cwd})            resolves on process exit, and
//                                               only for a non-interactive one
//   pod.delete()                                teardown
//
// There is deliberately NO XtermConsole, NO cx.stdin, NO cx.spawn, NO
// getStdout, and no global `CheerpX` — the fake omits all four, so any code
// that reaches for them fails here exactly as it would in a browser.
//
// The fake guest is a small tty + shell: keycodes in, bytes out, echo gated by
// `stty -echo`, and enough POSIX-ish line handling to run the sentinel script
// exec() types. That is what lets the exec assertions below be real.
const ttyLog = [];
let lastConsole = null;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8");

function emitBytes() {
  const con = lastConsole;
  if (!con || !con.write) return;
  for (const b of enc.encode(Array.prototype.join.call(arguments, ""))) {
    // One byte per call, like the real worker does.
    con.write(new Uint8Array([b]));
  }
}

const fakeTerminals = [];
class FakeTerminal {
  constructor(opts) {
    this.opts = opts;
    fakeTerminals.push(this);
    this.rows = 24;
    this.cols = 80;
    this.written = [];
    this.disposed = false;
    this._on = {};
  }
  loadAddon(a) {
    this.addon = a;
  }
  open(el) {
    this.element = el;
  }
  write(d) {
    this.written.push(String(d));
  }
  onData(fn) {
    this._on.data = fn;
  }
  // Test hook: pretend the user typed this into the dock.
  type(d) {
    if (this._on.data) this._on.data(d);
  }
  focus() {
    ttyLog.push(["focus", ""]);
  }
  resize(c, r) {
    this.cols = c;
    this.rows = r;
  }
  dispose() {
    this.disposed = true;
  }
  text() {
    return this.written.join("");
  }
}

class FakeFitAddon {
  fit() {
    ttyLog.push(["fit", ""]);
  }
}

// The guest: a line discipline plus just enough shell to run exec()'s script.
class FakeTty {
  constructor() {
    this.echo = true;
    this.line = "";
    this.rc = 0;
    this.hung = false;
    this.prompt = "sh-5.2# ";
    this.ps1 = "sh-5.2# ";
    this.pwd = "/root";
  }
  key(kc) {
    ttyLog.push(["key", kc]);
    // Ctrl+C is checked *before* the hung gate. A real tty turns the character
    // into SIGINT for the foreground process no matter what that process is
    // doing, and restoreTty() depends on exactly that: it interrupts a hung
    // command in order to put `stty echo` back. Modelling it the other way round
    // would make an interrupted command unrecoverable.
    if (kc === 3) {
      // SIGINT discards the pending line; it does not join it.
      this.line = "";
      if (this.hung) {
        this.hung = false;
        this.echo = true;
        emitBytes("^C\n");
        emitBytes(this.ps1);
      }
      return;
    }
    if (this.hung) return; // a hung command owns the tty; input just queues
    if (kc === 13) {
      const line = this.line;
      this.line = "";
      if (this.echo) emitBytes("\r\n");
      this.run(line);
      return;
    }
    if (kc === 8) {
      this.line = this.line.slice(0, -1);
      if (this.echo) emitBytes("\b \b");
      return;
    }
    if (kc === 4) return; // Ctrl+D: EOF, nothing to model
    this.line += String.fromCharCode(kc);
    if (this.echo) emitBytes(String.fromCharCode(kc));
  }
  run(line) {
    // `stty -echo` / `stty echo`
    if (/^stty -echo$/.test(line)) {
      this.echo = false;
      return;
    }
    // A `cd` can be part of a compound line — the exec wrapper's last line is
    // `cd "$__bvcd" 2>/dev/null; PS1="$__bvps1"; stty echo` — so this is matched
    // anywhere in the line and does NOT return. Handling it only as a whole line
    // would mean the compound restore line silently never moved the cwd.
    const cdm = /(^|;\s*)cd\s+('[^']*'|"[^"]*"|\S+)/.exec(line);
    if (cdm) {
      const arg = cdm[2];
      // Strip the quoting shQuote() adds, and drop any `2>/dev/null`.
      this.pwd =
        arg === '"$__bvcd"' || arg === "'$__bvcd'"
          ? this.savedCwd
          : arg.replace(/^['"]|['"]$/g, "").split(/\s+2>/)[0] || "/";
      // A bare `cd` is the whole command and produces no output; a compound line
      // (the exec wrapper's `cd ...; PS1=...; stty echo`) has more to run.
      if (/^cd\s+\S+\s*(2>\S*\s*)?$/.test(line)) return;
    }
    if (/stty echo/.test(line)) {
      this.echo = true;
      this.hung = false; // restoreTty() interrupts
      this.ps1 = this.savedPs1 || this.ps1;
      // Deliberately does NOT restore pwd: the cwd restore is the `cd` in the
      // line above. Restoring it here too would hide a missing `cd "$__bvcd"`.
      emitBytes(this.ps1);
      return;
    }
    // sentinel printers — the only lines that must be understood precisely
    const b = /^printf '\\033\]999;bv%s%s-b\\007' '(\w+)' '(\w+)'$/.exec(line);
    if (b) {
      emitBytes("\x1b]999;bv" + b[1] + b[2] + "-b\x07");
      return;
    }
    const e = /^printf '\\033\]999;bv%s%s-e\\007' '(\w+)' '(\w+)'"(\$__bvrc)"$/.exec(line);
    if (e) {
      emitBytes("\x1b]999;bv" + e[1] + e[2] + "-e:" + this.rc + "\x07");
      emitBytes(this.ps1);
      return;
    }
    if (/^__bvrc=/.test(line)) return;
    if (/^__bvps1=/.test(line)) {
      // The exec wrapper's one setup line: it saves the prompt *and* the cwd
      // into shell variables before blanking them. Modelling the variables is
      // what makes the later `cd "$__bvcd"` restore checkable at all.
      this.savedPs1 = this.ps1;
      this.savedCwd = this.pwd;
      this.ps1 = ""; // exec blanks PS1 so prompts stay out of the capture
      return;
    }
    // Lets a test ask where the guest shell is standing after an exec.
    if (/^pwd\b/.test(line)) {
      emitBytes(this.pwd + "\n");
      emitBytes(this.ps1);
      return;
    }
    if (line === "") {
      emitBytes(this.ps1);
      return;
    }
    // An ordinary command line.
    this.rc = 0;
    if (line.startsWith("fail:")) {
      this.rc = Number(line.slice(5)) || 1;
      emitBytes("err\n");
      emitBytes(this.ps1);
      return;
    }
    if (line.startsWith("hang:")) {
      this.hung = true;
      return;
    }
    if (line.startsWith("flood:")) {
      emitBytes("x".repeat(600 * 1024));
      emitBytes(this.ps1);
      return;
    }
    if (line.startsWith("utf8:")) {
      emitBytes("héllo → ✓\n");
      emitBytes(this.ps1);
      return;
    }
    emitBytes(line + ": ok\r\n"); // ONLCR, as a real tty in canonical mode
    emitBytes(this.ps1);
  }
}

const fakeTty = new FakeTty();

global.window.__BROWSER_VM_CHEERPX = {
  CloudDevice: { create: async (url) => ({ kind: "cloud", url: url }) },
  // The self-hosted rewrite streams the ext2 image over HTTP range requests
  // (HttpBytesDevice) instead of the ws CloudDevice, so the fake must expose it.
  HttpBytesDevice: { create: async (url) => ({ kind: "http", url: url }) },
  IDBDevice: { create: async (name) => ({ kind: "idb", name: name }) },
  OverlayDevice: { create: async (a, b) => ({ kind: "overlay", a: a, b: b }) },
  Linux: {
    create: async (opts) => {
      global.__linuxOpts = opts;
      return {
        opts: opts,
        _custom: [],
        setCustomConsole(write, cols, rows) {
          this._custom.push([cols, rows]);
          lastConsole = { write: write, cols: cols, rows: rows, pod: this };
          ttyLog.push(["setCustomConsole", cols + "x" + rows]);
          return (kc) => {
            ttyLog.push(["send", kc]);
            fakeTty.key(kc);
          };
        },
        run(file, args, opts2) {
          global.__runCalls = global.__runCalls || [];
          global.__runCalls.push([file, (args || []).join(" "), opts2]);
          ttyLog.push(["run", file + " " + (args || []).join(" ")]);
          // An interactive shell never exits, so this must not resolve. If the
          // panel ever awaits run(), init() hangs and the dock never opens.
          if ((args || []).indexOf("-i") >= 0) {
            emitBytes(fakeTty.prompt);
            return new Promise(() => {});
          }
          return Promise.resolve({ status: 0 });
        },
        delete() {
          global.__cxDeleted = (global.__cxDeleted || 0) + 1;
        },
      };
    },
  },
};
// No `XtermConsole` export, exactly like the real 1.3.9 namespace.
global.window.__BROWSER_VM_XTERM = { Terminal: FakeTerminal, FitAddon: FakeFitAddon };

if (MODE === "mock") {
  delete global.window.__BROWSER_VM_CHEERPX;
  delete global.window.__BROWSER_VM_XTERM;
  global.window.__BROWSER_VM_FORCE_MOCK = true; // skip the CheerpX import
}

// ── nocheerpx: the real VM cannot load, and the mock is NOT requested ──────
// This is the mode that guards the most important property in the file: when
// CheerpX is unavailable the panel must admit there is no VM. It must never
// fall back to the mock, whose exec() returns "[mock] <cmd>" with exit 0 —
// fabricated success handed straight to the agent.
if (MODE === "nocheerpx") {
  delete global.window.__BROWSER_VM_CHEERPX;
  delete global.window.__BROWSER_VM_XTERM;
  // Point at a module that cannot resolve. file:// fails in Node's ESM loader
  // with ERR_MODULE_NOT_FOUND, deterministically and with no network, so this
  // exercises the genuine load-failure path (including the cache-busted retry).
  global.window.__BROWSER_VM = { cheerpxUrl: "file:///bv-definitely-missing.js" };
}

// Everything below assumes a working pod. With no CheerpX there is no pod, no
// console and no tty, so the shared body has nothing to inspect; this mode runs
// its own assertions instead.
async function noCheerpXMode() {
  check("the forced-mock escape hatch is NOT set", !global.window.__BROWSER_VM_FORCE_MOCK);
  let threw = null;
  try {
    new Function(src)();
  } catch (e) {
    threw = e;
  }
  check("the panel still loads when CheerpX is unavailable", !threw, threw && threw.message);

  const vm = global.window.__owuiVm;
  for (const s of sockets) realSetTimeout(() => s._open(), 0);
  await drain(80);

  // Auto-open asks for a boot, which must fail honestly.
  await drain(400);
  const st = vm.getState();
  check("a CheerpX load failure is reported as a reason", !!st.failedReason, JSON.stringify(st));
  check("the adapter is not a mock", st.adapter !== "mock", JSON.stringify(st));
  check("the adapter is the failed one", st.adapter === "failed", JSON.stringify(st));
  check("the VM is never marked ready", st.ready === false, JSON.stringify(st));

  // The bar must say so. This is the difference between a visible outage and
  // the months-long silent one.
  const barLabel = body.querySelector("#bv-vmbar").querySelector("#bv-vmbar-label").textContent;
  check("the bar explains the failure", /unavailable|failed|cheerpx/i.test(barLabel), barLabel);
  check("the bar does not claim a mock is ready", !/mock/i.test(barLabel), barLabel);

  // The decisive property: exec must not invent a result.
  const res = await vm.exec("uname -a");
  check("exec on a dead VM reports a non-zero exit", res && res.exit !== 0, JSON.stringify(res));
  check("exec on a dead VM never returns exit 0", res.exit !== 0, JSON.stringify(res));
  check("exec on a dead VM explains itself", /unavailable/i.test(res.stderr || ""), JSON.stringify(res));
  check(
    "exec on a dead VM fabricates no stdout",
    !/\[mock\]/.test(res.stdout || ""),
    JSON.stringify(res),
  );
  check(
    "exec on a dead VM fabricates nothing in stderr either",
    !/\[mock\]/.test(res.stderr || ""),
    JSON.stringify(res),
  );

  // And the same through the relay path, which is how the agent actually sees
  // it. An agent that gets exit 0 here reports a command that never ran.
  const sock = sockets.filter((s) => s.readyState === 1).pop();
  sock._recv({ type: "exec", id: "nc1", cmd: "uname -a", timeout_ms: 2000 });
  await drain(300);
  // allSent() spans every socket, not just the live one: a result can be
  // written by a socket that has since closed.
  const allSent = () => sockets.flatMap((s) => s.sent.map((x) => String(x)));
  const frames = allSent().filter((s) => s.includes("nc1"));
  check("the dead VM still answers the relay's exec", frames.length > 0, allSent().join(" | ").slice(-300));
  const frame = frames.map((s) => JSON.parse(s)).pop();
  check("the relayed result is a failure", frame.exit !== 0, JSON.stringify(frame));
  check("the relayed result carries no mock output", !/\[mock\]/.test(JSON.stringify(frame)), JSON.stringify(frame));
  check("the relayed result explains itself", /unavailable/i.test(frame.stderr || ""), JSON.stringify(frame));
}

async function main() {
  // A CheerpX load failure invalidates every shared assertion below, so that
  // mode runs its own suite and stops here.
  if (MODE === "nocheerpx") {
    await noCheerpXMode();
    report();
    return;
  }
  // ── Load the panel ─────────────────────────────────────────────────────────
  let threw = null;
  try {
    new Function(src)();
  } catch (e) {
    threw = e;
  }
  if (threw) {
    console.log("FATAL: vm-panel.js threw on load: " + threw.message);
    console.log(threw.stack.split("\n").slice(0, 6).join("\n"));
    process.exit(1);
  }

  for (const s of sockets) realSetTimeout(() => s._open(), 0);
  await drain(50);

  const vm = global.window.__owuiVm;
  const open = (sel) => body.querySelector(sel);
  const live = () => sockets.filter((s) => s.readyState === 1);
  const lastSock = () => sockets[sockets.length - 1];
  const allSent = () => sockets.flatMap((s) => s.sent.map((x) => String(x)));

  // ── Mount + relay registration ─────────────────────────────────────────────
  check("window.__owuiVm is exported", !!vm);
  check("floating bar is mounted", !!document.getElementById("bv-vmbar"));
  check("bar has the terminal icon button", !!open("#bv-vmbar")?.querySelector("#bv-vmbar-term"));
  check("relay websocket opened", wsInstances > 0, "wsInstances=" + wsInstances);
  check(
    "register frame sent on open",
    allSent().some((s) => s.includes('"register"')),
  );
  check(
    "register frame carries the chat id",
    allSent().some((s) => s.includes("chat-abc123")),
  );
  check(
    "socket url targets the chat",
    lastSock().url.includes("chat_id=chat-abc123"),
    lastSock().url,
  );
  check(
    "getState reports the chat",
    vm.getState().chatId === "chat-abc123",
    JSON.stringify(vm.getState()),
  );
  // The terminal used to boot lazily, which left the agent's commands running
  // inside an xterm that was never opened — the user saw no output and no
  // reason why. It now comes up on page load.
  check(
    "the terminal opens by itself on page load",
    vm.getState().terminalOpen === true,
    JSON.stringify(vm.getState()),
  );
  check(
    "auto-open is the default",
    vm.getState().autoOpen === true,
    JSON.stringify(vm.getState()),
  );
  check(
    "a chat, sharing and auto-open together mean open",
    vm.shouldAutoOpen() === true,
    JSON.stringify(vm.getState()),
  );

  // ── Collapsible bar ─────────────────────────────────────────────────────────
  check("bar has a collapse chevron", !!open("#bv-vmbar").querySelector("#bv-vmbar-collapse"));
  check("bar has a thumbnail element", !!open("#bv-vmbar").querySelector("#bv-vmbar-thumb"));
  check("bar starts expanded", vm.getState().barCollapsed === false, JSON.stringify(vm.getState()));
  vm.setBarCollapsed(true);
  check("setBarCollapsed(true) collapses the bar", vm.getState().barCollapsed === true);
  check(
    "collapsed state is persisted",
    (() => { try { return localStorage.getItem("bv.barCollapsed") === "1"; } catch (_) { return false; } })(),
  );
  check(
    "collapsing does not close a running terminal",
    vm.getState().terminalOpen === true,
    JSON.stringify(vm.getState()),
  );
  vm.setBarCollapsed(false);
  check("setBarCollapsed(false) expands the bar", vm.getState().barCollapsed === false);

  // A relay ping must be answered, or the relay will drop the registration.
  lastSock()._recv({ type: "ping" });
  await drain(10);
  check(
    "ping is answered with pong",
    allSent().some((s) => s.includes('"pong"')),
  );

  // A relay error must surface in the bar, not fail silently.
  const barLabel = () => open("#bv-vmbar").querySelector("#bv-vmbar-label").textContent;
  lastSock()._recv({ type: "error", message: "pod gone" });
  await drain(10);
  check("relay error shows in the bar", /pod gone/.test(barLabel()), barLabel());
  check(
    "bar marked as errored",
    open("#bv-vmbar").classList.contains("bv-error"),
    open("#bv-vmbar").className,
  );

  // ── Dock: API surface ──────────────────────────────────────────────────────
  try {
    check("openTerminal is exposed", typeof vm?.openTerminal === "function");
    await vm.openTerminal();
    const dock = open("#bv-term");
    check("dock element created", !!dock);
    check("dock opens", dock?.classList.contains("bv-open"));
    check("isTerminalOpen reflects state", vm.isTerminalOpen() === true);
    check(
      "icon button is marked expanded",
      open("#bv-vmbar")?.querySelector("#bv-vmbar-term")?.getAttribute("aria-expanded") === "true",
    );
    vm.closeTerminal();
    check("dock closes", vm.isTerminalOpen() === false);
    check("closed dock drops bv-open", !dock.classList.contains("bv-open"));
    check("closed dock stays in the DOM for reuse", !!open("#bv-term"));
    vm.toggleTerminal();
    check("toggle reopens", vm.isTerminalOpen() === true);
    vm.toggleTerminal();
    check("toggle closes", vm.isTerminalOpen() === false);
  } catch (e) {
    failures.push("dock API threw: " + e.message);
  }

  // ── Dock: the icon button the user actually clicks ─────────────────────────
  try {
    const btn = open("#bv-vmbar").querySelector("#bv-vmbar-term");
    check("terminal icon is a button", btn.tagName === "BUTTON", btn.tagName);
    btn.click();
    await drain(20);
    check("icon click opens the dock", vm.isTerminalOpen() === true);
    btn.click();
    await drain(20);
    check("second icon click closes the dock", vm.isTerminalOpen() === false);
    check("aria-expanded returns to false", btn.getAttribute("aria-expanded") === "false");
    // The dock's own Close button must work too.
    await vm.openTerminal();
    open("#bv-term").querySelector("#bv-term-close").click();
    check("dock Close button closes the dock", vm.isTerminalOpen() === false);
  } catch (e) {
    failures.push("icon button threw: " + e.message);
  }

  // ── Opening the dock boots the pod ─────────────────────────────────────────
  try {
    // Auto-open has already asked for a boot, so let it land before asserting;
    // openTerminal() must then be a no-op rather than a second boot.
    await drain(400);
    await vm.openTerminal();
    const st = vm.getState();
    check("opening the dock boots the pod", st.ready === true, JSON.stringify(st));
    check("adapter is reported", !!st.adapter, JSON.stringify(st));
    check(
      "adapter matches mode",
      st.adapter === (MODE === "cheerpx" ? "cheerpx" : "mock"),
      st.adapter,
    );
    check("booting flag cleared", st.booting === false);
    // A boot that fails must say so on the bar. Before this rewrite the bar
    // stayed "idle" while the dock reported "no console", so a total CheerpX
    // failure looked identical to a VM that was merely not open yet.
    const barLabel = open("#bv-vmbar").querySelector("#bv-vmbar-label").textContent;
    check("the bar never reports a boot failure", !/boot failed|unavailable/i.test(barLabel), barLabel);
    const dock = open("#bv-term");
    const stateLine = dock.querySelector("#bv-term-state").textContent;
    check("dock state line is not the idle placeholder", stateLine !== "idle", stateLine);
    if (MODE === "cheerpx") {
      check("dock state line shows ready", /ready/.test(stateLine), stateLine);
      const host = dock.querySelector("#bv-term-xterm");
      check("terminal host exists in the dock", host !== null);
      check(
        "our own xterm is parented to the dock body",
        !!host && dock.querySelector("#bv-term-body").contains(host),
      );
      check(
        "fallback hidden once the console is live",
        !dock.querySelector("#bv-term-fallback").classList.contains("bv-on"),
      );
      await drain(120); // openTerminal defers focusConsole by one frame
      check(
        "tty was focused",
        ttyLog.some(([k]) => k === "focus"),
        JSON.stringify(ttyLog),
      );
    } else {
      check("mock dock reports no console", /no console/i.test(stateLine), stateLine);
    }
  } catch (e) {
    failures.push("dock boot threw: " + e.message);
  }

  // ── Sharing is always on (chip removed) ─────────────────────────────────────
  try {
    // The composer share chip was removed; sharing no longer toggles. It must
    // report on unconditionally so the browser always registers and the agent
    // can always reach the active terminal.
    check("share is always on", vm.shareEnabled() === true);
    // setShare(false) is a no-op now — it must NOT be able to disable sharing or
    // strand a stale "0" that locks the agent out.
    vm.setShare(false);
    await drain(20);
    check("setShare(false) cannot disable sharing", vm.shareEnabled() === true);
    check(
      "no stale share-off is persisted",
      localStorage.getItem("bv.shareWithAgent") === null,
      String(localStorage.getItem("bv.shareWithAgent")),
    );
    // Auto-open no longer gates on a toggle; a chat + auto-open is enough.
    check(
      "auto-open is not blocked by sharing",
      vm.shouldAutoOpen() === true,
      JSON.stringify(vm.getState()),
    );
  } catch (e) {
    failures.push("share-always-on check threw: " + e.message);
  }

  // ── Dismissing the terminal, and being told when the agent is busy ────────
  try {
    // Closing the dock must not immediately re-open it: that is a fight the
    // user always loses.
    vm.closeTerminal();
    await drain(50);
    check("the dock stays closed", vm.isTerminalOpen() === false, JSON.stringify(vm.getState()));
    check(
      "a dismissed dock is not auto-opened again",
      vm.shouldAutoOpen() === false,
      JSON.stringify(vm.getState()),
    );
    check(
      "dismissal is reported in the state",
      vm.getState().dismissed === true,
      JSON.stringify(vm.getState()),
    );
    // Nothing unseen yet, so nothing to advertise.
    check(
      "a quiet terminal shows no badge",
      open("#bv-vmbar").querySelector("#bv-vmbar-badge").hidden === true,
      open("#bv-vmbar").querySelector("#bv-vmbar-badge").outerHTML,
    );

    // The failure this exists to prevent: the agent runs a command, the output
    // goes to an xterm nobody is looking at, and the UI reports nothing at all.
    const sock = lastSock();
    sock._recv({ type: "exec", id: "bd", cmd: "echo badge", timeout_ms: 5000 });
    await drain(300);
    const badge = open("#bv-vmbar").querySelector("#bv-vmbar-badge");
    check(
      "agent work with the dock closed raises a badge",
      badge.hidden === false && /1/.test(badge.textContent),
      badge.outerHTML,
    );
    check(
      "the badge is also in the state",
      vm.getState().unseenAgentRuns === 1,
      JSON.stringify(vm.getState()),
    );

    // Re-opening is the "I've seen it" gesture.
    await vm.openTerminal();
    await drain(50);
    check(
      "opening the dock clears the badge",
      open("#bv-vmbar").querySelector("#bv-vmbar-badge").hidden === true &&
        vm.getState().unseenAgentRuns === 0,
      JSON.stringify(vm.getState()),
    );
    check(
      "opening the dock re-arms auto-open",
      vm.shouldAutoOpen() === true,
      JSON.stringify(vm.getState()),
    );
  } catch (e) {
    failures.push("dismiss/badge threw: " + e.message);
  }

  // ── Composer chip removed ───────────────────────────────────────────────────
  // The green "Browser VM" chip that used to sit under the composer was removed
  // (redundant with the hover bar's toggles + OpenWebUI's own selector). It must
  // never be created, and — critically — must never inject its label into the
  // ProseMirror message editor (the once-per-tick "Browser VM" prompt bug).
  try {
    check("no composer chip is created", open("#bv-chip") === null);
    check("no chip menu is created", open("#bv-chip-menu") === null);
    check("message editor is left empty (no chip injected)", chatInput.children.length === 0);
    // Survives a composer re-render without a chip reappearing.
    observers.forEach((o) => o.fire());
    await drain(20);
    check("still no chip after a composer re-render", open("#bv-chip") === null);
    check("editor still empty after re-render", chatInput.children.length === 0);
  } catch (e) {
    failures.push("chip-removed check threw: " + e.message);
  }

  // ── Collaboration: agent exec lands in the shared tty ──────────────────────
  try {
    if (MODE === "cheerpx") {
      const sock = lastSock();
      const xterm = () => fakeTerminals[fakeTerminals.length - 1];
      const parseSent = () =>
        sock.sent.map((x) => {
          try {
            return JSON.parse(String(x));
          } catch (_) {
            return null;
          }
        });
      // Everything the panel pushed into the guest, as text. This is the
      // panel↔tty direction, so it exercises textToKeycodes() end to end.
      const typedText = () =>
        ttyLog
          .filter(([k]) => k === "send")
          .map(([, kc]) => (kc === 13 ? "\n" : kc === 27 ? "\x1b" : String.fromCharCode(kc)))
          .join("");

      // ── Pod boot shape: the 1.3.9 contract, not the one we wished for ──────
      check("pod was created", !!global.__linuxOpts, JSON.stringify(global.__linuxOpts));
      check(
        "create() gets mounts and networkInterface, not cmd/network",
        !!global.__linuxOpts &&
          Array.isArray(global.__linuxOpts.mounts) &&
          "cmd" in global.__linuxOpts === false &&
          "network" in global.__linuxOpts === false,
        JSON.stringify(Object.keys(global.__linuxOpts || {})),
      );
      check(
        "root is an ext2 overlay mount",
        !!global.__linuxOpts &&
          global.__linuxOpts.mounts.some((m) => m.type === "ext2" && m.path === "/"),
        JSON.stringify((global.__linuxOpts || {}).mounts),
      );
      check(
        "proc and dev are mounted",
        !!global.__linuxOpts &&
          global.__linuxOpts.mounts.some((m) => m.path === "/proc") &&
          global.__linuxOpts.mounts.some((m) => m.path === "/dev"),
        JSON.stringify((global.__linuxOpts || {}).mounts),
      );
      check(
        "no network by default (sandbox)",
        !global.__linuxOpts || !global.__linuxOpts.networkInterface,
        JSON.stringify(global.__linuxOpts && global.__linuxOpts.networkInterface),
      );
      check(
        "console attached via setCustomConsole with a geometry",
        !!lastConsole && lastConsole.cols > 0 && lastConsole.rows > 0,
        JSON.stringify(lastConsole && [lastConsole.cols, lastConsole.rows]),
      );
      check(
        "an interactive shell is started with run()",
        Array.isArray(global.__runCalls) &&
          global.__runCalls.some(([f, a]) => f === "/bin/sh" && a.indexOf("-i") >= 0),
        JSON.stringify(global.__runCalls),
      );
      check(
        "the interactive run() was not awaited away",
        !!xterm() && xterm().text().indexOf("sh-5.2#") >= 0,
        JSON.stringify(xterm() && xterm().text().slice(0, 40)),
      );

      // ── exec: type the command, read it back between sentinels ─────────────
      ttyLog.length = 0;
      sock._recv({ type: "exec", id: "e1", cmd: "echo hello", timeout_ms: 5000 });
      await drain(300);
      const result = parseSent().find((m) => m && m.type === "exec_result" && m.id === "e1");
      check("exec_result returned upstream", !!result, JSON.stringify(sock.sent.slice(-3)));
      check(
        "exec_result carries the command output",
        result && result.stdout === "echo hello: ok\n" && !/\r/.test(result.stdout),
        JSON.stringify(result),
      );
      check("exec_result exit code is 0", result && result.exit === 0);
      check(
        "the sentinel markers never leak into stdout",
        result && !/\x1b\]999;/.test(result.stdout),
        JSON.stringify(result && result.stdout),
      );
      check(
        "the command was typed as individual keycodes ending in Enter",
        typedText().indexOf("echo hello\n") >= 0,
        JSON.stringify(typedText()),
      );
      check(
        "exec silences the tty echo before the command",
        typedText().indexOf("stty -echo") >= 0,
        JSON.stringify(typedText().slice(0, 60)),
      );
      check(
        "exec blanks PS1 so prompts stay out of the capture",
        typedText().indexOf('PS1=""') >= 0,
        JSON.stringify(typedText().slice(0, 120)),
      );
      check(
        "exec restores the tty afterwards",
        typedText().indexOf("stty echo") > typedText().indexOf("stty -echo"),
        JSON.stringify(typedText().slice(-60)),
      );
      // The panel dims its agent banners with SGR codes, so compare on plain text.
      const ttyText = () =>
        xterm()
          .text()
          .replace(/\u001b\[[0-9;]*m/g, "");
      check(
        "agent command echoed into the shared tty",
        ttyText().indexOf("[agent] echo hello") >= 0,
        ttyText(),
      );
      check(
        "agent output appears in the shared tty exactly once",
        ttyText().split("echo hello: ok").length - 1 === 1,
        ttyText(),
      );
      check(
        "agent exit line echoed into the shared tty",
        ttyText().indexOf("[agent] exit 0") >= 0,
        ttyText(),
      );
      check(
        "footer shows the agent ran something",
        /agent/.test(open("#bv-term").querySelector("#bv-term-agent").textContent),
        open("#bv-term").querySelector("#bv-term-agent").textContent,
      );

      // ── exec must not relocate the user's own shell ───────────────────────
      // The user parks their shell in /tmp, then the agent runs something with
      // cwd=/root. If exec did not save and restore the directory, the user
      // would silently be moved out of the directory they were working in.
      sock._recv({ type: "term:data", data: "cd /tmp\n" });
      await drain(30);
      check(
        "the user can move their own shell around",
        fakeTty.pwd === "/tmp",
        "pwd=" + fakeTty.pwd,
      );
      sock._recv({ type: "exec", id: "cw", cmd: "pwd", cwd: "/root", timeout_ms: 5000 });
      await drain(300);
      const cwdRun = parseSent().find((m) => m && m.type === "exec_result" && m.id === "cw");
      check(
        "the agent's command runs in the cwd it asked for",
        cwdRun && /^\/root/.test(cwdRun.stdout),
        JSON.stringify(cwdRun),
      );
      sock._recv({ type: "term:data", data: "pwd\n" });
      await drain(40);
      check(
        "the user's own shell is left where they put it",
        fakeTty.pwd === "/tmp",
        "pwd=" + fakeTty.pwd,
      );

      // ── User keystrokes: the dock and the native panel share one path ───────
      ttyLog.length = 0;
      sock._recv({ type: "term:data", data: "ls\n" });
      await drain(20);
      check(
        "native dock keystrokes reach the guest as keycodes",
        ttyLog.some(([k, d]) => k === "send" && d === 108) && ttyLog.some(([k, d]) => k === "send" && d === 13),
        JSON.stringify(ttyLog),
      );
      check(
        "tty echo is mirrored upstream to the relay",
        sock.sent.some((x) => String(x).indexOf("ls") >= 0),
        JSON.stringify(sock.sent.slice(-4)),
      );
      // Typing in our own xterm must take the identical path.
      ttyLog.length = 0;
      xterm().type("id\n");
      await drain(20);
      check(
        "typing in the dock reaches the guest too",
        typedText() === "id\n",
        JSON.stringify(typedText()),
      );
      // The relay may base64-encode frames; they must decode before the tty.
      ttyLog.length = 0;
      sock._recv({
        type: "term:data",
        data: Buffer.from("pwd\n").toString("base64"),
        enc: "b64",
      });
      await drain(20);
      check(
        "base64 terminal frames decode before the tty",
        typedText() === "pwd\n",
        JSON.stringify(typedText()),
      );
      // A tty keycode is one byte, so non-ASCII has no representation. It must
      // be dropped and said out loud, not silently mangled into the command.
      ttyLog.length = 0;
      sock._recv({ type: "term:data", data: "café\n" });
      await drain(20);
      check(
        "non-ASCII input is dropped, not guessed at",
        typedText() === "caf\n",
        JSON.stringify(typedText()),
      );
      check(
        "the dropped characters are reported in the dock",
        /1 character was dropped/.test(
          (open("#bv-term").querySelector("#bv-term-note") || { textContent: "" }).textContent,
        ),
        (open("#bv-term").querySelector("#bv-term-note") || { textContent: "" }).textContent,
      );

      // A hung command must time out rather than wedge the relay forever, and
      // the interrupt that recovers it has to restore everything, not just the
      // echo: a hung command never reaches the wrapper's own restore line.
      sock._recv({ type: "term:data", data: "cd /var/tmp\n" });
      await drain(30);
      sock._recv({ type: "exec", id: "e2", cmd: "hang:forever", cwd: "/root", timeout_ms: 60 });
      await drain(400);
      const timedOut = parseSent().find((m) => m && m.type === "exec_result" && m.id === "e2");
      check("hung command still returns a result", !!timedOut, JSON.stringify(sock.sent.slice(-4)));
      check(
        "hung command reports a failure exit",
        timedOut && timedOut.exit !== 0,
        JSON.stringify(timedOut),
      );
      check(
        "hung command says why",
        timedOut && /timed out/i.test(timedOut.stderr),
        JSON.stringify(timedOut),
      );
      check(
        "a timeout still restores the user's cwd",
        fakeTty.pwd === "/var/tmp",
        "pwd=" + fakeTty.pwd,
      );
      check(
        "a timeout still restores the tty echo",
        fakeTty.echo === true,
        "echo=" + fakeTty.echo,
      );

      // Output past the clip limit must be truncated on the way upstream.
      sock._recv({ type: "exec", id: "e3", cmd: "flood:big", timeout_ms: 5000 });
      await drain(600);
      const flooded = parseSent().find((m) => m && m.type === "exec_result" && m.id === "e3");
      check("flooded command returns a result", !!flooded);
      check(
        "flooded output is clipped",
        flooded &&
          flooded.stdout.length < 600 * 1024 &&
          /truncated by browser-vm/.test(flooded.stdout),
        flooded && flooded.stdout.length + " bytes",
      );

      // CheerpX 1.3.9 delivers output one byte per writeFunc call, so a burst
      // that is not batched becomes one xterm write (and one relay frame) per
      // byte. That is the difference between a responsive dock and a tab that
      // locks up, so the batching is load-bearing and gets its own assertion.
      const floodTerm = fakeTerminals[fakeTerminals.length - 1];
      const floodWrites = floodTerm.written.length;
      const floodChars = floodTerm.written.reduce((n, c) => n + c.length, 0);
      check(
        "a byte-at-a-time burst is batched before it reaches xterm",
        floodChars > 100 * 1024 && floodWrites < floodChars / 100,
        floodChars + " chars in " + floodWrites + " write() calls",
      );

      // Two agent commands in flight at once would interleave on the one shared
      // tty, and each sentinel capture would swallow the other's output. The
      // agent can absolutely send them back to back, so they must be queued.
      sock._recv({ type: "exec", id: "q1", cmd: "echo first", timeout_ms: 5000 });
      sock._recv({ type: "exec", id: "q2", cmd: "echo second", timeout_ms: 5000 });
      await drain(400);
      const q1 = parseSent().find((m) => m && m.type === "exec_result" && m.id === "q1");
      const q2 = parseSent().find((m) => m && m.type === "exec_result" && m.id === "q2");
      check(
        "back-to-back execs both return",
        !!q1 && !!q2,
        JSON.stringify([q1 && q1.stdout, q2 && q2.stdout]),
      );
      check(
        "back-to-back execs do not capture each other",
        q1 && q2 && /first/.test(q1.stdout) && !/second/.test(q1.stdout) &&
          /second/.test(q2.stdout) && !/first/.test(q2.stdout),
        JSON.stringify([q1 && q1.stdout, q2 && q2.stdout]),
      );

      // A non-zero exit must survive the sentinel round-trip.
      sock._recv({ type: "exec", id: "e4", cmd: "fail:7", timeout_ms: 5000 });
      await drain(300);
      const failed = parseSent().find((m) => m && m.type === "exec_result" && m.id === "e4");
      check("a non-zero exit code is reported", failed && failed.exit === 7, JSON.stringify(failed));
      check(
        "stderr is merged into stdout, as a tty actually behaves",
        failed && failed.stderr === "" && failed.stdout.indexOf("err") >= 0,
        JSON.stringify(failed),
      );

      // Multi-byte UTF-8 output arrives one byte at a time, so it has to be
      // decoded as a stream or every non-ASCII character is mojibake.
      sock._recv({ type: "exec", id: "e5", cmd: "utf8:show", timeout_ms: 5000 });
      await drain(300);
      const uni = parseSent().find((m) => m && m.type === "exec_result" && m.id === "e5");
      check(
        "multi-byte UTF-8 output survives per-byte delivery",
        uni && uni.stdout === "héllo → ✓\n",
        JSON.stringify(uni && uni.stdout),
      );

      // Resize must reach xterm *and* be re-announced to the guest, because
      // setCustomConsole is also the geometry channel.
      const podBefore = lastConsole.pod._custom.length;
      sock._recv({ type: "term:resize", cols: 100, rows: 40 });
      await drain(20);
      check(
        "resize reaches the terminal",
        xterm().cols === 100 && xterm().rows === 40,
        xterm().cols + "x" + xterm().rows,
      );
      check(
        "resize re-announces the geometry to the pod",
        lastConsole.pod._custom.length > podBefore &&
          lastConsole.cols === 100 &&
          lastConsole.rows === 40,
        JSON.stringify(lastConsole.pod._custom),
      );
      check(
        "input still works after a resize",
        (() => {
          ttyLog.length = 0;
          sock._recv({ type: "term:data", data: "z" });
          return ttyLog.some(([k, d]) => k === "send" && d === 122);
        })(),
      );
      // term:require is how the native dock asks for a pod; it must ack.
      sock._recv({ type: "term:require", chat_id: "chat-abc123" });
      await drain(50);
      const acked = sock.sent.some((x) => String(x).indexOf("term:ready") >= 0);
      check("term:require acks with term:ready", acked, JSON.stringify(sock.sent.slice(-3)));
    } else {
      check("mock adapter has no console to drive", lastConsole === null);
      check("mock adapter reports no console in the dock", /no console/i.test(open("#bv-term").querySelector("#bv-term-state").textContent));
    }
  } catch (e) {
    failures.push("collaboration threw: " + e.message);
  }

  // ── Freshness: the pod is torn down and rebuilt on reset ───────────────────
  try {
    if (MODE === "cheerpx") {
      const deletedBefore = global.__cxDeleted || 0;
      const termsBefore = fakeTerminals.length;
      const dockOpen = vm.isTerminalOpen();
      await vm.reset();
      check(
        "reset tears the old pod down with delete()",
        (global.__cxDeleted || 0) > deletedBefore,
        deletedBefore + " -> " + global.__cxDeleted,
      );
      check("reset leaves a ready pod", vm.getState().ready === true, JSON.stringify(vm.getState()));
      check("reset builds a fresh terminal", fakeTerminals.length > termsBefore);
      check(
        "the old terminal was disposed",
        fakeTerminals[termsBefore - 1].disposed === true,
      );
      check(
        "the fresh console is wired to the fresh pod",
        lastConsole && lastConsole.pod !== fakeTerminals[termsBefore - 1],
        "",
      );
      if (dockOpen) {
        check(
          "the dock re-adopts the fresh terminal",
          open("#bv-term")
            .querySelector("#bv-term-body")
            .contains(fakeTerminals[fakeTerminals.length - 1].element),
        );
        // A reset that leaves the guest tty dead would be silently useless: the
        // dock would look identical but nothing would respond to typing.
        ttyLog.length = 0;
        lastSock()._recv({ type: "term:data", data: "q" });
        await drain(30);
        check(
          "the fresh pod answers input after a reset",
          ttyLog.some(([k, d]) => k === "send" && d === 113),
          JSON.stringify(ttyLog),
        );
      }
    } else {
      await vm.reset();
      check(
        "reset leaves a ready pod (mock)",
        vm.getState().ready === true,
        JSON.stringify(vm.getState()),
      );
    }
  } catch (e) {
    failures.push("reset threw: " + e.message);
  }

  // ── Chat switch re-registers against the new chat ──────────────────────────
  try {
    // Dismiss the terminal FIRST, so the switch has a dismissal to clear.
    // Without that, "a chat switch clears a dismissal" would pass vacuously —
    // the flag was never set — and the per-chat reset would go untested.
    vm.closeTerminal();
    await drain(30);
    check(
      "the terminal is dismissed before the switch",
      vm.getState().dismissed === true,
      JSON.stringify(vm.getState()),
    );
    const before = wsInstances;
    global.location.pathname = "/c/chat-xyz789";
    // setInterval is captured, not run: drive the watcher by hand.
    const watch = intervals.find((h) => h.ms === 800 && !h.cleared);
    check("chat watcher is installed", !!watch);
    if (watch) safe(watch.f);
    await drain(40);
    check("chat switch opens a new socket", wsInstances > before, before + " -> " + wsInstances);
    check(
      "old socket was dropped",
      sockets[0].readyState === 3,
      "readyState=" + sockets[0].readyState,
    );
    check(
      "new socket targets the new chat",
      lastSock().url.includes("chat_id=chat-xyz789"),
      lastSock().url,
    );
    check(
      "getState follows the route",
      vm.getState().chatId === "chat-xyz789",
      JSON.stringify(vm.getState()),
    );
    // The pod is per-chat, so the terminal is too: a new conversation gets its
    // own terminal rather than inheriting the previous one's dismissal.
    await drain(400);
    check(
      "a chat switch brings the terminal back up",
      vm.isTerminalOpen() === true,
      JSON.stringify(vm.getState()),
    );
    check(
      "a chat switch clears a dismissal",
      vm.getState().dismissed === false,
      JSON.stringify(vm.getState()),
    );
    check(
      "a chat switch clears the badge",
      vm.getState().unseenAgentRuns === 0,
      JSON.stringify(vm.getState()),
    );
    check(
      "the new chat gets its own pod",
      vm.getState().ready === true,
      JSON.stringify(vm.getState()),
    );
  } catch (e) {
    failures.push("chat switch threw: " + e.message);
  }

  // ── The browser re-registers across navigation (agent reachability) ────────
  // Sharing is always on, so navigating to a new chat must drop the old relay
  // socket and re-register on the new chat — otherwise the agent's exec would
  // hit a browser registered for the wrong chat (no_browser).
  try {
    const before = wsInstances;
    global.location.pathname = "/c/chat-nav123";
    const watch = intervals.find((h) => h.ms === 800 && !h.cleared);
    if (watch) safe(watch.f);
    await drain(40);
    check("sharing stays on across a chat switch", vm.shareEnabled() === true);
    check("getState reports share on", vm.getState().share === true);
    check(
      "a socket is (re)opened for the new chat",
      wsInstances > before,
      before + " -> " + wsInstances,
    );
    check(
      "the socket targets the new chat",
      lastSock().url.includes("chat_id=chat-nav123"),
      lastSock().url,
    );
  } catch (e) {
    failures.push("re-register-across-navigation threw: " + e.message);
  }

  // ── Terminal switch keeps ONE shared console (webvm <-> docker) ─────────────
  // Runs LAST because it opens Docker sockets that would perturb the socket
  // counting above. The Sep-28 switch disposed the shared xterm and re-inited in
  // the wrong order, so Docker had nothing to draw into and WebVM was dead after
  // switching back. The console must be reused, never disposed, across a switch.
  if (MODE === "cheerpx") {
    try {
      const toggle = (t) =>
        open("#bv-vmbar").querySelectorAll(".bv-terminal-toggle").find((b) => b.dataset.type === t);
      const termsBefore = fakeTerminals.length;
      const consoleTerm = fakeTerminals[fakeTerminals.length - 1];

      await vm.switchTerminal("docker");
      await drain(30);
      check("switch to docker reports ready", vm.getState().ready === true, JSON.stringify(vm.getState()));
      check(
        "docker session created via the OpenWebUI proxy",
        global.fetchCalls.some((c) => c.url.includes("/terminals/docker-term/")),
        JSON.stringify(global.fetchCalls.slice(-1)),
      );
      const dockerSock = sockets[sockets.length - 1];
      check(
        "docker connects to its own PTY socket, not /vm-bridge",
        dockerSock.url.includes("docker-term"),
        dockerSock.url,
      );
      // The auth frame MUST carry chat_id: OpenWebUI's proxy reads it to resolve
      // the chat context and forward X-Session-Id to the relay. Without it the
      // relay closes the session and the terminal is dead.
      dockerSock._open();
      await drain(10);
      const dockerAuth = dockerSock.sent
        .map((s) => { try { return JSON.parse(s); } catch (_) { return null; } })
        .find((m) => m && m.type === "auth");
      check("docker auth frame carries the chat_id", !!dockerAuth && !!dockerAuth.chat_id, JSON.stringify(dockerAuth));
      check("docker toggle is marked active", !!toggle("docker") && toggle("docker").classList.contains("active"));
      check(
        "switching to docker reuses the same console (no new terminal)",
        fakeTerminals.length === termsBefore,
        termsBefore + " -> " + fakeTerminals.length,
      );
      check("the shared console is not disposed on switch", consoleTerm.disposed === false);

      // Agent exec must route to the ACTIVE terminal: with Docker active it runs
      // server-side via the container relay's /api/cmd (captured output), not the
      // in-browser CheerpX pod.
      global.fetchCalls.length = 0;
      const dockerExecResult = await vm.exec("whoami");
      check(
        "agent exec on docker hits the container relay /api/cmd",
        global.fetchCalls.some((c) => c.url.includes("/api/cmd")),
        JSON.stringify(global.fetchCalls.map((c) => c.url)),
      );
      check(
        "agent exec carries the command + chat_id to /api/cmd",
        (() => {
          const call = global.fetchCalls.find((c) => c.url.includes("/api/cmd"));
          if (!call) return false;
          const b = JSON.parse(call.opts.body);
          return b.command === "whoami" && !!b.chat_id;
        })(),
      );
      check(
        "agent exec on docker returns the captured output",
        dockerExecResult && dockerExecResult.stdout === "agent-ran\n",
        JSON.stringify(dockerExecResult),
      );

      await vm.switchTerminal("webvm");
      await drain(30);
      check("switch back to webvm reports ready", vm.getState().ready === true, JSON.stringify(vm.getState()));
      check("webvm toggle is marked active", !!toggle("webvm") && toggle("webvm").classList.contains("active"));
      check(
        "the round-trip kept exactly one console alive",
        fakeTerminals.length === termsBefore && consoleTerm.disposed === false,
        termsBefore + " -> " + fakeTerminals.length + " disposed=" + consoleTerm.disposed,
      );
      // The "unresponsive after switching back" bug: WebVM must answer input.
      ttyLog.length = 0;
      consoleTerm.type("x\n");
      await drain(20);
      check(
        "webvm answers keystrokes after the round-trip",
        ttyLog.some(([k, d]) => k === "send" && d === 120),
        JSON.stringify(ttyLog),
      );
    } catch (e) {
      failures.push("terminal switch threw: " + e.message);
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  report();
}

// Shared exit path, so the nocheerpx mode reports exactly like the others.
function report() {
  console.log("PASS (" + ok.length + ")");
  ok.forEach((n) => console.log("  [PASS] " + n));
  if (failures.length) {
    console.log("FAIL (" + failures.length + ")");
    failures.forEach((n) => console.log("  [FAIL] " + n));
    process.exit(1);
  }
  console.log("ALL PASS");
  process.exit(0);
}

main();
