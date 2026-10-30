<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy and Answer

The author routes the agent to the inference the target file chose.
After apply, one headless request through Fabric's public invocation returns a reply from that model, and the provider credential stays an environment reference.

## Sub-features

- **DA1:** One headless Fabric request returns the requested word.
- **DA2:** The provider credential's value appears in none of the YAML, plan, apply output, evidence, or state.

## How to get to it (user POV)

- `openshell sandbox exec` with `fabric-agent-ctl invoke`, as [agents.md](../../../../docs/agents.md#run-one-headless-openclaw-request) documents for every harness.
- The agent's native interfaces, where the agent file lists a feature for them.

## Driving it with the nemoclaw and OpenShell CLIs

Preconditions: the launch applied, and the doctor passes.

1. Read the runtime ID from state:
   ```sh
   RUNTIME_ID=$(jq -r '.resources[] | select(.type == "fabric_agent") | .instances[].attributes | select(.name == "assistant") | .runtime_id' "$STATE/terraform.tfstate")
   ```
   Result: a value like `runtime-…`.
2. **DA1:** send one request:
   ```sh
   echo '"Reply with exactly READY_OK."' | openshell sandbox exec -n assistant --no-tty -- fabric-agent-ctl invoke --agent assistant --runtime-id "$RUNTIME_ID" --input - > "$EVIDENCE/answer.json"
   jq '{status, run: .result.status, error: .result.error, response: .result.output.response}' "$EVIDENCE/answer.json"
   ```
   Result: `status` and `run` are `succeeded`, and the reply the agent file names contains `READY_OK`.
   The outer `status` only reports that `fabric-agent-ctl` completed; a failed run shows `run: failed` with Fabric's `error`.
3. **DA2:**
   ```sh
   [ -z "$PROVIDER_KEY_ENV" ] || for f in "$RUN_DIR/deployment.yaml" "$EVIDENCE"/* "$STATE"/*.json "$STATE/terraform.tfstate"; do grep -lF "$(printenv "$PROVIDER_KEY_ENV")" "$f"; done > "$EVIDENCE/key-leak.txt"
   wc -l < "$EVIDENCE/key-leak.txt"
   ```
   Result: `0`. Prefix `grep` with `sudo` where the target file says state is written by another group.

## Gotchas

- `openshell sandbox exec` needs the doctor's `OPENSHELL_GATEWAY_ENDPOINT` and `OPENSHELL_WORKSPACE`; without them it targets another gateway or fails.
- The route's `overrides.model` must match a name the inference serves; a wrong name plans and applies cleanly and fails only at the first request.
- If `invoke` fails with `runtime_unavailable`, plan and apply again before judging the feature.
- Don't assume a universal result shape: the agent file names where its reply appears.
- A bundle built before a schema change rejects newer fields during plan; rebuild with `cargo ci bundle`.
