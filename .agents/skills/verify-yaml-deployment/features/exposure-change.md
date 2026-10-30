<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Change a Service Exposure

A sandbox's `serviceExposures` belong to its creation, so adding or changing one replaces the sandbox, as [usage.md](../../../../docs/usage.md#choose-the-change-path)'s change-path table states.
The plan says so before apply, the gateway records the exposure after it, and the agent answers in the new sandbox.

## Sub-features

- **XC1:** Plan shows `delete → create` for the sandbox and warns that its files and history are deleted.
- **XC2:** After apply, the output lists the exposure's URL under **Service URLs**, `openshell service list` shows its port and mode, and the agent answers in the new sandbox.

## How to get to it (user POV)

- Editing `serviceExposures` in the YAML, then `nemoclaw plan` and `nemoclaw apply`.

## Driving it with the nemoclaw and OpenShell CLIs

Preconditions: [export-reapply](export-reapply.md) passed; this feature deletes the conversation history.

1. Change the exposure: when the YAML has one, switch its mode; otherwise add one on a port the agent file names, or on 18800:
   ```sh
   if grep -q 'authorizationMode: BEARER_PASSTHROUGH' "$RUN_DIR/deployment.yaml"; then
     sed -i 's/authorizationMode: BEARER_PASSTHROUGH/authorizationMode: STRIP/' "$RUN_DIR/deployment.yaml"; EXPECT=strip
   else
     python3 - "$RUN_DIR/deployment.yaml" <<'PY'
   import sys, yaml
   doc = yaml.safe_load(open(sys.argv[1]))
   doc["spec"]["sandboxes"]["assistant"]["serviceExposures"] = {"probe": {"targetPort": 18800}}
   yaml.safe_dump(doc, open(sys.argv[1], "w"), sort_keys=False)
   PY
     EXPECT=strip
   fi
   cp "$RUN_DIR/deployment.yaml" "$EVIDENCE/deployment-changed.yaml"
   ```
2. **XC1:**
   ```sh
   nc plan "$RUN_DIR/deployment.yaml" --progress off > "$EVIDENCE/change-plan.txt" 2>&1
   grep -A2 'sandbox/assistant' "$EVIDENCE/change-plan.txt"
   ```
   Result: `delete → create  sandbox/assistant`, then `Deletes sandbox files and conversation history.`
3. **XC2:**
   ```sh
   nc apply "$RUN_DIR/deployment.yaml" --progress off > "$EVIDENCE/change-apply.txt" 2>&1
   grep -c 'Apply complete' "$EVIDENCE/change-apply.txt"
   grep -A3 'Service URLs:' "$EVIDENCE/change-apply.txt"
   openshell service list assistant | tee "$EVIDENCE/services-changed.txt"
   ```
   Result: `1`, an `assistant/SERVICE: URL` line for the exposure, and the exposure's row shows `$EXPECT`.
   An omitted mode lists as OpenShell's default, `strip`.
   Rerun the doctor to pick up the new sandbox container, then [deploy-and-answer](deploy-and-answer.md)'s DA1 with the word `CHANGED_OK` and the file `answer-changed.json`.

## Gotchas

- YAML rejects a key repeated in one mapping, so `serviceExposures` can't name a service twice.
- OpenShell checks names only when it creates the sandbox: an invalid name such as `Probe` passes plan, and a replacing apply then deletes the old sandbox before the create fails. Use lowercase DNS labels.
- An exposure to a port nothing listens on still gets a URL in apply output and in `openshell service list`; this feature checks the gateway's record, not a response.
- After `STRIP`, an interface that needs the caller's `Authorization` header loses it; the agent's interface feature names the mode it needs.
