# Install Kit

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

## When to Use

Use when Python 3.12 Kit is needed for validators, profilers, or SO via Kit.

## Instructions

1. Confirm the target asset, artifact, or user intent and check the prerequisites listed below.
2. Read only the referenced files needed for the current phase, failure mode, or output contract.
3. Follow the workflow, rules, and safety gates in this reference before invoking downstream references or shell commands.
4. Return the result using the Output Format section and name any blocked prerequisite or unresolved user decision.

## Output Format

Return a concise status or report that names the input, selected runtime or evidence source, actions planned or performed, artifacts written, blockers, and the next validation or user-decision step. When a schema or template is referenced below, conform to that contract.

## Purpose

Install Omniverse Kit as a Python package via pip so skills can import
`omni.kit_app` and start a headless Kit runtime.

Do not use this reference for full Isaac Sim, Omniverse Launcher, or desktop app
installs.

## Prerequisites

- Python 3.12
- Network access to `pypi.nvidia.com`

## Limitations

- This installs Kit only; it does not install or enable Scene Optimizer by
  itself.
- Installing Kit does not authenticate access to remote `omniverse://` servers.
- The smoke test accepts the Kit EULA through `OMNI_KIT_ACCEPT_EULA=yes`.

## Install

```bash
python3.12 -m venv ~/venvs/kit
source ~/venvs/kit/bin/activate
pip install --upgrade pip
pip install omniverse-kit --extra-index-url https://pypi.nvidia.com
```

## Smoke test

```bash
OMNI_KIT_ACCEPT_EULA=yes python -m omni.kit_app --no-window --/app/quitAfter=10.0
```

Kit boots, prints its banner, and quits. That confirms the install.

Redirect smoke-test stdout/stderr to a log file and surface only a bounded tail
if troubleshooting is needed. Follow
`skills/omniverse-usd-performance-tuning/references/runtime-artifact-token-budget.md`
for Kit launch logs.

## Troubleshooting

- If `import omni.kit_app` fails, confirm the intended virtual environment is
  active and rerun the pip install command.
- If the smoke test stalls on EULA handling, rerun it with
  `OMNI_KIT_ACCEPT_EULA=yes`.
- For remote `omniverse://` assets, use `omniverse-authentication` to preflight
  remote access, handle browser-based SSO, and verify `omni.client` can
  stat/open the target URL before running profilers, validators, or Scene
  Optimizer operations.
