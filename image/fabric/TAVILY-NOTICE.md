<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Tavily Search plugin

Upstream: OpenClaw, `@openclaw/tavily-plugin` version `2026.9.4`.
Source archive: [published npm package](https://registry.npmjs.org/@openclaw/tavily-plugin/-/tavily-plugin-2026.9.4.tgz).
Archive SHA-256: `9b250b5ed8660247947701c4df3fb8b1c6b32fd7e30b7a186c7ae763e30c29e8`.

2026-09-21: No source modifications.
NemoClaw installs the published package beside OpenClaw and links its plugin SDK dependency to the pinned runtime.
The package archive omits an OpenClaw license file; the image retains the [upstream MIT license](https://github.com/openclaw/openclaw/blob/v2026.9.4/LICENSE) beside the plugin as `LICENSE`.
The bundled TypeBox dependency retains its upstream license in `node_modules/typebox/license`.
