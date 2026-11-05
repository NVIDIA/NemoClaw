<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Change a Service Exposure

A sandbox's `serviceExposures` belong to its creation, so adding, changing, or removing one replaces the sandbox and its agent runtime, as [usage.md](../../../../docs/build-deploy/usage.md#choose-the-change-path)'s change-path table states.
The plan says so before apply, the gateway records the exposure after it, and the agent answers in the new sandbox.

## Sub-features

- **XC1:** Plan shows `delete → create` for the sandbox and its agent runtime, warns that the sandbox's files and history are deleted, and lists no URLs.
- **XC2:** After apply, the old sandbox is gone, the output lists the exposure's URL under **Service URLs**, `openshell service list` shows its port and mode, and the agent answers under its new runtime ID.

## How to get to it (user POV)

- Editing `serviceExposures` in the YAML, then `nemoclaw plan` and `nemoclaw apply`.

## Driving it with the nemoclaw and OpenShell CLIs

Preconditions: [export-reapply](export-reapply.md) passed, and the agent's interface feature ran first; this feature deletes the conversation history.

1. Change the exposure by hand in `$RUN_DIR/deployment.yaml`, keeping any others.
   When `spec.sandboxes.assistant.serviceExposures` has a `BEARER_PASSTHROUGH` exposure, as the `openclaw` agent file declares for `dashboard`, set that exposure's `authorizationMode: STRIP` and `SERVICE` to its name.
   Otherwise, as for `hermes` and `deepagents-code`, add a `probe` exposure and set `SERVICE=probe`: put it in the existing `serviceExposures` map, or add the map under the sandbox, beside its `image` and `harness`:
   ```yaml
         serviceExposures:
           probe:
             targetPort: 18800
   ```
   Then record the change:
   ```sh
   SANDBOX_BEFORE=$SANDBOX_CONTAINER
   RUNTIME_BEFORE=$(jq -r '.resources[] | select(.type == "fabric_agent") | .instances[].attributes | select(.name == "assistant") | .runtime_id' "$STATE/terraform.tfstate")
   SERVICE=REPLACE_WITH_SERVICE
   cp "$RUN_DIR/deployment.yaml" "$EVIDENCE/deployment-changed.yaml"
   diff "$EVIDENCE/deployment.yaml" "$EVIDENCE/deployment-changed.yaml"
   ```
   Result: the diff shows only the `serviceExposures` change for `$SERVICE`.
2. **XC1:**
   ```sh
   nc plan "$RUN_DIR/deployment.yaml" --progress off > "$EVIDENCE/change-plan.txt" 2>&1
   grep -A2 '  sandbox/assistant$' "$EVIDENCE/change-plan.txt"
   grep -c 'delete → create  agent runtime/assistant' "$EVIDENCE/change-plan.txt"
   grep -c 'Service URLs' "$EVIDENCE/change-plan.txt"
   ```
   Result: `delete → create  sandbox/assistant`, `Deletes sandbox files and conversation history, except on mounted volumes.`, and `Replacement; service interruption may occur.`; then `1`, then `0`.
3. **XC2:**
   ```sh
   nc apply "$RUN_DIR/deployment.yaml" --progress off > "$EVIDENCE/change-apply.txt" 2>&1
   grep -c 'Apply complete' "$EVIDENCE/change-apply.txt"
   grep -A1 'delete → create  sandbox/assistant' "$EVIDENCE/change-apply.txt"
   grep "^  assistant/$SERVICE: " "$EVIDENCE/change-apply.txt" | tee "$EVIDENCE/service-url-changed.txt"
   openshell service list assistant | tee "$EVIDENCE/services-changed.txt"
   docker ps --format '{{.Names}}' | grep -cx "$SANDBOX_BEFORE"
   ```
   Result: `1`; `Sandbox files and conversation history deleted, except on mounted volumes.` under the sandbox line; one `assistant/$SERVICE: URL` line; the exposure's row shows `strip`; then `0`, the old sandbox gone.
   An omitted mode lists as OpenShell's default, `strip`.
   Rerun the doctor to pick up the new sandbox container, then [deploy-and-answer](deploy-and-answer.md)'s steps 1 and 2: read `RUNTIME_ID` again, which must differ from `$RUNTIME_BEFORE`, then send DA1 with the word `CHANGED_OK` and the file `answer-changed.json`.

## Gotchas

- YAML rejects a key repeated in one mapping, so `serviceExposures` can't name a service twice.
- OpenShell checks names only when it creates the sandbox: an invalid name such as `Probe` passes plan, and a replacing apply then deletes the old sandbox before the create fails. Use lowercase DNS labels.
- An exposure to a port nothing listens on still gets a URL in apply output and in `openshell service list`; this feature checks the gateway's record, not a response.
- After `STRIP`, an interface that needs the caller's `Authorization` header through the exposure loses it; run the agent's interface feature first.
- The old runtime ID fails with `runtime_unavailable` after the replacement; always read it again. An interface `Token` path that names the runtime changes too.
