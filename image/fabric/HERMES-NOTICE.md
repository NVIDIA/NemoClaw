<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes Image Source

Hermes Agent source is pinned to release [v0.22.5](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.5) (`bf0203a794a07aac3ff764972ab9087baa4e4f4e`) from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).
Its dependencies come from that release's own `uv.lock`.
Its built dashboard (`hermes_cli/web_dist`) and TUI bundle (`hermes_cli/tui_dist`) come unmodified from the release's published image, [`nousresearch/hermes-agent:v0.22.5`](https://hub.docker.com/r/nousresearch/hermes-agent) (`sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d`), whose files shared with the release source match it, apart from the `README.md` its build empties.
Its upstream license and notices remain in `/opt/hermes` and the retained source archive.
NemoClaw installs the source and these builds unmodified.
