<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Exit Without Saving

A user can leave onboarding at any question with **Esc**, and nothing is written.
Onboarding never overwrites an existing file: an output path that exists stops it before the first screen.

## Sub-features

- **EX1:** Esc on a question exits with status 0 and creates no output file.
- **EX2:** An existing output file makes onboarding fail with `output already exists; choose a new path with --output`, exit 1, and leaves the file unchanged.

## How to get to it (user POV)

- **Esc** on any onboarding screen, as the footer lists.
- `nemoclaw onboard [TEMPLATE] --output FILE` where `FILE` exists, as the [CLI reference](../../../../docs/reference/cli.md#commands) describes.

## Driving it with hc or tmux

Preconditions: the baseline only.

1. **EX1:**
   ```sh
   journey exit
   tui_start "$PWD/examples/onboarding/openclaw.yaml"
   tui_wait 'Press Enter to begin.'
   tui_keys enter; tui_wait 'Choose your agent harness' && snap 01-harness
   tui_keys esc; tui_wait 'onboard-exit=' && snap 02-exited
   grep -c 'onboard-exit=0' "$JEV/02-exited.txt"
   ls "$JDIR/deployment.yaml" 2>&1 | grep -c 'No such file'
   tui_stop
   ```
   Result: the harness question, then `1` and `1`.
2. **EX2:**
   ```sh
   printf 'kept by verify-onboarding\n' > "$JDIR/deployment.yaml"
   shasum -a 256 "$JDIR/deployment.yaml" > "$JEV/existing.sha256"
   tui_start "$PWD/examples/onboarding/openclaw.yaml"
   tui_wait 'onboard-exit=' && snap 03-exists
   grep -c 'output already exists; choose a new path with --output' "$JEV/03-exists.txt"
   grep -c 'onboard-exit=1' "$JEV/03-exists.txt"
   shasum -a 256 -c "$JEV/existing.sha256"
   ```
   Result: `1`, `1`, then `…/deployment.yaml: OK`.

Then run the [cleanup](../SKILL.md#cleanup); `owned` reads no UID from the placeholder file and prints `0`.

## Gotchas

- **Ctrl+C** also exits without saving, but as a cancellation error; this journey covers Esc only.
- EX2 fails before raw mode starts, so the message is ordinary terminal output, not a TUI screen.
