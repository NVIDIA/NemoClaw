<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw Dashboard

The author declares the Control UI under `harness.settings.interfaces.dashboard`, as [docs/interfaces.md](../../../../docs/interfaces.md#reach-an-agent-interface) documents.
Apply then prints how to forward it, the command that reads its sign-in token, and the sign-in URL; with a service exposure on the same port, it also lists the URL the gateway serves it at.
A browser at either address signs in with the token and chats with the agent.

## Sub-features

- **DB1:** Apply lists `assistant/dashboard on port PORT` under **Agent interfaces** with `Forward`, `Token`, and `Sign in` lines, and the exposure's URL under **Service URLs**; it prints no token.
- **DB2:** The URL apply lists serves the Control UI page.
- **DB3:** The `Token` command reads the token, and through the exposure `/control-ui-config.json` returns 401 without a token or with a wrong one, and the configuration with it.
- **DB4:** A browser at the exposure's URL signs in and gets a chat reply.
- **DB5:** The `Forward` command gives the same results on `127.0.0.1:PORT`.

## How to get to it (user POV)

- The `Forward` command apply prints, then `http://127.0.0.1:PORT/#token=TOKEN`; the gateway authorizes each forwarded connection, and the docs prefer it.
- The URL apply lists under **Service URLs**, opened on the host; `*.openshell.localhost` resolves to loopback. It skips the gateway's authorization, so the token is the only protection.
- From another machine, an SSH tunnel to the gateway port for the exposure, or to the forwarded port: `ssh -N -L PORT:127.0.0.1:PORT USER@HOST`.

## Driving it with curl, the OpenShell CLI, and Chromium

Preconditions: [deploy-and-answer](deploy-and-answer.md)'s DA1 passed with the agent file's YAML edits, which declare the interface and the exposure.
The exposure's URL derives from the workspace, sandbox, service name, and gateway port; the YAML lists it in `public_origins`:

```sh
HOST=$WORKSPACE--assistant--dashboard.openshell.localhost
URL=http://$HOST:$GATEWAY_PORT
```

1. **DB1:**
   ```sh
   sed -n '/^Agent interfaces:/,/^$/p' "$EVIDENCE/apply.txt" | tee "$EVIDENCE/interfaces.txt"
   APPLY_URL=$(sed -n 's|^  assistant/dashboard: \(http[^ ]*\)/$|\1|p' "$EVIDENCE/apply.txt")
   echo "$APPLY_URL" | tee "$EVIDENCE/service-url.txt"
   [ "$APPLY_URL" = "$URL" ] && echo matches
   openshell service list assistant | tee "$EVIDENCE/services.txt"
   ```
   Result: the block shows `assistant/dashboard on port 43000` with `Forward:`, `Token:`, and `Sign in:` lines; then the URL and `matches`; `openshell service list` shows `dashboard`, `127.0.0.1:43000`, and `bearer_passthrough`.
   Apply doesn't print the mode, so the mode check uses the OpenShell CLI.
2. **DB2:**
   ```sh
   curl -s -m 10 --resolve "$HOST:$GATEWAY_PORT:127.0.0.1" -o "$RUN_DIR/ui.html" -w '%{http_code}\n' "$URL/" | tee "$EVIDENCE/ui-page.txt"
   grep -c 'data-openclaw-control-ui-base-path=' "$RUN_DIR/ui.html"
   ```
   Result: `200`, then `1`.
3. **DB3:** read the token with the command apply printed, then check sign-in through the exposure:
   ```sh
   TOKEN_PATH=$(sed -n 's|^    Token:    openshell sandbox exec -n assistant --no-tty -- cat \(/sandbox/[^ ]*/dashboard\.token\)$|\1|p' "$EVIDENCE/apply.txt")
   echo "$TOKEN_PATH" | tee "$EVIDENCE/token-path.txt"
   TOKEN=$(openshell sandbox exec -n assistant --no-tty -- cat "$TOKEN_PATH")
   echo "${#TOKEN}"
   for h in "" "Authorization: Bearer wrong$RANDOM"; do
     curl -s -m 10 --resolve "$HOST:$GATEWAY_PORT:127.0.0.1" -o /dev/null -w '%{http_code}\n' ${h:+-H "$h"} "$URL/control-ui-config.json"
   done | tee "$EVIDENCE/no-token.txt"
   curl -s -m 10 --resolve "$HOST:$GATEWAY_PORT:127.0.0.1" -H "Authorization: Bearer $TOKEN" "$URL/control-ui-config.json" | jq -c '{basePath: has("basePath")}' | tee "$EVIDENCE/with-token.txt"
   ```
   Result: a path ending in `/.fabric/openclaw/runtimes/RUNTIME_ID/interfaces/dashboard.token`; a nonzero length, never the token; `401` twice; then `{"basePath":true}`.
4. **DB4:** with Playwright's Chromium installed outside the checkout, open the page with the token in the URL fragment, send a prompt with a new word, and save a screenshot:
   ```sh
   mkdir -p "$RUN_DIR/pw" && cd "$RUN_DIR/pw" && npm init -y > /dev/null && npm i playwright > /dev/null && npx playwright install chromium > /dev/null
   cat > ui.mjs <<'JS'
   import { chromium } from "playwright";
   const [url, token, word, shot] = process.argv.slice(2);
   const b = await chromium.launch({ args: ["--host-resolver-rules=MAP *.openshell.localhost 127.0.0.1"] });
   const p = await (await b.newContext({ viewport: { width: 1000, height: 600 } })).newPage();
   await p.goto(url + "/#token=" + token, { waitUntil: "load" });
   await p.waitForTimeout(6000);
   await p.getByPlaceholder("Message Assistant").fill("Reply with exactly " + word);
   await p.keyboard.press("Enter");
   // Only the agent's reply is a line that is exactly the word; titles and bubbles hold the whole prompt.
   const replied = async () => (await p.innerText("body")).split("\n").some((line) => line.trim() === word);
   let ok = false;
   for (let i = 0; i < 90 && !(ok = await replied()); i++) await p.waitForTimeout(2000);
   console.log(ok ? "reply" : "no reply");
   await p.screenshot({ path: shot });
   await b.close();
   JS
   WORD=DASH_$(date +%s)
   node ui.mjs "$URL" "$TOKEN" "$WORD" "$EVIDENCE/dashboard-$WORD.png" | tee "$EVIDENCE/dashboard.txt"
   cd - > /dev/null
   ```
   Result: `reply`, and the screenshot shows the prompt and the agent's reply with `$WORD`.
   The word must be new to the conversation: the check accepts any line equal to it, including an answer from an earlier attempt.
5. **DB5:** run the `Forward` command in the background, repeat DB3's sign-in checks on loopback, then stop it:
   ```sh
   openshell forward service assistant --target-port 43000 --local 127.0.0.1:43000 > "$RUN_DIR/forward.log" 2>&1 &
   FORWARD=$!
   sleep 4
   for h in "" "Authorization: Bearer wrong$RANDOM"; do
     curl -s -m 10 -o /dev/null -w '%{http_code}\n' ${h:+-H "$h"} http://127.0.0.1:43000/control-ui-config.json
   done | tee "$EVIDENCE/forward-no-token.txt"
   curl -s -m 10 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:43000/control-ui-config.json | jq -c '{basePath: has("basePath")}' | tee "$EVIDENCE/forward-with-token.txt"
   kill "$FORWARD"
   unset TOKEN
   ```
   Result: `401` twice, then `{"basePath":true}`.

## Gotchas

- Run this feature before [exposure-change](exposure-change.md): its `STRIP` mode removes the UI's `Authorization` header, so side requests fail through the exposure; the forward isn't affected.
- `public_origins` must list the exposure's URL exactly, including the gateway port, or the page reports "Browser origin not allowed"; set it after choosing the UID and port. Loopback origins are always accepted, so the forward needs none.
- The `Token` line names the runtime ID. After a runtime restart or sandbox replacement, read the new line from the latest apply; the old path is gone.
- `interfaces.dashboard.port` can't be combined with `port_range`, and OpenClaw reserves `port` through `port + 110`.
- Planning rejects an interface name or field the image's adapter doesn't declare, naming `harness_interfaces`; rebuild the image when the error mentions an interface the docs list.
- With `BEARER_PASSTHROUGH`, the avatar and workspace-icon requests return 404; they don't affect the feature.
- After a sandbox replacement, use a new screenshot file name and a fresh browser context: a cached page can show the previous conversation.
- Snap Firefox can't use a profile outside `~/snap` and has captured blank pages before rendering; use Chromium.
