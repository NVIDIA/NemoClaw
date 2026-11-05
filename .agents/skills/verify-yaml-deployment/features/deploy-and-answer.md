<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy and Answer

The author routes the agent to the inference the target file chose.
After apply, one headless request through Fabric's public invocation returns a reply from that model, and the provider credential stays an environment reference.

## Sub-features

- **DA1:** One headless Fabric request returns the requested word.
- **DA2:** The provider credential's value appears in none of the YAML, plan, apply output, evidence, or state.

## How to get to it (user POV)

- `openshell sandbox exec` with `fabric-agent-ctl invoke`, as [Invoke an Agent](../../../../docs/agents-inference/interfaces.md#invoke-an-agent) and [Run One Request](../../../../docs/agents-inference/agents.md#run-one-deep-agents-or-pi-request) document; the [OpenClaw example](../../../../docs/agents-inference/agents.md#run-one-headless-openclaw-request) reads the runtime ID the same way.
- The agent's native interfaces, where the agent file lists a feature for them; apply lists them under **Agent interfaces**.

## Driving it with the nemoclaw and OpenShell CLIs

Preconditions: the launch applied, and the doctor passes.

1. Read the runtime ID from state:
   ```sh
   RUNTIME_ID=$(jq -r '.resources[] | select(.type == "fabric_agent") | .instances[].attributes | select(.name == "assistant") | .runtime_id' "$STATE/terraform.tfstate")
   ```
   Result: a single nonempty ID; its format belongs to Fabric.
2. **DA1:** send one request:
   ```sh
   echo '"Reply with exactly READY_OK."' | openshell sandbox exec -n assistant --no-tty -- fabric-agent-ctl invoke --agent assistant --runtime-id "$RUNTIME_ID" --input - > "$EVIDENCE/answer.json"; echo "exit $?"
   jq --arg rt "$RUNTIME_ID" '{status, run: .result.status, error: .result.error, same_runtime: (.result.runtime_id == $rt), response: .result.output.response}' "$EVIDENCE/answer.json"
   ```
   Result: `exit 0`; `status` and `run` are `succeeded`, `error` is `null`, `same_runtime` is `true`, and the reply the agent file names contains `READY_OK`.
   The outer `status` only reports that `fabric-agent-ctl` completed; a failed run shows `run: failed` with Fabric's `error`.
3. **DA2:**
   ```sh
   { [ -z "$PROVIDER_KEY_ENV" ] || grep -rlF "$(printenv "$PROVIDER_KEY_ENV")" "$RUN_DIR/deployment.yaml" "$EVIDENCE" "$STATE"; } > "$EVIDENCE/key-leak.txt"
   wc -l < "$EVIDENCE/key-leak.txt"
   ```
   Result: `0`. The state directory belongs to `$USER` even under the target's sudo `nc`, so no `sudo grep` is needed.

## Gotchas

- `openshell sandbox exec` needs the doctor's `OPENSHELL_GATEWAY_ENDPOINT` and `OPENSHELL_WORKSPACE`; without them it targets another gateway or fails.
- With an existing endpoint, the route's `overrides.model` must match a name the server lists in `/models`; a wrong name plans and applies cleanly and fails only at the first request. With a managed service, plan rejects it.
- `invoke` with a runtime ID from before a replacement or restart fails with `runtime_unavailable`; read the ID from state again. If the current ID fails the same way, plan should list the agent as not running, and apply restarts it in the same sandbox. Don't replace the sandbox without the user: [replacement](../../../../docs/build-deploy/usage.md#replace-workloads-after-an-unusable-runtime) deletes its files.
- Don't assume a universal result shape: the agent file names where its reply appears.
- A bundle built before a schema change rejects newer fields during plan; rebuild with `cargo ci bundle`.
