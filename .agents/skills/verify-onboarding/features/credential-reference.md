<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Credential Reference

Onboarding never asks for a credential value: the saved YAML names the environment variable that holds it, and the review and post-save summary say when that variable is unset.
A non-interactive plan without an inference credential succeeds and defers the credential to apply, and a plan with the variable set marks it available without recording its value.

## Sub-features

- **CR1:** The review and post-save summary say the variable is not set and that apply will ask for it, and the saved YAML holds `credential: env: NVIDIA_API_KEY` and no value.
- **CR2:** `nemoclaw plan --non-interactive` without the variable succeeds (`plan-exit=0`), reports `Credential references: 0/1 available.`, and defers `NVIDIA_API_KEY` to apply.
- **CR3:** With the variable set, plan reports `Credential references: 1/1 available.`, and neither the plan output nor the saved plan holds the value.

## How to get to it (user POV)

- The review screen of `nemoclaw onboard`, and the [Reviewing and Saving the YAML](../../../../docs/get-started/onboard.md#reviewing-and-saving-the-yaml) steps.
- `nemoclaw plan FILE --non-interactive`, as the [CLI reference](../../../../docs/reference/cli.md#credential-resolution) describes.

## Driving it with hc or tmux

Preconditions: [answer-each-question](answer-each-question.md) saved `$RUN_DIR/answer/deployment.yaml` and its review and post-save captures.

1. **CR1:**
   ```sh
   grep -c 'NVIDIA_API_KEY · not set (apply will ask for it)' "$EVIDENCE/answer/30-review.txt"
   grep -c 'NVIDIA_API_KEY: not set; apply will ask' "$EVIDENCE/answer/31-saved.txt"
   grep -A1 'credential:' "$RUN_DIR/answer/deployment.yaml"
   ```
   Result: `1`, `1`, then `credential:` and `env: NVIDIA_API_KEY`.
2. **CR2:**
   ```sh
   journey credential
   cp "$RUN_DIR/answer/deployment.yaml" "$JDIR/deployment.yaml"
   env -u NVIDIA_API_KEY "$BUNDLE/bin/nemoclaw" plan "$JDIR/deployment.yaml" --state-dir "$JDIR/state" \
     --non-interactive --progress off > "$JEV/plan-missing.txt" 2>&1
   echo "plan-exit=$?"
   grep -c 'Credential references: 0/1 available.' "$JEV/plan-missing.txt"
   grep -c 'Credential reference NVIDIA_API_KEY is unavailable or unverified; resolve it before apply.' "$JEV/plan-missing.txt"
   ```
   Result: `plan-exit=0`, `1`, then `1`.
3. **CR3:**
   ```sh
   plan_intent | head -1
   grep -c 'Credential references: 1/1 available.' "$JEV/plan.txt"
   jq -c '.discovery.credentials' "$JEV/plan.json"
   jq -c '.inference' "$JEV/intent.json"
   grep -rl verify-placeholder "$JEV" "$JDIR/state" | wc -l
   ```
   Result: `plan-exit=0`, `1`, `[{"reason":null,"reference":"NVIDIA_API_KEY","status":"available"}]`, an inference entry with `credential_env: "NVIDIA_API_KEY"`, then `0`.
   `plan-show.json` is the saved plan rendered as text; `apply.plan` itself is compressed, so grep the rendered copy.

Then run the [cleanup](../SKILL.md#cleanup) for this journey and for `answer`.

## Gotchas

- `--non-interactive` belongs to `plan` and `apply`; plan requires only gateway, cluster, and image-registry credentials up front and defers inference and integration credentials to apply.
- A real `NVIDIA_API_KEY` in the shell does not reach these journeys: `tui_start` unsets it and `plan_intent` overrides it. Removing either breaks CR1 or CR3 and sends a real key to the hosted catalog.
- `1/1 available` proves only that the variable is set and nonempty, not that the key works.
