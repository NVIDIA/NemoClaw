---
name: statechart
description: Check a small TLA+ model with TLC and read the result as a state chart and shortest failing paths. Use to model a lifecycle, protocol, or specification and find the orders of events that break it.
disable-model-invocation: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Wraps pstack's statechart skill; see ../NOTICE.md. -->

# Statechart

This skill runs pstack's statechart tool at a pinned revision.
The tool checks a TLA+ model with TLC, then writes `chart.mmd`, `report.md`, and each broken rule's shortest path in the view's words.
The pinned checkout's own `SKILL.md` explains how to write the model, the view, and the report; follow it, and follow the rules below where they differ.

## Set Up the Pinned Tool

The tool needs Node.js 22.18 or later, Bun 1.1.5 or later, or Deno 2 to run its TypeScript, and Java 11 or later for TLC.
This script fetches the tool and the checksum-verified TLC jar into your user cache:

```sh
rev=4dd1d05818d19792e7cd6e818f1667f95f7e1dbe
pstack="${XDG_CACHE_HOME:-$HOME/.cache}/pstack-$rev"
if [ ! -d "$pstack/.git" ]; then
  git clone --quiet --filter=blob:none --no-checkout https://github.com/cursor/plugins "$pstack"
  git -C "$pstack" sparse-checkout set pstack/skills/statechart
  git -C "$pstack" checkout --quiet "$rev"
fi
if [ ! -f "$pstack/tla2tools.jar" ]; then
  curl -fsSLo "$pstack/tla2tools.jar.part" \
    https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
  echo "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  $pstack/tla2tools.jar.part" |
    sha256sum -c -
  mv "$pstack/tla2tools.jar.part" "$pstack/tla2tools.jar"
fi
```

Then read `$pstack/pstack/skills/statechart/SKILL.md` and run the tool with `TLA2TOOLS` and `JAVA` set, which skips its `mise` install:

```sh
TLA2TOOLS="$pstack/tla2tools.jar" JAVA=/path/to/java-11-or-later \
  "$pstack/pstack/skills/statechart/scripts/statechart" Model.tla --view view.mjs --out out
```

The tool exits with status 1 when a rule breaks and still writes its output.
If no Java 11 or later is installed, ask before installing one.

## Local Rules

- Work in a scratch folder outside the checkout.
  Commit a model only through the `create-formal-verification-skill` skill.
- Model only what the code or specification states, and cite the file, function, or issue comment behind each action.
  Where the source says nothing, model each possible behavior and report the gap as a question, not a finding.
- Name states and steps in the source's terms, such as runtime, sandbox, apply, and interface.
- Treat each broken rule as a candidate.
  Check every step of its path against the source before reporting it.
  When code exists, turn the path into a behavioral test with the `test-driven-development` skill.
- Ask before posting charts or paths on an issue or pull request.
