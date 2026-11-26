<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Express Review from a Template

A user who starts from a template, accepts its harness and name, and presses **Ctrl+D** gets the remaining settings chosen for them, a review whose target checks pass, and a saved YAML.
Planning that file intends a managed Docker gateway, one `assistant` sandbox running the template's image and harness, and the template's provider and model.

## Sub-features

- **ER1:** After the harness and name questions, Ctrl+D checks the engine and image and opens **Review your deployment** with `Image: … · metadata compatible`, and Tab expands **Configuration file**.
- **ER2:** Enter saves the reviewed YAML with a fresh UID, the template's image, harness, engine, provider, and model.
- **ER3:** The plan creates only, every owned resource carries the saved UID, and the intent matches ER2's values.

## How to get to it (user POV)

- `nemoclaw onboard TEMPLATE --output FILE`, then **Ctrl+D** after the harness is chosen, as the [onboarding guide](../../../../docs/get-started/onboard.md#starting-onboarding) describes.
- Then `nemoclaw plan FILE`.

## Driving it with hc or tmux

Preconditions: a local agent image with Fabric metadata, referenced by digest, and the engine's socket.
Build the image if it is missing; it takes many minutes and several gigabytes:

```sh
docker image inspect nc-fabric:openclaw > /dev/null 2>&1 || cargo images build --platform "linux/$(uname -m | sed 's/aarch64/arm64/;s/x86_64/amd64/')" openclaw
IMAGE=$(docker image inspect nc-fabric:openclaw --format '{{index .RepoDigests 0}}')
docker image inspect nc-fabric:openclaw --format '{{index .Config.Labels "io.nemoclaw.fabric.catalog"}}' | grep -c nvidia.fabric.openclaw
ENGINE=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
```

Result: `IMAGE` is `nc-fabric@sha256:…`, the count is `1`, and `ENGINE` is a `unix://` socket.

1. **ER1:** Write the template from the onboarding example, setting the Docker engine and replacing the placeholder image digest with the local image, then onboard:
   ```sh
   journey express
   awk -v engine="$ENGINE" -v image="$IMAGE" '
     /^      docker: \{\}$/ { print "      docker:"; print "        engine: " engine; next }
     /^        ref: nc-fabric@sha256:0+$/ { print "        ref: " image; next }
     { print }
   ' examples/onboarding/openclaw.yaml > "$JDIR/template.yaml"
   grep -cE "engine: $ENGINE|ref: $IMAGE" "$JDIR/template.yaml"
   cp "$JDIR/template.yaml" "$JEV/template.yaml"
   tui_start "$JDIR/template.yaml"
   tui_wait 'Press Enter to begin.' && snap 01-welcome
   tui_keys enter; tui_wait 'Choose your agent harness' && snap 02-harness
   tui_screen | grep -c '●  OpenClaw'
   tui_keys enter; tui_wait 'Name this deployment' && snap 03-name
   tui_keys enter; tui_wait 'Where should the sandbox run?'
   tui_keys ctrl+d; tui_wait 'Review your deployment' 60
   tui_wait 'metadata compatible' && snap 04-review
   grep -c 'metadata compatible' "$JEV/04-review.txt"
   grep -c 'Press Enter to save.' "$JEV/04-review.txt"
   tui_keys tab; tui_wait 'Tab hides it' && snap 04b-yaml
   grep -c '▾ Configuration file  Tab hides it' "$JEV/04b-yaml.txt"
   ```
   Result: `2`, then the welcome, harness, name, review, and expanded YAML screens, and four counts of `1`.
2. **ER2:**
   ```sh
   tui_keys enter; tui_wait 'onboard-exit=' && snap 05-saved
   grep -c 'onboard-exit=0' "$JEV/05-saved.txt"
   saved_uid; grep -c 12345678-1234-4234-9234-123456789abc "$JDIR/deployment.yaml"
   grep -cE "kind: nvidia.fabric.openclaw|$IMAGE|engine: $ENGINE|endpoint: https://integrate.api.nvidia.com/v1|model: nvidia/nemotron-3.5-super-vl-120b-a12b" "$JDIR/deployment.yaml"
   ```
   Result: `Authored desired state: …/deployment.yaml` on screen, `1`, a new UUID, `0`, then `5`.
3. **ER3:** Run the [doctor](../SKILL.md#doctor), then:
   ```sh
   plan_intent
   jq -c '{outcome, changes: [.changes[].resource | sub("\\..*"; "")] | unique, credentials: .discovery.credentials}' "$JEV/plan.json"
   jq -e --arg uid "$(saved_uid)" --arg image "$IMAGE" --arg engine "$ENGINE" '
     .actions == ["create"] and .owners == [$uid]
     and .gateway.compute_driver == "docker" and .gateway.engine == $engine
     and .sandboxes == [{name: "assistant", image: $image}]
     and .agents == [{harness: "nvidia.fabric.openclaw", agent: "primary", models: ["nvidia/nemotron-3.5-super-vl-120b-a12b"]}]
     and .inference == [{api: "openai-completions", endpoint: "https://integrate.api.nvidia.com/v1", credential_env: "NVIDIA_API_KEY"}]
   ' "$JEV/intent.json"
   ```
   Result: `plan-exit=0`; `plan.txt` lists `create  gateway`, `create  sandbox/assistant`, `create  agent runtime/assistant`, and `create  provider/nvidia-prod`; the JSON line shows `outcome: planned`, resource types including `docker_container`, `openshell_sandbox`, `fabric_agent`, and `openshell_inference`, and `NVIDIA_API_KEY` `available`; then `true`.

Then run the [cleanup](../SKILL.md#cleanup).

## Gotchas

- Without `spec.gateway.target.docker.engine` and an image the engine holds, Ctrl+D shows `delegation: Target engine and image compatibility is not verified.` and stays on the question; that is the journey failing its precondition, not a pass. The onboarding example omits the engine socket and carries a zero-digest placeholder `image.ref`, so the template sets both.
- An `nc-fabric:openclaw` built before the image gained the `io.nemoclaw.fabric.catalog` label leaves the target unverified; rebuild it.
- Discovery after Ctrl+D can take several seconds; the 60-second wait covers a slow engine.
- The plan stays `complete: false`; refer to [Plan and Read the Intent](../SKILL.md#plan-and-read-the-intent).
