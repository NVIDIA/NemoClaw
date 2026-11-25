<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Answer Each Question

A user who changes answers instead of accepting the template's sees each question in turn, reviews the result, and saves it, even when the target cannot confirm the image.
The saved YAML and the plan carry the changed answers, not the template's.

## Sub-features

- **AQ1:** Choosing another harness from the list changes the harness.
- **AQ2:** Tab copies a suggested text answer for editing, and a typed deployment name replaces the suggestion.
- **AQ3:** Enter accepts each remaining suggestion, one question at a time, until **Review your deployment**, which allows saving when the image is compatible, unverified, or not present locally.
- **AQ4:** The saved YAML and the plan's intent carry the changed harness and name, with the template's provider and model.

## How to get to it (user POV)

- `nemoclaw onboard examples/onboarding/openclaw.yaml --output FILE`, answering each question; the screen lists **Enter**, **↑/↓**, **←**, **Ctrl+O**, and **Esc**.
- Then `nemoclaw plan FILE`.

## Driving it with hc or tmux

Preconditions: the baseline only.

1. **AQ1:**
   ```sh
   journey answer
   tui_start "$PWD/examples/onboarding/openclaw.yaml"
   tui_wait 'Press Enter to begin.' && snap 01-welcome
   tui_keys enter; tui_wait 'Choose your agent harness' && snap 02-harness
   tui_choose Hermes && snap 03-hermes
   ```
   Result: `●  OpenClaw` in `02-harness.txt`, then `●  Hermes` in `03-hermes.txt`.
2. **AQ2:**
   ```sh
   tui_keys enter; tui_wait 'Name this deployment' && snap 04-name
   tui_keys tab; tui_wait 'Delete the text to use the suggestion again.' && snap 04b-edit
   tui_answer verify-onboarding-answer
   tui_wait 'Where should the sandbox run?' && snap 05-runtime
   ```
   Result: the deployment name suggestion in `04-name.txt`, the copied suggestion in `04b-edit.txt`, then the target question with `●  Docker`.
3. **AQ3:** Accept each remaining suggestion, waiting for catalog and review discovery before advancing:
   ```sh
   tui_keys enter; tui_wait 'How should your agent reach its model?' && snap 06-step
   tui_keys enter; tui_wait 'Choose the model' && sleep 1 && snap 07-step
   tui_keys enter; tui_wait 'Sandbox image' && snap 08-step
   tui_keys enter; tui_wait 'Review your deployment'
   tui_wait 'NVIDIA_API_KEY · not set (apply will ask for it)' && snap 30-review
   for f in "$JEV"/*-step.txt; do sed -n 's/ *⟦.*//p' "$f"; done | uniq
   grep -cE 'Image +.* · (metadata compatible|not present|not checked)' "$JEV/30-review.txt"
   grep -c 'Press Enter to save.' "$JEV/30-review.txt"
   ```
   Result: the question titles in order (for this template and a Docker host: `How should your agent reach its model?`, `Choose the model`, and `Sandbox image`), then `1` and `1`.
   Record which `Image` status the review shows; on a host with a local Hermes image onboarding suggests that image and shows `metadata compatible`, whereas on a host without one it keeps the template's placeholder digest and shows `not present`.
4. **AQ4:**
   ```sh
   tui_keys enter; tui_wait 'onboard-exit=' && snap 31-saved
   grep -c 'onboard-exit=0' "$JEV/31-saved.txt"
   grep -cE 'name: verify-onboarding-answer|kind: nvidia.fabric.hermes' "$JDIR/deployment.yaml"
   ```
   Result: `1`, then `2`. Run the [doctor](../SKILL.md#doctor), then:
   ```sh
   plan_intent
   IMAGE=$(jq -r '.discovery.targets.sandbox_assistant_acquired.image' "$JEV/plan.json")
   grep -cF "${IMAGE#*@}" "$JDIR/deployment.yaml"
   jq -e --arg uid "$(saved_uid)" --arg image "$IMAGE" '
     .actions == ["create"] and .owners == [$uid]
     and .sandboxes == [{name: "assistant", image: $image}]
     and .agents == [{harness: "nvidia.fabric.hermes", agent: "primary", models: ["nvidia/nemotron-3.5-super-vl-120b-a12b"]}]
     and .inference == [{api: "openai-completions", endpoint: "https://integrate.api.nvidia.com/v1", credential_env: "NVIDIA_API_KEY"}]
   ' "$JEV/intent.json"
   ```
   Result: `plan-exit=0`, `1`, then `true`.

Keep `$RUN_DIR/answer` until [credential-reference](credential-reference.md) has run, then run the [cleanup](../SKILL.md#cleanup) for both.

## Gotchas

- The question list depends on the template, the engine, and which answers change; capture it rather than counting Enter presses.
- Ctrl+D after a changed harness usually shows `delegation: Target engine and image compatibility is not verified.`; this journey does not use it.
- The image suggestion can be folded across two lines in the saved YAML (`ref: >-`); compare with `grep -F` on the digest, not a whole-line match.
- `tui_choose` presses ↑ and then ↓; if the screen is too short to show the whole list, the label may scroll out of view.
