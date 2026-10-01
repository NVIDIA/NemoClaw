# browser-vm — Browser Terminal Bridge for OpenWebUI

Ephemeral Linux VMs that run **in the user's browser tab** (CheerpX/WebVM),
bridged to OpenWebUI v0.11.4's native **Open Terminal** panel and exposed to
the model as an OpenWebUI Tool. Implemented per the "Browser Terminal Bridge"
plan with the relay re-scoped as an Open-Terminal-compatible **terminal
server**.

Deliberately **no scripts run on the relay host**: the CheerpX VM is a
user-mode WebAssembly sandbox inside Chromium. The relay only routes frames
and (optionally) proxies a network via CheerpX.Network.

```
┌────────────┐   https://supachad.com/vm-bridge  ┌───────────────────────┐
│ Chromium   │  WS: register /exec /term:data    │ browser-vm-relay      │
│  loader.js │◄───────────────┐                  │  (fastapi+uvicorn)    │
│  CheerpX   │  CheerpX boot  │                  └──────────┬────────────┘
└────────────┘  (no code here│)   POST /api/cmd  (HTTP, Bearer)  │ WS /api/terminals/{id}
   untrusted sandbox         │                ┌────────────────┘  (X-Session-Id = chat_id,
                             │                │                   first-message auth)
                       ┌─────▼──────┐  ┌──────▼─────────────┐
                       │ OWUI Tool  │  │ OpenWebUI terminal  │
                       │ browser_shell ─  (v0.11.4 native    │
                       └────────────┘   xterm panel)         ┘
```

## Layout

```
relay/relay.py          FastAPI daemon: /vm (browser WS), /api/terminals/{id}
                        (native WS bridge), POST /api/cmd (tool HTTP), /files/*
                        (Open Terminal sidebar), /api/status, /api/config,
                        /api/debug/registry, /healthz
relay/requirements.txt
owui-tool/browser_shell.py   OpenWebUI Tool: browser_shell(command, cwd, timeout_ms),
                             browser_vm_status()  -> POSTs to relay /api/cmd
loader/vm-panel.js      Appended to static/loader.js by build.sh; CheerpX+WS client,
                        status bar, floating terminal dock, composer chip,
                        window.__owuiVm API. The CheerpX adapter is written
                        against the real 1.3.9 API — see "CheerpX 1.3.9 API
                        reality" below before changing makeCheerpxAdapter().
loader/loader-source.js Verbatim current static/loader.js (chad-shim v3).
loader/build.sh         Merges loader-source.js + vm-panel.js -> ../../static/loader.js
                        (bind-mounted into the container at /app/build/static/loader.js).
                        Gates the merge: node --check, duplicate-`case` check,
                        entry-point/hook greps, and the smoke test.
loader/test_vm_panel.js  Headless smoke test: runs the real vm-panel.js IIFE
                        against a stub DOM in two modes (mock pod, and a fake
                        CheerpX 1.3.9 that models writeFunc-per-byte, keycode
                        input, and a guest tty) and asserts the dock, chip,
                        share toggle, exec capture, reset, and the
                        agent<->user terminal bridge. 216 assertions.
                        Run: `node test_vm_panel.js` (no args — it fans out to
                        both modes itself).
test/                   mock_browser.py (headless pod), mock_tool.py (tool stand-in),
                        test_e2e.py (full protocol suite; see below).
deploy/                 relay.Dockerfile, relay-compose.yml, routes-notice.md.
```

## Two terminals, one VM

Both terminal surfaces drive the **same** CheerpX pod for a chat, so the user
and the agent share one machine and one scrollback:

| Surface | Entry point | How it reaches the VM |
|---|---|---|
| **Floating dock** (`#bv-term`) | **opens by itself** once a chat is open (see below); the terminal icon in `#bv-vmbar` toggles it | our own xterm.js, fed by `setCustomConsole(writeFunc, …)` and read back by xterm's `onData` |
| **Native Open Terminal panel** | OpenWebUI's own panel | relay `WS /api/terminals/{id}` → `term:data` frames → the same tty |
| **Agent** | `browser_shell(command, cwd, timeout_ms)` tool | `POST /api/cmd` → `exec` frame → same pod, same tty |

Both keyboard paths converge on one function (`writeTerm` → `textToKeycodes`),
so the dock and the native panel are the same tty by construction rather than by
convention. `execRequest` writes `[agent] <cmd>` and `[agent] exit N` into the
tty so the agent's work is visible as it happens — but deliberately **not** the
command's stdout, which would print twice (the shell already wrote it) and is
long enough to swamp the scrollback.

### Composer chip — what the agent is allowed to drive

The chip next to the chat input (`#bv-chip`) is the per-chat control for
"what does the agent get". It toggles `browser_shell` sharing on and off:

- **on** — the chat is registered with the relay, so `browser_shell` runs in
  this tab's VM.
- **off** — `dropRelay()` unregisters the chat, so `browser_shell` gets an
  explicit `no_browser` ("open the VM to let me use it") instead of silently
  sharing a VM the user switched off. `connectRelay()` also refuses to
  re-register while sharing is off, so the setting survives navigation.

It persists in `localStorage` under `bv.shareWithAgent` and defaults to on
(`CFG.shareWithAgent`). Pick the terminal from the chip's menu, and the dock
opens alongside it.

OWUI's own terminal dropdown is deliberately *not* used for this: it is gated
on an internal `$selectedTerminalId` Svelte store that only a user click can
set, which is exactly why a correctly-seeded install still showed "no terminal
configured". See `seed-terminal-config.py` below.

### Auto-open — why the terminal is already there

The dock opens and the pod boots **on page load and on every chat switch**,
without waiting for a click (`CFG.autoOpen`, default `true`).

It used to be lazy: `start()` set the bar to `VM: <chat> (boot on demand)` and
booted nothing until you clicked. That was wrong. The agent's commands still
ran — `execRequest` calls `ensureBooted()`, so the pod booted and the output
was written into the xterm — but the dock had never been opened, so the user
saw an agent running commands with no terminal and no explanation. For a
*shared* terminal the worst failure mode is silence, because it reads as
"broken" rather than "hidden". The cost of booting eagerly is one cached disk
image per browser profile, which is not a reason to hide the feature.

Three gates, all in `shouldAutoOpen()`:

- `CFG.autoOpen` — set `window.__BROWSER_VM = { autoOpen: false }` to go back
  to lazy.
- `shareEnabled()` — never open a terminal the agent is not allowed to drive.
- `!STATE.dismissed` — closing it is a decision, so `closeTerminal()` always
  records one. There is no "close but keep auto-opening" case; the only ways
  back are opening it yourself or switching chat. A chat switch clears both the
  dismissal and the badge, because the pod is per-chat and a stale count would
  describe runs from a conversation that no longer has a terminal.

**Badge.** `#bv-vmbar-term` carries a red count of agent runs that happened
while the dock was closed, cleared by opening it (and the button pulses). The
output still lands in the xterm and in the relay mirror — the badge only makes
it *discoverable*, so the silent-output failure cannot recur. It counts runs,
not writes: one exec writes several lines into the tty (the `[agent]` banner,
any stderr, the exit line) and would otherwise inflate the count.

`getState()` reports `autoOpen`, `dismissed` and `unseenAgentRuns`, and
`__owuiVm.shouldAutoOpen()` is exposed, so all of it is assertable from the
page console.

## Wire protocol (relay ↔ browser)

- **Browser → relay** (`/vm?chat_id=…&token=…`): `{"type":"register","chat_id","client"}`
  (first frame), `{"type":"pong"}`, `{"type":"exec_result","id","exit","stdout","stderr"}`,
  `{"type":"reset_ack","id"}`. Any *non-JSON* frame is terminal bytes from the
  VM/console.
- **relay → browser**: `{"type":"exec","id","cmd","cwd","timeout_ms"}`,
  `{"type":"term:data","data"}` (keystrokes from a bridged native terminal;
  `enc:"b64"` when the relay received raw bytes — the browser decodes to a
  byte-string, not UTF-8, so multi-byte paste survives),
  `{"type":"term:require"}` (native dock attached → boot + `term:ready` ack),
  `{"type":"term:resize","rows","cols"}`,
  `{"type":"ping"}` (every `KEEPALIVE_SECONDS`=15), `{"type":"error","id","message"}`.

## Native terminal leg (Open WebUI panel)

OWUI proxies to `/{server_id}/api/terminals/{session_id}` with headers
`X-Session-Id` (the chat id) and `X-Terminal-Context-Id`; first frame must be
`{"type":"auth","token":"<RELAY_API_KEY>"}`, then raw bytes flow in each
direction. The relay resolves the chat id from `X-Session-Id` and bridges to
that chat's browser pod.

## Tool HTTP leg

`POST /api/cmd` `{"chat_id","command","cwd","timeout_ms"}` with
`Authorization: Bearer <RELAY_API_KEY>`:

- 200 `{"ok":true,"id","exit","stdout","stderr"}`
- 409 `{"error":"no_browser"}` — user's VM not open; tool tells the user to
  open this chat in a browser and open the Local VM terminal
- 504 `{"error":"timeout"}` — VM did not finish in time
- 401 bad/missing key · 400 bad payload · 400 too-long command

One **primary** browser pod per chat; a second `/vm` connection for the same
chat is rejected (close code 4009).

## Open Terminal file API leg

The stock Open WebUI Web Terminal sidebar file browser calls
`/files/cwd`, `/files/list`, `/files/read`, `/files/view`, `/files/mkdir`,
`/files/move`, `/files/delete`, `/files/search`, `/files/matches`,
`/files/glob`, and `POST /files/upload`. OWUI proxies them via
`/api/v1/terminals/{server_id}/{path}` (forwarding `X-Session-Id`, the chat
id, and passing the connection key as the Bearer). The relay implements the
open-terminal REST contract — **executing every operation inside the user's
VM** via the same exec plumbing as `/api/cmd`, never touching the files on the
host:

- `GET /files/cwd` → `{"cwd","home"}`; `POST /files/cwd {"path"}` → `{"cwd"}`
- `GET /files/list?directory=` → `{"dir","writable","entries":[{name,type,size,modified,writable}]}`
- `GET /files/read?path=[&start_line=&end_line=]` → `{"path","total_lines","content"}`
  (images returned as binary) · `GET /files/view?path=` → raw bytes
- `POST /files/mkdir {"path"}`, `POST /files/move {"source","destination"}`,
  `DELETE /files/delete?path=` → open-terminal-shaped responses
- `GET /files/search` / `/files/matches` → grep-backed `{"results":[...]}`
- `GET /files/glob` → `{find,path,matches}`-backed `{"path","matches":[{path,name}]}`
- `POST /files/upload` (multipart `file` field, `?directory=`) → `{"path","size"}`

File reads are capped at `FILE_READ_CAP` (350 KiB — below the browser's exec
stdout clip of 524288 B); uploads cap at `UPLOAD_MAX_BODY` (2 MiB). All ops
require the relay Bearer key; all are scoped to the chat in `X-Session-Id`
(400 without it, 409 when that chat has no connected VM).

## Execute + ports (TerminalDock)

The terminal dock's "execute" box and port list use open-terminal's
`/execute` and `/ports` contract, executed inside the VM:

- `GET /execute` → chat's recent commands `[{id,command,status,exit_code,log_path}]`
  (`[]` even with no VM — poll-safe); `POST /execute {"command","cwd"}` runs it
  synchronously (`?wait=` window, `{"id","status","exit_code","output"}`
  where `output` = `[{type,data}]`) → 409 when the VM isn't open
- `GET /execute/{id}/status?offset=` (partial output+`next_offset`),
  `POST /execute/{id}/input` (400 — execs are synchronous),
  `DELETE /execute/{id}` → `{"status":"killed"}`
- `GET /ports` → `{"ports":[{port,pid,process}]}` from the VM's
  `/proc/net/tcp[6]` (`{"ports":[]}` when no VM)

## Config

Env (see `relay/relay.py` defaults): `RELAY_PORT=8787`, `RELAY_API_KEY`
(required in prod; also authenticates native leg), `RELAY_WS_KEY` (defaults to
API key; browser token), `RELAY_LOG_VERBOSE`, `RELAY_BOOT_WAIT_SECONDS=120`,
`RELAY_EXEC_GRACE_SECONDS=5`, `RELAY_MAX_COMMAND_LENGTH=100000`,
`RELAY_MAX_OUTPUT_BYTES=524288`, `KEEPALIVE_SECONDS=15`.

Browser loader config: `window.__BROWSER_VM = { relay, token, cheerpxUrl,
imageWs, network }` — defaults covered in `loader/vm-panel.js`. The chat chip
takes `shareWithAgent` (default `true`) and `terminalName` (default
`"Browser VM"`).

## CheerpX 1.3.9 API reality — and what the adapter now does about it

Verified 2026-09-27 against the shipped package
(`@leaningtech/cheerpx@1.3.9`, whose `index.js` is a ~580-byte ESM shim
re-exporting `https://cxrtnc.leaningtech.com/1.3.9/cx.esm.js`, 376,708 bytes).
`makeCheerpxAdapter()` has been rewritten against that surface. The short
version of why it had to be:

**1. The CDN URL 404s.** The old `CFG.cheerpxUrl` pointed at
`.../cheerpx@latest/build/cheerpx.min.js`, which does not exist. The package
ships only `index.js` and `index.d.ts`. `resolveAdapter()` used to swallow the
failure and fall through to `makeMockAdapter()`, so the dock silently ran a
**mock** pod with no terminal — the literal source of
`No console available in this VM.` The adapter now imports the ESM shim
(pinned to `1.3.9`) and, on failure, **says so on the bar and in the console**
instead of quietly degrading.

**2. The API is nothing like what the old adapter assumed.** `Linux` has exactly:

```ts
static create(optionals?: {mounts?, networkInterface?}): Promise<Linux>
delete(): void
run(fileName, args, optionals?): Promise<{status: number}>
setActivateConsole(activateFunc): EventListener
setConsole(e: HTMLElement): void
setCustomConsole(writeFunc: (buffer: Uint8Array, vt: number) => void,
                 columns: number, rows: number): (keyCode: number) => void
registerCallback(eventName, callback): void
unregisterCallback(eventName, callback): void
```

| Old assumption | 1.3.9 reality | What the adapter does now |
|---|---|---|
| `CheerpX.XtermConsole` | **absent** — zero occurrences in the bundle | loads its own xterm.js (pinned, below) |
| `con.element`, `con.terminal` | absent (`setConsole` takes a raw `HTMLElement`) | `STATE.console = {el, term, fit, sink, send}` |
| `cx.stdin.getWriter().write()` | **no `stdin`** | all input goes through the handler `setCustomConsole` returns |
| `cx.spawn(sh, ["-c", cmd])` → `p.getStdout()` | **no `spawn`**; `run()` resolves `{status}` only | `exec` types into the tty and reads the console back (see below) |
| `Linux.create({mounts, network, cmd})` | `create({mounts, networkInterface})`; no `cmd` | `run("/bin/sh", ["-i"], …)` after `create` |
| output pushed out of a console node | arrives via `setCustomConsole(writeFunc, …)` | `makeOutputSink()` → batching + streaming decode |
| bytes in, bytes out | **input is keycodes** | `textToKeycodes()` translates xterm's `onData` |
| `close()` / `destroy()` | **`delete()`** | `teardown()` calls `delete()`; the old names silently leaked the worker on every reset |

### Pinned frontend dependencies

1.3.9 hands output to us and takes keycodes back, so there is no third-party
console node to adopt — the dock hosts its own xterm.js. All four are pinned and
all four are self-contained (no bare imports, so they need no bundler):

| What | URL |
|---|---|
| CheerpX | `cdn.jsdelivr.net/npm/@leaningtech/cheerpx@1.3.9/index.js` |
| xterm core | `cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/lib/xterm.mjs` |
| fit addon | `cdn.jsdelivr.net/npm/@xterm/addon-fit@0.11.0/lib/addon-fit.mjs` |
| xterm CSS | `cdn.jsdelivr.net/npm/@xterm/xterm@6.0.0/css/xterm.css` |

Pre-bundling hooks `window.__BROWSER_VM_CHEERPX` / `window.__BROWSER_VM_XTERM`
are checked *before* `import()`, so a page that already ships those libraries
does not pay for a second download — and so the headless test drives the exact
production code path.

### ⚠ Network is off by default — this is a capability change

`Linux.create` takes a `networkInterface` **object**, not a boolean, so the old
`network: true` was never a working value: it was silently ignored. The adapter
now defaults to **no network at all**:

```js
CFG.network = false;   // egress is an explicit opt-in
```

To give the pod egress, set a real interface before the VM boots:

```js
window.__BROWSER_VM = { network: { authKey: "…" } };
```

This is a deliberate change, not an oversight: it is a sandbox, and `true` was
never a value 1.3.9 accepted. It does mean commands that previously *looked*
like they had network will now fail to resolve — correctly, but visibly.

### How `exec` reads a command's output

1.3.9 has no stdout stream, no `spawn()` and no stdin, and `run()` resolves with
`{status}` only. The one channel carrying bytes both ways is the console, so
`exec` **types the command into the shared tty** and reads the output back
between two OSC 999 sentinels that xterm swallows (unknown OSC ⇒ no visible
output, and the markers never reach the relay mirror):

```
stty -echo
__bvps1="$PS1"; __bvcd="$PWD"; PS1=""; PS2=""
printf '\033]999;bv%s%s-b\007' 'a1b2' 'c3d4'                      # begin
cd '<cwd>' 2>/dev/null
<the bare command>
__bvrc=$?
printf '\033]999;bv%s%s-e\007' 'a1b2' 'c3d4' "$__bvrc"             # end + exit code
cd "$__bvcd" 2>/dev/null; PS1="$__bvps1"; stty echo
```

Details that are load-bearing, each covered by a mutation-tested assertion:

- **The sentinel token is split across two `printf` arguments.** With one
  argument the token appears verbatim in the command line, the tty's own echo
  matches it, and the capture swallows its own echo and returns nothing.
- **`stty -echo` first**, or the tty reflects the wrapper lines back into the
  captured text. `restoreTty()` puts echo back — and restores the cwd too,
  because a command that hung never reaches the script's own restore line.
- **The command is bare** — no braces, no subshell — so an unbalanced `}` or `)`
  in the command cannot break the wrapper.
- **The final line needs its trailing newline.** Without it the shell sits on
  the restore line *unexecuted*, so the cwd, PS1 and tty echo were never put
  back and every agent command silently relocated the user's own shell.
- **execs are serialised.** Two concurrent sentinel captures on one tty
  interleave and each swallows the other's output; the agent can fire commands
  back to back, so they queue.
- **Output is batched** (1.3.9 calls `writeFunc` *once per byte*) and decoded
  with a streaming `TextDecoder`, because multi-byte UTF-8 straddles callbacks.

### Known limitations

- **stdout and stderr are merged**, because a tty has one stream. They are
  reported in `stdout` with `stderr: ""`. Splitting them would be a lie the
  model would then reason from.
- **Non-ASCII input is dropped**, not guessed at: the keycode channel is one
  byte wide, so a `é` has no representable code. The drop is reported in the
  dock ("N characters were dropped…") rather than silently corrupting the
  command line.
- **`stty -echo` can survive a killed guest shell.** `restoreTty()` mitigates
  this but cannot guarantee it; Reset gives a clean tty.
- **exec races with concurrent user typing.** A random 8-character token makes
  forgery impossible; worst case is slight output pollution.

## Terminal config: one place, not two

> **Corrected 2026-09-27.** An earlier version of this file claimed the
> per-user list had to be seeded too. **That was wrong, and seeding it breaks
> the UI.** See below.

OpenWebUI's terminal dropdown has **two sections**, fed by two different
sources, and they are *not* two halves of one setting:

| Section | Source | Selected by | Reached via |
|---|---|---|---|
| **System** | `config` → `terminal_server.connections` (admin) | **id** | `{WEBUI_API_BASE_URL}/terminals/{id}` — same-origin backend proxy |
| **Direct** | `user.settings` → `ui.terminalServers` (per-user) | **url** | the `url` verbatim, straight from the browser |

Only the **admin** list is needed. `$terminalServers` is populated in
`(app)/+layout.svelte` from `GET /api/v1/terminals/` and the URLs are rewritten
to same-origin proxy paths, so the admin entry alone makes the terminal appear
and be selectable.

Seeding the **per-user** list as well is actively harmful, because
`+layout.svelte` *also* probes every enabled per-user entry **from the
browser** (`GET {url}{path}`, default `/openapi.json`). Our relay URL is a
Docker-internal name, `http://browser-vm-relay:8787`, which resolves only inside
the compose network. So on every page load the browser:

- toasts `Failed to connect to http://browser-vm-relay:8787 terminal server`, and
- lists the same connection a second time, under both **Direct** and **System**.

`scripts/openwebui/seed-terminal-config.py` therefore seeds the admin
connection and **prunes** per-user entries pointing at the relay:

```bash
python3 scripts/openwebui/seed-terminal-config.py           # dry run
python3 scripts/openwebui/seed-terminal-config.py --apply   # write (backs up first)
```

It reads the DB from `$WEBUI_DB` and the key from `$BROWSER_VM_RELAY_KEY` or
`scripts/openwebui/.env`, and never prints the key. Re-running is a no-op.
`scripts/openwebui-setup.sh` calls it as step 9e, so a fresh install is
correct out of the box.

Note `TERMINAL_SERVER_CONNECTIONS` in `docker-compose.yml` seeds
`terminal_server.connections` on the **first** boot of a fresh `webui.db` only,
and is silently ignored on every boot after that — which is why the seeder
script exists.

Users must reload the page (or re-open the chat) for settings changes to reach
the Svelte store.

## Verify locally (no browser / no CheerpX needed)

```bash
uv venv .venv && uv pip install --python .venv/bin/python -r relay/requirements.txt websockets
.venv/bin/python test/test_e2e.py          # boots relay on :18787, runs all legs
.venv/bin/python test/mock_browser.py --url ws://127.0.0.1:8787 --chat c1 --token test-key &
RELAY_API_KEY=test-key RELAY_WS_KEY=test-key .venv/bin/python relay/relay.py
.venv/bin/python test/mock_tool.py --chat c1 --cmd "uname -a" --key test-key --cwd /tmp
```

`test_e2e.py` asserts: 401 / 409 no_browser / 400, exec round-trip (200),
 exec timeout (504), native keystrokes reaching the pod (`term:data`) and pod
 output returning to the panel, status endpoint, browser bad-token rejection,
 and access-log query-string redaction.

 `test/prod_smoke.py` runs the same protocol checks against a **live deployed**
 relay on 127.0.0.1:8787 using the real key from `scripts/openwebui/.env`
 (never prints it): `.venv/bin/python test/prod_smoke.py`.

### Panel smoke test (no browser, no CheerpX)

```bash
cd scripts/openwebui/browser-vm/loader
node test_vm_panel.js            # runs both modes
```

Runs the real `vm-panel.js` against a stub DOM/WebSocket and asserts the dock
opens from the icon, the chip toggles sharing (and actually drops/reopens the
relay socket), the share setting survives a chat switch, `exec` output is
echoed into the shared tty, `term:data` (plain and base64) reaches the tty,
resize propagates, exec times out rather than hanging, and output is clipped.
Two modes: `mock` (pod with no console) and `cheerpx` (a fake CheerpX, which
exercises the real console-adoption path).

`loader/build.sh` runs this as a gate, so a panel that parses but throws on
load — or references a helper that does not exist — cannot ship. That is not
hypothetical: `b64ToBinary` was called but never defined, so every base64
keystroke from the native terminal threw a `ReferenceError` and typing in that
panel did nothing at all.

## Deploy

See `deploy/routes-notice.md` (cloudflared `/vm-bridge/*` route, no nginx),
`deploy/relay.Dockerfile`, `deploy/relay-compose.yml`. In short:

1. Add the `browser-vm-relay` service to `openwebui-net`, publish loopback
   `127.0.0.1:8787`.
2. `.env`: `BROWSER_VM_RELAY_KEY=<random>`. That is the only terminal setting
   that has to be in `.env` — everything else is written into `webui.db` by the
   seeder, which is the only thing that reliably reaches **both** config
   locations. Keep `TERMINAL_SERVER_CONNECTIONS` in compose for the first-boot
   case, but do not treat it as sufficient.
3. `python3 scripts/openwebui/seed-terminal-config.py --apply` (step 9e of
   `openwebui-setup.sh` does this).
4. CF dashboard: add public hostname path `/vm-bridge/*` →
   `http://host.docker.internal:8787`.
5. `loader/build.sh`, then make it live. The bind mount alone is **not**
   enough: `open_webui/config.py` copies `/app/build/static/*` into `STATIC_DIR`
   once at container boot, and `STATIC_DIR` is what gets served. So either

   ```bash
   docker cp scripts/openwebui/static/loader.js \
     nemoclaw-openwebui:/app/backend/open_webui/static/loader.js   # live patch
   # or
   docker restart nemoclaw-openwebui                               # boot copy
   ```

   Then hard-reload the browser. `openwebui-setup.sh` step 9b does the first
   automatically. Note `docker cp` into `/app/build/static/loader.js` fails
   with `device or resource busy` — it is a live mount, which is the point.
6. Enable the **Browser VM shell** tool on the chat and reload. The terminal
   opens on its own and the pod boots; the native Open Terminal panel bridges
   the same VM. The terminal icon in the bottom-right bar toggles the dock.

## Security properties

- No command execution on the relay / OpenWebUI host — CheerpX (WASM) is the
  entire sandbox.
- Secrets must never enter the VM: the container env holds a live
  `OPENAI_API_KEY`; the loader must not pipe host environment into the disk
  image. Disk image is public `debian-trixie-mxl.ext2` from `disks.webvm.io`
  (network loaded, freshness policy per plan §9).
- Per-chat isolation: fresh VM per chat; VM state is memory-only (persistence
  is Phase 2 / M5 deferred). CheerpX is free for non-commercial homelab use
  (plan §14).
- Relay logs chat_id + timing + exit codes only — never command payloads,
  stdout, or stderr content.
- The uvicorn access logger redacts `token=`/`api_key=`/`key=` query parameters
  (both the HTTP and WebSocket row routes) so the shared key never appears in
  container logs. Regression coverage in `test/test_e2e.py`
  (`scenario_log_redaction`).

## M1 acceptance (what to verify by hand in Chromium)

Everything below is **covered by `loader/test_vm_panel.js` except** the rows
marked *(browser)* — those need a real tab and a real CheerpX boot, which is
the one thing the headless harness cannot fake. The harness models the 1.3.9
API exactly, so a green run means the *protocol* is right; what is left is
whether a real Chromium tab and a real disk image behave the same way.

- [ ] Load a chat with the loader: the terminal **is already open** and
      `#bv-vmbar` shows a live CheerpX boot. Watch the console for
      `CheerpX unavailable` — the adapter reports a load failure instead of
      falling back to a mock pod. *(browser)*
- [ ] Closing the dock keeps it closed; the terminal icon re-opens it and the
      badge clears. An agent command run while it is closed raises the badge
      rather than printing into an unseen terminal. *(browser)*
- [ ] The dock shows "Booting the VM…", then a live prompt; typing echoes. *(browser)*
- [ ] The dock's xterm is the VM's real tty, not a mirror: run `tty` in the
      dock and confirm it is the pod's pty, not `not a tty`. *(browser)*
- [ ] Measure the boot time to a usable prompt. The disk image is fetched from
      CheerpX's CDN on first boot and then cached by the browser — the first
      load in a fresh profile is the worst case. *(browser)*
- [ ] Press Reset in the dock: the pod comes back, and the second Reset still
      works (this is the `delete()` + host-retention path). *(browser)*
- [ ] Chip in the composer shows "Browser VM"; clicking it opens the menu.
- [ ] Chip → off, reload: stays off. Chip → on: the agent can drive the VM
      again. Chat switch preserves the choice.
- [ ] Agent command echoes into the dock as `[agent] <cmd>` … `[agent] exit N`.
- [ ] Open Terminal from the native panel: `term:data` echo works (this is the
      base64 path — the bug that made typing a silent no-op); `ls` lists a
      Debian rootfs. *(browser)*
- [ ] Typing in the **dock** and in the **native panel** interleaves in one
      scrollback. *(browser)*
- [ ] Ask the model to run `browser_shell("uname -a")`; it returns
      `Linux … trixie …`; output shown in chat **and in the already-open dock**.
- [ ] After an agent command, the user's own shell is exactly where they left
      it (`pwd` is unchanged) and still echoes. *(browser)*
- [ ] Model runs a command with the chip off → tool reports `no_browser` and
      tells the user to turn sharing on.
- [ ] Chat switch tears down the VM (fresh per chat); second browser tab for
      the same chat is rejected (4009).
- [ ] Big output is clipped (relay `RELAY_MAX_OUTPUT_BYTES`).
- [ ] A command that needs the network fails to resolve, and that is expected —
      egress is opt-in (see "Network is off by default" above). *(browser)*

## Deferred (explicitly out of first wave)

- Phase 2 persistence (per-chat IDBDevice namespace `c<chat_id>`), M5/M6
  bridge hardening, custom terminal UI (native panel replaces the plan's
  custom drawer), any nginx reverse proxy (see routes-notice).