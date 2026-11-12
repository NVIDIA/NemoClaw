<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Change a Service Exposure

Adding, changing, or removing one of a sandbox's `serviceExposures` updates the running sandbox's endpoints in place, as [usage.md](../../../../docs/build-deploy/usage.md#choose-the-change-path)'s change-path table states.
The plan says so before apply, the gateway records the exposure after it, and the agent answers in the same sandbox under the same runtime.

## Sub-features

- **XC1:** Plan shows `update` for the sandbox, no change to its agent runtime, no deletion warning, and no URLs.
- **XC2:** After apply, the sandbox's container and the agent's runtime ID are unchanged, the output lists the exposure's URL under **Service URLs**, `openshell service list` shows its port and mode, and the agent answers.

## How to get to it (user POV)

- Editing `serviceExposures` in the YAML, then `nemoclaw plan` and `nemoclaw apply`.

## Driving it with the nemoclaw and OpenShell CLIs

Preconditions: [export-reapply](export-reapply.md) passed, and the agent's interface feature ran first.

1. Change the exposure by hand in `$RUN_DIR/deployment.yaml`, keeping any others.
   When `spec.sandboxes.assistant.serviceExposures` has a `BEARER_PASSTHROUGH` exposure, as the `openclaw` agent file declares for `dashboard`, set that exposure's `authorizationMode: STRIP` and `SERVICE` to its name.
   Otherwise, as for `hermes`, add a `probe` exposure and set `SERVICE=probe`: put it in the existing `serviceExposures` map, or add the map under the sandbox, beside its `image` and `harness`:
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
   grep -A1 '  sandbox/assistant$' "$EVIDENCE/change-plan.txt"
   grep -c 'agent runtime/assistant' "$EVIDENCE/change-plan.txt"
   grep -c 'Deletes sandbox files' "$EVIDENCE/change-plan.txt"
   grep -c 'Service URLs' "$EVIDENCE/change-plan.txt"
   ```
   Result: `update  sandbox/assistant` with no warning under it; then `0`, `0`, and `0`.
3. **XC2:**
   ```sh
   nc apply "$RUN_DIR/deployment.yaml" --progress off > "$EVIDENCE/change-apply.txt" 2>&1
   grep -c 'Apply complete' "$EVIDENCE/change-apply.txt"
   grep -c 'Sandbox files and conversation history deleted' "$EVIDENCE/change-apply.txt"
   grep "^  assistant/$SERVICE: " "$EVIDENCE/change-apply.txt" | tee "$EVIDENCE/service-url-changed.txt"
   openshell service list assistant | tee "$EVIDENCE/services-changed.txt"
   docker ps --format '{{.Names}}' | grep -cx "$SANDBOX_BEFORE"
   ```
   Result: `1`, then `0`; one `assistant/$SERVICE: URL` line; the exposure's row shows `strip`; then `1`, the same sandbox container.
   An omitted mode lists as OpenShell's default, `strip`.
   Then run [deploy-and-answer](deploy-and-answer.md)'s steps 1 and 2: read `RUNTIME_ID` again, which must equal `$RUNTIME_BEFORE`, then send DA1 with the word `CHANGED_OK` and the file `answer-changed.json`.

## Gotchas

- YAML rejects a key repeated in one mapping, so `serviceExposures` can't name a service twice.
- OpenShell checks a name when it exposes the service: an invalid name such as `Probe` passes plan, and apply then fails with OpenShell's `ExposeService` rejection while the sandbox keeps running. Use lowercase DNS labels.
- An exposure to a port nothing listens on still gets a URL in apply output and in `openshell service list`; this feature checks the gateway's record, not a response.
- After `STRIP`, an interface that needs the caller's `Authorization` header through the exposure loses it; run the agent's interface feature first.
