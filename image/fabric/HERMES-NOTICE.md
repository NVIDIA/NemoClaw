<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes Image Source

Hermes Agent source is pinned to release [v0.22.7](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.7) (`b200f5bc60e31588ba2cb60e288029c4a54ba5fa`) from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).
Its dependencies come from that release's own `uv.lock`.
Its built dashboard (`hermes_cli/web_dist`) and TUI bundle (`hermes_cli/tui_dist`) come unmodified from the release's published image, [`nousresearch/hermes-agent:v0.22.7`](https://hub.docker.com/r/nousresearch/hermes-agent) (`sha256:e6d81ae52ebf6a43efa529701405509f20054ba818f179ddd748bed4f8af584c`), whose files shared with the release source match it, apart from the `README.md` its build empties.
Its upstream license and notices remain in `/opt/hermes` and the retained source archive.
`/opt/nemoclaw/source/anydoc-LICENSE` retains the unmodified MIT notice of firecrawl-anydoc 0.2.4 from commit `42bf1c5ecdde9eb0d96d6bd75a9e6698cf93b14c`, matching that release's source distribution.
This file names Copyright (c) 2026 Sideguide Technologies Inc.; `versions.json` pins its URL and SHA-256.
`/opt/nemoclaw/source/xterm-LICENSE` retains the unmodified xterm.js 6.0.0 MIT notice from commit `f447274f430fd22513f6adbf9862d19524471c04`, matching its npm package.
The dashboard bundles xterm.js; this notice preserves the xterm.js authors, SourceLair, and Christopher Jeffrey credits.
`/opt/nemoclaw/source/hermes/hermes-NOTICES.md` retains original license/notice texts and available package declarations for the 108 packages observed in a local dashboard rebuild and the published TUI's module labels.
`hermes-inventory.json` beside it records exact npm archive URLs, integrity values, notice hashes, and observed bundle membership.
It identifies four packages whose inspected upstream material declares MIT without supplying a standalone license file: `@nous-research/ui`, `unicode-animations`, `react-remove-scroll-bar`, and `@alcalzone/ansi-tokenize`.
The original declarations are retained without inventing copyright notices.
The local rebuild is not claimed byte-identical to the published dashboard.
The TUI's `entry.js` also retains its inline bundled-license comments.
The shipped Collapse, Mondwest, and Rules fonts carry commercial-foundry metadata; package-level MIT metadata does not establish the font files' redistribution terms.
The [image review](../../internal-docs/contributing/image-licenses.md) tracks their applicable coverage decision.
NemoClaw installs the source and these builds unmodified.
