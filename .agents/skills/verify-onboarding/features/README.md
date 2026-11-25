<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboarding Feature Map

## Baseline Preconditions

- The [launch](../SKILL.md#launch) built and copied the bundle and chose a driver, and the [doctor](../SKILL.md#doctor) passes.
- A Docker engine answers on this host; `docker context inspect` names its socket.
- `jq` on the host, and `hc` or `tmux`.

## Driving Conventions

- Use the variables and functions the launch defines: `RUN`, `RUN_DIR`, `EVIDENCE`, `BUNDLE`, `DRIVER`, and `journey`, `tui_*`, `snap`, `saved_uid`, `owned`, `plan_intent`.
- Start each feature with `journey NAME`; it sets `JDIR`, `JEV`, and `TUI`.
- Drive only through keys a user presses; the screen lists them. Wait for a question's title before answering it, never for a fixed time.
- Typing replaces a suggested text answer; `tui_answer` clears the input first and submits.
- Never apply a YAML this skill saves: the journeys share the default gateway endpoint, and applying belongs to [verify-yaml-deployment](../../verify-yaml-deployment/SKILL.md).

## Proof Rules

- A journey passes only on its observable results, saved under `$EVIDENCE/<journey>/`.
- The saved YAML proves what onboarding wrote; `plan.txt` and `plan.json` prove what the user sees; `intent.json` proves which harness, image, model, endpoint, and owner the plan carries. A feature needs all three.
- A plan proves intent, not that apply succeeds or that the agent answers.
- A missing precondition fails the journey, with the reason in the feature's `Gotchas`.
- A proof through one entry point, such as a template with Ctrl+D, does not cover another, such as answering each question.

## Features

| File | Feature |
|---|---|
| [express-review.md](express-review.md) | From a template that names a local agent image, Ctrl+D fills the rest, the review marks the image metadata compatible and toggles the YAML preview with Tab, and the plan intends the template |
| [answer-each-question.md](answer-each-question.md) | Changed answers (harness, Tab-edited and replaced name) reach the saved YAML and the plan |
| [credential-reference.md](credential-reference.md) | The YAML names the credential variable, non-interactive plan defers an unset inference key to apply, and no value is stored |
| [exit-without-saving.md](exit-without-saving.md) | Esc writes nothing, and an existing output file is never overwritten |

Run them in this order; [credential-reference](credential-reference.md) reuses the YAML [answer-each-question](answer-each-question.md) saves.
