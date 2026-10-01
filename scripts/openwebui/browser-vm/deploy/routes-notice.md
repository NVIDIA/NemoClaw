# Browser-VM routing note (no nginx in this stack)

The plan assumed an nginx in front of OpenWebUI (`nginx-snippets.conf`
in §11), but this stack **has no nginx**: the only inbound path is the
`cloudflared-tunnel` sidecar (managed Cloudflare tunnel, token auth) in
`scripts/openwebui/docker-compose.yml`, serving `supachad.com` behind a
Cloudflare Access ACL.

So the browser leg of the relay is exposed through Cloudflare directly.

## Public hostname route (applied live via the CF API)

> This was **completed over the API** (no dashboard clicks needed): the route
> is already live on the `chad.supachad.com` host, in front of the broad
> hostname rule. Reference table for future edits:

| Field        | Value                                        |
|--------------|----------------------------------------------|
| Public host  | `chad.supachad.com` (existing — NOT supachad.com) |
| Path         | `/vm-bridge/*`                               |
| Service      | `http://host.docker.internal:8787`           |
| HTTP settings | No TLS origin; websocket is automatic       |

Two gotchas learned here:
- **Matches are first-match-wins**, and a pathless rule matches every path. The
  relay's `/vm-bridge/*` ingress rule MUST sit *before* the `chad.supachad.com`
  → `http://open-webui:8080` pathless rule, or OpenWebUI swallows the path.
- cloudflared passes the request path through **un-stripped**, so the relay
  also serves the prefixed twins `/vm-bridge/healthz` and `/vm-bridge/vm`
  (`relay.py`, bottom of routes section). The native/tool legs keep their bare
  root paths for OpenWebUI internal traffic.

The route was written with a token that has tunnel read/write via
`PUT /accounts/{account}/cfd_tunnel/{tunnel_id}/configurations`
(ingress array), using `.env` `CF_API_TOKEN`/`CF_ACCOUNT_ID`/`CF_TUNNEL_ID`.

- The `host.docker.internal` host alias already exists on the sidecar
  (`extra_hosts: host-gateway`) and resolves to the Mac host, so a route
  can target `host.docker.internal:8787` even though the relay container
  binds its port to `127.0.0.1:8787` on the host.
- Keep the same Access service policy on the whole hostname (CF Access /
  browser-based policy applies to all paths) — anyone who can open the UI
  can open this path, same trust boundary as the app.

Verified live: `GET https://chad.supachad.com/vm-bridge/healthz` → `200 ok`
and a full `tool → relay → wss://chad.supachad.com/vm-bridge/vm → browser →
relay → tool` exec round-trip (both through CF Access).

## Path the loader uses

`loader/vm-panel.js` derives its relay URL from `window.__BROWSER_VM.relay`
and defaults to `ws(s)://<location.host>/vm-bridge` — i.e. it hits
`wss://chad.supachad.com/vm-bridge/vm?chat_id=…` through the same tunnel.
Nothing extra to configure per-CORS; same origin as the app.

## Why not nginx meanwhile

If the stack ever grows an nginx/reverse proxy, the plan's
`nginx-snippets.conf` (proxy `/vm-bridge` → `127.0.0.1:8787`, WS upgrade
headers) applies verbatim and the direct CF route should be removed.

## OpenWebUI → relay (internal path)

OpenWebUI reaches the relay at `http://browser-vm-relay:8787` (compose
service name) OR via `http://host.docker.internal:8787` depending on how
the `TERMINAL_SERVER_CONNECTIONS` URL is set. The two must agree on the
key (`auth_type: bearer`), and the relay must be reachable from the
`open-webui` container's network (put `browser-vm-relay` on
`openwebui-net`).

## Cutover status (all applied live)

1. ✅ `browser-vm-relay` joined `openwebui-net` (compose service).
2. ✅ `/vm-bridge/*` public hostname route on `chad.supachad.com`, ordered
   before the pathless hostname rule (written over the CF API; see above).
3. ✅ `TERMINAL_SERVER_CONNECTIONS` + `BROWSER_VM_RELAY_KEY` in `.env`.
4. ✅ Relay built + running (image `openwebui-browser-vm-relay:latest`).
5. ✅ `terminal_server.connections` seeded in webui.db — Open Terminal lists
   "Browser VM (fresh)"; a public access grant means non-admin accounts see
   it too (verified: `/api/v1/terminals/` returns the server for both the
   admin and the non-admin user).
6. ✅ `/files/*` Open Terminal file API implemented in the relay (executes in
   the VM) and reachable through the OWUI proxy:
   `/api/v1/terminals/{server_id}/files/cwd` → `200 {"cwd":"/root",...}`;
   no-VM list → `409` (clean message, no more 404).
7. ✅ TerminalDock `/execute` (+ `/{id}/status`, `/input`, DELETE) and
   `/ports` implemented (chat-scoped, VM-backed, poll-safe): the sidebar
   dock's execute box and port list no longer 404. Verified live through the
   proxy: `/execute` → `200 []`, `/ports` → `200 {"ports":[]}`, no-VM run →
   clean `409`.
8. ⏳ Browser hand-check remains: open a chat, hit the terminal icon; expect
   the loader to boot CheerpX, the relay to bridge (`/api/v1/terminals/{id}`
   returns 101; tool `browser_shell` returns 200 with a Debian rootfs), and
   the sidebar file browser to list the VM's root. See the M1 checklist in
   `../README.md`; every row except the `*(browser)*` ones is now covered
   headlessly by `loader/test_vm_panel.js`.
9. ✅ Per-user `ui.terminalServers` seeded for every user — this was the real
   cause of the chat showing "No terminal connections configured" while
   `/api/v1/terminals/` returned 200. Done by `seed-terminal-config.py`, now
   run as step 9e of `openwebui-setup.sh`.

---

## As-built events (2026-09-23)

- **Q1 confirmed live:** `/api/config` `features.enable_code_interpreter =
  True` (admin JWT, served by the running open-webui; the flag the dock's
  loader keyed on is on, so no UI toggling was needed).
- **Q2 dock 404 → root cause was a STALE BAKED IMAGE, not a missing route:**
  the running `browser-vm-relay` container's `/relay/relay.py` md5
  `ae2ac03…` predated the terminal CRUD routes (grep showed CRUD decorator
  count **0**); the host `relay/relay.py` (`c21bf01…`) had all 4 CRUD + 1
  WS. Rebuilt the image from the current `browser-vm/` source
  (`docker compose build browser-vm-relay`, context `./browser-vm`,
  `deploy/relay.Dockerfile`) and recreated with `--force-recreate`. The
  recreated container's `/relay/relay.py` now matches host md5 and the 404
  is gone: `/api/terminals` GET → `200` (no-VM → `409` "no chat context
  for terminal session"), no more `404` on the CRUD leg.
- **Remaining live leg is the browser only:** CheerpX boot + `term:require`
  round-trip + keystroke echo — needs a human in a real tab (item 8).

---

## As-built events (2026-09-27) — "no terminal configured" + panel hardening

Three separate faults, none of which was visible from the symptom.

**1. The on-disk `SyntaxError` was never actually served.** An earlier pass
found a fatal `SyntaxError` in `loader/vm-panel.js` (stray braces after
`watchChat()`, duplicate `case "term:data"/"term:require"/"term:resize"`
labels, a dangling `window.__owuiVm.reconnect`/`}`), plus an undefined
`dropRelay()` call and inverted lazy-boot logic `if (wasReady || !STATE.cx)`.
All real bugs, all fixed. But the container had been up 4 days serving the
50871-byte Sep-22 snapshot, so none of them were the live cause. Worth
recording so nobody re-fixes the same dead code and calls it a day.

**2. The actual live blocker was config, in two places.** The backend row
`config.terminal_server.connections` was already correct and
`GET /api/v1/terminals/` returned the webvm server. What was missing was
**per-user** `user.settings.ui.terminalServers` — absent for both users. The
frontend copies only entries with `enabled: true` from `$settings.terminalServers`
into the `$terminalServers` store, and the chat's terminal controls are gated
on `$selectedTerminalId`, which only a user click in a dropdown ever sets. An
empty store therefore renders "No terminal connections configured." while the
API returns 200. There is no `ENABLE_TERMINAL` flag to set — the gating is
purely store-based. Fixed by `seed-terminal-config.py`; wired into
`openwebui-setup.sh` as step 9e so it cannot drift again.

**3. A real bug the syntax check could never catch:** `writeTerm()` called
`b64ToBinary(data)` for `enc:"b64"` frames, and the function did not exist
anywhere in the file. The relay base64-encodes **every** binary keystroke from
the native Open Terminal panel (`relay.py` `_native_to_vm_loop`), so every
keystroke threw a `ReferenceError` and was silently dropped — the native panel
was a type-to-nothing black hole. `node --check` passes on that code; it does
not execute it. Fixed by adding the decoder (byte-string, not UTF-8, so
multi-byte paste survives) and now covered by the smoke test.

### Verification added

`loader/test_vm_panel.js` runs the real panel IIFE against a stub DOM in two
modes — `mock` and `cheerpx` (a fake CheerpX, so console adoption and the
agent-to-user bridge are genuinely exercised) — and asserts 158 behaviours.
`loader/build.sh` runs it as a gate before overwriting the deploy artifact.
Mutation-tested: removing the base64 decoder, the `connectRelay` share guard,
`mountConsole`'s adoption, the register frame's chat id, `watchChat`'s
`dropRelay`, or the `exec_result` frame each fails the suite.

### Deployment subtlety (corrected)

The bind mount works, but **not** the way it first appears.
`docker-compose.yml` mounts host `static/loader.js` →
`/app/build/static/loader.js`, and it would be reasonable to assume a rebuild
shows up on refresh. It does not:

- `open_webui/config.py` copies `/app/build/static/*` into `STATIC_DIR`
  (`/app/backend/open_webui/static`) **once, at module import**, i.e. at
  container boot. `STATIC_DIR` is what the app serves. There is no watcher and
  no periodic resync.
- So a rebuilt loader goes live on **`docker restart nemoclaw-openwebui`**, or
  via a direct `docker cp` into `STATIC_DIR` if you cannot restart.
- `docker cp` into `/app/build/static/loader.js` fails with
  `device or resource busy` — it is a live bind mount, which is exactly why it
  exists. `openwebui-setup.sh` step 9b chained the two `docker cp`s with `&&`,
  so once the mount was added the first failure short-circuited the second and
  the deploy silently did nothing but print a warning.
- Docker Desktop's bind-mount read path is also inconsistent: `docker exec …
  md5sum /app/build/static/loader.js` can return a **stale** digest while
  `docker cp` out of the same path returns the current bytes. Verify with
  `docker cp`, not `md5sum` over `exec`, or you will chase a phantom drift.

Verified after this pass: host == served == `83e952f8…`, and that digest
survives a container restart.
---

## As built 2026-09-27 — composer injection, duplicate menu rows, and a 307

Three user-visible faults, all root-caused. A fourth (the CheerpX API) is
documented in `../README.md` and is **not** fixed.

### 1. "Browser VM" typed into the chat box once per second

`ensureChip()` anchored the composer chip with

```js
document.querySelector("#chat-input, form.relative, .chat-input")
```

`#chat-input` is **not a textarea** — it is a TipTap/ProseMirror
`contenteditable` (confirmed from the shipped sourcemap:
`src/lib/components/common/RichTextInput.svelte`, TipTap
`Editor({... attributes: () => ({ id, ... })})`). Appending a node into it makes
ProseMirror parse the node's text as **message content**, so the chip's label
became part of the user's prompt. ProseMirror then detached the node, and the
1-second re-attach poll put it straight back — hence the once-per-second
repetition. (An earlier theory that this was xterm's `textarea` was wrong.)

Fixed by anchoring only to inert containers that sit *beside* the editor
(`#message-input-container` → `form` → `footer`), plus an `isEditorSurface()`
guard that rejects any contenteditable / textarea / `#chat-input` / `.ProseMirror`
host, so the two protections are mutually redundant. The 1s poll was replaced by
a `MutationObserver` that gives up after 5 consecutive misses, so a host that
keeps detaching the chip cannot spin a timer.

`test_vm_panel.js` now models the real composer (a `<form>` containing a
ProseMirror `#chat-input`) instead of a bare `<footer>` — which is precisely why
the bug shipped. New assertions: chip is not inside the editor, editor stays
empty, chip re-attaches after a simulated SPA re-render and is still outside the
editor, and the `#message-input-container`-absent fallback still lands in the
`<form>`. 158 → 182 assertions. The original bug (editor host **and** no guard)
fails 8 of them; each protection alone holds, which is the intent.

### 2. `Failed to connect to http://browser-vm-relay:8787 terminal server` + duplicated menu rows

`(app)/+layout.svelte::setToolServers()` probes every **enabled per-user**
`settings.terminalServers` entry *from the browser* via
`GET {url}{path}` (default `/openapi.json`). `browser-vm-relay` is a
Docker-internal name, so that probe can never resolve: the toast fires on every
page load, and the `.filter(data => !data.error)` then drops it.

The menu is two sections — **Direct** (per-user, keyed by `url`) and **System**
(admin `terminal_server.connections` via `GET /api/v1/terminals/`, keyed by
`id`, URLs rewritten to same-origin `/terminals/{id}`). The seeder wrote the same
connection into *both*, which is why "Browser VM (fresh)" appeared under each.

The previous fix — and the docstring that justified it — was **backwards**: the
admin list alone is sufficient, and the per-user entry is the thing that breaks.
`seed-terminal-config.py` now seeds the admin connection and *prunes* per-user
entries pointing at the relay. Applied to both users; re-run reports no changes.
Container-side confirmation: `GET /api/v1/terminals/` returns the connection
with the same-origin proxy URL.

### 3. Every native terminal create returned 401 (trailing-slash 307)

Even on the good **System** path, `POST /api/v1/terminals/webvm/api/terminals/`
failed. The relay registers `@app.post("/api/terminals")` with no trailing
slash, but OpenWebUI's client asks for `/api/terminals/`. FastAPI answers
`redirect_slashes` with a **307**, OpenWebUI's aiohttp proxy does not replay
`Authorization` across it, and the relay's `_require_bearer` rejected the
redirected request — so a *correct* key still yielded 401. Observed in the relay
log as `POST /api/terminals/ 307` ×4 then `POST /api/terminals 401`.

Fixed in `relay.py` with a raw-ASGI `_SlashNormaliser` middleware that strips one
trailing slash when the stripped path matches a registered route. Route
*patterns* are compiled with `starlette.routing.compile_path` rather than
compared as literal strings, so parameterised routes such as
`/api/terminals/{session_id}` match the concrete id (string comparison only
fixed the static routes and left `DELETE …/{id}/` still 307-ing — caught by the
new test).

Verified through the real stack: `POST /api/v1/terminals/webvm/api/terminals/`
now returns **200** with a session id, and the relay log shows the request
arriving as `POST /api/terminals 200` with zero 307/401. Auth is still enforced
on the slash form. `test_e2e.py` gains a `scenario_trailing_slash` (12
assertions, 60 → 72); removing the middleware fails it.

### Deploy record

- `static/loader.js` → 1921 lines, `d33ddda7b6df4ce15a047a7cc2310465`; copied
  into `STATIC_DIR` with `docker cp` and confirmed via `docker cp` back out
  (host digest == served digest).
- `browser-vm-relay` image rebuilt and recreated; healthy.
- DB backup before the seeder write:
  `webui.db.bak-seed-terminal-20260927T011208Z`.

## Fifth fix — the CheerpX adapter, rewritten against the real 1.3.9 API

The first four fixes made the plumbing negotiate correctly. The pod itself had
never booted, and the reason was not a configuration error: the old
`makeCheerpxAdapter()` was written against an API that does not exist.

### As-built root causes

**1. Wrong CDN path, and the failure was invisible.** `CFG.cheerpxUrl` pointed at
`.../cheerpx@latest/build/cheerpx.min.js`, which does not exist — the package
ships only `index.js` (a ~580-byte ESM shim re-exporting
`https://cxrtnc.leaningtech.com/1.3.9/cx.esm.js`) and `index.d.ts`.
`resolveAdapter()` caught the failure and returned `makeMockAdapter()`, so the
dock ran a mock pod with no terminal: the literal source of
`No console available in this VM.` `resolveAdapter()` now logs the load error
*and* puts it on the bar, and `ensureBooted()` logs boot failures for the same
reason — a bar line that the next line overwrites is not a report.

**2. The adapter assumed a console node, a stdin, and a spawn.** All three are
absent from 1.3.9. Concretely: there is no `XtermConsole` (zero occurrences in
the 376,708-byte bundle), no `stdin`, no `spawn()`/`getStdout()` — `run()`
resolves with `{status}` only, and `setCustomConsole(writeFunc, cols, rows)`
returns a handler that takes a **keycode**, not bytes. So the rewrite supplies
its own xterm.js in the dock, translates `onData` text into keycodes, and gets
`exec` to *type* into the shared tty and read the output back between two OSC
999 sentinels.

**3. Teardown was spelled wrong.** 1.3.9 has `delete()`; the code called
`close()`/`destroy()`, neither of which exists, so every reset silently leaked
the worker and the whole disk image.

Two further bugs were found by the rewrite's own tests rather than by reading:

- **`teardown()` unparented `#bv-term-xterm`.** That element is permanent dock
  markup, not something xterm owns, so the *first* reset left the dock
  structurally broken and every later boot failed with
  `terminal host missing from dock`. It now empties the host and keeps it.
- **The exec wrapper's restore line had no trailing newline.** The shell was
  left holding `cd "$__bvcd"; PS1=…; stty echo` *unexecuted*, so after every
  agent command the user's own shell was left in the command's cwd with a blank
  prompt and no tty echo. `restoreTty()` also never restored the cwd, and it
  fired a bare `^C` at a healthy shell on every successful command; it now runs
  only on the paths where the script's own restore did not, and restores the cwd
  too, because a command that hung never reaches that line.

### Deploy record

- `static/loader.js` → 2392 lines, `bbebde983b4b171e548439d90bc86a43`; copied
  into `STATIC_DIR` with `docker cp`, confirmed by `docker cp` back out
  (host digest == container digest == digest served on
  `http://127.0.0.1:8080/static/loader.js` from inside the container).
- Relay unchanged; `test/test_e2e.py` still 72/72.
- `loader/test_vm_panel.js` 82 (mock) + 134 (cheerpx) = **216 assertions**, and
  12 of 12 mutations of load-bearing exec logic are caught by a named
  assertion. `loader/build.sh` (which refuses to overwrite the deploy artifact
  unless the suite is green) is the gate that was run.

### ⚠ Capability change: the pod has no network

`Linux.create` takes a `networkInterface` **object**. The old `network: true` was
never a valid value and was silently ignored, so any command that appeared to
have network was relying on something that was not happening. `CFG.network` now
defaults to `false`, and egress is an explicit opt-in:

```js
window.__BROWSER_VM = { network: { authKey: "…" } };
```

Expect DNS failures inside the VM until that is set. This is correct for a
sandbox, and it is a visible change from the previous behaviour.

### Still needs a human

`browser-vm/README.md`'s M1 checklist has `*(browser)*` rows that the headless
harness cannot cover: the `textToKeycodes()` translation against a real tty,
disk-image boot time on a cold profile, double-Reset, and the four original
symptoms (no composer injection, no connect-failure toast, one
"Browser VM (fresh)" row under System only, a live terminal in the dock).

## Sixth fix — the terminal never opened, so the agent's output went nowhere

The report was "the terminal UI does not work as expected; it should start on
page load and be shared with the active agent chat if enabled — why are the
commands not showing in the terminal?"

### As-built root cause

Not a regression: the lazy boot was the original design, and it was wrong.

`start()` deliberately set the bar to `VM: <chat> (boot on demand)` and booted
nothing, and `bootOnChatChange()` only re-booted when a pod was *already*
ready. So on any page load nothing booted, and the dock only existed after a
click on the terminal icon or the chip menu.

The agent's commands still ran. `execRequest` calls `ensureBooted()`, which
boots the pod, creates the xterm in `attachConsole()`, and writes both the
`[agent] <cmd>` banner and the command's output into it. The output was going
exactly where it should — into an xterm inside a dock that was never opened.
From the user's side the agent silently ran commands and the UI reported
nothing at all, which is the worst possible failure mode for a shared terminal:
it looks like the feature is broken rather than hidden.

### Fix

- `CFG.autoOpen` (default **true**): the terminal opens and boots as soon as a
  chat is open, and again on every chat switch. Overridable with
  `window.__BROWSER_VM = { autoOpen: false }` if the disk-image cost matters
  more than the visibility.
- Gated on `shareEnabled()`, so it never opens a terminal the agent is not
  allowed to drive, and on `!STATE.dismissed`, so closing it is respected.
- `closeTerminal()` now always records the dismissal. There is no
  "close but keep auto-opening" case.
- A chat switch clears the dismissal and the badge: the pod is per-chat, so the
  terminal is too, and a stale count would describe runs from a chat that no
  longer has a terminal.
- **Badge on the terminal button** counting agent runs that happened while the
  dock was closed, cleared by opening it. The output still lands in the xterm
  and in the relay mirror; the badge only makes it *discoverable*, so this
  failure mode cannot recur silently. Counted once per exec, not per
  `agentWrite` call — one exec writes several lines and would otherwise inflate
  the count.

`getState()` gained `autoOpen`, `dismissed` and `unseenAgentRuns`, and
`__owuiVm.shouldAutoOpen()` is exposed, so all of this is assertable from the
page.

### Deploy record

- `static/loader.js` → 2490 lines, `f858548eab70bd6e3898f62b2b55e505`; copied
  into `STATIC_DIR` and confirmed by container digest, `docker cp` round-trip,
  and the digest the app serves (with `autoOpen: true` and `bv-vmbar-badge`
  both asserted present in the served bytes).
- `loader/test_vm_panel.js` 99 (mock) + 151 (cheerpx) = **250 assertions**. The
  two assertions that encoded the old behaviour (`boot is lazy on load`) were
  replaced, not deleted: they now assert auto-open *is* on, that it is gated on
  sharing, and that a dismissal and a chat switch each behave correctly.
- Mutation-tested: 12/12 for the exec sentinel scheme, 7/7 for the auto-open
  and badge work. Two candidate mutants are documented as *equivalent* rather
  than un-caught — see the note in `mutate_open.py`.
- Relay unchanged; `test/test_e2e.py` still 72/72.
