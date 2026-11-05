<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes API Server and Dashboard

The author declares Hermes's API server and dashboard under `harness.settings.interfaces`, as [docs/agents-inference/interfaces.md](../../../../docs/agents-inference/interfaces.md#reach-an-agent-interface) documents.
Apply prints how to forward each one, and the command that reads the API server's token; the dashboard has no sign-in.
Through the forwards, the API server answers an authenticated chat request and the dashboard serves its page.

## Sub-features

- **HI1:** Apply lists `assistant/api on port PORT` with `Forward`, `Token`, and `Sign in` lines, and `assistant/dashboard on port PORT` with `Forward` and `Sign in: none`, under **Agent interfaces**.
- **HI2:** The `Token` command reads the API server's token, from a path that stays the same across runtimes because Hermes keeps its state.
- **HI3:** Through the API forward, `/v1/models` returns 401 without a token or with a wrong one, and lists the agent's model with it; a chat request with the token gets the requested word.
- **HI4:** Through the dashboard forward, the page loads and `/api/health` reports no sign-in required.

## How to get to it (user POV)

- The `Forward` commands apply prints, then `http://127.0.0.1:PORT` with `Authorization: Bearer TOKEN` for the API server and a browser for the dashboard.
- A service exposure on either port; the docs warn against exposing the dashboard, which anyone who reaches it can use. This map doesn't drive it.

## Driving it with curl and the OpenShell CLI

Preconditions: [deploy-and-answer](deploy-and-answer.md)'s DA1 passed with the agent file's YAML edits, which declare `api` on 8642 and `dashboard` on 9119.

1. **HI1:**
   ```sh
   sed -n '/^Agent interfaces:/,/^$/p' "$EVIDENCE/apply.txt" | tee "$EVIDENCE/interfaces.txt"
   ```
   Result: `assistant/api on port 8642` with `Forward:`, `Token:`, and `Sign in:  send the header Authorization: Bearer TOKEN…`; `assistant/dashboard on port 9119` with `Forward:` and `Sign in:  none…`.
2. **HI2:**
   ```sh
   TOKEN_PATH=$(sed -n 's|^    Token:    openshell sandbox exec -n assistant --no-tty -- cat \(/sandbox/[^ ]*/api\.token\)$|\1|p' "$EVIDENCE/apply.txt")
   echo "$TOKEN_PATH" | tee "$EVIDENCE/api-token-path.txt"
   TOKEN=$(openshell sandbox exec -n assistant --no-tty -- cat "$TOKEN_PATH")
   echo "${#TOKEN}"
   ```
   Result: `/sandbox/artifacts/.fabric/state/nvidia.fabric.hermes/assistant/interfaces/api.token`, then a nonzero length, never the token.
3. **HI3:** start both forwards, then check the API server:
   ```sh
   openshell forward service assistant --target-port 8642 --local 127.0.0.1:8642 > "$RUN_DIR/forward-api.log" 2>&1 &
   FORWARD_API=$!
   openshell forward service assistant --target-port 9119 --local 127.0.0.1:9119 > "$RUN_DIR/forward-dashboard.log" 2>&1 &
   FORWARD_DASHBOARD=$!
   sleep 5
   for h in "" "Authorization: Bearer wrong$RANDOM"; do
     curl -s -m 10 -o /dev/null -w '%{http_code}\n' ${h:+-H "$h"} http://127.0.0.1:8642/v1/models
   done | tee "$EVIDENCE/api-no-token.txt"
   curl -s -m 10 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8642/v1/models | jq -c '[.data[].id]' | tee "$EVIDENCE/api-models.txt"
   curl -s -m 180 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"model":"hermes-agent","messages":[{"role":"user","content":"Reply with exactly API_OK."}]}' \
     http://127.0.0.1:8642/v1/chat/completions > "$EVIDENCE/api-chat.json"
   jq -r '.choices[0].message.content' "$EVIDENCE/api-chat.json"
   unset TOKEN
   ```
   Result: `401` twice; `["hermes-agent"]`; then `API_OK`.
   The API server names the agent `hermes-agent`, not the route's model; Hermes calls the configured model with its key.
4. **HI4:**
   ```sh
   curl -s -m 10 -o "$RUN_DIR/dashboard.html" -w '%{http_code} %{content_type}\n' http://127.0.0.1:9119/ | tee "$EVIDENCE/dashboard-page.txt"
   curl -s -m 10 http://127.0.0.1:9119/api/health | jq -c '{ok, auth_required}' | tee "$EVIDENCE/dashboard-health.txt"
   kill "$FORWARD_API" "$FORWARD_DASHBOARD"
   ```
   Result: `200 text/html; charset=utf-8`, then `{"ok":true,"auth_required":false}`.

## Gotchas

- The dashboard's browser chat runs the agent without approvals for anyone who can reach its forward; never expose it.
- The token path doesn't name a runtime, but the adapter rewrites the token at each runtime start; read it again after a restart or replacement.
- Hermes's interfaces fail without stopping the agent: a dead interface leaves plan unchanged, and only the next runtime start brings it back. Check the forward before judging the agent.
- An explicit network policy replaces the image's `/dev/pts` grant; browser chat then fails with `out of pty devices`, while the API server still works.
