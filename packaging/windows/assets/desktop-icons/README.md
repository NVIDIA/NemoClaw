<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Desktop agent icons

These desktop icons retain the existing agent artwork:

- `NemoClaw.ico` is the unchanged installer icon from `../NemoClaw.ico`.
- `openclaw.ico`, `langchain-deepagents-code.ico`, and `nemocua.ico` wrap the existing onboarding PNG bytes in a Windows ICO container.
- `pi.ico` renders the existing `../../onboarding/assets/pi.svg` mark at 256 × 256 pixels, then wraps the PNG in an ICO container.
- `hermes.ico` is the unchanged `hermes_cli/web_dist/favicon.ico` in the pinned official `hermes_agent-0.19.0-py3-none-any.whl` (MIT license, retained with the installed Hermes distribution). The wheel SHA-256 is `bd0bac012aee38a60894781f4597dc29ee7bedb3448540249921f10d3bef327f`; the icon SHA-256 is `aefe65e6574e6f46d3382588f46c508e1b3f3b3c9ce3dec6d335403a5374add9`.

The build packages exactly the six ICO files. Shortcut targets use the installed launcher with an explicit agent identity; they contain no provider keys.
