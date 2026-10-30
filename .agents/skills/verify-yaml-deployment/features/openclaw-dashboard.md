<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw Dashboard Through a Service Exposure

The author declares `serviceExposures` on the sandbox, so OpenShell's gateway serves OpenClaw's Control UI at a URL with no client-side forward.
With a Control UI-enabled image, a browser at that URL signs in with the gateway token and chats with the agent.

## Sub-features

- **DB1:** Apply creates the declared exposure, with its port and authorization mode, with no `openshell service expose`, and lists its URL under **Service URLs**.
- **DB2:** The URL apply lists serves the Control UI page.
- **DB3:** A request through the exposure without the gateway token is rejected, and one with it gets a reply from the chat endpoint (`BEARER_PASSTHROUGH`).
- **DB4:** A browser at the URL signs in and gets a chat reply.

## How to get to it (user POV)

- The service URL that apply lists under **Service URLs** as `assistant/dashboard`, opened in a browser on the Spark; `*.openshell.localhost` resolves to loopback.
- From another machine, an SSH tunnel to the gateway port: `ssh -N -L PORT:127.0.0.1:PORT USER@SPARK`, then the same URL.
- `openshell forward service` to a local port, which skips the exposure; this map doesn't drive it.

## Driving it with curl, the OpenShell CLI, and Chromium

Preconditions: the Control UI-enabled image, built before writing the YAML so `image.ref` uses its digest.
The allowed origin is the exposure's URL, which derives from the workspace, sandbox, service name, and gateway port; the image needs it before apply can report the URL:

```sh
HOST=$WORKSPACE--assistant--dashboard.openshell.localhost
URL=http://$HOST:$GATEWAY_PORT
ADAPTER=/opt/fabric/lib/python3.14/site-packages/nemo_fabric_adapters/openclaw/adapter.py
C=$(docker create nc-fabric:openclaw)
docker cp "$C:$ADAPTER" "$RUN_DIR/adapter.py"
sudo chown "$USER" "$RUN_DIR/adapter.py"
grep -c '"controlUi": {"enabled": False},' "$RUN_DIR/adapter.py"
```

The count must be 1; otherwise the adapter changed and this patch doesn't apply.

```sh
sed -i "s|\"controlUi\": {\"enabled\": False},|\"controlUi\": {\"enabled\": True, \"allowedOrigins\": [\"$URL\"]},|" "$RUN_DIR/adapter.py"
docker cp "$RUN_DIR/adapter.py" "$C:$ADAPTER"
docker commit "$C" "nc-fabric:openclaw-ui-$RUN" > /dev/null
docker rm "$C" > /dev/null
IMAGE=$(docker image inspect "nc-fabric:openclaw-ui-$RUN" --format '{{index .RepoDigests 0}}')
echo "$IMAGE (patched)" > "$EVIDENCE/image.txt"
docker run --rm --entrypoint cat nc-fabric:openclaw "$ADAPTER" | diff - "$RUN_DIR/adapter.py" > "$EVIDENCE/adapter.diff"
```

`docker commit` keeps the Fabric catalog labels NemoClaw reads.
`adapter.diff` must show only the `controlUi` line.

1. **DB1:** take the URL from apply output, check it matches the origin the image allows, and check the mode:
   ```sh
   APPLY_URL=$(sed -n 's|^  assistant/dashboard: \(http[^ ]*\)/$|\1|p' "$EVIDENCE/apply.txt")
   echo "$APPLY_URL" | tee "$EVIDENCE/service-url.txt"
   [ "$APPLY_URL" = "$URL" ] && echo matches
   openshell service list assistant | tee "$EVIDENCE/services.txt"
   ```
   Result: the URL, then `matches`; `openshell service list` shows `dashboard`, target `127.0.0.1:43000`, and `bearer_passthrough`.
   Apply doesn't print the mode, so the mode check still uses the OpenShell CLI.
2. **DB2:**
   ```sh
   curl -s -m 10 --resolve "$HOST:$GATEWAY_PORT:127.0.0.1" "$URL/" | grep -c 'data-openclaw-control-ui-base-path=' | tee "$EVIDENCE/ui-page.txt"
   ```
   Result: `1`, the attribute on the Control UI's root element.
3. Read the token from the OpenClaw gateway process in this run's sandbox ([#13973](https://github.com/NVIDIA/NemoClaw/issues/13973)):
   ```sh
   CID=$(docker inspect -f '{{.Id}}' "$SANDBOX_CONTAINER")
   GPID=$(for p in $(pgrep -f '^openclaw-gateway'); do sudo grep -q "$CID" "/proc/$p/cgroup" && echo "$p"; done | head -1)
   TOKEN=$(sudo cat "/proc/$GPID/environ" | tr '\0' '\n' | sed -n 's/^OPENCLAW_GATEWAY_TOKEN=//p')
   echo "${#TOKEN}"
   ```
   Result: a length such as 64; never print the token.
4. **DB3:**
   ```sh
   curl -s -m 10 --resolve "$HOST:$GATEWAY_PORT:127.0.0.1" -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' -d '{"model":"openclaw/default","messages":[{"role":"user","content":"x"}]}' "$URL/v1/chat/completions" | tee "$EVIDENCE/no-token.txt"
   ```
   Result: `401`.
   With the token, ask the chat endpoint for a reply:
   ```sh
   curl -s -m 180 --resolve "$HOST:$GATEWAY_PORT:127.0.0.1" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"model":"openclaw/default","messages":[{"role":"user","content":"Reply with exactly CHAT_HTTP."}]}' \
     "$URL/v1/chat/completions" > "$EVIDENCE/chat-http.json"
   jq -r '.choices[0].message.content' "$EVIDENCE/chat-http.json"
   ```
   Result: `CHAT_HTTP`.
5. **DB4:** with Playwright's Chromium installed outside the checkout, open the page with the token in the URL fragment, send a prompt with a new word, and save a screenshot:
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
   node ui.mjs "$URL" "$TOKEN" "$WORD" "$EVIDENCE/dashboard.png" | tee "$EVIDENCE/dashboard.txt"
   cd - > /dev/null
   unset TOKEN
   ```
   Result: `reply`, and the screenshot shows the prompt and the agent's reply with `$WORD`.
   The word must be new to the conversation: the check accepts any line equal to it, including an answer from an earlier attempt.

## Gotchas

- Without the patched image, DB2 finds no Control UI page and DB4 can't pass; that is the Fabric gap ([NVIDIA/NeMo-Fabric#541](https://github.com/NVIDIA/NeMo-Fabric/issues/541)), not a NemoClaw failure.
- The allowed origin must match the URL exactly, including the gateway port; a different origin loads a "Browser origin not allowed" page. Build the patched image after choosing the UID and port.
- The default `STRIP` mode removes the UI's `Authorization` header, so its side requests return 401; this map declares `BEARER_PASSTHROUGH`.
- With `BEARER_PASSTHROUGH`, the avatar and workspace-icon requests still return 404; they don't affect the feature.
- After a sandbox replacement, reuse neither a screenshot file name nor a browser profile: a cached page can show the previous conversation.
- Snap Firefox can't use a profile outside `~/snap` and has captured blank pages before rendering; use Chromium.
- Two OpenClaw sandboxes on one host each run an `openclaw-gateway`; select the process by the sandbox container's cgroup, never by name alone.
